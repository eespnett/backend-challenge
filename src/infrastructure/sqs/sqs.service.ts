import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { GetQueueAttributesCommand, GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import { AppConfig } from '../../config/app-config';

export const QUEUE_NAMES = [
  'wager-transactions.fifo',
  'wager-transactions-dlq.fifo',
  'wager-events.fifo',
] as const;

@Injectable()
export class SqsService implements OnModuleDestroy {
  readonly client: SQSClient;

  constructor(@Inject(AppConfig) config: AppConfig) {
    this.client = new SQSClient({
      endpoint: config.sqs.endpoint,
      region: config.sqs.region,
      credentials: {
        accessKeyId: config.sqs.accessKeyId,
        secretAccessKey: config.sqs.secretAccessKey,
      },
      maxAttempts: 2,
      requestHandler: { connectionTimeout: 2000, requestTimeout: 3000 },
    });
  }

  async queueUrl(name: string): Promise<string> {
    const response = await this.client.send(
      new GetQueueUrlCommand({ QueueName: name }),
      { abortSignal: AbortSignal.timeout(5000) },
    );
    if (!response.QueueUrl) throw new Error('SQS returned no queue URL');
    // LocalStack URLs use the Docker hostname. Use the configured endpoint
    // on the SDK client for both host and container requests.
    return response.QueueUrl;
  }

  async check(): Promise<void> {
    await Promise.all(QUEUE_NAMES.map(async (name) => {
      const QueueUrl = await this.queueUrl(name);
      await this.client.send(
        new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ['QueueArn'] }),
        { abortSignal: AbortSignal.timeout(5000) },
      );
    }));
  }

  onModuleDestroy(): void {
    this.client.destroy();
  }
}
