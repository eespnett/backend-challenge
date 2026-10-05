import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { canonicalWagerPayload, validateWagerRequest, wagerPayloadHash } from '../../src/application/wager-request';
import { isTransientDatabaseError } from '../../src/infrastructure/persistence/mikro-orm-transaction-manager';

const body = { walletId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', providerId: 'provider-a',
  playerId: 'player-1', kind: 'BET', money: { currency: 'BRL', amount: '25.00' },
  roundId: 'round-1', gameId: 'game-1', externalTransactionId: 'tx-123' };

describe('canonical wager contract', () => {
  test('exact canonical JSON and SHA-256 ignore object order and idempotency key', () => {
    const request = validateWagerRequest(body, 'key-1');
    const json = '{"externalTransactionId":"tx-123","gameId":"game-1","kind":"BET","money":{"amount":"25.00","currency":"BRL"},"playerId":"player-1","providerId":"provider-a","referenceExternalTransactionId":null,"roundId":"round-1","walletId":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
    expect(canonicalWagerPayload(request)).toBe(json);
    expect(wagerPayloadHash(request)).toBe(createHash('sha256').update(json).digest('hex'));
    const reordered = Object.fromEntries(Object.entries(body).reverse());
    expect(wagerPayloadHash(validateWagerRequest(reordered, 'another-key'))).toBe(wagerPayloadHash(request));
    expect(wagerPayloadHash(validateWagerRequest({ ...body, walletId: body.walletId.toUpperCase() }, 'key'))).toBe(wagerPayloadHash(request));
  });
  test('every business field affects the hash', () => {
    const original = wagerPayloadHash(validateWagerRequest(body, 'key'));
    for (const [field, value] of Object.entries({ externalTransactionId: 'other', gameId: 'other', kind: 'WIN',
      playerId: 'other', providerId: 'other', roundId: 'other', walletId: crypto.randomUUID(),
      referenceExternalTransactionId: 'reference', money: { amount: '26.00', currency: 'BRL' } })) {
      const kind = field === 'referenceExternalTransactionId' ? 'WIN' : body.kind;
      expect(wagerPayloadHash(validateWagerRequest({ ...body, kind, [field]: value }, 'key'))).not.toBe(original);
    }
    expect(wagerPayloadHash(validateWagerRequest({ ...body, money: { amount: '25.00', currency: 'USD' } }, 'key'))).not.toBe(original);
  });
  test.each([undefined, null, '', ' ', ' key', 'key ', 'key, other', ['key'], 'é', 'x'.repeat(201)]
    .map((key) => ({ key })))('invalid key %j', ({ key }) => {
    expect(() => validateWagerRequest(body, key)).toThrow();
  });
  test.each(['', '-1.00', '1e2', 'NaN', 'Infinity', '1.001', '1', '01.00', '1.0', 1.00])('invalid money %j', (amount) => {
    expect(() => validateWagerRequest({ ...body, money: { amount, currency: 'BRL' } }, 'key')).toThrow();
  });
  test.each([null, [], {}, { ...body, kind: 'OPENING' }, { ...body, providerId: 'internal' },
    { ...body, walletId: 'bad' }, { ...body, extra: true }, { ...body, referenceExternalTransactionId: null },
    { ...body, playerId: ' ' }, { ...body, playerId: 'embedded\u0000null' },
    { ...body, money: { ...body.money, extra: true } }].map((payload) => ({ payload })))('invalid payload %j', ({ payload }) => {
    expect(() => validateWagerRequest(payload, 'key')).toThrow();
  });
  test('large amounts remain exact strings', () => {
    const amount = '9007199254740993123456789.99';
    expect(canonicalWagerPayload(validateWagerRequest({ ...body, money: { amount, currency: 'BRL' } }, 'key'))).toContain(`"amount":"${amount}"`);
  });
});

test('only transient database failures map to unavailable; unique/business errors do not', () => {
  for (const code of ['40001','40P01','55P03','57014','08006','57P01','ECONNREFUSED','ETIMEDOUT']) {
    expect(isTransientDatabaseError(Object.assign(new Error(), { code }))).toBe(true);
  }
  for (const code of ['23505','23514','23503','P0001','55000']) {
    expect(isTransientDatabaseError(Object.assign(new Error(), { code }))).toBe(false);
  }
});
