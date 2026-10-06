import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { EventTransport, OutboxClaim } from '../../application/outbox-ports';
import { canonicalJson } from '../../application/wager-envelope';
import { SqsService } from '../sqs/sqs.service';

export class SqsEventTransport implements EventTransport {
  constructor(private readonly sqs: SqsService,private readonly queueName: string) {}
  async send(claim: OutboxClaim, signal: AbortSignal): Promise<void> {
    const walletId=(claim.payload.data as Record<string,unknown>)?.walletId;
    if (typeof walletId!=='string' || !walletId) throw new Error('Outbox event has no wallet identity');
    const QueueUrl=await this.sqs.queueUrl(this.queueName);
    signal.throwIfAborted();
    const response=await this.sqs.client.send(new SendMessageCommand({QueueUrl,MessageBody:canonicalJson(claim.payload),
      MessageGroupId:walletId,MessageDeduplicationId:claim.eventId}),{abortSignal:signal});
    if (!response.MessageId) throw new Error('SQS event send was not confirmed');
  }
}
