import 'reflect-metadata';
import { afterEach,beforeEach,describe,expect,spyOn,test } from 'bun:test';
import { CreateQueueCommand,DeleteQueueCommand,SendMessageCommand,DeleteMessageCommand } from '@aws-sdk/client-sqs';
import { OutboxPublisher } from '../../src/application/outbox-publisher';
import { IntegrationEventConsumer } from '../../src/infrastructure/outbox/event-consumer';
import { MikroOrmEventReceiptStore } from '../../src/infrastructure/persistence/event-receipt-store';
import { phase7Harness } from '../support/phase7-harness';
import { assertLedgerConsistency } from '../support/assert-ledger-consistency';
import { deferred,parallelRequests,withDeadline } from '../support/concurrency-helpers';
import { ProcessWagerTransactionUseCase } from '../../src/application/process-wager-transaction';
import { wagerBody } from '../support/phase3-harness';
import { WagerTransactionKind } from '../../src/domain/wager-transaction';

describe('Phase 7: real PostgreSQL + LocalStack outbox',()=>{
  let h:Awaited<ReturnType<typeof phase7Harness>>;
  beforeEach(async()=>{h=await phase7Harness();});
  afterEach(async()=>{try{await assertLedgerConsistency(h.orm,{allowPublished:true});}finally{await h.close();}});

  test('two publishers race one event: one claim, one confirmed publication and one receipt',async()=>{
    await h.singleEvent();
    const result=await parallelRequests(2,(i)=>h.publisher(`publisher-${i}`).run());
    expect(result.flat()).toEqual(['PUBLISHED']);
    const row=(await h.rows())[0]!;expect(row.attempts).toBe(1);expect(row.published_at).not.toBeNull();expect(row.lease_token).toBeNull();
    const message=(await h.receive())!;expect(JSON.parse(message.Body!).eventId).toBe(row.id);
    expect(message.Attributes?.MessageDeduplicationId).toBe(row.id);
    expect(await h.consumer.handle(message,h.queueUrl)).toBe('CONSUMED');expect(await h.receive()).toBeUndefined();
    expect(await h.sql('select count(*)::text as count from wagering.integration_event_receipts')).toEqual([{count:'1'}]);
    expect(await h.publisher('already-published').run()).toEqual([]);
  });

  test('expired lease is reclaimed; previous worker cannot confirm, renew or schedule retry',async()=>{
    await h.singleEvent();const [old]=await h.store.claim('old',1,30000);
    expect(await h.store.claim('other',1,30000)).toEqual([]);
    await h.expire();expect(await h.store.published(old!)).toBe(false);
    const [fresh]=await h.store.claim('replacement',1,30000);
    expect(fresh?.eventId).toBe(old?.eventId);expect(fresh?.leaseToken).not.toBe(old?.leaseToken);expect(fresh?.attempts).toBe(2);
    expect(await h.store.renew(old!,30000)).toBe(false);expect(await h.store.retry(old!,'STALE',1000)).toBe(false);
    await h.transport.send(fresh!,new AbortController().signal);
    expect(await h.store.published(fresh!)).toBe(true);
    expect((await h.rows())[0]?.id).toBe(old?.eventId);
  });

  test('committed pending event survives no publisher, and abandoned claim before send is recovered',async()=>{
    await h.singleEvent();const original=(await h.rows())[0]!;
    expect(await h.receive()).toBeUndefined();await h.store.claim('crashed-before-send',1,30000);
    await h.expire();expect(await h.publisher('restarted').run()).toEqual(['PUBLISHED']);
    const row=(await h.rows())[0]!;expect(row.id).toBe(original.id);expect(row.payload).toEqual(original.payload);expect(row.attempts).toBe(2);
    expect(JSON.parse((await h.receive())!.Body!).eventId).toBe(original.id);
  });

  test('send succeeds before confirmation crash; recovery republishes same eventId, consumer deduplicates fresh delivery persistently',async()=>{
    await h.singleEvent();const [claim]=await h.store.claim('crashed-after-send',1,30000);
    await h.transport.send(claim!,new AbortController().signal);
    expect((await h.rows())[0]?.published_at).toBeNull();
    const first=(await h.receive())!;expect(await h.consumer.handle(first,h.queueUrl)).toBe('CONSUMED');
    await h.expire();expect(await h.publisher('restarted').run()).toEqual(['PUBLISHED']);
    expect((await h.rows())[0]?.id).toBe(claim?.eventId);
    // FIFO dedup applies within five minutes; force a later delivery with the identical eventId.
    await h.sendDuplicate(claim!.payload as Record<string,unknown>);
    const duplicate=(await h.receive())!;expect(JSON.parse(duplicate.Body!).eventId).toBe(claim?.eventId);
    const restartedConsumer=new IntegrationEventConsumer(new MikroOrmEventReceiptStore(h.orm),h.sqs);
    expect(await restartedConsumer.handle(duplicate,h.queueUrl)).toBe('REPLAY');
    expect(await h.sql('select count(*)::text as count from wagering.integration_event_receipts')).toEqual([{count:'1'}]);
  });

  test('publisher never sees uncommitted financial events or sends before commit',async()=>{
    const wallet=await h.wallet('0.00');const staged=deferred<void>();const release=deferred<void>();
    const process=new ProcessWagerTransactionUseCase({run:(work)=>h.manager.run(async(uow)=>{
      const result=await work(uow);staged.resolve();await release.promise;return result;
    })});
    const processing=process.execute(wagerBody(wallet,WagerTransactionKind.Win,'25.00'),crypto.randomUUID());
    try{await staged.promise;expect(await h.publisher().run()).toEqual([]);expect(await h.receive()).toBeUndefined();}
    finally{release.resolve();}
    expect((await processing).httpStatus).toBe(200);
    expect(await h.publisher().run()).toEqual(['PUBLISHED','PUBLISHED']);
  });

  test('SQS send blocked after real confirmation holds no wallet or financial transaction locks',async()=>{
    const wallet=await h.wallet();const entered=deferred<void>();const release=deferred<void>();
    const send=h.sqs.client.send.bind(h.sqs.client);
    const intercepted=spyOn(h.sqs.client,'send').mockImplementation((async(command:unknown,options:unknown)=>{
      const result=await send(command as never,options as never);
      if(command instanceof SendMessageCommand){entered.resolve();await release.promise;}return result;
    }) as typeof h.sqs.client.send);
    const publishing=h.publisher().run();
    try{
      await entered.promise;
      const processed=await withDeadline(h.post(wagerBody(wallet)),2000,'financial progress during SQS send');
      expect(processed.httpStatus).toBe(200);expect(processed.body.balance.amount).toBe('75.00');
      expect(await h.sql("select id from wagering.outbox_events where published_at is not null")).toEqual([]);
    }finally{release.resolve();await publishing;intercepted.mockRestore();}
  });

  test('retry/backoff persists attempts and failures forever; restoration publishes existing event',async()=>{
    await h.singleEvent();const id=(await h.rows())[0]!.id;
    await h.sqs.client.send(new DeleteQueueCommand({QueueUrl:h.queueUrl}));
    for(let attempt=1;attempt<=7;attempt++){
      await h.due();expect(await h.publisher('retry-worker').run()).toEqual(['RETRY']);
      const row=(await h.rows())[0]!;expect(row.id).toBe(id);expect(row.attempts).toBe(attempt);
      expect(row.published_at).toBeNull();expect(row.last_error).toBe('SQS_SEND_FAILED');expect(row.lease_token).toBeNull();
      expect(await h.store.claim('not-yet-due',1,30000)).toEqual([]);
    }
    await h.sqs.client.send(new CreateQueueCommand({QueueName:h.queueName,Attributes:{FifoQueue:'true',VisibilityTimeout:'30',MessageRetentionPeriod:'1209600'}}));
    await h.due();expect(await h.publisher('restored').run()).toEqual(['PUBLISHED']);
    const row=(await h.rows())[0]!;expect(row.id).toBe(id);expect(row.attempts).toBe(8);expect(row.last_error).toBeNull();
    expect(JSON.parse((await h.receive())!.Body!).eventId).toBe(id);
  });

  test('receipt commit before failed ack redelivers safely and cannot change original event payload',async()=>{
    await h.singleEvent();await h.publisher().run();const first=(await h.receive())!;
    const send=h.sqs.client.send.bind(h.sqs.client);
    const intercepted=spyOn(h.sqs.client,'send').mockImplementation((async(command:unknown,options:unknown)=>{
      if(command instanceof DeleteMessageCommand)throw new Error('Crash before consumer ack');
      return send(command as never,options as never);
    }) as typeof h.sqs.client.send);
    try{expect(await h.consumer.handle(first,h.queueUrl)).toBe('RETRY');}finally{intercepted.mockRestore();}
    await h.release(first);expect(await h.consumer.handle((await h.receive())!,h.queueUrl)).toBe('REPLAY');
    const payload=(await h.rows())[0]!.payload;
    await h.sendDuplicate({...payload,correlationId:'different'});
    expect(await h.consumer.handle((await h.receive())!,h.queueUrl)).toBe('RETRY');
    expect(await h.sql('select payload from wagering.integration_event_receipts')).toEqual([{payload}]);
  });

  test('direct SQL protects event identity/content/audit and validates lease shape/attempts',async()=>{
    await h.singleEvent();const id=(await h.rows())[0]!.id;
    for(const [statement,params,code] of [
      ["update wagering.outbox_events set payload=jsonb_set(payload,'{correlationId}','\"changed\"') where id=?",[id],'55000'],
      ['delete from wagering.outbox_events where id=?',[id],'55000'],
      ['update wagering.outbox_events set attempts=-1 where id=?',[id],'23514'],
      ['update wagering.outbox_events set lease_token=gen_random_uuid() where id=?',[id],'23514'],
    ] as const){let error:unknown;try{await h.sql(statement,[...params]);}catch(caught){error=caught;}expect((error as {code:string}).code).toBe(code);}
    await h.publisher().run();await h.consumer.handle((await h.receive())!,h.queueUrl);
    await expect(h.sql('update wagering.outbox_events set published_at=null where id=?',[id])).rejects.toThrow();
    await expect(h.sql('delete from wagering.integration_event_receipts where event_id=?',[id])).rejects.toThrow();
    await expect(h.sql("update wagering.integration_event_receipts set payload_hash=repeat('b',64) where event_id=?",[id])).rejects.toThrow();
  });

  test('publisher lease heartbeat retains ownership during slow SQS delivery',async()=>{
    await h.singleEvent();const entered=deferred<void>();const release=deferred<void>();
    const publisher=new OutboxPublisher(h.store,{send:async(claim,signal)=>{entered.resolve();await release.promise;await h.transport.send(claim,signal);}},'slow-publisher',300);
    const publishing=publisher.run();
    try{
      await entered.promise;await new Promise((resolve)=>setTimeout(resolve,750));
      expect(await h.store.claim('competing-worker',1,300)).toEqual([]);
      expect((await h.rows())[0]?.attempts).toBe(1);
    }finally{release.resolve();}
    expect(await publishing).toEqual(['PUBLISHED']);
  });

  test('locked outbox row is skipped immediately; confirmation cannot outlive a blocked lease',async()=>{
    await h.singleEvent();const [claim]=await h.store.claim('owner',1,300);
    const acquired=deferred<void>();const release=deferred<void>();
    const lock=h.orm.em.fork({clear:true,useContext:false}).transactional(async(em)=>{
      await em.execute('select id from wagering.outbox_events where id=? for update',[claim!.eventId]);
      acquired.resolve();await release.promise;
    });
    try{
      await acquired.promise;
      expect(await withDeadline(h.store.published(claim!),1000,'confirmation skips row lock')).toBe(false);
      expect(await h.store.renew(claim!,300)).toBe(false);
      await new Promise((resolve)=>setTimeout(resolve,350));
    }finally{release.resolve();await lock;}
    expect(await h.store.published(claim!)).toBe(false);
    expect(await h.publisher('replacement').run()).toEqual(['PUBLISHED']);
  });

  test('two independent event consumers race duplicate eventId and persist one effect',async()=>{
    await h.singleEvent();await h.publisher().run();const original=(await h.receive())!;
    const row=(await h.rows())[0]!;await h.sendDuplicate(row.payload,crypto.randomUUID());
    const duplicate=(await h.receive())!;expect(duplicate.MessageId).not.toBe(original.MessageId);
    const messages=[original,duplicate];
    const results=await parallelRequests(2,(i)=>new IntegrationEventConsumer(new MikroOrmEventReceiptStore(h.orm),h.sqs).handle(messages[i]!,h.queueUrl));
    expect(results.sort()).toEqual(['CONSUMED','REPLAY']);
    expect(await h.sql('select count(*)::text as count from wagering.integration_event_receipts')).toEqual([{count:'1'}]);
  });

  test('confirmation infrastructure failure is audited and retried with the same eventId',async()=>{
    await h.singleEvent();const id=(await h.rows())[0]!.id;
    await h.sql(`create function wagering.fail_publication_marker() returns trigger language plpgsql as $$ begin
      if new.published_at is not null then raise exception 'Publication marker unavailable' using errcode='40001';end if;
      return new;end;$$;
      create trigger fail_publication_marker before update on wagering.outbox_events for each row execute function wagering.fail_publication_marker()`);
    try{expect(await h.publisher().run()).toEqual(['RETRY']);}
    finally{await h.sql('drop trigger fail_publication_marker on wagering.outbox_events;drop function wagering.fail_publication_marker()');}
    const row=(await h.rows())[0]!;expect(row.id).toBe(id);expect(row.published_at).toBeNull();expect(row.last_error).toBe('PUBLICATION_CONFIRMATION_FAILED');
    await h.due();expect(await h.publisher().run()).toEqual(['PUBLISHED']);expect((await h.rows())[0]!.id).toBe(id);
    expect(await h.consumer.handle((await h.receive())!,h.queueUrl)).toBe('CONSUMED');expect(await h.receive()).toBeUndefined();
  });
});
