import { DomainError } from './domain-error';
import { FailureCode } from './failure-code';
import { Money } from './money';
import { LedgerDirection } from './wallet-ledger-entry';
import { assertIdentifier, copyDate } from './validation';

export interface WalletState {
  readonly id: string;
  readonly playerId: string;
  readonly currency: string;
  readonly balance: Money;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Immutable facts from which the application can build a ledger entry. */
export interface WalletBalanceChange {
  readonly walletId: string;
  readonly direction: LedgerDirection;
  readonly money: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  readonly walletVersion: number;
}

export class Wallet {
  readonly id: string;
  readonly playerId: string;
  readonly currency: string;
  private _balance: Money;
  private _version: number;
  private readonly openedAt: Date;
  private changedAt: Date;
  readonly openingMovement: WalletBalanceChange | undefined;

  private constructor(state: WalletState, opening = false) {
    assertIdentifier(state.id, FailureCode.InvalidWalletState);
    assertIdentifier(state.playerId, FailureCode.InvalidWalletState);
    Money.zero(state.currency).equals(state.balance);
    if (state.balance.isNegative() || !Number.isSafeInteger(state.version) || state.version < 1) {
      throw new DomainError(FailureCode.InvalidWalletState, 'Wallet balance or version is invalid');
    }
    this.id = state.id;
    this.playerId = state.playerId;
    this.currency = state.currency;
    this._balance = state.balance;
    this._version = state.version;
    this.openedAt = copyDate(state.createdAt, FailureCode.InvalidWalletState);
    this.changedAt = copyDate(state.updatedAt, FailureCode.InvalidWalletState);
    this.openingMovement = opening && state.balance.isPositive() ? Object.freeze({
      walletId: this.id, direction: LedgerDirection.Credit, money: state.balance,
      balanceBefore: Money.zero(this.currency), balanceAfter: state.balance, walletVersion: 1,
    }) : undefined;
  }

  static open(props: { id: string; playerId: string; initialBalance: Money; at?: Date }): Wallet {
    const at = props.at ?? new Date();
    return new Wallet({ ...props, currency: props.initialBalance.currency, balance: props.initialBalance,
      version: 1, createdAt: at, updatedAt: at }, true);
  }

  static rehydrate(state: WalletState): Wallet { return new Wallet(state); }
  get balance(): Money { return this._balance; }
  get version(): number { return this._version; }
  get createdAt(): Date { return new Date(this.openedAt.getTime()); }
  get updatedAt(): Date { return new Date(this.changedAt.getTime()); }

  debit(money: Money, at = new Date()): WalletBalanceChange | undefined {
    return this.move(money, LedgerDirection.Debit, at);
  }

  credit(money: Money, at = new Date()): WalletBalanceChange | undefined {
    return this.move(money, LedgerDirection.Credit, at);
  }

  private move(money: Money, direction: LedgerDirection, at: Date): WalletBalanceChange | undefined {
    if (this.currency !== money.currency) {
      throw new DomainError(FailureCode.CurrencyMismatch, 'Movement currency differs from the wallet');
    }
    if (money.isNegative()) throw new DomainError(FailureCode.InvalidAmount, 'Movement must not be negative');
    if (money.isZero()) return undefined;
    const after = direction === LedgerDirection.Debit ? this._balance.subtract(money) : this._balance.add(money);
    if (after.isNegative()) throw new DomainError(FailureCode.InsufficientBalance, 'Wallet has insufficient balance');
    if (this._version === Number.MAX_SAFE_INTEGER) {
      throw new DomainError(FailureCode.InvalidWalletState, 'Wallet version exhausted');
    }
    const timestamp = copyDate(at, FailureCode.InvalidWalletState);
    const change = Object.freeze({ walletId: this.id, direction, money,
      balanceBefore: this._balance, balanceAfter: after, walletVersion: this._version + 1 });
    this._balance = after;
    this._version = change.walletVersion;
    this.changedAt = timestamp;
    return change;
  }
}
