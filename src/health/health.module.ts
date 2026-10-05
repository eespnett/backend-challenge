import { Module } from '@nestjs/common';
import { PersistenceModule } from '../infrastructure/persistence/persistence.module';
import { SqsModule } from '../infrastructure/sqs/sqs.module';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

@Module({
  imports: [PersistenceModule, SqsModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
