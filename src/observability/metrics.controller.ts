import { Controller, Get, Header, Inject, ServiceUnavailableException } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { SqsService } from '../infrastructure/sqs/sqs.service';
import { AppConfig } from '../config/app-config';
import { TelemetryService } from './telemetry.service';

@Controller('metrics')
export class MetricsController {
  constructor(@Inject(MikroORM) private readonly orm: MikroORM, @Inject(SqsService) private readonly sqs: SqsService,
    @Inject(AppConfig) private readonly config: AppConfig, @Inject(TelemetryService) private readonly telemetry: TelemetryService) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async get(): Promise<string> {
    try {
      const [statuses, lag, dlq] = await Promise.all([
        this.orm.em.getConnection().execute<Array<{ status: string; count: string }>>('select status,count(*)::text as count from wagering.wager_transactions group by status'),
        this.orm.em.getConnection().execute<Array<{ seconds: string }>>(`select coalesce(greatest(0,extract(epoch from clock_timestamp()-min(created_at))),0)::text as seconds
          from wagering.outbox_events where published_at is null`),
        this.dlqDepth(),
      ]);
      const lines = ['# TYPE transactions_by_status gauge'];
      for (const status of ['PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED']) {
        lines.push(`transactions_by_status{status="${status}"} ${statuses.find((row) => row.status === status)?.count ?? '0'}`);
      }
      lines.push('# HELP outbox_lag Age in seconds of the oldest unpublished event.', '# TYPE outbox_lag gauge',
        `outbox_lag ${lag[0]?.seconds ?? '0'}`, '# HELP dlq_messages Approximate visible and in-flight messages in the command DLQ.',
        '# TYPE dlq_messages gauge', `dlq_messages ${dlq}`);
      return lines.join('\n') + '\n' + this.telemetry.render();
    } catch {
      throw new ServiceUnavailableException({ failureCode: 'INFRASTRUCTURE_UNAVAILABLE', message: 'Metrics dependencies unavailable' });
    }
  }
  private async dlqDepth(): Promise<number> {
    const QueueUrl = await this.sqs.queueUrl(this.config.messaging.dlqName);
    const { Attributes } = await this.sqs.client.send(new GetQueueAttributesCommand({ QueueUrl,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'] }), { abortSignal: AbortSignal.timeout(5000) });
    const visible = Number(Attributes?.ApproximateNumberOfMessages);
    const inFlight = Number(Attributes?.ApproximateNumberOfMessagesNotVisible);
    if (!Number.isFinite(visible) || !Number.isFinite(inFlight)) throw new Error('Missing DLQ attributes');
    return visible + inFlight;
  }
}
