import { describe, expect, test } from 'bun:test';
import { canonicalJson, messageIdentity, validateWagerEnvelope } from '../../src/application/wager-envelope';
import { retryVisibility } from '../../src/infrastructure/messaging/wager-consumer';

const body = { messageId: 'message-1', type: 'WagerTransactionRequested', occurredAt: '2026-10-05T12:00:00.000Z',
  data: { providerId: 'provider', externalTransactionId: 'external', idempotencyKey: 'key', playerId: 'player',
    walletId: '00000000-0000-0000-0000-000000000001', roundId: 'round', gameId: 'game', kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' } } };
describe('SQS envelope and retry', () => {
  test('reuses HTTP payload and decimal string validation', () => {
    const envelope = validateWagerEnvelope(JSON.stringify(body));
    expect(envelope.idempotencyKey).toBe('key');
    expect(envelope.body.money).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(envelope.body).not.toHaveProperty('idempotencyKey');
  });
  test('hash ignores JSON property order but includes transport envelope and key', () => {
    const original = messageIdentity(JSON.stringify(body), 'transport-1');
    expect(messageIdentity(canonicalJson(body), 'transport-2')).toEqual(original);
    expect(messageIdentity(JSON.stringify({ ...body, data: { ...body.data, idempotencyKey: 'another' } }), 'transport-1').hash).not.toBe(original.hash);
  });
  test.each(['', 'null', '[]', '{bad', JSON.stringify({ ...body, type: 'Unknown' }),
    JSON.stringify({ ...body, extra: true }), JSON.stringify({ ...body, occurredAt: '2026-02-30T12:00:00.000Z' })])('rejects malformed envelope: %s', (raw) => {
    expect(() => validateWagerEnvelope(raw)).toThrow('INVALID_ENVELOPE');
  });
  test.each(['', '1e3', 'NaN', 'Infinity', '-1.00', '1.001', 25])('rejects invalid amount: %j', (amount) => {
    expect(() => validateWagerEnvelope(JSON.stringify({ ...body, data: { ...body.data, money: { amount, currency: 'BRL' } } }))).toThrow('INVALID_PAYLOAD');
  });
  test('rejects internal OPENING', () => {
    expect(() => validateWagerEnvelope(JSON.stringify({ ...body, data: { ...body.data, kind: 'OPENING' } }))).toThrow('INVALID_PAYLOAD');
  });
  test('invalid JSON falls back to original SQS identity', () => {
    expect(messageIdentity('{bad', 'transport-1').messageId).toBe('transport:transport-1');
  });
  test('persistent transport retry backoff is bounded', () => {
    expect([1,2,3,4,5,6,99].map(retryVisibility)).toEqual([1,2,4,8,16,30,30]);
  });
});
