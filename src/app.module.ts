import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { PersistenceModule } from './infrastructure/persistence/persistence.module';
import { SqsModule } from './infrastructure/sqs/sqs.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [ConfigModule, PersistenceModule, SqsModule, HealthModule],
})
export class AppModule {}
