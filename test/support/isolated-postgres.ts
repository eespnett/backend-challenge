import 'reflect-metadata';
import { MikroORM } from '@mikro-orm/postgresql';
import { AppConfig } from '../../src/config/app-config';
import { createOrmConfig } from '../../src/infrastructure/persistence/mikro-orm.config';

export async function isolatedPostgres() {
  const base = new AppConfig();
  const admin = await MikroORM.init(createOrmConfig(base));
  const dbName = `phase2_probe_${crypto.randomUUID().replaceAll('-', '')}`;
  let orm: MikroORM;
  const config: AppConfig = { ...base, database: { ...base.database, dbName } };
  try {
    await admin.em.getConnection().execute(`create database "${dbName}" template template0`);
    try {
      orm = await MikroORM.init(createOrmConfig(config));
    } catch (error) {
      await admin.em.getConnection().execute(`drop database "${dbName}"`);
      throw error;
    }
  } catch (error) {
    await admin.close(true);
    throw error;
  }
  return { orm, config, async dispose() {
    try {
      await orm.close(true);
      // Only the randomly generated database owned by this fixture is removed.
      await admin.em.getConnection().execute(`drop database "${dbName}"`);
    } finally { await admin.close(true); }
  } };
}
