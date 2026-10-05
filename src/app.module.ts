import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { PersistenceModule } from './infrastructure/persistence/persistence.module';
import { SqsModule } from './infrastructure/sqs/sqs.module';
import { HealthModule } from './health/health.module';
import { WalletsModule } from './wallets/wallets.module';
import { WageringModule } from './wagering/wagering.module';

@Module({
  imports: [ConfigModule, PersistenceModule, SqsModule, HealthModule, WalletsModule, WageringModule],
})
export class AppModule {}
