import { DomainError } from './domain-error';
import { FailureCode } from './failure-code';

export interface MoneyProps {
  readonly amount: string;
  readonly currency: string;
}

export class Money {
  private constructor(private readonly cents: bigint, readonly currency: string) {
    Object.freeze(this);
  }

  static from(props: MoneyProps): Money {
    return Money.parse(props, false);
  }

  /** Signed amounts are allowed only when reconstructing internal values. */
  static rehydrate(props: MoneyProps): Money {
    return Money.parse(props, true);
  }

  static zero(currency: string): Money {
    return Money.from({ amount: '0.00', currency });
  }

  private static parse(props: MoneyProps, signed: boolean): Money {
    if (typeof props.currency !== 'string' || props.currency.length !== 3 || !/^[A-Z]{3}$/.test(props.currency)) {
      throw new DomainError(FailureCode.InvalidCurrency, 'Currency must be a three-letter uppercase code');
    }
    const pattern = signed ? /^-?(0|[1-9]\d*)\.\d{2}$/ : /^(0|[1-9]\d*)\.\d{2}$/;
    if (typeof props.amount !== 'string' || props.amount.trim() !== props.amount || !pattern.test(props.amount)) {
      throw new DomainError(FailureCode.InvalidAmount, 'Amount must be a decimal string with exactly two places');
    }
    const negative = props.amount.startsWith('-');
    const digits = (negative ? props.amount.slice(1) : props.amount).replace('.', '');
    const cents = BigInt(digits);
    return new Money(negative ? -cents : cents, props.currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents + other.cents, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents - other.cents, this.currency);
  }

  negate(): Money { return new Money(-this.cents, this.currency); }
  isZero(): boolean { return this.cents === 0n; }
  isPositive(): boolean { return this.cents > 0n; }
  isNegative(): boolean { return this.cents < 0n; }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.cents < other.cents;
  }

  equals(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.cents === other.cents;
  }

  toString(): string {
    const magnitude = this.cents < 0n ? -this.cents : this.cents;
    const whole = magnitude / 100n;
    const fraction = (magnitude % 100n).toString().padStart(2, '0');
    return `${this.cents < 0n ? '-' : ''}${whole}.${fraction}`;
  }

  toJSON(): MoneyProps { return { amount: this.toString(), currency: this.currency }; }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new DomainError(FailureCode.CurrencyMismatch, 'Money currencies do not match');
    }
  }
}
