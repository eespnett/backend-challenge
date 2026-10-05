import { describe, expect, test } from 'bun:test';
import { WageringPolicy, WageringDecision, WageringContext } from '../../../src/domain/wagering-policy';
import { WagerTransaction, WagerTransactionKind as Kind, WagerTransactionStatus as Status } from '../../../src/domain/wager-transaction';
import { LedgerDirection as Direction, WalletLedgerEntry } from '../../../src/domain/wallet-ledger-entry';
import { Wallet } from '../../../src/domain/wallet';
import { FailureCode } from '../../../src/domain/failure-code';
import { at, expectCode, money, reference, reversal, transaction, transactionProps, wallet } from './fixtures';

function applyDecision(aggregate: Wallet, tx: WagerTransaction, context?: WageringContext): {
  decision: WageringDecision; entry: WalletLedgerEntry | undefined;
} {
  const decision = WageringPolicy.evaluate(aggregate, tx, context);
  if (decision.outcome !== 'APPLY') return { decision, entry: undefined };
  const change = decision.direction === Direction.Debit ? aggregate.debit(decision.money, at)
    : decision.direction === Direction.Credit ? aggregate.credit(decision.money, at) : undefined;
  const entry = change === undefined ? undefined : WalletLedgerEntry.create({ ...change,
    id: `entry-${tx.id}`, transactionId: tx.id, createdAt: at });
  tx.markProcessed(decision.referenceTransactionId, at);
  return { decision, entry };
}

const rejected = (failureCode: FailureCode) => ({ outcome: 'REJECT' as const, failureCode });

