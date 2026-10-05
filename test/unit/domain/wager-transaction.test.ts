import { describe, expect, test } from 'bun:test';
import { WagerTransaction, WagerTransactionKind as Kind, WagerTransactionStatus as Status } from '../../../src/domain/wager-transaction';
import { LedgerDirection as Direction } from '../../../src/domain/wallet-ledger-entry';
import { FailureCode } from '../../../src/domain/failure-code';
import { InvalidTransactionStateError } from '../../../src/domain/domain-error';
import { at, expectCode, money, reference, reversal, transaction, transactionProps } from './fixtures';

describe('WagerTransaction factories and queries', () => {
  test('create starts PENDING and compares the supplied business payload hash', () => {
    const tx = transaction();
    expect(tx.status).toBe(Status.Pending);
    expect(tx.isTerminal()).toBe(false);
    expect(tx.matchesPayload('payload-hash')).toBe(true);
    expect(tx.matchesPayload('different-payload')).toBe(false);
    expect(tx.idempotencyKey).toBe('provider-1:external-1');
    expect(tx.affectsBalance()).toBe(true);
    expect(tx.requiresReference()).toBe(false);
  });

  test.each([Kind.Refund, Kind.Rollback])('%s requires reference on create and rehydrate', (kind) => {
    expectCode(() => transaction({ kind }), FailureCode.ReferenceRequired);
    expectCode(() => WagerTransaction.rehydrate({ ...transactionProps({ kind }), status: Status.Pending }), FailureCode.ReferenceRequired);
    expectCode(() => transaction({ kind, referenceExternalTransactionId: ' ' }), FailureCode.InvalidReference);
    expect(reversal(kind).requiresReference()).toBe(true);
  });

  test('OPENING is unavailable through create but has a dedicated internal factory', () => {
    expectCode(() => transaction({ kind: Kind.Opening }), FailureCode.OpeningInternalOnly);
    const opening = WagerTransaction.createOpening({ id: 'opening', walletId: 'wallet-1', playerId: 'player-1',
      money: money('100.00'), payloadHash: 'opening-hash', createdAt: at });
    expect(opening.kind).toBe(Kind.Opening);
    expect(opening.providerId).toBe('internal');
    expect(opening.status).toBe(Status.Pending);
    expect(opening.ledgerDirectionFor()).toBe(Direction.Credit);
    opening.markProcessed(undefined, at);
    const restored = WagerTransaction.rehydrate({ ...transactionProps({ kind: Kind.Opening }), status: Status.Processed, processedAt: at });
    expect(restored.status).toBe(Status.Processed);
    expectCode(() => WagerTransaction.createOpening({ id: 'o', walletId: 'w', playerId: 'p', money: money('0.00'),
      payloadHash: 'h', createdAt: at }), FailureCode.InvalidAmount);
  });

  test('direction queries distinguish LOSS and invert all allowed rollback references', () => {
    expect(transaction().ledgerDirectionFor()).toBe(Direction.Debit);
    expect(transaction({ kind: Kind.Win }).ledgerDirectionFor()).toBe(Direction.Credit);
    expect(reversal().ledgerDirectionFor()).toBe(Direction.Credit);
    const loss = transaction({ kind: Kind.Loss });
    expect(loss.affectsBalance()).toBe(false);
    expect(loss.ledgerDirectionFor()).toBeUndefined();
    expect(transaction({ money: money('0.00') }).affectsBalance()).toBe(false);
    const rollback = reversal(Kind.Rollback);
    expect(rollback.ledgerDirectionFor(reference(Kind.Bet))).toBe(Direction.Credit);
    expect(rollback.ledgerDirectionFor(reference(Kind.Win))).toBe(Direction.Debit);
    expect(rollback.ledgerDirectionFor(reference(Kind.Refund))).toBe(Direction.Debit);
    expectCode(() => rollback.ledgerDirectionFor(), FailureCode.InvalidReference);
    expectCode(() => rollback.ledgerDirectionFor(reference(Kind.Loss)), FailureCode.InvalidReference);
  });

  test('rejects malformed metadata and negative money', () => {
    expectCode(() => transaction({ id: '' }), FailureCode.InvalidTransaction);
    expectCode(() => transaction({ kind: 'OTHER' as Kind }), FailureCode.InvalidTransaction);
    expectCode(() => transaction({ money: money('1.00').negate() }), FailureCode.InvalidTransaction);
    expectCode(() => transaction({ referenceExternalTransactionId: 'ref' }), FailureCode.InvalidReference);
    expectCode(() => transaction({ createdAt: new Date('invalid') }), FailureCode.InvalidTransaction);
  });

  test.each(Object.values(Status))('rehydrates %s directly without replaying transitions', (status) => {
    const props = transactionProps({ kind: Kind.Refund, referenceExternalTransactionId: 'external-ref' });
    const failed = status === Status.Rejected || status === Status.Failed;
    const restored = WagerTransaction.rehydrate({ ...props, status,
      ...(failed ? { failureCode: FailureCode.InvalidReference } : {}),
      ...(status === Status.Processed ? { referenceTransactionId: 'internal-ref', processedAt: at } : {}) });
    expect(restored.status).toBe(status);
    expect(restored.referenceExternalTransactionId).toBe('external-ref');
    expect(restored.referenceTransactionId).toBe(status === Status.Processed ? 'internal-ref' : undefined);
    expect(restored.failureCode).toBe(failed ? FailureCode.InvalidReference : undefined);
  });

  test('rehydrate detects impossible persisted shapes', () => {
    for (const state of [
      { ...transactionProps(), status: Status.Processed },
      { ...transactionProps(), status: Status.Rejected },
      { ...transactionProps(), status: Status.Pending, failureCode: FailureCode.InvalidReference },
      { ...transactionProps(), status: Status.Pending, processedAt: at },
      { ...transactionProps(), status: Status.PendingReference },
      { ...transactionProps(), status: Status.Processed, processedAt: at, referenceTransactionId: 'unexpected' },
      { ...transactionProps({ kind: Kind.Refund, referenceExternalTransactionId: 'ref' }), status: Status.Processed, processedAt: at },
    ]) {
      expectCode(() => WagerTransaction.rehydrate(state), FailureCode.InvalidTransactionState);
    }
  });
});

