import { Module } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ConfigModule } from '../../config/config.module';
import { TransactionManager, TRANSACTION_MANAGER } from '../../application/financial-unit-of-work';
import { PendingReferenceClaimStore, PENDING_REFERENCE_CLAIM_STORE } from '../../application/pending-reference-ports';
import { ReprocessPendingReferenceUseCase } from '../../application/reprocess-pending-reference';
import { RunPendingReferenceBatch } from '../../application/run-pending-reference-batch';
import { PersistenceModule } from '../persistence/persistence.module';
import { PendingReferenceWorker } from './pending-reference.worker';
import { ObservabilityModule } from '../../observability/observability.module';
import { TelemetryService } from '../../observability/telemetry.service';

@Module({ imports: [ConfigModule, PersistenceModule, ObservabilityModule], providers: [
  { provide: ReprocessPendingReferenceUseCase, inject: [TRANSACTION_MANAGER, TelemetryService],
    useFactory: (transactions: TransactionManager, telemetry: TelemetryService) => new ReprocessPendingReferenceUseCase(transactions, telemetry) },
  { provide: RunPendingReferenceBatch, inject: [PENDING_REFERENCE_CLAIM_STORE, ReprocessPendingReferenceUseCase],
    useFactory: (claims: PendingReferenceClaimStore, reprocess: ReprocessPendingReferenceUseCase) =>
      new RunPendingReferenceBatch(claims, reprocess, `${process.pid}:${randomUUID()}`) },
  PendingReferenceWorker,
] })
export class PendingReferencesModule {}
