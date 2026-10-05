import { DomainError } from './domain-error';
import { FailureCode } from './failure-code';
import { Money, MoneyProps } from './money';
import { Wallet } from './wallet';
import { WalletLedgerEntry, LedgerDirection } from './wallet-ledger-entry';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from './wager-transaction';
import { assertIdentifier, copyDate } from './validation';

export interface EventContext {
  readonly eventId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
}

export interface IntegrationEventProps<T> extends EventContext {
  readonly aggregateId: string;
  readonly data: T;
}

function freezeTree<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeTree(child);
    Object.freeze(value);
  }
  return value;
}

export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;
  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId: string | undefined;
  readonly data: Readonly<T>;
  private readonly timestamp: Date;

  protected constructor(props: IntegrationEventProps<T>) {
    for (const id of [props.eventId, props.aggregateId, props.correlationId]) {
      assertIdentifier(id, FailureCode.InvalidTransaction);
    }
    if (props.causationId !== undefined) assertIdentifier(props.causationId, FailureCode.InvalidTransaction);
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.timestamp = copyDate(props.occurredAt, FailureCode.InvalidTransaction);
    this.data = freezeTree(structuredClone(props.data));
  }

  get occurredAt(): Date { return new Date(this.timestamp.getTime()); }

  toJSON() {
    return { eventId: this.eventId, eventType: this.eventType, version: this.version,
      aggregateId: this.aggregateId, correlationId: this.correlationId,
      ...(this.causationId === undefined ? {} : { causationId: this.causationId }),
      occurredAt: this.timestamp.toISOString(), data: this.data };
  }
}

export interface TransactionEventData {
  readonly transactionId: string;
  readonly walletId: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly kind: WagerTransactionKind;
  readonly money: MoneyProps;
}

function transactionData(transaction: WagerTransaction): TransactionEventData {
  return { transactionId: transaction.id, walletId: transaction.walletId, providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId, kind: transaction.kind, money: transaction.money.toJSON() };
}

function assertStatus(transaction: WagerTransaction, status: WagerTransactionStatus): void {
  if (transaction.status !== status) throw new DomainError(FailureCode.InvalidTransactionState, 'Event requires matching status');
}

export class WagerTransactionProcessed extends IntegrationEvent<TransactionEventData & { readonly balance: MoneyProps }> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;
  private constructor(props: IntegrationEventProps<TransactionEventData & { readonly balance: MoneyProps }>) {
    super(props);
    Object.freeze(this);
  }
  static from(transaction: WagerTransaction, balance: Money, ctx: EventContext): WagerTransactionProcessed {
    assertStatus(transaction, WagerTransactionStatus.Processed);
    if (transaction.money.currency !== balance.currency) {
      throw new DomainError(FailureCode.CurrencyMismatch, 'Observed balance currency differs from the transaction');
    }
    if (balance.isNegative()) throw new DomainError(FailureCode.InvalidWalletState, 'Observed balance must not be negative');
    return new WagerTransactionProcessed({ ...ctx, aggregateId: transaction.id,
      data: { ...transactionData(transaction), balance: balance.toJSON() } });
  }
}

export class WagerTransactionRejected extends IntegrationEvent<TransactionEventData & { readonly failureCode: FailureCode }> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;
  private constructor(props: IntegrationEventProps<TransactionEventData & { readonly failureCode: FailureCode }>) {
    super(props);
    Object.freeze(this);
  }
  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    assertStatus(transaction, WagerTransactionStatus.Rejected);
    const failureCode = transaction.failureCode;
    if (failureCode === undefined) throw new DomainError(FailureCode.InvalidTransactionState, 'Rejection requires a failure code');
    return new WagerTransactionRejected({ ...ctx, aggregateId: transaction.id,
      data: { ...transactionData(transaction), failureCode } });
  }
}

export class WagerTransactionPendingReference extends IntegrationEvent<TransactionEventData & {
  readonly referenceExternalTransactionId: string;
}> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;
  private constructor(props: IntegrationEventProps<TransactionEventData & { readonly referenceExternalTransactionId: string }>) {
    super(props);
    Object.freeze(this);
  }
  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    assertStatus(transaction, WagerTransactionStatus.PendingReference);
    const referenceExternalTransactionId = transaction.referenceExternalTransactionId;
    if (referenceExternalTransactionId === undefined) throw new DomainError(FailureCode.ReferenceRequired, 'Event requires reference');
    return new WagerTransactionPendingReference({ ...ctx, aggregateId: transaction.id,
      data: { ...transactionData(transaction), referenceExternalTransactionId } });
  }
}

export interface WalletBalanceChangedData {
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: MoneyProps;
  readonly balanceBefore: MoneyProps;
  readonly balanceAfter: MoneyProps;
  readonly walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;
  private constructor(props: IntegrationEventProps<WalletBalanceChangedData>) {
    super(props);
    Object.freeze(this);
  }
  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    if (wallet.id !== entry.walletId || !wallet.balance.equals(entry.balanceAfter)) {
      throw new DomainError(FailureCode.InvalidLedgerEntry, 'Event does not match wallet and ledger');
    }
    return new WalletBalanceChanged({ ...ctx, aggregateId: wallet.id, data: {
      walletId: wallet.id, transactionId: entry.transactionId, direction: entry.direction,
      money: entry.money.toJSON(), balanceBefore: entry.balanceBefore.toJSON(),
      balanceAfter: entry.balanceAfter.toJSON(), walletVersion: wallet.version,
    } });
  }
}