describe('explicit transaction transitions', () => {
  test('PENDING_REFERENCE can wait again, then process with the resolved internal id', () => {
    const tx = reversal();
    tx.markPendingReference();
    tx.markPendingReference();
    expect(tx.status).toBe(Status.PendingReference);
    expect(tx.isTerminal()).toBe(false);
    tx.markProcessed('ref-id', at);
    expect(tx.status).toBe(Status.Processed);
    expect(tx.referenceTransactionId).toBe('ref-id');
    expect(tx.processedAt).toEqual(at);
  });

  test.each([Status.Pending, Status.PendingReference])('%s can reject or fail', (status) => {
    const rejected = WagerTransaction.rehydrate({ ...transactionProps({ kind: Kind.Refund,
      referenceExternalTransactionId: 'ref' }), status });
    rejected.reject(FailureCode.ReferenceNotFound);
    expect(rejected.failureCode).toBe(FailureCode.ReferenceNotFound);
    const failed = WagerTransaction.rehydrate({ ...transactionProps({ kind: Kind.Refund,
      referenceExternalTransactionId: 'ref' }), status });
    failed.fail(FailureCode.PermanentInfrastructureFailure);
    expect(failed.status).toBe(Status.Failed);
  });

  test.each([Status.Processed, Status.Rejected, Status.Failed])('%s blocks every transition, including repeats', (status) => {
    const tx = WagerTransaction.rehydrate({ ...transactionProps(), status,
      ...(status === Status.Processed ? { processedAt: at } : { failureCode: FailureCode.InsufficientBalance }) });
    for (const action of [() => tx.markProcessed(undefined, at), () => tx.markPendingReference(),
      () => tx.reject(FailureCode.InvalidReference), () => tx.fail(FailureCode.PermanentInfrastructureFailure)]) {
      expect(action).toThrow(InvalidTransactionStateError);
      expectCode(action, FailureCode.InvalidTransactionState);
      expect(tx.status).toBe(status);
    }
  });

  test('invalid transitions are atomic and dates cannot mutate entity state', () => {
    const date = new Date(at);
    const tx = transaction({ createdAt: date });
    expectCode(() => tx.markPendingReference(), FailureCode.InvalidTransactionState);
    expectCode(() => tx.markProcessed('unrequested-ref', at), FailureCode.InvalidReference);
    expectCode(() => tx.markProcessed(undefined, new Date('invalid')), FailureCode.InvalidTransactionState);
    expect(tx.status).toBe(Status.Pending);
    tx.markProcessed(undefined, date);
    date.setUTCFullYear(2000);
    tx.createdAt.setUTCFullYear(2001);
    tx.processedAt!.setUTCFullYear(2002);
    expect(tx.createdAt).toEqual(at);
    expect(tx.processedAt).toEqual(at);
    expectCode(() => reversal().markProcessed(undefined, at), FailureCode.InvalidReference);
  });
});
