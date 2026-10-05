import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { parallelRequests, boundedRequests, deferred, reportScenario } from '../support/concurrency-helpers';
import { processHarness, processWagerBody } from '../support/process-harness';
import { ProcessWagerTransactionUseCase } from '../../src/application/process-wager-transaction';
import { TransactionManager } from '../../src/application/financial-unit-of-work';
import { MikroOrmTransactionManager } from '../../src/infrastructure/persistence/mikro-orm-transaction-manager';
import { ProcessingConflictError } from '../../src/application/processing-errors';

let h: Awaited<ReturnType<typeof processHarness>>;
beforeAll(async () => { h = await processHarness(3); });
afterEach(async () => { if (h) await h.assertConsistent(); });
afterAll(async () => { if (h) await h.close(); });

describe('three real Bun application processes sharing PostgreSQL', () => {
  test('distinct processes, ports and database connections are simultaneously alive', async () => {
    const started = performance.now();
    const instances = h.instances();
    expect(instances).toHaveLength(3);
    expect(new Set(instances.map((p) => p.pid)).size).toBe(3);
    expect(instances.every((p) => p.pid !== process.pid)).toBe(true);
    expect(new Set(instances.map((p) => p.url)).size).toBe(3);
    expect(new Set(instances.map((p) => p.dbName))).toEqual(new Set([h.config.database.dbName]));
    const responses = await Promise.all(instances.map((p) => fetch(`${p.url}/health/ready`)));
    expect(responses.every((r) => r.status === 200)).toBe(true);
    const connections = await h.sql<Array<{ count: string }>>(`select count(*)::text from pg_stat_activity
      where datname=current_database() and pid<>pg_backend_pid()`);
    expect(BigInt(connections[0]!.count) >= 3n).toBe(true);
    reportScenario('three-processes', started, { pids: instances.map((p) => p.pid), database: h.config.database.dbName });
  });

  test('50 simultaneous identical submissions have one effect and 49 replays across all three processes', async () => {
    const wallet = await h.wallet();
    const body = processWagerBody(wallet, 'BET', '80.00');
    const key = crypto.randomUUID();
    const started = performance.now();
    const results = await parallelRequests(50, (i) => h.post(body, key, i));
    expect(new Set(results.map((r) => r.pid)).size).toBe(3);
    expect(results.filter((r) => r.httpStatus !== 200).map(({ httpStatus, body }) => ({ httpStatus, body }))).toEqual([]);
    expect(results.every((r) => r.body.status === 'PROCESSED')).toBe(true);
    expect(results.filter((r) => !r.body.idempotentReplay)).toHaveLength(1);
    expect(results.filter((r) => r.body.idempotentReplay)).toHaveLength(49);
    expect(new Set(results.map((r) => r.body.transactionId)).size).toBe(1);
    expect(results.every((r) => r.body.balance.amount === '20.00')).toBe(true);
    expect(await h.state(wallet.id)).toEqual({ balance: '20.00', version: '2', transactions: '2', ledger: '2', outbox: '4' });
    expect(await h.sql("select amount::text from wagering.wallet_ledger_entries where wallet_id=? and direction='DEBIT'", [wallet.id]))
      .toEqual([{ amount: '80.00' }]);
    reportScenario('50-identical', started, { requests: 50, processed: 1, replays: 49, balance: '20.00', debits: 1 });
  });

  test('50 different keys sharing external identity accept once and conflict 49 times', async () => {
    const wallet = await h.wallet();
    const body = processWagerBody(wallet, 'BET', '80.00');
    const started = performance.now();
    const results = await parallelRequests(50, (i) => h.post(body, crypto.randomUUID(), i));
    expect(new Set(results.map((r) => r.pid)).size).toBe(3);
    expect(results.filter((r) => r.httpStatus === 200)).toHaveLength(1);
    const conflicts = results.filter((r) => r.httpStatus === 409);
    expect(conflicts).toHaveLength(49);
    expect(conflicts.every((r) => r.body.failureCode === 'EXTERNAL_TRANSACTION_CONFLICT')).toBe(true);
    expect(await h.state(wallet.id)).toEqual({ balance: '20.00', version: '2', transactions: '2', ledger: '2', outbox: '4' });
    reportScenario('50-external-collisions', started, { accepted: 1, conflicts: 49, balance: '20.00' });
  });

  test.each([false, true])('commit between key and external SELECTs respects payload hash; divergent=%j', async (divergent) => {
    const wallet = await h.wallet();
    const body = processWagerBody(wallet);
    const key = crypto.randomUUID();
    const reached = deferred<void>();
    const release = deferred<void>();
    let firstRead = true;
    // Only pause a real SQL read. A separate application process commits the
    // winner while this READ COMMITTED transaction remains open.
    const manager = new MikroOrmTransactionManager(h.orm);
    const paused: TransactionManager = { run: (work) => manager.run((uow) => work({ ...uow,
      transactions: new Proxy(uow.transactions, { get(target, property) {
        if (property === 'findSubmissionByIdempotencyKey') return async (id: string) => {
          const result = await target.findSubmissionByIdempotencyKey(id);
          if (firstRead) { firstRead = false; expect(result).toBeUndefined(); reached.resolve(); await release.promise; }
          return result;
        };
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      } }),
    })) };
    const racedBody = divergent ? { ...body, money: { amount: '26.00', currency: 'BRL' } } : body;
    const raced = new ProcessWagerTransactionUseCase(paused).execute(racedBody, key);
    // Record errors immediately, then inspect them after releasing the real SQL read.
    const outcome = raced.then((result) => ({ result, error: undefined }), (error: unknown) => ({ result: undefined, error }));
    let original;
    try {
      await reached.promise;
      original = await h.post(body, key, 2);
      expect(original.httpStatus).toBe(200);
    } finally { release.resolve(); }
    const replay = await outcome;
    if (divergent) {
      expect(replay.error).toBeInstanceOf(ProcessingConflictError);
      expect((replay.error as ProcessingConflictError).code).toBe('IDEMPOTENCY_CONFLICT');
    } else {
      expect(replay.error).toBeUndefined();
      expect(replay.result!.httpStatus).toBe(200);
      expect(replay.result!.body as unknown).toEqual({ ...original.body, idempotentReplay: true });
    }
    expect(await h.state(wallet.id)).toEqual({ balance: '75.00', version: '2', transactions: '2', ledger: '2', outbox: '4' });
  });

  test('two BETs of 80 on 100 across different processes cannot overspend', async () => {
    const wallet = await h.wallet();
    const bodies = [processWagerBody(wallet, 'BET', '80.00'), processWagerBody(wallet, 'BET', '80.00')];
    const keys = [crypto.randomUUID(), crypto.randomUUID()];
    const started = performance.now();
    const results = await parallelRequests(2, (i) => h.post(bodies[i], keys[i]!, i));
    expect(new Set(results.map((r) => r.pid)).size).toBe(2);
    expect(results.map((r) => r.httpStatus).sort()).toEqual([200, 422]);
    expect(results.find((r) => r.httpStatus === 422)?.body.failureCode).toBe('INSUFFICIENT_BALANCE');
    const before = await h.state(wallet.id);
    expect(before).toEqual({ balance: '20.00', version: '2', transactions: '3', ledger: '2', outbox: '5' });
    const retries = await parallelRequests(2, (i) => h.post(bodies[i], keys[i]!, i + 1));
    retries.forEach((retry, i) => {
      expect(retry.httpStatus).toBe(results[i]!.httpStatus);
      expect(retry.body).toEqual({ ...results[i]!.body, idempotentReplay: true });
    });
    expect(await h.state(wallet.id)).toEqual(before);
    reportScenario('two-bets-80-on-100', started, { processed: 1, rejected: 1, balance: '20.00', debits: 1 });
  });

  test('replay after process shutdown/restart preserves the original balance after later movements', async () => {
    const wallet = await h.wallet();
    const body = processWagerBody(wallet, 'BET', '25.00');
    const key = crypto.randomUUID();
    const started = performance.now();
    const original = await h.post(body, key, 0);
    expect(original.httpStatus).toBe(200);
    await h.post(processWagerBody(wallet, 'WIN', '50.00'), crypto.randomUUID(), 1);
    const before = await h.state(wallet.id);
    expect(before.balance).toBe('125.00');
    const restart = await h.restart(0);
    expect(restart.oldPid).toBe(original.pid);
    expect(restart.newPid).not.toBe(restart.oldPid);
    const replay = await h.post(body, key, 0);
    expect(replay.pid).toBe(restart.newPid);
    expect(replay.httpStatus).toBe(original.httpStatus);
    expect(replay.body).toEqual({ ...original.body, idempotentReplay: true });
    expect(replay.body.balance.amount).toBe('75.00');
    expect(await h.state(wallet.id)).toEqual(before);
    reportScenario('replay-after-restart', started, { ...restart, originalBalance: '75.00', currentBalance: '125.00' });
  });

  test('controlled stress: 360 distinct operations on 12 wallets reconcile with ledger and replay safely', async () => {
    const wallets = await Promise.all(Array.from({ length: 12 }, (_, i) => h.wallet('100.00', i)));
    const submissions = Array.from({ length: 360 }, (_, i) => {
      const wallet = wallets[i % wallets.length]!;
      const operation = Math.floor(i / wallets.length) % 3;
      return { wallet, body: processWagerBody(wallet, ['BET', 'WIN', 'LOSS'][operation]!, ['2.00', '3.00', '1.00'][operation]!),
        key: crypto.randomUUID() };
    });
    const started = performance.now();
    const results = await boundedRequests(submissions.length, 30, (i) => h.post(submissions[i]!.body, submissions[i]!.key, i));
    expect(new Set(results.map((r) => r.pid)).size).toBe(3);
    expect(results.every((r) => r.httpStatus === 200 && !r.body.idempotentReplay)).toBe(true);
    expect(new Set(results.map((r) => r.body.transactionId)).size).toBe(360);
    const states = await Promise.all(wallets.map((wallet) => h.state(wallet.id)));
    for (const state of states) expect(state).toEqual({ balance: '110.00', version: '21', transactions: '31', ledger: '21', outbox: '52' });
    await h.assertConsistent();
    const replayed = await boundedRequests(submissions.length, 30, (i) => h.post(submissions[i]!.body, submissions[i]!.key, i + 1));
    expect(replayed.every((r) => r.httpStatus === 200 && r.body.idempotentReplay)).toBe(true);
    replayed.forEach((r, i) => expect(r.body).toEqual({ ...results[i]!.body, idempotentReplay: true }));
    expect(await Promise.all(wallets.map((wallet) => h.state(wallet.id)))).toEqual(states);
    reportScenario('controlled-stress', started, { wallets: 12, operations: 360, retries: 360, concurrency: 30,
      processed: 360, replays: 360, balancePerWallet: '110.00', reconciliation: 'OK' });
  });
});
