import { CreateQueueCommand, GetQueueAttributesCommand, DeleteQueueCommand, SendMessageCommand,
  ReceiveMessageCommand, ChangeMessageVisibilityCommand, Message } from '@aws-sdk/client-sqs';
import { AppConfig } from '../../src/config/app-config';
import { SqsService } from '../../src/infrastructure/sqs/sqs.service';
import { WagerConsumer } from '../../src/infrastructure/messaging/wager-consumer';
import { phase3Harness } from './phase3-harness';
import { waitUntil } from './concurrency-helpers';

/** Each fixture owns random FIFO queues; never purge/remove the project's business queues. */
export async function isolatedQueues() {
  const sqs = new SqsService(new AppConfig());
  const suffix = crypto.randomUUID();
  const queueName = `phase6-${suffix}.fifo`;
  const dlqName = `phase6-dlq-${suffix}.fifo`;
  let queueUrl: string | undefined;
  let dlqUrl: string | undefined;
  try {
    dlqUrl = (await sqs.client.send(new CreateQueueCommand({ QueueName: dlqName,
      Attributes: { FifoQueue: 'true', MessageRetentionPeriod: '1209600' } }))).QueueUrl!;
    const arn = (await sqs.client.send(new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['QueueArn'] }))).Attributes!.QueueArn!;
    queueUrl = (await sqs.client.send(new CreateQueueCommand({ QueueName: queueName, Attributes: {
      FifoQueue: 'true', VisibilityTimeout: '30', MessageRetentionPeriod: '345600',
      RedrivePolicy: JSON.stringify({ deadLetterTargetArn: arn, maxReceiveCount: '5' }),
    } }))).QueueUrl!;
    return { sqs, queueName, dlqName, queueUrl, dlqUrl,
      async send(body: unknown, group: string = crypto.randomUUID()) {
        const raw = typeof body === 'string' ? body : JSON.stringify(body);
        return sqs.client.send(new SendMessageCommand({ QueueUrl: queueUrl!, MessageBody: raw,
          MessageGroupId: group, MessageDeduplicationId: crypto.randomUUID() }));
      },
      async receive(dlq = false): Promise<Message | undefined> {
        return (await sqs.client.send(new ReceiveMessageCommand({ QueueUrl: dlq ? dlqUrl! : queueUrl!,
          MaxNumberOfMessages: 1, WaitTimeSeconds: 1, VisibilityTimeout: 1,
          MessageSystemAttributeNames: ['All'], MessageAttributeNames: ['All'] }))).Messages?.[0];
      },
      async release(message: Message) { await sqs.client.send(new ChangeMessageVisibilityCommand({
        QueueUrl: queueUrl!, ReceiptHandle: message.ReceiptHandle!, VisibilityTimeout: 0 })); },
      async close() {
        try { await sqs.client.send(new DeleteQueueCommand({ QueueUrl: queueUrl! })); }
        finally { try { await sqs.client.send(new DeleteQueueCommand({ QueueUrl: dlqUrl! })); } finally { sqs.onApplicationShutdown(); } }
      },
    };
  } catch (error) {
    if (queueUrl) await sqs.client.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
    if (dlqUrl) await sqs.client.send(new DeleteQueueCommand({ QueueUrl: dlqUrl }));
    sqs.onApplicationShutdown(); throw error;
  }
}
export function wagerEnvelope(body: Record<string, unknown>, key: string = crypto.randomUUID(), messageId: string = crypto.randomUUID()) {
  return { messageId, type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(), data: { ...body, idempotencyKey: key } };
}
export async function phase6Harness() {
  const h = await phase3Harness();
  try {
    const queues = await isolatedQueues();
    const consumer = new WagerConsumer(h.manager, h.process, queues.sqs);
    return { ...h, ...queues, consumer,
      async deliver(body: unknown) {
        const sent = await queues.send(body);
        let message: Message | undefined;
        await waitUntil(async () => { message = await queues.receive(); return message !== undefined; }, 'SQS delivery', 5000);
        if (message!.MessageId !== sent.MessageId) throw new Error('Unexpected delivery identity');
        return { message: message!, outcome: await consumer.handle(message!, queues.queueUrl, queues.dlqUrl) };
      },
      async inbox(messageId: string) {
        return (await h.sql<Array<{ payload_hash: string; status: string; result: unknown; error_code: string | null; processed_at: Date | null }>>(
          'select payload_hash,status,result,error_code,processed_at from wagering.consumer_inbox where message_id=?',[messageId]))[0];
      },
      async close() { try { await queues.close(); } finally { await h.close(); } },
    };
  } catch (error) { await h.close(); throw error; }
}
