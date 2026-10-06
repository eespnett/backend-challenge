import { ChangeMessageVisibilityCommand, DeleteMessageCommand, Message } from '@aws-sdk/client-sqs';
import { validateIntegrationEvent } from '../../application/integration-event-envelope';
import { MikroOrmEventReceiptStore } from '../persistence/event-receipt-store';
import { SqsService } from '../sqs/sqs.service';

export class IntegrationEventConsumer {
  constructor(private readonly receipts:MikroOrmEventReceiptStore,private readonly sqs:SqsService){}
  async handle(message:Message,queueUrl:string,signal:AbortSignal=new AbortController().signal):Promise<'CONSUMED'|'REPLAY'|'RETRY'|'ABANDONED'>{
    if(!message.ReceiptHandle)throw new Error('Missing event receipt');
    try{
      const event=validateIntegrationEvent(message.Body??'');
      const result=await this.receipts.consume(event,signal);
      signal.throwIfAborted();
      // Persistent deduplication effect has committed before any SQS delete.
      await this.sqs.client.send(new DeleteMessageCommand({QueueUrl:queueUrl,ReceiptHandle:message.ReceiptHandle}),{abortSignal:signal});
      return result;
    }catch{
      if(signal.aborted)return 'ABANDONED';
      try{await this.sqs.client.send(new ChangeMessageVisibilityCommand({QueueUrl:queueUrl,ReceiptHandle:message.ReceiptHandle,VisibilityTimeout:30}),{abortSignal:signal});}
      catch{/* No delete: preserve the original event for retry. */}
      return 'RETRY';
    }
  }
}
