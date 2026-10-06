import { Module } from '@nestjs/common';
import { ConfigModule } from '../../config/config.module';
import { TRANSACTION_MANAGER, TransactionManager } from '../../application/financial-unit-of-work';
import { ProcessWagerTransactionUseCase } from '../../application/process-wager-transaction';
import { PersistenceModule } from '../persistence/persistence.module';
import { SqsModule } from '../sqs/sqs.module';
import { SqsService } from '../sqs/sqs.service';
import { WageringModule } from '../../wagering/wagering.module';
import { WagerConsumer } from './wager-consumer';
import { WagerWorker } from './wager-worker';

@Module({ imports: [ConfigModule, PersistenceModule, SqsModule, WageringModule], providers: [
  { provide: WagerConsumer, inject: [TRANSACTION_MANAGER, ProcessWagerTransactionUseCase, SqsService],
    useFactory: (manager: TransactionManager, process: ProcessWagerTransactionUseCase, sqs: SqsService) => new WagerConsumer(manager, process, sqs) },
  WagerWorker,
], exports: [WagerConsumer] })
export class MessagingModule {}
