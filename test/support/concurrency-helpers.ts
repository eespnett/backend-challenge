import type { MikroORM } from '@mikro-orm/postgresql';

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

export async function withDeadline<T>(work: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timeout: ${label}`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

/** Release all HTTP submissions from the same local barrier; effects run in real child processes. */
export async function parallelRequests<T>(count: number, run: (index: number) => Promise<T>): Promise<T[]> {
  const gate = deferred<void>();
  const requests = Array.from({ length: count }, async (_, index) => { await gate.promise; return run(index); });
  gate.resolve();
  // Drain every request even when one fails, so teardown never races an in-flight request.
  const results = await Promise.allSettled(requests);
  const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failures.length > 0) throw new AggregateError(failures.map((r) => r.reason), 'Parallel requests failed');
  return results.map((r) => (r as PromiseFulfilledResult<T>).value);
}

export async function boundedRequests<T>(count: number, concurrency: number, run: (index: number) => Promise<T>): Promise<T[]> {
  const results: T[] = new Array(count);
  let next = 0;
  await parallelRequests(Math.min(count, concurrency), async () => {
    while (next < count) {
      const index = next++;
      results[index] = await run(index);
    }
  });
  return results;
}

export async function waitUntil(check: () => Promise<boolean>, label: string, timeoutMs = 3000): Promise<void> {
  const end = performance.now() + timeoutMs;
  do {
    if (await check()) return;
    // Short bounded polling is only for observing PostgreSQL; it does not order financial effects.
    await new Promise((resolve) => setTimeout(resolve, 20));
  } while (performance.now() < end);
  throw new Error(`Timeout observing ${label}`);
}

export function reportScenario(scenario: string, startedAt: number, facts: Record<string, unknown>) {
  console.log(JSON.stringify({ scenario, durationMs: Math.round(performance.now() - startedAt), ...facts }));
}

/** An independent PostgreSQL transaction holds an actual row lock until explicitly released. */
export async function holdWalletLock(orm: MikroORM, walletId: string) {
  const acquired = deferred<number>();
  const gate = deferred<void>();
  const done = orm.em.fork({ clear: true, useContext: false }).transactional(async (em) => {
    const rows = await em.execute<Array<{ pid: number }>>('select pg_backend_pid() as pid');
    const wallets = await em.execute('select id from wagering.wallets where id=? for update', [walletId]);
    if (wallets.length !== 1) throw new Error('Lock probe requires an existing wallet');
    acquired.resolve(rows[0]!.pid);
    await gate.promise;
  });
  // Handle early SQL failure while the caller is still awaiting acquisition.
  void done.catch((error) => acquired.reject(error));
  try {
    const pid = await acquired.promise;
    return { pid, async release() { gate.resolve(); await done; } };
  } catch (error) { gate.resolve(); await done.catch(() => undefined); throw error; }
}

export async function waitingWalletLocks(orm: MikroORM) {
  return orm.em.getConnection().execute<Array<{ pid: number; wait_event: string; blockers: number[] }>>(`
    select pid,wait_event,pg_blocking_pids(pid) as blockers from pg_stat_activity
    where datname=current_database() and wait_event_type='Lock' and query ilike '%wallets%'
    order by pid`);
}
