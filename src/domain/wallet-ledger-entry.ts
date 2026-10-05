import { DomainError } from './domain-error';
import { FailureCode } from './failure-code';
import { Money } from './money';
import { assertIdentifier, copyDate } from './validation';

export enum LedgerDirection { Debit = 'DEBIT', Credit = 'CREDIT' }

export interface LedgerEntryState {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  readonly createdAt: Date;
}

export class WalletLedgerEntry {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  private readonly timestamp: Date;

  private constructor(state: LedgerEntryState) {
    for (const id of [state.id, state.walletId, state.transactionId]) {
      assertIdentifier(id, FailureCode.InvalidLedgerEntry);
    }
    if (!Object.values(LedgerDirection).includes(state.direction) || !state.money.isPositive() ||
        state.balanceBefore.isNegative() || state.balanceAfter.isNegative()) {
      throw new DomainError(FailureCode.InvalidLedgerEntry, 'Invalid ledger values');
    }
    this.id = state.id;
    this.walletId = state.walletId;
    this.transactionId = state.transactionId;
    this.direction = state.direction;
    this.money = state.money;
    this.balanceBefore = state.balanceBefore;
    this.balanceAfter = state.balanceAfter;
    this.timestamp = copyDate(state.createdAt, FailureCode.InvalidLedgerEntry);
    if (!this.isBalanced()) {
      throw new DomainError(FailureCode.InvalidLedgerEntry, 'Ledger arithmetic does not balance');
    }
    Object.freeze(this);
  }

  static create(props: LedgerEntryState): WalletLedgerEntry { return new WalletLedgerEntry(props); }
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry { return new WalletLedgerEntry(state); }
  get createdAt(): Date { return new Date(this.timestamp.getTime()); }

  isBalanced(): boolean {
    const expected = this.direction === LedgerDirection.Debit
      ? this.balanceBefore.subtract(this.money) : this.balanceBefore.add(this.money);
    return expected.equals(this.balanceAfter);
  }
}
