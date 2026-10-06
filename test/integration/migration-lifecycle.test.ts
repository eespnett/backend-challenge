import 'reflect-metadata';
import { expect, test } from 'bun:test';
import { isolatedPostgres } from '../support/isolated-postgres';
import { OpenWallet } from '../../src/application/open-wallet';
import { ProcessWagerTransactionUseCase } from '../../src/application/process-wager-transaction';
import { wagerBody } from '../support/phase3-harness';
import { MikroOrmTransactionManager } from '../../src/infrastructure/persistence/mikro-orm-transaction-manager';

test('empty PostgreSQL database supports reproducible UP, DOWN, UP', async () => {
  const fixture = await isolatedPostgres();
  const probe = fixture.orm;
  try {
    const connection = probe.em.getConnection();
    const state = async () => {
      const schemas: Array<{ exists: boolean }> = await connection.execute(
        "select exists(select 1 from information_schema.schemata where schema_name = 'wagering')",
      );
      const tables: Array<{ table_schema: string; table_name: string }> = await connection.execute(
        "select table_schema, table_name from information_schema.tables " +
        "where table_schema in ('public', 'wagering') order by table_schema, table_name",
      );
      return { wagering: schemas[0]?.exists, tables };
    };
    expect(await state()).toEqual({ wagering: false, tables: [] });
    const migrator = probe.getMigrator();
    // MikroORM keeps its bookkeeping table after DOWN; establish that baseline.
    expect(await migrator.getPendingMigrations()).toHaveLength(6);
    const baseline = await state();
    expect(baseline).toEqual({
      wagering: false,
      tables: [{ table_schema: 'public', table_name: 'mikro_orm_migrations' }],
    });
    const history = () => connection.execute<Array<{ name: string }>>(
      'select name from public.mikro_orm_migrations order by id',
    );
    expect(await history()).toEqual([]);
    const migrated = { wagering: true, tables: [
      ...baseline.tables,
      { table_schema: 'wagering', table_name: 'consumer_dead_letters' },
      { table_schema: 'wagering', table_name: 'consumer_inbox' },
      { table_schema: 'wagering', table_name: 'integration_event_receipts' },
      { table_schema: 'wagering', table_name: 'outbox_events' },
      { table_schema: 'wagering', table_name: 'pending_reference_jobs' },
      { table_schema: 'wagering', table_name: 'wager_transactions' },
      { table_schema: 'wagering', table_name: 'wallet_ledger_entries' },
      { table_schema: 'wagering', table_name: 'wallets' },
    ] };
    const expectedHistory = [{ name: 'Migration20261005000000' }, { name: 'Migration20261005020000' },
      { name: 'Migration20261005030000' }, { name: 'Migration20261005050000' }, { name: 'Migration20261005060000' },
      { name: 'Migration20261005070000' }];

    for (let cycle = 0; cycle < 2; cycle++) {
      await migrator.up();
      expect(await state()).toEqual(migrated);
      expect(await history()).toEqual(expectedHistory);
      expect(await migrator.getPendingMigrations()).toHaveLength(0);
      // A repeated UP must not add another history record.
      await migrator.up();
      expect(await history()).toHaveLength(6);
      // DOWN must also work with actual wallet + OPENING + immutable ledger rows.
      const manager = new MikroOrmTransactionManager(probe);
      const wallet = await new OpenWallet(manager).execute({ playerId: `cycle-${cycle}`,
        initialBalance: { amount: '10.00', currency: 'BRL' } });
      const processed = await new ProcessWagerTransactionUseCase(manager).execute(wagerBody(wallet, undefined, '2.00'), crypto.randomUUID());
      expect(processed.httpStatus).toBe(200);
      expect(processed.body.balance.amount).toBe('8.00');
      await manager.run(async (uow) => {
        await uow.inbox.reserve(`migration-cycle-${cycle}`,'a'.repeat(64));
        await uow.inbox.finish(`migration-cycle-${cycle}`,'a'.repeat(64),processed);
      });
      await migrator.down();
      expect(await history()).toEqual(expectedHistory.slice(0,5));
      const phase6={...migrated,tables:migrated.tables.filter((t)=>t.table_name!=='integration_event_receipts')};
      expect(await state()).toEqual(phase6);
      await migrator.down();
      expect(await history()).toEqual(expectedHistory.slice(0, 4));
      const phase5 = { ...phase6, tables: phase6.tables.filter((t) => !t.table_name.startsWith('consumer_')) };
      expect(await state()).toEqual(phase5);
      await migrator.down();
      expect(await history()).toEqual(expectedHistory.slice(0, 3));
      const phase3 = { ...phase5, tables: phase5.tables.filter((t) => t.table_name !== 'pending_reference_jobs') };
      expect(await state()).toEqual(phase3);
      await migrator.down();
      expect(await history()).toEqual(expectedHistory.slice(0, 2));
      expect(await state()).toEqual({ ...phase3, tables: phase3.tables.filter((t) => t.table_name !== 'outbox_events') });
      await migrator.down();
      expect(await state()).toEqual({ ...baseline, wagering: true });
      expect(await history()).toEqual([{ name: 'Migration20261005000000' }]);
      const functions: Array<{ count: string }> = await connection.execute(
        "select count(*)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace " +
        "where n.nspname='wagering' and p.proname='prevent_ledger_mutation'",
      );
      expect(functions[0]?.count).toBe('0');
      await migrator.down();
      expect(await state()).toEqual(baseline);
      expect(await history()).toEqual([]);
      expect(await migrator.getPendingMigrations()).toHaveLength(6);
    }
    await migrator.up();
    expect(await state()).toEqual(migrated);
    expect(await history()).toEqual(expectedHistory);
    expect(await migrator.getPendingMigrations()).toHaveLength(0);
  } finally {
    await fixture.dispose();
  }
});
