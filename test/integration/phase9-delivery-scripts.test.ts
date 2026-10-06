import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { unlinkSync } from 'node:fs';
import { phase6Harness, wagerEnvelope } from '../support/phase6-harness';
import { processWagerBody } from '../support/process-harness';
import { assertLedgerConsistency } from '../support/assert-ledger-consistency';
import { wagerBody } from '../support/phase3-harness';

describe('Phase 9 delivery scripts use real PostgreSQL and SQS', () => {
  let h: Awaited<ReturnType<typeof phase6Harness>>;
  beforeEach(async () => { h = await phase6Harness(); });
  afterEach(async () => { try { await assertLedgerConsistency(h.orm); } finally { await h.close(); } });

  async function run(script: string, args: string[] = []) {
    const { database: db, sqs } = h.config;
    const child = Bun.spawn([process.execPath, resolve(__dirname, '../../scripts', script), ...args], {
      cwd: resolve(__dirname, '../..'), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
      env: { ...process.env, DB_HOST: db.host, DB_PORT: String(db.port), DB_NAME: db.dbName,
        DB_USER: db.user, DB_PASSWORD: db.password, SQS_ENDPOINT: sqs.endpoint, AWS_REGION: sqs.region,
        AWS_ACCESS_KEY_ID: sqs.accessKeyId, AWS_SECRET_ACCESS_KEY: sqs.secretAccessKey,
        SQS_TRANSACTION_QUEUE_NAME: h.queueName, SQS_DLQ_QUEUE_NAME: h.dlqName },
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { code, stdout, stderr };
  }

  test('concurrent/repeated seed preserves one OPENING and never resets an existing wallet balance', async () => {
    const seeds = await Promise.all([run('seed.ts'), run('seed.ts')]);
    expect(seeds.map((result) => result.code)).toEqual([0, 0]);
    const ids = seeds.map((result) => (JSON.parse(result.stdout) as { walletId: string }).walletId);
    expect(ids[0]).toBe(ids[1]);
    expect(await h.sql('select count(*)::text as count from wagering.wallets')).toEqual([{ count: '1' }]);
    const [row] = await h.sql<Array<{ id: string; player_id: string }>>('select id,player_id from wagering.wallets');
    const wallet = { id: row!.id, playerId: row!.player_id, balance: { amount: '100.00', currency: 'BRL' }, version: 1 };
    await h.process.execute(processWagerBody(wallet), crypto.randomUUID());
    expect((await run('seed.ts')).code).toBe(0);
    expect((await h.state(wallet.id)).balance).toBe('75.00');
    expect(await h.sql("select count(*)::text as count from wagering.wager_transactions where kind='OPENING'")).toEqual([{ count: '1' }]);
    expect(seeds[0]!.stdout).not.toContain('100.00'); expect(seeds[0]!.stdout).not.toContain('password');
  });

  test('send-wager defaults use seeded identity and the real consumer applies exactly one debit', async () => {
    expect((await run('seed.ts')).code).toBe(0);
    const sent = await run('send-wager.ts', ['--external-transaction-id', 'delivery-bet', '--idempotency-key', 'delivery-key']);
    expect(sent.code).toBe(0);
    expect(JSON.parse(sent.stdout)).toMatchObject({ event: 'wager_sent', providerId: 'demo-provider', externalTransactionId: 'delivery-bet' });
    expect(sent.stdout).not.toContain('25.00');
    const message = (await h.receive())!;
    expect(await h.consumer.handle(message, h.queueUrl, h.dlqUrl)).toBe('ACK');
    const { walletId } = JSON.parse(sent.stdout) as { walletId: string };
    expect((await h.state(walletId)).balance).toBe('75.00');
    expect(await h.sql("select count(*)::text as count from wagering.wallet_ledger_entries where direction='DEBIT'")).toEqual([{ count: '1' }]);
  });

  test('file submission preserves envelope identity and invalid money/options fail without sending financial bodies to logs', async () => {
    const wallet = await h.wallet();
    const file = join(tmpdir(), `wager-delivery-${crypto.randomUUID()}.json`);
    try {
      const envelope = wagerEnvelope(wagerBody(wallet));
      await Bun.write(file, JSON.stringify(envelope));
      const sent = await run('send-wager.ts', ['--file', file]); expect(sent.code).toBe(0);
      const message = (await h.receive())!; expect(message.Body).toBe(JSON.stringify(envelope));
      expect(await h.consumer.handle(message, h.queueUrl, h.dlqUrl)).toBe('ACK');
      await Bun.write(file, JSON.stringify({ ...envelope, data: { ...envelope.data, money: { amount: 123.45, currency: 'BRL' } } }));
      for (const args of [['--file', file], ['--file', file, '--amount', '1.00'], ['--not-an-option', 'secret-value']]) {
        const invalid = await run('send-wager.ts', args); expect(invalid.code).toBe(1);
        expect(invalid.stderr).not.toContain('123.45'); expect(invalid.stderr).not.toContain('secret-value');
        expect(invalid.stderr).toContain('send_wager_failed');
      }
      expect(await h.receive()).toBeUndefined();
    } finally { unlinkSync(file); }
  });
});