describe('WageringPolicy financial rules', () => {
  test('BET debits once, with a consistent ledger', () => {
    const aggregate = wallet();
    const tx = transaction();
    const result = applyDecision(aggregate, tx);
    expect(result.entry?.direction).toBe(Direction.Debit);
    expect(result.entry?.isBalanced()).toBe(true);
    expect(aggregate.balance.toString()).toBe('75.00');
    expect(aggregate.version).toBe(2);
    expect(tx.status).toBe(Status.Processed);
    expectCode(() => WageringPolicy.evaluate(aggregate, tx), FailureCode.InvalidTransactionState);
    expect(aggregate.balance.toString()).toBe('75.00');
  });

  test('insufficient BET balance rejects without mutation or ledger', () => {
    const aggregate = wallet('24.99');
    const tx = transaction();
    const result = applyDecision(aggregate, tx);
    expect(result.decision).toEqual(rejected(FailureCode.InsufficientBalance));
    expect(result.entry).toBeUndefined();
    expect(aggregate.balance.toString()).toBe('24.99');
    expect(aggregate.version).toBe(1);
    expect(tx.status).toBe(Status.Pending); // Policy itself performs no transitions.
    tx.reject(FailureCode.InsufficientBalance);
    expect(tx.status).toBe(Status.Rejected);
  });

  test('WIN credits; optional BET reference need not have equal amount', () => {
    for (const withReference of [false, true]) {
      const aggregate = wallet();
      const tx = transaction({ kind: Kind.Win, money: money('80.00'),
        ...(withReference ? { referenceExternalTransactionId: 'ref-external' } : {}) });
      const result = applyDecision(aggregate, tx, withReference ? { reference: reference() } : undefined);
      expect(result.entry?.direction).toBe(Direction.Credit);
      expect(aggregate.balance.toString()).toBe('180.00');
      expect(tx.referenceTransactionId).toBe(withReference ? 'ref-1' : undefined);
    }
  });

  test('LOSS records a processed result without changing balance, version or ledger', () => {
    const aggregate = wallet();
    const tx = transaction({ kind: Kind.Loss, money: money('999.00') });
    const result = applyDecision(aggregate, tx);
    expect(result.decision.outcome).toBe('APPLY');
    expect(result.entry).toBeUndefined();
    expect(tx.status).toBe(Status.Processed);
    expect(aggregate.balance.toString()).toBe('100.00');
    expect(aggregate.version).toBe(1);
  });

  test('REFUND restores a processed BET in full', () => {
    const aggregate = wallet('75.00');
    const tx = reversal();
    const result = applyDecision(aggregate, tx, { reference: reference() });
    expect(aggregate.balance.toString()).toBe('100.00');
    expect(result.entry?.direction).toBe(Direction.Credit);
    expect(result.entry?.isBalanced()).toBe(true);
    expect(tx.referenceTransactionId).toBe('ref-1');
  });

  test.each([Kind.Bet, Kind.Win, Kind.Refund])('ROLLBACK reverses processed %s', (kind) => {
    const aggregate = wallet('100.00');
    const result = applyDecision(aggregate, reversal(Kind.Rollback), { reference: reference(kind) });
    expect(result.entry?.direction).toBe(kind === Kind.Bet ? Direction.Credit : Direction.Debit);
    expect(result.entry?.isBalanced()).toBe(true);
    expect(aggregate.balance.toString()).toBe(kind === Kind.Bet ? '125.00' : '75.00');
  });

  test.each([Kind.Win, Kind.Refund])('ROLLBACK of %s cannot make the wallet negative', (kind) => {
    const aggregate = wallet('24.99');
    const result = applyDecision(aggregate, reversal(Kind.Rollback), { reference: reference(kind) });
    expect(result.decision).toEqual(rejected(FailureCode.ReversalInsufficientFunds));
    expect(result.entry).toBeUndefined();
    expect(aggregate.balance.toString()).toBe('24.99');
    expect(aggregate.version).toBe(1);
  });

  test('ROLLBACK credit may debit the exact remaining balance to zero', () => {
    const aggregate = wallet('25.00');
    const result = applyDecision(aggregate, reversal(Kind.Rollback), { reference: reference(Kind.Win) });
    expect(result.decision.outcome).toBe('APPLY');
    expect(aggregate.balance.isZero()).toBe(true);
  });

  test.each([Kind.Bet, Kind.Win, Kind.Loss])('zero-valued %s is processed without ledger or version change', (kind) => {
    const aggregate = wallet();
    const tx = transaction({ kind, money: money('0.00') });
    expect(applyDecision(aggregate, tx).entry).toBeUndefined();
    expect(aggregate.version).toBe(1);
    expect(aggregate.balance.toString()).toBe('100.00');
    expect(tx.status).toBe(Status.Processed);
  });

  test('opening is not applied twice to an already opened wallet', () => {
    const opening = WagerTransaction.createOpening({ id: 'opening', walletId: 'wallet-1', playerId: 'player-1',
      money: money('100.00'), payloadHash: 'hash', createdAt: at });
    expect(WageringPolicy.evaluate(wallet(), opening)).toEqual(rejected(FailureCode.OpeningInternalOnly));
  });

  test('wallet/player identity and currencies must match even for LOSS and zero amounts', () => {
    expect(WageringPolicy.evaluate(wallet(), transaction({ walletId: 'other' }))).toEqual(rejected(FailureCode.WalletMismatch));
    expect(WageringPolicy.evaluate(wallet(), transaction({ playerId: 'other' }))).toEqual(rejected(FailureCode.WalletMismatch));
    for (const kind of [Kind.Bet, Kind.Win, Kind.Loss]) {
      expect(WageringPolicy.evaluate(wallet(), transaction({ kind, money: money('0.00', 'USD') })))
        .toEqual(rejected(FailureCode.CurrencyMismatch));
    }
  });
});

