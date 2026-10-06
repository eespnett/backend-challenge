import 'reflect-metadata';
import { expect, test } from 'bun:test';
import { phase8Harness } from '../support/phase8-harness';
import { processWagerBody } from '../support/process-harness';
import { deferred, withDeadline, parallelRequests } from '../support/concurrency-helpers';
import { ProcessWagerTransactionUseCase } from '../../src/application/process-wager-transaction';
import { assertLedgerConsistency } from '../support/assert-ledger-consistency';

test('reconciliation reads one committed snapshot while wallet update and ledger insertion are in flight', async () => {
  const h = await phase8Harness();
  try {
    const wallet = await h.wallet(); const updated = deferred<void>(); const continueLedger = deferred<void>();
    const staged = new ProcessWagerTransactionUseCase({ run: (work) => h.manager.run((uow) => work({ ...uow, wallets: {
      ...uow.wallets, lockById: (id) => uow.wallets.lockById(id), add: (value) => uow.wallets.add(value),
      saveLocked: async (value) => { await uow.wallets.saveLocked(value); updated.resolve(); await continueLedger.promise; },
    } })) });
    const writing = staged.execute(processWagerBody(wallet), crypto.randomUUID());
    try {
      await updated.promise;
      const reads = await parallelRequests(10, () => withDeadline(h.request(`/wallets/${wallet.id}/reconciliation`, 'POST'), 2000, 'snapshot reconciliation without writer lock'));
      for (const response of reads) {
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ consistent: true, checkedEntries: 1,
          storedBalance: { amount: '100.00', currency: 'BRL' }, calculatedBalance: { amount: '100.00', currency: 'BRL' } });
      }
    } finally { continueLedger.resolve(); await writing; }
    const final = await h.request(`/wallets/${wallet.id}/reconciliation`, 'POST');
    expect(await final.json()).toMatchObject({ consistent: true, checkedEntries: 2, storedBalance: { amount: '75.00', currency: 'BRL' } });
    // Repeated reads concurrent with committed writes must never report a torn balance/ledger pair.
    await Promise.all([
      (async () => { for (let i = 0; i < 20; i++) await h.process.execute(processWagerBody(wallet, 'WIN', '1.00'), crypto.randomUUID()); })(),
      (async () => { for (let i = 0; i < 40; i++) {
        const response = await h.request(`/wallets/${wallet.id}/reconciliation`, 'POST');
        expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ consistent: true, difference: { amount: '0.00', currency: 'BRL' } });
      } })(),
    ]);
    expect(h.telemetry.render()).toContain('reconciliation_inconsistencies{source="reconciliation"} 0');
    await assertLedgerConsistency(h.orm);
  } finally { await h.close(); }
});

test('a real PostgreSQL lock timeout increments lock_conflicts and failed processing creates no effects', async () => {
  const h = await phase8Harness();
  try {
    const wallet = await h.wallet(); const acquired = deferred<void>(); const release = deferred<void>();
    const holder = h.orm.em.fork({ clear: true, useContext: false }).transactional(async (em) => {
      await em.execute('select id from wagering.wallets where id=? for update', [wallet.id]); acquired.resolve(); await release.promise;
    });
    try {
      await acquired.promise;
      const response = await h.request('/wagering/transactions', 'POST', processWagerBody(wallet), { 'idempotency-key': crypto.randomUUID() });
      expect(response.status).toBe(503);
      const metrics = await (await h.request('/metrics')).text();
      expect(metrics).toContain('lock_conflicts{source="database"} 1');
      expect(metrics).toContain('transactions_by_status{status="PROCESSED"} 1');
    } finally { release.resolve(); await holder; }
    await assertLedgerConsistency(h.orm);
  } finally { await h.close(); }
});
