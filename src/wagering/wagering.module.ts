import { Module } from '@nestjs/common';
import { ProcessWagerTransactionUseCase } from '../application/process-wager-transaction';
import { TRANSACTION_MANAGER, TransactionManager } from '../application/financial-unit-of-work';
import { PersistenceModule } from '../infrastructure/persistence/persistence.module';
import { WageringController } from './wagering.controller';

@Module({ imports: [PersistenceModule], controllers: [WageringController], providers: [
  { provide: ProcessWagerTransactionUseCase, inject: [TRANSACTION_MANAGER],
    useFactory: (transactions: TransactionManager) => new ProcessWagerTransactionUseCase(transactions) },
] })
export class WageringModule {}
