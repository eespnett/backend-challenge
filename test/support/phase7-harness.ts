import { CreateQueueCommand, DeleteQueueCommand, ReceiveMessageCommand, SendMessageCommand,
  ChangeMessageVisibilityCommand, GetQueueAttributesCommand, Message } from '@aws-sdk/client-sqs';
import { AppConfig } from '../../src/config/app-config';
import { SqsService } from '../../src/infrastructure/sqs/sqs.service';
import { OutboxPublisher } from '../../src/application/outbox-publisher';
import { MikroOrmOutboxClaimStore } from '../../src/infrastructure/persistence/outbox-claim-store';
import { MikroOrmEventReceiptStore } from '../../src/infrastructure/persistence/event-receipt-store';
import { IntegrationEventConsumer } from '../../src/infrastructure/outbox/event-consumer';
import { SqsEventTransport } from '../../src/infrastructure/outbox/sqs-event-transport';
import { phase3Harness, wagerBody } from './phase3-harness';
import { WagerTransactionKind } from '../../src/domain/wager-transaction';

export interface OutboxRow { id:string;payload:Record<string,unknown>;published_at:Date|null;attempts:number;
  lease_token:string|null;lease_owner:string|null;lease_until:Date|null;next_attempt_at:Date;last_error:string|null }
export async function isolatedEventQueue(){
  const sqs=new SqsService(new AppConfig());
  const queueName=`phase7-events-${crypto.randomUUID()}.fifo`;
  try{
    const queueUrl=(await sqs.client.send(new CreateQueueCommand({QueueName:queueName,
      Attributes:{FifoQueue:'true',VisibilityTimeout:'30',MessageRetentionPeriod:'1209600'}}))).QueueUrl!;
    return {sqs,queueName,queueUrl,
      async empty(){const attrs=(await sqs.client.send(new GetQueueAttributesCommand({QueueUrl:queueUrl,
        AttributeNames:['ApproximateNumberOfMessages','ApproximateNumberOfMessagesNotVisible']}))).Attributes!;
        return attrs.ApproximateNumberOfMessages==='0'&&attrs.ApproximateNumberOfMessagesNotVisible==='0';},
      async receive():Promise<Message|undefined>{return(await sqs.client.send(new ReceiveMessageCommand({QueueUrl:queueUrl,
        MaxNumberOfMessages:1,WaitTimeSeconds:1,VisibilityTimeout:1,MessageSystemAttributeNames:['All']}))).Messages?.[0];},
      async sendDuplicate(payload:Record<string,unknown>,group:string=(payload.data as {walletId:string}).walletId){
        // Force another transport delivery to model republication outside SQS's 5-minute dedup window.
        return sqs.client.send(new SendMessageCommand({QueueUrl:queueUrl,MessageBody:JSON.stringify(payload),
          MessageGroupId:group,MessageDeduplicationId:crypto.randomUUID()}));
      },
      async release(message:Message){await sqs.client.send(new ChangeMessageVisibilityCommand({QueueUrl:queueUrl,
        ReceiptHandle:message.ReceiptHandle!,VisibilityTimeout:0}));},
      async close(){try{await sqs.client.send(new DeleteQueueCommand({QueueUrl:queueUrl}));}finally{sqs.onApplicationShutdown();}},
    };
  }catch(error){sqs.onApplicationShutdown();throw error;}
}
export async function phase7Harness(){
  const h=await phase3Harness();
  try{
    const queue=await isolatedEventQueue();
    const store=new MikroOrmOutboxClaimStore(h.orm);
    const transport=new SqsEventTransport(queue.sqs,queue.queueName);
    const consumer=new IntegrationEventConsumer(new MikroOrmEventReceiptStore(h.orm),queue.sqs);
    return {...h,...queue,store,transport,consumer,
      publisher:(owner:string=crypto.randomUUID(),leaseMs=30000)=>new OutboxPublisher(store,transport,owner,leaseMs),
      rows:()=>h.sql<OutboxRow[]>('select * from wagering.outbox_events order by created_at,id'),
      async singleEvent(){const wallet=await h.wallet('0.00');await h.post(wagerBody(wallet,WagerTransactionKind.Loss,'0.00'));return wallet;},
      async due(){await h.sql("update wagering.outbox_events set next_attempt_at=clock_timestamp()-interval '1 ms' where published_at is null");},
      async expire(){await h.sql("update wagering.outbox_events set lease_until=clock_timestamp()-interval '1 ms' where published_at is null and lease_token is not null");},
      async close(){try{await queue.close();}finally{await h.close();}},
    };
  }catch(error){await h.close();throw error;}
}
