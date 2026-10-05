import 'reflect-metadata';
import { expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { AppConfig } from '../../src/config/app-config';
import { createOrmConfig } from '../../src/infrastructure/persistence/mikro-orm.config';

test('empty PostgreSQL database supports reproducible UP, DOWN, UP', async () => {
  const config = new AppConfig();
  const admin = await MikroORM.init(createOrmConfig(config));
  // Generated identifier only: never reset or drop the application's database.
  const dbName = `phase0_probe_${crypto.randomUUID().replaceAll('-', '')}`;
  let created = false;
  let probe: MikroORM | undefined;
  try {
    await admin.em.getConnection().execute(`create database "${dbName}" template template0`);
    created = true;
    probe = await MikroORM.init(createOrmConfig({
      ...config, database: { ...config.database, dbName },
    }));
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
    expect(await migrator.getPendingMigrations()).toHaveLength(1);
    const baseline = await state();
    expect(baseline).toEqual({
      wagering: false,
      tables: [{ table_schema: 'public', table_name: 'mikro_orm_migrations' }],
    });
    const history = () => connection.execute<Array<{ name: string }>>(
      'select name from public.mikro_orm_migrations order by id',
    );
    expect(await history()).toEqual([]);

    for (let cycle = 0; cycle < 2; cycle++) {
      await migrator.up();
      expect(await state()).toEqual({ ...baseline, wagering: true });
      expect(await history()).toEqual([{ name: 'Migration20261005000000' }]);
      expect(await migrator.getPendingMigrations()).toHaveLength(0);
      // A repeated UP must not add another history record.
      await migrator.up();
      expect(await history()).toHaveLength(1);
      await migrator.down();
      expect(await state()).toEqual(baseline);
      expect(await history()).toEqual([]);
      expect(await migrator.getPendingMigrations()).toHaveLength(1);
    }
    await migrator.up();
    expect(await state()).toEqual({ ...baseline, wagering: true });
    expect(await history()).toEqual([{ name: 'Migration20261005000000' }]);
    expect(await migrator.getPendingMigrations()).toHaveLength(0);
  } finally {
    try {
      if (probe) await probe.close(true);
      if (created) await admin.em.getConnection().execute(`drop database "${dbName}"`);
    } finally {
      await admin.close(true);
    }
  }
});
