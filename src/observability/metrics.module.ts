import { Module } from '@nestjs/common';
import { ConfigModule } from '../config/config.module';
import { PersistenceModule } from '../infrastructure/persistence/persistence.module';
import { SqsModule } from '../infrastructure/sqs/sqs.module';
import { ObservabilityModule } from './observability.module';
import { MetricsController } from './metrics.controller';

@Module({ imports: [ConfigModule, PersistenceModule, SqsModule, ObservabilityModule], controllers: [MetricsController] })
export class MetricsModule {}
