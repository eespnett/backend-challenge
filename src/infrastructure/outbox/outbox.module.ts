import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { ConfigModule } from '../../config/config.module';
import { AppConfig } from '../../config/app-config';
import { OutboxPublisher } from '../../application/outbox-publisher';
import { MikroOrmOutboxClaimStore } from '../persistence/outbox-claim-store';
import { MikroOrmEventReceiptStore } from '../persistence/event-receipt-store';
import { PersistenceModule } from '../persistence/persistence.module';
import { SqsModule } from '../sqs/sqs.module';
import { SqsService } from '../sqs/sqs.service';
import { SqsEventTransport } from './sqs-event-transport';
import { IntegrationEventConsumer } from './event-consumer';
import { OutboxWorkers } from './outbox-workers';
import { ObservabilityModule } from '../../observability/observability.module';
import { TelemetryService } from '../../observability/telemetry.service';

@Module({imports:[ConfigModule,PersistenceModule,SqsModule,ObservabilityModule],providers:[
  {provide:OutboxPublisher,inject:[MikroORM,SqsService,AppConfig,TelemetryService],useFactory:(orm:MikroORM,sqs:SqsService,config:AppConfig,telemetry:TelemetryService)=>
    new OutboxPublisher(new MikroOrmOutboxClaimStore(orm),new SqsEventTransport(sqs,config.outbox.queueName),`${process.pid}:${randomUUID()}`,config.outbox.leaseMs,telemetry)},
  {provide:IntegrationEventConsumer,inject:[MikroORM,SqsService,TelemetryService],useFactory:(orm:MikroORM,sqs:SqsService,telemetry:TelemetryService)=>
    new IntegrationEventConsumer(new MikroOrmEventReceiptStore(orm),sqs,telemetry)},OutboxWorkers,
],exports:[OutboxPublisher,IntegrationEventConsumer]})
export class OutboxModule{}
