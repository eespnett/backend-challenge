import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { holdWalletLock, parallelRequests, reportScenario, waitingWalletLocks, waitUntil } from '../support/concurrency-helpers';
import { processHarness, processWagerBody } from '../support/process-harness';

let h: Awaited<ReturnType<typeof processHarness>>;
beforeAll(async () => { h = await processHarness(3); });
afterEach(async () => { if (h) await h.assertConsistent(); });
afterAll(async () => { if (h) await h.close(); });

describe('wallet locks observed in PostgreSQL across independent application processes', () => {
  test('blocked wallet waits while distinct wallets progress on all three processes: no global lock', async () => {
    const blockedWallet = await h.wallet();
    const otherWallets = await Promise.all(Array.from({ length: 6 }, (_, i) => h.wallet('100.00', i)));
    const lock = await holdWalletLock(h.orm, blockedWallet.id);
    const started = performance.now();
    let completedBlocked = 0;
    const blocked = parallelRequests(2, (i) => h.post(processWagerBody(blockedWallet, 'BET', '10.00'),
      crypto.randomUUID(), i).then((result) => { completedBlocked++; return result; }));
    let observed: Awaited<ReturnType<typeof waitingWalletLocks>> = [];
    try {
      await waitUntil(async () => { observed = await waitingWalletLocks(h.orm); return observed.length === 2; }, 'two waiting wallets');
      expect(observed.some((row) => row.blockers.includes(lock.pid))).toBe(true);
      const progressing = await parallelRequests(otherWallets.length, (i) => h.post(
        processWagerBody(otherWallets[i]!, 'BET', '10.00'), crypto.randomUUID(), i));
      expect(new Set(progressing.map((r) => r.pid)).size).toBe(3);
      expect(progressing.every((r) => r.httpStatus === 200)).toBe(true);
      expect(completedBlocked).toBe(0);
      expect((await h.state(blockedWallet.id)).balance).toBe('100.00');
      for (const wallet of otherWallets) expect((await h.state(wallet.id)).balance).toBe('90.00');
      expect((await waitingWalletLocks(h.orm)).length).toBe(2);
    } finally { await lock.release(); await blocked; }
    const resumed = await blocked;
    expect(resumed.every((r) => r.httpStatus === 200)).toBe(true);
    expect(await h.state(blockedWallet.id)).toEqual({ balance: '80.00', version: '3', transactions: '3', ledger: '3', outbox: '6' });
    reportScenario('no-global-lock', started, { waitingBackends: observed.length, holderBackend: lock.pid,
      progressingWallets: 6, progressingInstances: 3, blockedWalletBalanceAfterRelease: '80.00' });
  });

  test('real 5-second lock timeouts return 503 with no effects, then retries commit exactly once', async () => {
    const wallet = await h.wallet();
    const before = await h.state(wallet.id);
    const bodies = Array.from({ length: 3 }, () => processWagerBody(wallet, 'BET', '10.00'));
    const keys = bodies.map(() => crypto.randomUUID());
    const lock = await holdWalletLock(h.orm, wallet.id);
    const started = performance.now();
    const requests = parallelRequests(3, (i) => h.post(bodies[i], keys[i]!, i));
    let timedOut: Awaited<typeof requests>;
    try {
      await waitUntil(async () => (await waitingWalletLocks(h.orm)).length === 3, 'three waiting PostgreSQL backends');
      timedOut = await requests;
      expect(new Set(timedOut.map((r) => r.pid)).size).toBe(3);
      expect(timedOut.map((r) => r.httpStatus)).toEqual([503, 503, 503]);
      expect(timedOut.every((r) => r.body.failureCode === 'INFRASTRUCTURE_UNAVAILABLE')).toBe(true);
      expect(await h.state(wallet.id)).toEqual(before);
      expect(await h.sql('select id from wagering.wager_transactions where idempotency_key in (?,?,?)', keys)).toEqual([]);
      expect(await waitingWalletLocks(h.orm)).toEqual([]);
    } finally { await lock.release(); await requests; }
    const elapsedTimeoutMs = Math.round(performance.now() - started);
    const retries = await parallelRequests(3, (i) => h.post(bodies[i], keys[i]!, i + 1));
    expect(retries.every((r) => r.httpStatus === 200 && !r.body.idempotentReplay)).toBe(true);
    const after = await h.state(wallet.id);
    expect(after).toEqual({ balance: '70.00', version: '4', transactions: '4', ledger: '4', outbox: '8' });
    const replays = await parallelRequests(3, (i) => h.post(bodies[i], keys[i]!, i + 2));
    replays.forEach((r, i) => expect(r.body).toEqual({ ...retries[i]!.body, idempotentReplay: true }));
    expect(await h.state(wallet.id)).toEqual(after);
    reportScenario('lock-timeouts', started, { transientConflicts: 3, httpStatus: 503, elapsedTimeoutMs,
      successfulRetries: 3, idempotentReplays: 3, finalBalance: '70.00' });
  });
});
