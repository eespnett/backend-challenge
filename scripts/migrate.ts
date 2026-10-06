import 'reflect-metadata';
import { MikroORM } from '@mikro-orm/postgresql';
import { AppConfig } from '../src/config/app-config';
import { createOrmConfig } from '../src/infrastructure/persistence/mikro-orm.config';
import { CliInputError, runCli } from './cli';

async function main(): Promise<void> {
  const action = process.argv[2] ?? 'up';
  if (!['up', 'down', 'list'].includes(action)) {
    throw new CliInputError('Usage: bun scripts/migrate.ts up|down|list');
  }
  const orm = await MikroORM.init(createOrmConfig(new AppConfig()));
  try {
    const migrator = orm.getMigrator();
    if (action === 'up') await migrator.up();
    else if (action === 'down') await migrator.down();
    else console.log(await migrator.getPendingMigrations());
  } finally {
    await orm.close(true);
  }
}

void runCli('migration_failed', main);
