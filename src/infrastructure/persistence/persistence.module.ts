import { MikroORM, PostgreSqlDriver } from '@mikro-orm/postgresql';
import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { ConfigModule } from '../../config/config.module';
import { AppConfig } from '../../config/app-config';
import { createOrmConfig } from './mikro-orm.config';
import { TRANSACTION_MANAGER } from '../../application/financial-unit-of-work';
import { MikroOrmTransactionManager } from './mikro-orm-transaction-manager';
import { PENDING_REFERENCE_CLAIM_STORE } from '../../application/pending-reference-ports';
import { MikroOrmPendingReferenceClaimStore } from './pending-reference-repository';

@Module({
  imports: [
    MikroOrmModule.forRootAsync({
      driver: PostgreSqlDriver,
      imports: [ConfigModule],
      inject: [AppConfig],
      useFactory: (config: AppConfig) => createOrmConfig(config),
    }),
  ],
  providers: [{ provide: TRANSACTION_MANAGER, inject: [MikroORM],
    useFactory: (orm: MikroORM) => new MikroOrmTransactionManager(orm) },
    { provide: PENDING_REFERENCE_CLAIM_STORE, inject: [MikroORM],
      useFactory: (orm: MikroORM) => new MikroOrmPendingReferenceClaimStore(orm) }],
  exports: [TRANSACTION_MANAGER, PENDING_REFERENCE_CLAIM_STORE],
})
export class PersistenceModule {}
