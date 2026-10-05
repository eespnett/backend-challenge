import { Module } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ConfigModule } from '../../config/config.module';
import { TransactionManager, TRANSACTION_MANAGER } from '../../application/financial-unit-of-work';
import { PendingReferenceClaimStore, PENDING_REFERENCE_CLAIM_STORE } from '../../application/pending-reference-ports';
import { ReprocessPendingReferenceUseCase } from '../../application/reprocess-pending-reference';
import { RunPendingReferenceBatch } from '../../application/run-pending-reference-batch';
import { PersistenceModule } from '../persistence/persistence.module';
import { PendingReferenceWorker } from './pending-reference.worker';

@Module({ imports: [ConfigModule, PersistenceModule], providers: [
  { provide: ReprocessPendingReferenceUseCase, inject: [TRANSACTION_MANAGER],
    useFactory: (transactions: TransactionManager) => new ReprocessPendingReferenceUseCase(transactions) },
  { provide: RunPendingReferenceBatch, inject: [PENDING_REFERENCE_CLAIM_STORE, ReprocessPendingReferenceUseCase],
    useFactory: (claims: PendingReferenceClaimStore, reprocess: ReprocessPendingReferenceUseCase) =>
      new RunPendingReferenceBatch(claims, reprocess, `${process.pid}:${randomUUID()}`) },
  PendingReferenceWorker,
] })
export class PendingReferencesModule {}
