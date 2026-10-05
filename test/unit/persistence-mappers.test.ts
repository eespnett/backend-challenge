import 'reflect-metadata';
import { expect, test } from 'bun:test';
import { Money } from '../../src/domain/money';
import { Wallet } from '../../src/domain/wallet';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../../src/domain/wager-transaction';
import { WalletLedgerEntry } from '../../src/domain/wallet-ledger-entry';
import { WalletMapper, WagerTransactionMapper, WalletLedgerEntryMapper } from '../../src/infrastructure/persistence/domain-mappers';
import { canonicalDecimal, ExactMoneyType } from '../../src/infrastructure/persistence/exact-money.type';
import { FailureCode } from '../../src/domain/failure-code';

const at = new Date('2026-10-05T12:00:00Z');

test('exact money type never loses a cent above safe integer range', () => {
  const type = new ExactMoneyType();
  expect(type.convertToJSValue('9007199254740993123456789.99')).toBe('9007199254740993123456789.99');
  expect(type.compareValues('9007199254740993.00', '9007199254740993.01')).toBe(false);
  expect(type.compareValues('100.0', '100.00')).toBe(true);
  expect(canonicalDecimal('100')).toBe('100.00');
  expect(canonicalDecimal('-0.00')).toBe('0.00');
  for (const invalid of ['1.001', '1e5', 'NaN', 'Infinity', '1.00\n']) expect(() => canonicalDecimal(invalid)).toThrow();
  expect(() => type.convertToJSValue(100 as unknown as string)).toThrow();
});

test('wallet mapper rehydrates exact Money and preserves version without reopening', () => {
  const wallet = Wallet.open({ id: crypto.randomUUID(), playerId: 'p', initialBalance: Money.from({
    amount: '9007199254740993123456789.99', currency: 'BRL' }), at });
  const entity = WalletMapper.toPersistence(wallet);
  expect(typeof entity.balance).toBe('string');
  const restored = WalletMapper.toDomain(entity);
  expect(restored.balance.equals(wallet.balance)).toBe(true);
  expect(restored.version).toBe(1);
  expect(restored.openingMovement).toBeUndefined();
  entity.balance = '10';
  expect(WalletMapper.toDomain(entity).balance.toString()).toBe('10.00');
});

test('OPENING and ledger mapper roundtrips use domain rehydrate factories', () => {
  const wallet = Wallet.open({ id: crypto.randomUUID(), playerId: 'p', initialBalance: Money.from({ amount: '10.00', currency: 'BRL' }), at });
  const tx = WagerTransaction.createOpening({ id: crypto.randomUUID(), walletId: wallet.id, playerId: wallet.playerId,
    money: wallet.balance, payloadHash: 'a'.repeat(64), createdAt: at });
  tx.markProcessed(undefined, at);
  const txEntity = WagerTransactionMapper.toPersistence(tx);
  const restoredTx = WagerTransactionMapper.toDomain(txEntity);
  expect(restoredTx.kind).toBe(WagerTransactionKind.Opening);
  expect(restoredTx.status).toBe(WagerTransactionStatus.Processed);
  expect(restoredTx.money.equals(tx.money)).toBe(true);
  expect(restoredTx.processedAt).toEqual(at);
  const entry = WalletLedgerEntry.create({ ...wallet.openingMovement!, id: crypto.randomUUID(), transactionId: tx.id, createdAt: at });
  const restoredEntry = WalletLedgerEntryMapper.toDomain(WalletLedgerEntryMapper.toPersistence(entry, tx.kind));
  expect(restoredEntry.isBalanced()).toBe(true);
  expect(restoredEntry.money.equals(entry.money)).toBe(true);
  expect(restoredEntry.createdAt).toEqual(at);
});

test('transaction mapper preserves resolved reference and failure codes', () => {
  const props = { id: crypto.randomUUID(), walletId: crypto.randomUUID(), playerId: 'p', providerId: 'provider',
    externalTransactionId: 'ref', idempotencyKey: 'key', payloadHash: 'b'.repeat(64), roundId: 'r', gameId: 'g',
    kind: WagerTransactionKind.Refund, referenceExternalTransactionId: 'bet',
    money: Money.from({ amount: '1.00', currency: 'BRL' }), createdAt: at };
  const processed = WagerTransaction.create(props);
  processed.markProcessed('internal-bet', at);
  expect(WagerTransactionMapper.toDomain(WagerTransactionMapper.toPersistence(processed)).referenceTransactionId).toBe('internal-bet');
  const rejected = WagerTransaction.create(props);
  rejected.reject(FailureCode.InvalidReference);
  const restored = WagerTransactionMapper.toDomain(WagerTransactionMapper.toPersistence(rejected));
  expect(restored.failureCode).toBe(FailureCode.InvalidReference);
  expect(restored.processedAt).toBeUndefined();
});
