import type { Subprocess } from 'bun';
import { resolve } from 'node:path';
import { isolatedPostgres } from './isolated-postgres';
import { deferred, withDeadline } from './concurrency-helpers';
import { assertLedgerConsistency } from './assert-ledger-consistency';
import type { ProcessingBody } from '../../src/application/processing-result';
import type { MoneyProps } from '../../src/domain/money';

export interface TestWallet { id: string; playerId: string; balance: MoneyProps; version: number }
export interface HttpResult {
  httpStatus: number;
  body: Omit<ProcessingBody, 'failureCode'> & { failureCode?: string };
  pid: number;
}
interface Ready { type: 'ready'; pid: number; url: string; dbName: string }
interface ApplicationProcess extends Ready { child: Subprocess<'pipe', 'pipe', 'pipe'>; drain: Promise<void>; diagnostics: () => string }

export async function processHarness(instanceCount = 3, options: { pendingWorkerEnabled?: boolean; messagingEnabled?: boolean;
  queueName?: string; dlqName?: string; shutdownMs?: number; pauseBeforeAck?: boolean;
  visibilitySeconds?: number; messagingInstances?: readonly number[]; outboxPublisherEnabled?: boolean;
  eventConsumerEnabled?: boolean; eventQueueName?: string; outboxLeaseMs?: number;
  publisherInstances?: readonly number[]; eventConsumerInstances?: readonly number[];
  pauseBeforePublish?: boolean; pauseAfterPublish?: boolean } = {}) {
  if (!Number.isInteger(instanceCount) || instanceCount < 3) throw new Error('At least three real processes are required');
  const fixture = await isolatedPostgres();
  const processes: ApplicationProcess[] = [];
  const root = resolve(__dirname, '../..');

  async function stop(instance: ApplicationProcess) {
    if (instance.child.exitCode === null) {
      try {
        instance.child.stdin.write('shutdown\n');
        instance.child.stdin.end();
        await withDeadline(instance.child.exited, 5000, 'graceful child shutdown');
      } catch { instance.child.kill(); await instance.child.exited; }
    }
    await instance.drain;
  }

  async function start(index: number): Promise<ApplicationProcess> {
    const { database: db, sqs } = fixture.config;
    const ready = deferred<Ready>();
    const child = Bun.spawn([process.execPath, resolve(root, 'test/support/application-process.ts')], {
      cwd: root, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
      env: { ...process.env, PORT: '3000', DB_HOST: db.host, DB_PORT: String(db.port), DB_NAME: db.dbName,
        PENDING_REFERENCE_WORKER_ENABLED: String(options.pendingWorkerEnabled ?? false),
        SQS_CONSUMER_ENABLED: String((options.messagingEnabled ?? false) && (options.messagingInstances?.includes(index) ?? true)),
        SQS_TRANSACTION_QUEUE_NAME: options.queueName ?? 'wager-transactions.fifo',
        SQS_DLQ_QUEUE_NAME: options.dlqName ?? 'wager-transactions-dlq.fifo',
        SQS_SHUTDOWN_TIMEOUT_MS: String(options.shutdownMs ?? 10000),
        SQS_TEST_PAUSE_BEFORE_ACK: String(options.pauseBeforeAck ?? false),
        SQS_TEST_VISIBILITY_SECONDS: options.visibilitySeconds === undefined ? '' : String(options.visibilitySeconds),
        OUTBOX_PUBLISHER_ENABLED: String((options.outboxPublisherEnabled??false)&&(options.publisherInstances?.includes(index)??true)),
        EVENT_CONSUMER_ENABLED: String((options.eventConsumerEnabled??false)&&(options.eventConsumerInstances?.includes(index)??true)),
        SQS_EVENT_QUEUE_NAME: options.eventQueueName??'wager-events.fifo',
        OUTBOX_LEASE_MS: String(options.outboxLeaseMs??30000),
        OUTBOX_TEST_PAUSE_BEFORE_SEND: String(options.pauseBeforePublish??false),
        OUTBOX_TEST_PAUSE_AFTER_SEND: String(options.pauseAfterPublish??false),
        DB_USER: db.user, DB_PASSWORD: db.password, SQS_ENDPOINT: sqs.endpoint, AWS_REGION: sqs.region,
        AWS_ACCESS_KEY_ID: sqs.accessKeyId, AWS_SECRET_ACCESS_KEY: sqs.secretAccessKey },
    });
    let log = '';
    const drain = async (stream: ReadableStream<Uint8Array>, parseReady: boolean) => {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true });
          log = (log + text).slice(-4000);
          if (!parseReady) continue;
          pending += text;
          const lines = pending.split('\n');
          pending = lines.pop()!;
          for (const line of lines) {
            try {
              const message = JSON.parse(line) as Ready;
              if (message.type === 'ready' && message.pid === child.pid && message.dbName === db.dbName &&
                /^http:\/\/127\.0\.0\.1:\d+$/.test(message.url)) ready.resolve(message);
            } catch { /* Non-protocol output is retained for bounded diagnostics. */ }
          }
        }
      } finally { reader.releaseLock(); }
    };
    const draining = Promise.all([drain(child.stdout, true), drain(child.stderr, false)]).then(() => undefined);
    void child.exited.then((code) => ready.reject(new Error(`Application process exited before ready (code ${code})`)));
    try {
      const info = await withDeadline(ready.promise, 15000, 'application process bootstrap');
      const instance = { ...info, child, drain: draining, diagnostics: () => log };
      // A listening process can still be warming its database/SQS connections.
      // Retry only startup probes; require a real 200 within a bounded total deadline.
      const deadline = performance.now() + 20000;
      let lastStatus = 'probe timed out or failed';
      while (performance.now() < deadline) {
        try {
          // Normally exceeds the service's 6s probe deadline to observe a 503.
          const response = await fetch(`${info.url}/health/ready`, {
            signal: AbortSignal.timeout(Math.max(1, Math.ceil(Math.min(8000, deadline - performance.now())))),
          });
          await response.arrayBuffer();
          if (response.ok) return instance;
          lastStatus = `HTTP ${response.status}`;
        } catch { lastStatus = 'probe timed out or failed'; }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`Child readiness deadline exceeded (${lastStatus})`);
    } catch (error) {
      child.kill();
      await child.exited;
      await draining;
      // The child suppresses bootstrap SQL/connection details; no environment dump.
      throw new Error(`Failed starting application process: ${String(error)}; ${log}`);
    }
  }

  try {
    await fixture.orm.getMigrator().up();
    // Keep all successful starts for cleanup, even if a different child fails.
    const starts = await Promise.allSettled(Array.from({ length: instanceCount }, async (_, index) => {
      const instance = await start(index); processes[index] = instance; return instance;
    }));
    const failure = starts.find((r) => r.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
    if (new Set(processes.map((p) => p.pid)).size !== instanceCount) throw new Error('Processes must have distinct PIDs');
    const sql = <T extends object[] = Record<string, unknown>[]>(statement: string, parameters: unknown[] = []) =>
      fixture.orm.em.getConnection().execute<T>(statement, parameters);
    return { orm: fixture.orm, config: fixture.config,
      diagnostics: (index: number) => processes[index]!.diagnostics(),
      resumeAck: (index: number) => { processes[index]!.child.stdin.write('resume-ack\n'); },
      resumePublish: (index: number) => { processes[index]!.child.stdin.write('resume-publish\n'); },
      async restartAll(){
        const oldPids=processes.map((p)=>p.pid);
        await Promise.all(processes.map(stop));
        const started=await Promise.allSettled(processes.map(async(_,index)=>{const replacement=await start(index);processes[index]=replacement;return replacement;}));
        const failure=started.find((result)=>result.status==='rejected');if(failure?.status==='rejected')throw failure.reason;
        return {oldPids,newPids:processes.map((p)=>p.pid)};
      },
      async terminate(index: number) {
        const instance = processes[index]!;
        // Unix uses the real OS signal. Windows dispatches the same Nest signal handler.
        if (process.platform === 'win32') instance.child.stdin.write('sigterm\n');
        else instance.child.kill('SIGTERM');
        await withDeadline(instance.child.exited, 15000, 'SIGTERM shutdown');
        await instance.drain;
      },
      instances: () => processes.map(({ pid, url, dbName }) => ({ pid, url, dbName })), sql,
      async post(body: unknown, key: string, instanceIndex = 0): Promise<HttpResult> {
        const instance = processes[instanceIndex % processes.length]!;
        const response = await fetch(`${instance.url}/wagering/transactions`, { method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify(body),
          signal: AbortSignal.timeout(20000) });
        return { httpStatus: response.status, body: await response.json() as HttpResult['body'], pid: instance.pid };
      },
      async wallet(amount = '100.00', instanceIndex = 0): Promise<TestWallet> {
        const instance = processes[instanceIndex % processes.length]!;
        const response = await fetch(`${instance.url}/wallets`, { method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ playerId: crypto.randomUUID(), initialBalance: { amount, currency: 'BRL' } }),
          signal: AbortSignal.timeout(20000) });
        if (response.status !== 201) throw new Error(`Open wallet failed: ${response.status}`);
        return await response.json() as TestWallet;
      },
      async state(walletId: string) {
        return (await sql<Array<{ balance: string; version: string; transactions: string; ledger: string; outbox: string }>>(`
          select w.balance::text,w.version::text,
            (select count(*)::text from wagering.wager_transactions t where t.wallet_id=w.id) as transactions,
            (select count(*)::text from wagering.wallet_ledger_entries l where l.wallet_id=w.id) as ledger,
            (select count(*)::text from wagering.outbox_events o join wagering.wager_transactions t
              on t.id=o.transaction_id where t.wallet_id=w.id) as outbox from wagering.wallets w where w.id=?`, [walletId]))[0]!;
      },
      async restart(index: number) {
        const old = processes[index]!;
        await stop(old);
        const replacement = await start(index);
        processes[index] = replacement;
        return { oldPid: old.pid, newPid: replacement.pid };
      },
      async crash(index: number) {
        const old = processes[index]!;
        old.child.kill('SIGKILL');
        await old.child.exited;
        await old.drain;
        const replacement = await start(index);
        processes[index] = replacement;
        return { oldPid: old.pid, newPid: replacement.pid };
      },
      assertConsistent: () => assertLedgerConsistency(fixture.orm,{allowPublished:options.outboxPublisherEnabled??false}),
      async close() {
        const stopped = await Promise.allSettled(processes.map(stop));
        await fixture.dispose();
        const failure = stopped.find((r) => r.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
      },
    };
  } catch (error) {
    try { await Promise.allSettled(processes.map(stop)); } finally { await fixture.dispose(); }
    throw error;
  }
}


export function processWagerBody(wallet: TestWallet, kind = 'BET', amount = '25.00', overrides: Record<string, unknown> = {}) {
  return { providerId: 'phase4-provider', externalTransactionId: crypto.randomUUID(), playerId: wallet.playerId,
    walletId: wallet.id, roundId: 'phase4-round', gameId: 'phase4-game', kind,
    money: { amount, currency: wallet.balance.currency }, ...overrides };
}
