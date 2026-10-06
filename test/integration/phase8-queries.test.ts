import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { phase8Harness } from '../support/phase8-harness';
import { processWagerBody } from '../support/process-harness';
import { decodeLedgerCursor, encodeLedgerCursor } from '../../src/application/ledger-cursor';
import { WagerConsumer } from '../../src/infrastructure/messaging/wager-consumer';
import { wagerEnvelope } from '../support/phase6-harness';
import { MikroOrmOutboxClaimStore } from '../../src/infrastructure/persistence/outbox-claim-store';
import { OutboxPublisher } from '../../src/application/outbox-publisher';

describe('Phase 8 queries, reconciliation and observability on PostgreSQL + LocalStack', () => {
  let h: Awaited<ReturnType<typeof phase8Harness>>;
  beforeEach(async () => { h = await phase8Harness(); });
  afterEach(async () => { await h.close(); });

  test('GET wallet preserves exact large decimal balance; missing resources return 404', async () => {
    const wallet = await h.wallet('9007199254740993.01');
    const response = await h.request(`/wallets/${wallet.id}`); expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: wallet.id, playerId: wallet.playerId, balance: { amount: '9007199254740993.01', currency: 'BRL' }, version: 1 });
    for (const path of [`/wallets/${crypto.randomUUID()}`, '/wallets/not-a-uuid', `/wallets/${crypto.randomUUID()}/ledger`,
      `/wallets/${crypto.randomUUID()}/reconciliation`, `/wagering/transactions/${crypto.randomUUID()}`,
      '/providers/absent/wagering/transactions/absent']) {
      expect((await h.request(path, path.endsWith('reconciliation') ? 'POST' : 'GET')).status).toBe(404);
    }
  });

  test('GET internal and provider/external identities return current transaction state without stored replay internals', async () => {
    const wallet = await h.wallet(); const body = processWagerBody(wallet); const result = await h.process.execute(body, crypto.randomUUID());
    const internal = await h.request(`/wagering/transactions/${result.body.transactionId}`); expect(internal.status).toBe(200);
    const transaction = await internal.json();
    expect(transaction).toMatchObject({ transactionId: result.body.transactionId, providerId: body.providerId, externalTransactionId: body.externalTransactionId,
      walletId: wallet.id, status: 'PROCESSED', kind: 'BET', money: { amount: '25.00', currency: 'BRL' } });
    const external = await h.request(`/providers/${body.providerId}/wagering/transactions/${body.externalTransactionId}`);
    expect(external.status).toBe(200); expect(await external.json()).toEqual(transaction);
    expect(transaction).not.toHaveProperty('idempotencyKey'); expect(transaction).not.toHaveProperty('payloadHash'); expect(transaction).not.toHaveProperty('resultBody');
    expect((await h.request(`/providers/other/wagering/transactions/${body.externalTransactionId}`)).status).toBe(404);
  });

  test('ledger keyset pagination handles equal microsecond timestamps, inserts between pages and final empty page', async () => {
    await h.sql(`create function wagering.fixed_ledger_time() returns trigger language plpgsql as $$ begin
      new.created_at='2000-01-01T00:00:00.123456Z'; return new;end;$$;
      create trigger fixed_ledger_time before insert on wagering.wallet_ledger_entries for each row execute function wagering.fixed_ledger_time()`);
    const wallet = await h.wallet();
    for (let i = 0; i < 4; i++) await h.process.execute(processWagerBody(wallet, 'WIN', '1.00'), crypto.randomUUID());
    const expected = await h.sql<Array<{ id: string }>>('select id from wagering.wallet_ledger_entries where wallet_id=? order by created_at desc,id desc', [wallet.id]);
    const firstResponse = await h.request(`/wallets/${wallet.id}/ledger?limit=2`); expect(firstResponse.status).toBe(200);
    const first = await firstResponse.json() as { items: { id: string }[]; nextCursor: string };
    expect(decodeLedgerCursor(first.nextCursor, wallet.id)?.createdAt).toBe('2000-01-01T00:00:00.123456Z');
    await h.sql('drop trigger fixed_ledger_time on wagering.wallet_ledger_entries;drop function wagering.fixed_ledger_time()');
    await h.process.execute(processWagerBody(wallet, 'WIN', '2.00'), crypto.randomUUID());
    const ids = first.items.map((item) => item.id); let cursor: string | null = first.nextCursor;
    while (cursor) {
      const response = await h.request(`/wallets/${wallet.id}/ledger?limit=2&cursor=${cursor}`); expect(response.status).toBe(200);
      const page = await response.json() as { items: { id: string }[]; nextCursor: string | null };
      ids.push(...page.items.map((item) => item.id)); cursor = page.nextCursor;
    }
    expect(ids).toEqual(expected.map((row) => row.id)); expect(new Set(ids).size).toBe(5);
    const emptyWallet = await h.wallet('0.00');
    expect(await (await h.request(`/wallets/${emptyWallet.id}/ledger`)).json()).toEqual({ items: [], nextCursor: null });
    expect((await (await h.request(`/wallets/${wallet.id}/ledger`)).json() as { items: unknown[] }).items).toHaveLength(6);
  });

  test('invalid cursors, cross-wallet cursors and invalid limits return 400', async () => {
    const wallet = await h.wallet(); await h.process.execute(processWagerBody(wallet), crypto.randomUUID());
    const yearZero = encodeLedgerCursor({ version: 1, walletId: wallet.id, id: crypto.randomUUID(), createdAt: '0000-01-01T00:00:00.000000Z' });
    for (const query of ['cursor=!', 'cursor=', `cursor=${yearZero}`, 'cursor=a&cursor=b', 'limit=0', 'limit=101', 'limit=2.5', 'limit=1&limit=2']) {
      expect((await h.request(`/wallets/${wallet.id}/ledger?${query}`)).status).toBe(400);
    }
    const { nextCursor } = await (await h.request(`/wallets/${wallet.id}/ledger?limit=1`)).json() as { nextCursor: string };
    const other = await h.wallet(); expect((await h.request(`/wallets/${other.id}/ledger?cursor=${nextCursor}`)).status).toBe(400);
  });

  test('reconciliation includes OPENING, debits and credits and never repairs a simulated divergence', async () => {
    const wallet = await h.wallet(); await h.process.execute(processWagerBody(wallet), crypto.randomUUID());
    await h.process.execute(processWagerBody(wallet, 'WIN', '5.00'), crypto.randomUUID());
    const path = `/wallets/${wallet.id}/reconciliation`;
    const response = await h.request(path, 'POST'); expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ walletId: wallet.id, storedBalance: { amount: '80.00', currency: 'BRL' },
      calculatedBalance: { amount: '80.00', currency: 'BRL' }, difference: { amount: '0.00', currency: 'BRL' }, consistent: true, checkedEntries: 3 });
    const history = await h.sql('select * from wagering.wallet_ledger_entries order by id');
    await h.sql('update wagering.wallets set balance=balance-1 where id=?', [wallet.id]);
    const divergent = await h.request(path, 'POST', undefined, { 'x-correlation-id': 'reconcile-test' });
    expect(await divergent.json()).toMatchObject({ storedBalance: { amount: '79.00', currency: 'BRL' }, calculatedBalance: { amount: '80.00', currency: 'BRL' },
      difference: { amount: '-1.00', currency: 'BRL' }, consistent: false, checkedEntries: 3 });
    expect(await h.sql('select * from wagering.wallet_ledger_entries order by id')).toEqual(history);
    expect((await (await h.request(`/wallets/${wallet.id}`)).json() as { balance: { amount: string } }).balance.amount).toBe('79.00');
    expect(h.lines.map((line) => JSON.parse(line))).toContainEqual(expect.objectContaining({ level: 'error', event: 'reconciliation_inconsistent', walletId: wallet.id, correlationId: 'reconcile-test' }));
    const metrics = await (await h.request('/metrics')).text(); expect(metrics).toContain('reconciliation_inconsistencies{source="reconciliation"} 1');
  });

  test('HTTP processing metrics and logs are emitted after commit without financial bodies or credentials', async () => {
    const wallet = await h.wallet(); const body = processWagerBody(wallet); const key = crypto.randomUUID();
    for (let i = 0; i < 2; i++) expect((await h.request('/wagering/transactions', 'POST', body,
      { 'idempotency-key': key, 'x-correlation-id': 'http-corr', authorization: 'Bearer private-token' })).status).toBe(200);
    const metrics = await h.request('/metrics'); expect(metrics.status).toBe(200); expect(metrics.headers.get('content-type')).toContain('text/plain');
    const text = await metrics.text(); expect(text).toContain('transactions_by_status{status="PROCESSED"} 2');
    expect(text).toContain('duplicates_detected{source="http"} 1'); expect(text).toContain('processing_latency_count{source="http"} 2');
    expect(Number(text.match(/^outbox_lag ([\d.]+)/m)?.[1])).toBeGreaterThanOrEqual(0);
    for (const name of ['retries_total', 'dlq_messages', 'lock_conflicts', 'reconciliation_inconsistencies']) expect(text).toContain(`# TYPE ${name}`);
    expect(h.lines.map((line) => JSON.parse(line))).toContainEqual(expect.objectContaining({ event: 'transaction_committed', correlationId: 'http-corr',
      transactionId: expect.any(String), walletId: wallet.id, providerId: body.providerId }));
    for (const line of h.lines) {
      expect(Object.keys(JSON.parse(line)).sort().every((key) => ['timestamp', 'level', 'event', 'correlationId', 'messageId', 'transactionId', 'walletId', 'providerId'].includes(key))).toBe(true);
      for (const secret of ['25.00', '100.00', 'wagering_local', 'private-token', 'idempotencyKey', 'payloadHash', 'balance', 'amount']) expect(line).not.toContain(secret);
    }
  });

  test('real SQS inbox replay, retry, DLQ and outbox retry are observable', async () => {
    const wallet = await h.wallet(); const consumer = new WagerConsumer(h.manager, h.process, h.sqs, h.telemetry);
    const body = processWagerBody(wallet); const envelope = wagerEnvelope(body);
    await h.queues.send(envelope); const first = (await h.queues.receive())!;
    expect(await consumer.handle(first, h.queues.queueUrl, h.queues.dlqUrl)).toBe('ACK');
    await h.queues.send(envelope); expect(await consumer.handle((await h.queues.receive())!, h.queues.queueUrl, h.queues.dlqUrl)).toBe('ACK');
    await h.queues.send('{invalid'); expect(await consumer.handle((await h.queues.receive())!, h.queues.queueUrl, h.queues.dlqUrl)).toBe('DLQ');
    await h.queues.send(wagerEnvelope(processWagerBody(wallet)));
    const failure = spyOn(h.manager, 'run').mockRejectedValue(new Error('database unavailable with credentials'));
    try { expect(await consumer.handle((await h.queues.receive())!, h.queues.queueUrl, h.queues.dlqUrl)).toBe('RETRY'); }
    finally { failure.mockRestore(); }
    const publisher = new OutboxPublisher(new MikroOrmOutboxClaimStore(h.orm), { send: async () => { throw new Error('SDK secret'); } }, 'metrics-test', 30000, h.telemetry);
    expect(await publisher.run()).toEqual(['RETRY', 'RETRY', 'RETRY', 'RETRY']);
    const metrics = await (await h.request('/metrics')).text();
    expect(metrics).toContain('duplicates_detected{source="sqs"} 1'); expect(metrics).toContain('retries_total{source="sqs"} 1');
    expect(metrics).toContain('retries_total{source="outbox"} 4'); expect(metrics).toContain('dlq_messages 1');
    expect(h.lines.map((line) => JSON.parse(line))).toContainEqual(expect.objectContaining({ event: 'transaction_committed', messageId: envelope.messageId,
      correlationId: envelope.messageId, walletId: wallet.id, providerId: body.providerId, transactionId: expect.any(String) }));
    expect(h.lines.join('\n')).not.toContain('SDK secret'); expect(h.lines.join('\n')).not.toContain('credentials');
  });

  test('query infrastructure failure becomes sanitized HTTP 503', async () => {
    const wallet = await h.wallet();
    const orm = h.app.get((await import('@mikro-orm/postgresql')).MikroORM);
    const broken = spyOn(orm.em.getConnection(), 'execute').mockRejectedValue(new Error('private connection string'));
    try {
      const response = await h.request(`/wallets/${wallet.id}`); expect(response.status).toBe(503);
      expect(await response.text()).not.toContain('private connection');
    } finally { broken.mockRestore(); }
  });
});
