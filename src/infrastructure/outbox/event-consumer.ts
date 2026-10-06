import { ChangeMessageVisibilityCommand, DeleteMessageCommand, Message } from '@aws-sdk/client-sqs';
import { validateIntegrationEvent } from '../../application/integration-event-envelope';
import { MikroOrmEventReceiptStore } from '../persistence/event-receipt-store';
import { SqsService } from '../sqs/sqs.service';
import { silentTelemetry, TelemetryPort, TraceContext } from '../../application/telemetry-port';

export class IntegrationEventConsumer {
  constructor(private readonly receipts:MikroOrmEventReceiptStore,private readonly sqs:SqsService,
    private readonly telemetry: TelemetryPort = silentTelemetry){}
  async handle(message:Message,queueUrl:string,signal:AbortSignal=new AbortController().signal):Promise<'CONSUMED'|'REPLAY'|'RETRY'|'ABANDONED'>{
    if(!message.ReceiptHandle)throw new Error('Missing event receipt');
    const trace: TraceContext = { messageId: message.MessageId };
    try{
      const event=validateIntegrationEvent(message.Body??'');
      const data = event.payload.data as Record<string, unknown>;
      Object.assign(trace, { messageId: event.eventId, correlationId: event.payload.correlationId,
        transactionId: data.transactionId, walletId: data.walletId, providerId: data.providerId });
      const result=await this.receipts.consume(event,signal);
      if (result === 'REPLAY') this.telemetry.increment('duplicates_detected', 'events');
      this.telemetry.log('info', result === 'REPLAY' ? 'event_replayed' : 'event_consumed', trace);
      signal.throwIfAborted();
      // Persistent deduplication effect has committed before any SQS delete.
      await this.sqs.client.send(new DeleteMessageCommand({QueueUrl:queueUrl,ReceiptHandle:message.ReceiptHandle}),{abortSignal:signal});
      return result;
    }catch{
      if(signal.aborted)return 'ABANDONED';
      this.telemetry.increment('retries_total', 'events');
      this.telemetry.log('warn', 'event_retry', trace);
      try{await this.sqs.client.send(new ChangeMessageVisibilityCommand({QueueUrl:queueUrl,ReceiptHandle:message.ReceiptHandle,VisibilityTimeout:30}),{abortSignal:signal});}
      catch{/* No delete: preserve the original event for retry. */}
      return 'RETRY';
    }
  }
}
