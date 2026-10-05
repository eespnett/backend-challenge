import { describe, expect, test } from 'bun:test';
import { EventContext, WalletBalanceChanged, WagerTransactionPendingReference,
  WagerTransactionProcessed, WagerTransactionRejected } from '../../../src/domain/events';
import { FailureCode } from '../../../src/domain/failure-code';
import { WalletLedgerEntry } from '../../../src/domain/wallet-ledger-entry';
import { WagerTransactionKind as Kind } from '../../../src/domain/wager-transaction';
import { at, expectCode, money, reversal, transaction, wallet } from './fixtures';

const ctx = (): EventContext => ({ eventId: 'event-1', correlationId: 'correlation-1', causationId: 'request-1', occurredAt: at });

describe('domain integration event envelopes only', () => {
  test('processed LOSS has a JSON event even though it has no ledger', () => {
    const tx = transaction({ kind: Kind.Loss, money: money('0.00') });
    tx.markProcessed(undefined, at);
    const event = WagerTransactionProcessed.from(tx, money('100.00'), ctx());
    expect(JSON.parse(JSON.stringify(event))).toEqual({ eventId: 'event-1', eventType: 'WagerTransactionProcessed',
      version: 1, aggregateId: 'tx-1', correlationId: 'correlation-1', causationId: 'request-1',
      occurredAt: at.toISOString(), data: { transactionId: 'tx-1', walletId: 'wallet-1', providerId: 'provider-1',
        externalTransactionId: 'external-1', kind: 'LOSS', money: { amount: '0.00', currency: 'BRL' },
        balance: { amount: '100.00', currency: 'BRL' } } });
  });

  test('wallet change snapshots money and ledger facts without retaining mutable dates', () => {
    const aggregate = wallet();
    const change = aggregate.debit(money('25.00'), at)!;
    const entry = WalletLedgerEntry.create({ ...change, id: 'entry', transactionId: 'tx-1', createdAt: at });
    const date = new Date(at);
    const context = { ...ctx(), occurredAt: date };
    const event = WalletBalanceChanged.from(aggregate, entry, context);
    aggregate.credit(money('20.00'));
    date.setUTCFullYear(2000);
    event.occurredAt.setUTCFullYear(2001);
    expect(event.eventType).toBe('WalletBalanceChanged');
    expect(event.aggregateId).toBe('wallet-1');
    expect(event.data.balanceBefore.amount).toBe('100.00');
    expect(event.data.balanceAfter.amount).toBe('75.00');
    expect(event.data.walletVersion).toBe(2);
    expect(event.occurredAt).toEqual(at);
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.data)).toBe(true);
    expect(Object.isFrozen(event.data.money)).toBe(true);
    expect(() => Object.assign(event.data.money, { amount: '99.00' })).toThrow();
    expect(event.toJSON().data.money.amount).toBe('25.00');
  });

  test('rejected and pending-reference events require matching entity status', () => {
    const tx = transaction();
    expectCode(() => WagerTransactionRejected.from(tx, ctx()), FailureCode.InvalidTransactionState);
    expectCode(() => WagerTransactionProcessed.from(tx, money('100.00'), ctx()), FailureCode.InvalidTransactionState);
    tx.reject(FailureCode.InsufficientBalance);
    expect(WagerTransactionRejected.from(tx, ctx()).data.failureCode).toBe(FailureCode.InsufficientBalance);
    const pending = reversal();
    expectCode(() => WagerTransactionPendingReference.from(pending, ctx()), FailureCode.InvalidTransactionState);
    pending.markPendingReference();
    const event = WagerTransactionPendingReference.from(pending, { ...ctx(), causationId: undefined });
    expect(event.data.referenceExternalTransactionId).toBe('ref-external');
    expect(event.toJSON()).not.toHaveProperty('causationId');
  });

  test('events reject conflicting wallet facts and currencies', () => {
    const aggregate = wallet();
    const entry = WalletLedgerEntry.create({ ...aggregate.openingMovement!, id: 'entry', transactionId: 'opening', createdAt: at });
    aggregate.credit(money('1.00'));
    expectCode(() => WalletBalanceChanged.from(aggregate, entry, ctx()), FailureCode.InvalidLedgerEntry);
    const tx = transaction();
    tx.markProcessed(undefined, at);
    expectCode(() => WagerTransactionProcessed.from(tx, money('100.00', 'USD'), ctx()), FailureCode.CurrencyMismatch);
    expectCode(() => WagerTransactionProcessed.from(tx, money('1.00').negate(), ctx()), FailureCode.InvalidWalletState);
  });
});
