import { describe, expect, test } from 'bun:test';
import { Wallet, WalletState } from '../../../src/domain/wallet';
import { LedgerDirection as Direction, LedgerEntryState, WalletLedgerEntry } from '../../../src/domain/wallet-ledger-entry';
import { FailureCode } from '../../../src/domain/failure-code';
import { at, expectCode, money, wallet } from './fixtures';

const walletState = (): WalletState => ({ id: 'wallet-1', playerId: 'player-1', currency: 'BRL',
  balance: money('40.00'), version: 7, createdAt: at, updatedAt: at });
const entryState = (): LedgerEntryState => ({ id: 'entry-1', walletId: 'wallet-1', transactionId: 'tx-1',
  direction: Direction.Debit, money: money('25.00'), balanceBefore: money('100.00'), balanceAfter: money('75.00'), createdAt: at });

describe('Wallet aggregate', () => {
  test('opens at version 1 and exposes the opening credit without incrementing', () => {
    const aggregate = wallet();
    expect(aggregate.version).toBe(1);
    expect(aggregate.balance.toString()).toBe('100.00');
    expect(aggregate.openingMovement?.balanceBefore.toString()).toBe('0.00');
    expect(aggregate.openingMovement?.walletVersion).toBe(1);
    expect(aggregate.openingMovement?.direction).toBe(Direction.Credit);
    const entry = WalletLedgerEntry.create({ ...aggregate.openingMovement!, id: 'opening-entry', transactionId: 'opening', createdAt: at });
    expect(entry.isBalanced()).toBe(true);
    expect(wallet('0.00').openingMovement).toBeUndefined();
  });

  test('debit and credit snapshots produce a consistent ledger and preserve previous facts', () => {
    const aggregate = wallet();
    const debit = aggregate.debit(money('25.00'), at)!;
    const first = WalletLedgerEntry.create({ ...debit, id: 'entry-1', transactionId: 'bet', createdAt: at });
    const credit = aggregate.credit(money('10.00'), at)!;
    const second = WalletLedgerEntry.create({ ...credit, id: 'entry-2', transactionId: 'win', createdAt: at });
    expect(first.direction).toBe(Direction.Debit);
    expect(second.direction).toBe(Direction.Credit);
    expect(first.balanceAfter.equals(second.balanceBefore)).toBe(true);
    expect(aggregate.balance.toString()).toBe('85.00');
    expect(aggregate.version).toBe(3);
    expect(debit.walletVersion).toBe(2);
    expect(debit.balanceAfter.toString()).toBe('75.00');
    expect(Object.isFrozen(debit)).toBe(true);
    expect(first.isBalanced() && second.isBalanced()).toBe(true);
  });

  test('zero does not change balance, version or timestamp; exact debit can reach zero', () => {
    const aggregate = wallet();
    const later = new Date('2026-10-06T12:00:00Z');
    expect(aggregate.credit(money('0.00'), later)).toBeUndefined();
    expect(aggregate.debit(money('0.00'), later)).toBeUndefined();
    expect(aggregate.version).toBe(1);
    expect(aggregate.updatedAt).toEqual(at);
    aggregate.debit(money('100.00'));
    expect(aggregate.balance.isZero()).toBe(true);
    expect(aggregate.version).toBe(2);
  });

  test('rejected movements leave all aggregate state unchanged', () => {
    const aggregate = wallet();
    for (const action of [() => aggregate.debit(money('100.01')), () => aggregate.credit(money('1.00'), new Date('invalid'))]) {
      expect(action).toThrow();
      expect(aggregate.balance.toString()).toBe('100.00');
      expect(aggregate.version).toBe(1);
      expect(aggregate.updatedAt).toEqual(at);
    }
    expectCode(() => aggregate.debit(money('100.01')), FailureCode.InsufficientBalance);
    expectCode(() => aggregate.credit(money('1.00').negate()), FailureCode.InvalidAmount);
    expectCode(() => aggregate.debit(money('1.00').negate()), FailureCode.InvalidAmount);
    expectCode(() => aggregate.credit(money('0.00', 'USD')), FailureCode.CurrencyMismatch);
    expectCode(() => aggregate.debit(money('1.00', 'USD')), FailureCode.CurrencyMismatch);
  });

  test('rehydrate preserves persisted version and has no new opening movement', () => {
    const aggregate = Wallet.rehydrate(walletState());
    expect(aggregate.version).toBe(7);
    expect(aggregate.balance.toString()).toBe('40.00');
    expect(aggregate.openingMovement).toBeUndefined();
    aggregate.credit(money('0.01'));
    expect(aggregate.version).toBe(8);
  });

  test('factories reject negative balances, mismatched currency and invalid versions', () => {
    expectCode(() => Wallet.open({ id: 'w', playerId: 'p', initialBalance: money('1.00').negate() }), FailureCode.InvalidWalletState);
    expectCode(() => Wallet.rehydrate({ ...walletState(), balance: money('1.00').negate() }), FailureCode.InvalidWalletState);
    expectCode(() => Wallet.rehydrate({ ...walletState(), currency: 'USD' }), FailureCode.CurrencyMismatch);
    for (const version of [0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expectCode(() => Wallet.rehydrate({ ...walletState(), version }), FailureCode.InvalidWalletState);
    }
    const exhausted = Wallet.rehydrate({ ...walletState(), version: Number.MAX_SAFE_INTEGER });
    expectCode(() => exhausted.credit(money('1.00')), FailureCode.InvalidWalletState);
    expect(exhausted.balance.toString()).toBe('40.00');
  });

  test('date inputs and getters cannot mutate the wallet', () => {
    const date = new Date(at);
    const aggregate = Wallet.open({ id: 'w', playerId: 'p', initialBalance: money('0.00'), at: date });
    date.setUTCFullYear(2000);
    aggregate.createdAt.setUTCFullYear(2001);
    aggregate.updatedAt.setUTCFullYear(2002);
    expect(aggregate.createdAt).toEqual(at);
    expect(aggregate.updatedAt).toEqual(at);
  });
});

describe('immutable WalletLedgerEntry', () => {
  test('create and rehydrate preserve balanced facts and isolate timestamps', () => {
    const date = new Date(at);
    const entry = WalletLedgerEntry.create({ ...entryState(), createdAt: date });
    const restored = WalletLedgerEntry.rehydrate(entryState());
    expect(entry.isBalanced()).toBe(true);
    expect(restored.balanceAfter.toString()).toBe('75.00');
    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => Object.assign(entry, { direction: Direction.Credit })).toThrow();
    date.setUTCFullYear(2000);
    entry.createdAt.setUTCFullYear(2001);
    expect(entry.createdAt).toEqual(at);
  });

  test.each([WalletLedgerEntry.create, WalletLedgerEntry.rehydrate])('rejects corrupt facts with either factory', (factory) => {
    expectCode(() => factory({ ...entryState(), balanceAfter: money('74.99') }), FailureCode.InvalidLedgerEntry);
    expectCode(() => factory({ ...entryState(), money: money('0.00') }), FailureCode.InvalidLedgerEntry);
    expectCode(() => factory({ ...entryState(), money: money('1.00').negate() }), FailureCode.InvalidLedgerEntry);
    expectCode(() => factory({ ...entryState(), balanceAfter: money('1.00').negate() }), FailureCode.InvalidLedgerEntry);
    expectCode(() => factory({ ...entryState(), direction: 'OTHER' as Direction }), FailureCode.InvalidLedgerEntry);
    expectCode(() => factory({ ...entryState(), money: money('25.00', 'USD') }), FailureCode.CurrencyMismatch);
    expectCode(() => factory({ ...entryState(), balanceAfter: money('75.00', 'USD') }), FailureCode.CurrencyMismatch);
    expectCode(() => factory({ ...entryState(), id: '' }), FailureCode.InvalidLedgerEntry);
  });

  test('validates credit arithmetic', () => {
    const entry = WalletLedgerEntry.create({ ...entryState(), direction: Direction.Credit, balanceAfter: money('125.00') });
    expect(entry.isBalanced()).toBe(true);
    expectCode(() => WalletLedgerEntry.create({ ...entryState(), direction: Direction.Credit }), FailureCode.InvalidLedgerEntry);
  });
});
