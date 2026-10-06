import { Inject, Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import { AppConfig } from '../../config/app-config';
import { SqsService } from '../sqs/sqs.service';
import { WagerConsumer, SQS_VISIBILITY_SECONDS } from './wager-consumer';

@Injectable()
export class WagerWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WagerWorker.name);
  private readonly polling = new AbortController();
  private readonly deliveries = new AbortController();
  private running?: Promise<void>;
  private stopping = false;
  constructor(@Inject(AppConfig) private readonly config: AppConfig, @Inject(SqsService) private readonly sqs: SqsService,
    @Inject(WagerConsumer) private readonly consumer: WagerConsumer) {}

  onModuleInit(): void { if (this.config.messaging.enabled) this.running = this.poll(); }
  private async poll(): Promise<void> {
    while (!this.stopping) {
      try {
        const queueUrl = await this.sqs.queueUrl(this.config.messaging.queueName);
        const dlqUrl = await this.sqs.queueUrl(this.config.messaging.dlqName);
        while (!this.stopping) {
          const batch = await this.sqs.client.send(new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 5,
            WaitTimeSeconds: 2, VisibilityTimeout: SQS_VISIBILITY_SECONDS,
            MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'], MessageAttributeNames: ['All'] }),
            { abortSignal: this.polling.signal });
          if (this.stopping) break; // Received but unaccepted messages return through visibility timeout.
          const groups = new Map<string, NonNullable<typeof batch.Messages>>();
          for (const message of batch.Messages ?? []) {
            const group = message.Attributes?.MessageGroupId ?? message.MessageId!;
            const messages = groups.get(group) ?? [];
            messages.push(message); groups.set(group,messages);
          }
          // SQS can return several ordered messages from one FIFO group in a batch.
          // Serialize those messages; different groups still run concurrently.
          await Promise.allSettled([...groups.values()].map(async (messages) => {
            for (const message of messages) {
              if (this.stopping) break;
              const outcome = await this.consumer.handle(message,queueUrl,dlqUrl,this.deliveries.signal);
              if (outcome === 'RETRY' || outcome === 'ABANDONED') break;
            }
          }));
        }
      } catch {
        if (this.stopping) break;
        this.logger.warn('SQS polling unavailable; retrying');
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, 1000);
          const signal = this.polling.signal;
          function done() { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); }
          signal.addEventListener('abort', done, { once: true });
          if (signal.aborted) done();
        });
      }
    }
  }
  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    this.polling.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([this.running, new Promise<void>((resolve) => {
        timer = setTimeout(() => { this.deliveries.abort(); resolve(); }, this.config.messaging.shutdownMs);
      })]);
    } finally { clearTimeout(timer); }
  }
}
