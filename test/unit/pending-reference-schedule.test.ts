import { expect, test } from 'bun:test';
import { pendingReferenceBackoffMs, pendingReferenceNextAttempt, PENDING_REFERENCE_TTL_MS } from '../../src/application/pending-reference-schedule';

test('pending reference backoff doubles from 1s and caps at 30s', () => {
  expect(Array.from({ length: 9 }, (_, attempt) => pendingReferenceBackoffMs(attempt)))
    .toEqual([1000,2000,4000,8000,16000,30000,30000,30000,30000]);
  expect(pendingReferenceBackoffMs(Number.MAX_SAFE_INTEGER)).toBe(30000);
  for (const invalid of [-1,0.1,NaN,Infinity]) expect(() => pendingReferenceBackoffMs(invalid)).toThrow();
});
test('TTL is 15 minutes and next retry never exceeds the persisted deadline', () => {
  expect(PENDING_REFERENCE_TTL_MS).toBe(900000);
  const now = new Date('2026-10-05T12:00:00Z');
  const expires = new Date(now.getTime()+5000);
  expect(pendingReferenceNextAttempt(now,expires,1).getTime()).toBe(now.getTime()+2000);
  expect(pendingReferenceNextAttempt(now,expires,20)).toEqual(expires);
  expect(pendingReferenceNextAttempt(expires,expires,0)).toEqual(expires);
});