describe('reference rules and duplicate reversals', () => {
  test.each([Kind.Refund, Kind.Rollback, Kind.Win])('%s with missing reference waits without mutation', (kind) => {
    const aggregate = wallet();
    const tx = reversal(kind);
    expect(WageringPolicy.evaluate(aggregate, tx)).toEqual({ outcome: 'PENDING_REFERENCE' });
    expect(tx.status).toBe(Status.Pending);
    expect(aggregate.version).toBe(1);
    tx.markPendingReference();
    expect(WageringPolicy.evaluate(aggregate, tx, { reference: reference() }).outcome).toBe('APPLY');
  });

  test.each([Status.Pending, Status.PendingReference])('a %s reference waits', (status) => {
    const ref = WagerTransaction.rehydrate({ ...transactionProps({ id: 'ref-1', externalTransactionId: 'ref-external',
      kind: status === Status.PendingReference ? Kind.Refund : Kind.Bet,
      ...(status === Status.PendingReference ? { referenceExternalTransactionId: 'original' } : {}) }), status });
    const tx = reversal(status === Status.PendingReference ? Kind.Rollback : Kind.Refund);
    expect(WageringPolicy.evaluate(wallet(), tx, { reference: ref })).toEqual({ outcome: 'PENDING_REFERENCE' });
  });

  test.each([Status.Rejected, Status.Failed])('a %s reference is invalid', (status) => {
    const ref = WagerTransaction.rehydrate({ ...transactionProps({ id: 'ref-1', externalTransactionId: 'ref-external' }),
      status, failureCode: FailureCode.InsufficientBalance });
    expect(WageringPolicy.evaluate(wallet(), reversal(), { reference: ref })).toEqual(rejected(FailureCode.InvalidReference));
  });

  test.each(['providerId', 'playerId', 'walletId', 'roundId', 'externalTransactionId'] as const)('rejects mismatched reference %s', (field) => {
    const ref = transaction({ id: 'ref-1', externalTransactionId: 'ref-external', [field]: 'different' });
    ref.markProcessed(undefined, at);
    expect(WageringPolicy.evaluate(wallet(), reversal(), { reference: ref })).toEqual(rejected(FailureCode.InvalidReference));
  });

  test('rejects reference currency mismatch, self reference and unexpected reference', () => {
    const ref = transaction({ id: 'ref-1', externalTransactionId: 'ref-external', money: money('25.00', 'USD') });
    ref.markProcessed(undefined, at);
    expect(WageringPolicy.evaluate(wallet(), reversal(), { reference: ref })).toEqual(rejected(FailureCode.CurrencyMismatch));
    const self = transaction({ id: 'tx-1', externalTransactionId: 'ref-external' });
    self.markProcessed(undefined, at);
    expect(WageringPolicy.evaluate(wallet(), reversal(), { reference: self })).toEqual(rejected(FailureCode.InvalidReference));
    expect(WageringPolicy.evaluate(wallet(), transaction(), { reference: reference() })).toEqual(rejected(FailureCode.InvalidReference));
  });

  test('allowed reference kinds are enforced for REFUND, WIN and ROLLBACK', () => {
    expect(WageringPolicy.evaluate(wallet(), reversal(), { reference: reference(Kind.Win) })).toEqual(rejected(FailureCode.InvalidReference));
    expect(WageringPolicy.evaluate(wallet(), reversal(Kind.Win), { reference: reference(Kind.Loss) })).toEqual(rejected(FailureCode.InvalidReference));
    expect(WageringPolicy.evaluate(wallet(), reversal(Kind.Rollback), { reference: reference(Kind.Loss) })).toEqual(rejected(FailureCode.InvalidReference));
    const nested = reversal(Kind.Rollback);
    nested.markProcessed('some-ref', at);
    const tx = transaction({ kind: Kind.Rollback, referenceExternalTransactionId: nested.externalTransactionId, id: 'new' });
    expect(WageringPolicy.evaluate(wallet(), tx, { reference: nested })).toEqual(rejected(FailureCode.InvalidReference));
  });

  test.each([Kind.Refund, Kind.Rollback])('%s rejects partial or excessive amounts', (kind) => {
    for (const amount of ['24.99', '25.01']) {
      expect(WageringPolicy.evaluate(wallet(), reversal(kind, amount), { reference: reference() }))
        .toEqual(rejected(FailureCode.ReferenceAmountMismatch));
    }
  });

  test.each([Kind.Refund, Kind.Rollback])('%s rejects a second processed reversal of the same type', (kind) => {
    const previous = transaction({ kind, id: 'previous', referenceExternalTransactionId: 'ref-external' });
    previous.markProcessed('ref-1', at);
    expect(WageringPolicy.evaluate(wallet(), reversal(kind), { reference: reference(), processedReversals: [previous] }))
      .toEqual(rejected(FailureCode.DuplicateReversal));
  });

  test('duplicate scope is reference + kind, and excludes unsuccessful reversals', () => {
    const otherKind = reversal(Kind.Rollback);
    otherKind.markProcessed('ref-1', at);
    const otherRef = reversal();
    otherRef.markProcessed('different-ref', at);
    const rejectedTx = reversal();
    rejectedTx.reject(FailureCode.InvalidReference);
    const pending = reversal();
    expect(WageringPolicy.evaluate(wallet(), reversal(), { reference: reference(),
      processedReversals: [otherKind, otherRef, rejectedTx, pending] }).outcome).toBe('APPLY');
  });
});
