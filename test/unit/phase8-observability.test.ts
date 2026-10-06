import 'reflect-metadata';
import { expect, test } from 'bun:test';
import { decodeLedgerCursor, encodeLedgerCursor, ledgerLimit } from '../../src/application/ledger-cursor';
import { TelemetryService } from '../../src/observability/telemetry.service';
import { JsonLogger } from '../../src/observability/json-logger';
import { NoopProviderIdentityAdapter } from '../../src/infrastructure/identity/noop-provider-identity';

test('cursor preserves microseconds, scopes wallets and validates version, timestamp and canonical base64url', () => {
  const walletId = crypto.randomUUID();
  const value = { version: 1 as const, walletId, createdAt: '2026-10-05T12:34:56.123456Z', id: crypto.randomUUID() };
  const encoded = encodeLedgerCursor(value);
  expect(decodeLedgerCursor(encoded, walletId)).toEqual(value);
  expect(decodeLedgerCursor(undefined, walletId)).toBeUndefined();
  for (const cursor of ['', '!', encoded + '=', [], 'x'.repeat(601),
    encodeLedgerCursor({ ...value, walletId: crypto.randomUUID() }),
    encodeLedgerCursor({ ...value, createdAt: '2026-02-30T12:34:56.123456Z' }),
    encodeLedgerCursor({ ...value, createdAt: '0000-01-01T00:00:00.000000Z' }),
    Buffer.from(JSON.stringify({ ...value, version: 2 })).toString('base64url'),
    Buffer.from(JSON.stringify({ ...value, extra: 'ignored?' })).toString('base64url')]) {
    expect(() => decodeLedgerCursor(cursor, walletId)).toThrow('Invalid ledger cursor');
  }
  expect(ledgerLimit(undefined)).toBe(50); expect(ledgerLimit('100')).toBe(100);
  for (const limit of ['0', '-1', '101', '01', '1.5', 'Infinity', '', ['1']]) expect(() => ledgerLimit(limit)).toThrow();
});

test('JSON telemetry only emits allowlisted identifiers and metrics never label by user IDs', () => {
  const lines: string[] = []; const telemetry = new TelemetryService((line) => lines.push(line));
  const context = { correlationId: 'corr', messageId: 'msg', transactionId: 'tx', walletId: 'wallet', providerId: 'provider',
    body: { money: { amount: '123.45', currency: 'BRL' } }, password: 'secret', payload: 'private', authorization: 'Bearer token' };
  telemetry.log('info', 'transaction_committed', context);
  expect(JSON.parse(lines[0]!)).toEqual({ timestamp: expect.any(String), level: 'info', event: 'transaction_committed',
    correlationId: 'corr', messageId: 'msg', transactionId: 'tx', walletId: 'wallet', providerId: 'provider' });
  telemetry.increment('duplicates_detected', 'wallet-ID'); telemetry.latency(0.1, 'http'); telemetry.latency(NaN, 'http');
  expect(telemetry.render()).toContain('duplicates_detected{source="unknown"} 1');
  expect(telemetry.render()).not.toContain('wallet-ID');
  expect(telemetry.render()).toContain('processing_latency_count{source="http"} 1');
  telemetry.log('warn', 'event_retry', { correlationId: 'evil\nline', walletId: 'x'.repeat(201) });
  expect(JSON.parse(lines[1]!)).not.toHaveProperty('correlationId');
});

test('explicit no-op identity adapter accepts development provider scope', async () => {
  expect(await new NoopProviderIdentityAdapter().assertProviderAccess('provider')).toBeUndefined();
});

test('framework logger does not serialize an infrastructure error or credential-bearing message', () => {
  const original = console.log; const lines: string[] = [];
  console.log = (line) => lines.push(String(line));
  try { new JsonLogger().error(new Error('postgres://user:secret@host payload=123.45')); }
  finally { console.log = original; }
  expect(JSON.parse(lines[0]!)).toMatchObject({ level: 'error', event: 'worker_or_framework_error' });
  expect(lines[0]).not.toContain('secret'); expect(lines[0]).not.toContain('123.45');
});
