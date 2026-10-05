import { expect } from 'bun:test';
import { DomainError } from '../../../src/domain/domain-error';
import { FailureCode } from '../../../src/domain/failure-code';
import { Money } from '../../../src/domain/money';
import { Wallet } from '../../../src/domain/wallet';
import { CreateWagerTransactionProps, WagerTransaction, WagerTransactionKind as Kind } from '../../../src/domain/wager-transaction';

export const at = new Date('2026-10-05T12:00:00.000Z');
export const money = (amount: string, currency = 'BRL') => Money.from({ amount, currency });
export const wallet = (amount = '100.00') => Wallet.open({
  id: 'wallet-1', playerId: 'player-1', initialBalance: money(amount), at,
});
export const transactionProps = (overrides: Partial<CreateWagerTransactionProps> = {}): CreateWagerTransactionProps => ({
  id: 'tx-1', providerId: 'provider-1', externalTransactionId: 'external-1', idempotencyKey: 'provider-1:external-1',
  payloadHash: 'payload-hash', walletId: 'wallet-1', playerId: 'player-1', roundId: 'round-1', gameId: 'game-1',
  kind: Kind.Bet, money: money('25.00'), createdAt: at, ...overrides,
});
export const transaction = (overrides: Partial<CreateWagerTransactionProps> = {}) => WagerTransaction.create(transactionProps(overrides));
export const reference = (kind = Kind.Bet, amount = '25.00') => {
  const tx = transaction({ id: 'ref-1', externalTransactionId: 'ref-external', kind, money: money(amount),
    ...(kind === Kind.Refund ? { referenceExternalTransactionId: 'original-bet' } : {}) });
  tx.markProcessed(kind === Kind.Refund ? 'original-bet-id' : undefined, at);
  return tx;
};
export const reversal = (kind = Kind.Refund, amount = '25.00') => transaction({
  kind, money: money(amount), referenceExternalTransactionId: 'ref-external',
});

export function expectCode(action: () => unknown, code: FailureCode): void {
  let error: unknown;
  try { action(); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(DomainError);
  expect((error as DomainError).code).toBe(code);
}
