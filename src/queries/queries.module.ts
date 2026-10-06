import { Module } from '@nestjs/common';
import { PersistenceModule } from '../infrastructure/persistence/persistence.module';
import { ObservabilityModule } from '../observability/observability.module';
import { QueryService } from './query.service';

@Module({ imports: [PersistenceModule, ObservabilityModule], providers: [QueryService], exports: [QueryService] })
export class QueriesModule {}
