import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { join } from 'node:path';
import { AppConfig } from '../../config/app-config';
import { WalletEntity } from './entities/wallet.entity';
import { WagerTransactionEntity } from './entities/wager-transaction.entity';
import { WalletLedgerEntryEntity } from './entities/wallet-ledger-entry.entity';

export function createOrmConfig(config: AppConfig) {
  return defineConfig({
    ...config.database,
    entities: [WalletEntity, WagerTransactionEntity, WalletLedgerEntryEntity],
    // Entities explicitly use wagering; migration bookkeeping stays in public.
    schema: 'public',
    extensions: [Migrator],
    pool: { min: 0, max: 10 },
    // Avoid PostgreSQL's user-named schema taking precedence for unqualified inserts.
    driverOptions: { connection: { connectionTimeoutMillis: 3000, options: '-c search_path=public' } },
    migrations: {
      path: join(__dirname, 'migrations'),
      pathTs: join(__dirname, 'migrations'),
      glob: '!(*.d).{js,ts}',
      tableName: 'public.mikro_orm_migrations',
      transactional: true,
      allOrNothing: true,
      snapshot: false,
    },
  });
}
