import { Inject, Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { TelemetryService } from '../../observability/telemetry.service';
import { ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import { AppConfig } from '../../config/app-config';
import { OutboxPublisher } from '../../application/outbox-publisher';
import { SqsService } from '../sqs/sqs.service';
import { IntegrationEventConsumer } from './event-consumer';

/** Independent loops: consumer failure cannot block publication of durable events. */
@Injectable()
export class OutboxWorkers implements OnModuleInit,OnModuleDestroy {
  private readonly polling=new AbortController();
  private readonly work=new AbortController();
  private stopping=false;
  private tasks:Promise<void>[]=[];
  constructor(@Inject(AppConfig)private readonly config:AppConfig,@Inject(OutboxPublisher)private readonly publisher:OutboxPublisher,
    @Inject(IntegrationEventConsumer)private readonly consumer:IntegrationEventConsumer,@Inject(SqsService)private readonly sqs:SqsService,
    @Inject(TelemetryService)private readonly telemetry:TelemetryService){}
  onModuleInit():void{
    if(this.config.outbox.publisherEnabled)this.tasks.push(this.publishLoop());
    if(this.config.outbox.consumerEnabled)this.tasks.push(this.consumeLoop());
  }
  private async pause():Promise<void>{
    if(this.stopping)return;
    await new Promise<void>((resolve)=>{
      const signal=this.polling.signal;
      const finish=()=>{clearTimeout(timer);signal.removeEventListener('abort',finish);resolve();};
      const timer=setTimeout(finish,1000);signal.addEventListener('abort',finish,{once:true});
      if(signal.aborted)finish();
    });
  }
  private async publishLoop():Promise<void>{
    while(!this.stopping){
      try{await this.publisher.run(this.work.signal);}catch{if(!this.stopping)this.telemetry.log('warn','outbox_poll_unavailable');}
      await this.pause();
    }
  }
  private async consumeLoop():Promise<void>{
    while(!this.stopping){
      try{
        const QueueUrl=await this.sqs.queueUrl(this.config.outbox.queueName);
        const batch=await this.sqs.client.send(new ReceiveMessageCommand({QueueUrl,WaitTimeSeconds:2,MaxNumberOfMessages:5,
          VisibilityTimeout:30}),{abortSignal:this.polling.signal});
        for(const message of batch.Messages??[]){if(this.stopping)break;await this.consumer.handle(message,QueueUrl,this.work.signal);}
      }catch{if(!this.stopping){this.telemetry.log('warn','event_poll_unavailable');await this.pause();}}
    }
  }
  async onModuleDestroy():Promise<void>{
    this.stopping=true;this.polling.abort();
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{await Promise.race([Promise.allSettled(this.tasks),new Promise<void>((resolve)=>{
      timer=setTimeout(()=>{this.work.abort();resolve();},this.config.messaging.shutdownMs);
    })]);}finally{clearTimeout(timer);}
  }
}
