import { Module } from '@nestjs/common';
import { ProcessWagerTransactionUseCase } from '../application/process-wager-transaction';
import { TRANSACTION_MANAGER, TransactionManager } from '../application/financial-unit-of-work';
import { PersistenceModule } from '../infrastructure/persistence/persistence.module';
import { WageringController } from './wagering.controller';
import { QueriesModule } from '../queries/queries.module';
import { ProviderTransactionsController } from './provider-transactions.controller';
import { ProviderIdentityModule } from '../infrastructure/identity/noop-provider-identity';
import { ObservabilityModule } from '../observability/observability.module';
import { TelemetryService } from '../observability/telemetry.service';

@Module({ imports: [PersistenceModule, QueriesModule, ProviderIdentityModule, ObservabilityModule], controllers: [WageringController, ProviderTransactionsController], providers: [
  { provide: ProcessWagerTransactionUseCase, inject: [TRANSACTION_MANAGER, TelemetryService],
    useFactory: (transactions: TransactionManager, telemetry: TelemetryService) => new ProcessWagerTransactionUseCase(transactions, telemetry) },
], exports: [ProcessWagerTransactionUseCase] })
export class WageringModule {}
