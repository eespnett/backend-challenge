import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { PersistenceModule } from './infrastructure/persistence/persistence.module';
import { SqsModule } from './infrastructure/sqs/sqs.module';
import { HealthModule } from './health/health.module';
import { WalletsModule } from './wallets/wallets.module';
import { WageringModule } from './wagering/wagering.module';
import { PendingReferencesModule } from './infrastructure/pending-references/pending-references.module';
import { MessagingModule } from './infrastructure/messaging/messaging.module';
import { OutboxModule } from './infrastructure/outbox/outbox.module';

@Module({
  imports: [ConfigModule, PersistenceModule, SqsModule, HealthModule, WalletsModule, WageringModule, PendingReferencesModule, MessagingModule, OutboxModule],
})
export class AppModule {}
