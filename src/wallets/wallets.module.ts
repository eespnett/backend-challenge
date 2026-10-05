import { Module } from '@nestjs/common';
import { OpenWallet } from '../application/open-wallet';
import { TransactionManager, TRANSACTION_MANAGER } from '../application/financial-unit-of-work';
import { PersistenceModule } from '../infrastructure/persistence/persistence.module';
import { WalletsController } from './wallets.controller';

@Module({ imports: [PersistenceModule], controllers: [WalletsController],
  providers: [{ provide: OpenWallet, inject: [TRANSACTION_MANAGER],
    useFactory: (transactions: TransactionManager) => new OpenWallet(transactions) }] })
export class WalletsModule {}
