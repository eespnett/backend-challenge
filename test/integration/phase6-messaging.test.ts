import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { DeleteMessageCommand, SendMessageCommand, GetQueueAttributesCommand, ChangeMessageVisibilityCommand } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { AppConfig } from '../../src/config/app-config';
import { createOrmConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import type { StoredProcessingResult } from '../../src/application/processing-result';
import type { TransactionManager } from '../../src/application/financial-unit-of-work';
import { WagerConsumer } from '../../src/infrastructure/messaging/wager-consumer';
import { phase6Harness, wagerEnvelope } from '../support/phase6-harness';
import { wagerBody } from '../support/phase3-harness';
import { assertLedgerConsistency } from '../support/assert-ledger-consistency';
import { deferred, holdWalletLock, waitUntil, waitingWalletLocks, withDeadline, parallelRequests } from '../support/concurrency-helpers';

describe('Phase 6: real PostgreSQL + LocalStack inbox/ack/retry/DLQ', () => {
  let h: Awaited<ReturnType<typeof phase6Harness>>;
  beforeEach(async () => { h = await phase6Harness(); });
  afterEach(async () => { try { await assertLedgerConsistency(h.orm); } finally { await h.close(); } });

  test('HTTP then SQS same operation share original result; distinct messages cannot duplicate effects', async () => {
    const wallet = await h.wallet(); const body = wagerBody(wallet); const key = crypto.randomUUID();
    const http = await h.post(body,key);
    for (let n=0;n<2;n++) {
      const envelope = wagerEnvelope(body,key);
      expect((await h.deliver(envelope)).outcome).toBe('ACK');
      const inbox = await h.inbox(envelope.messageId);
      expect(inbox?.result).toEqual({ httpStatus:200,body:{...http.body,idempotentReplay:true} });
    }
    expect((await h.state(wallet.id)).balance).toBe('75.00');
    expect((await h.state(wallet.id)).ledger).toBe('2'); // opening + one BET
  });

  test('same logical messageId/hash sent again is acknowledged without new transaction/events', async () => {
    const wallet = await h.wallet(); const envelope = wagerEnvelope(wagerBody(wallet));
    expect((await h.deliver(envelope)).outcome).toBe('ACK');
    const before = await h.state(wallet.id); const inbox = await h.inbox(envelope.messageId);
    expect((await h.deliver(envelope)).outcome).toBe('ACK');
    expect(await h.state(wallet.id)).toEqual(before);
    expect(await h.inbox(envelope.messageId)).toEqual(inbox);
    expect(await h.receive()).toBeUndefined();
  });

  test('SQS first then HTTP returns the persisted financial result as replay',async()=>{
    const wallet=await h.wallet();const body=wagerBody(wallet);const key=crypto.randomUUID();
    const envelope=wagerEnvelope(body,key);
    expect((await h.deliver(envelope)).outcome).toBe('ACK');
    const snapshot=(await h.inbox(envelope.messageId))!.result as StoredProcessingResult;
    const before=await h.state(wallet.id);
    expect(await h.post(body,key)).toEqual({httpStatus:200,body:{...snapshot.body,idempotentReplay:true}});
    expect(await h.state(wallet.id)).toEqual(before);
  });

  test('same messageId with different hash preserves original inbox and forwards exact body to DLQ', async () => {
    const wallet = await h.wallet(); const envelope = wagerEnvelope(wagerBody(wallet));
    await h.deliver(envelope); const before = await h.state(wallet.id); const inbox = await h.inbox(envelope.messageId);
    const altered = { ...envelope, data:{...envelope.data,money:{amount:'30.00',currency:'BRL'}} };
    expect((await h.deliver(altered)).outcome).toBe('DLQ');
    expect(await h.inbox(envelope.messageId)).toEqual(inbox);
    expect(await h.state(wallet.id)).toEqual(before);
    const dlq = await h.receive(true);
    expect(JSON.parse(dlq!.Body!)).toEqual(altered);
    expect(dlq?.MessageAttributes?.FailureCode?.StringValue).toBe('MESSAGE_ID_CONFLICT');
    expect(dlq?.MessageAttributes?.OriginalMessageId?.StringValue).toBe(envelope.messageId);
    expect(await h.receive()).toBeUndefined();
  });

  test('commit before failed ack redelivers original SQS identity without financial duplicate', async () => {
    const wallet = await h.wallet(); const envelope = wagerEnvelope(wagerBody(wallet));
    const send = h.sqs.client.send.bind(h.sqs.client);
    const intercepted = spyOn(h.sqs.client,'send').mockImplementation((async (command: unknown, options: unknown) => {
      if(command instanceof DeleteMessageCommand) throw new Error('Connection lost before ack');
      return send(command as never,options as never);
    }) as typeof h.sqs.client.send);
    let first;
    try { first = await h.deliver(envelope); } finally { intercepted.mockRestore(); }
    expect(first.outcome).toBe('RETRY');
    expect((await h.inbox(envelope.messageId))?.status).toBe('PROCESSED');
    const committed = await h.state(wallet.id);
    await h.release(first.message); const redelivery = (await h.receive())!;
    expect(redelivery.MessageId).toBe(first.message.MessageId);
    expect(redelivery.Attributes?.ApproximateReceiveCount).toBe('2');
    expect(await h.consumer.handle(redelivery,h.queueUrl,h.dlqUrl)).toBe('ACK');
    expect(await h.state(wallet.id)).toEqual(committed);
  });

  test('business rejection and idempotency conflicts are durable and acknowledged', async () => {
    const wallet = await h.wallet('0.00'); const body = wagerBody(wallet); const key = crypto.randomUUID();
    const envelope = wagerEnvelope(body,key);
    expect((await h.deliver(envelope)).outcome).toBe('ACK');
    expect((await h.inbox(envelope.messageId))?.result).toMatchObject({httpStatus:422,body:{status:'REJECTED',failureCode:'INSUFFICIENT_BALANCE'}});
    const conflict = wagerEnvelope({...body,money:{amount:'50.00',currency:'BRL'}},key);
    expect((await h.deliver(conflict)).outcome).toBe('ACK');
    expect((await h.inbox(conflict.messageId))?.error_code).toBe('IDEMPOTENCY_CONFLICT');
    expect((await h.state(wallet.id)).ledger).toBe('0');
    expect(await h.receive(true)).toBeUndefined();
  });

  test('PENDING_REFERENCE is acknowledged with one event and persistent future work', async () => {
    const wallet = await h.wallet();
    const envelope = wagerEnvelope(wagerBody(wallet,'REFUND' as never,'25.00',{referenceExternalTransactionId:'future-bet'}));
    expect((await h.deliver(envelope)).outcome).toBe('ACK');
    await h.deliver(envelope);
    expect((await h.inbox(envelope.messageId))?.result).toMatchObject({httpStatus:202,body:{status:'PENDING_REFERENCE'}});
    expect(await h.sql("select count(*)::text as count from wagering.pending_reference_jobs")).toEqual([{count:'1'}]);
    expect(await h.sql("select count(*)::text as count from wagering.outbox_events where event_type='WagerTransactionPendingReference'")).toEqual([{count:'1'}]);
    expect((await h.state(wallet.id)).balance).toBe('100.00');
    expect((await h.state(wallet.id)).ledger).toBe('1');
  });

  test('failure after wallet mutation rolls back inbox, balance, transaction, ledger and outbox; retry succeeds', async () => {
    const wallet = await h.wallet(); const envelope = wagerEnvelope(wagerBody(wallet)); const before = await h.state(wallet.id);
    await h.sql(`create function wagering.fail_inbox_probe() returns trigger language plpgsql as $$ begin
      raise exception 'Transient probe' using errcode='40001'; end; $$;
      create trigger fail_inbox_probe before insert on wagering.wallet_ledger_entries for each row execute function wagering.fail_inbox_probe()`);
    let delivery;
    try { delivery = await h.deliver(envelope); } finally {
      await h.sql('drop trigger fail_inbox_probe on wagering.wallet_ledger_entries;drop function wagering.fail_inbox_probe()');
    }
    expect(delivery.outcome).toBe('RETRY');
    expect(await h.inbox(envelope.messageId)).toBeUndefined();
    expect(await h.state(wallet.id)).toEqual(before);
    await h.release(delivery.message);
    expect(await h.consumer.handle((await h.receive())!,h.queueUrl,h.dlqUrl)).toBe('ACK');
    expect((await h.state(wallet.id)).balance).toBe('75.00');
  });

  test('PostgreSQL temporarily refuses connections: no ack, then recovery processes once', async () => {
    const wallet = await h.wallet(); const envelope = wagerEnvelope(wagerBody(wallet));
    await h.send(envelope); const message = (await h.receive())!;
    const admin = await MikroORM.init(createOrmConfig(new AppConfig()));
    const db = h.config.database.dbName;
    if (!/^phase2_probe_[0-9a-f]{32}$/.test(db)) throw new Error('Not an owned test database');
    try {
      await admin.em.getConnection().execute(`alter database "${db}" allow_connections false`);
      await admin.em.getConnection().execute('select pg_terminate_backend(pid) from pg_stat_activity where datname=?',[db]);
      expect(await h.consumer.handle(message,h.queueUrl,h.dlqUrl)).toBe('RETRY');
    } finally {
      await admin.em.getConnection().execute(`alter database "${db}" allow_connections true`);
      await admin.close(true);
    }
    expect(await h.inbox(envelope.messageId)).toBeUndefined();
    await h.release(message);
    expect(await h.consumer.handle((await h.receive())!,h.queueUrl,h.dlqUrl)).toBe('ACK');
    expect((await h.state(wallet.id)).balance).toBe('75.00');
  });

  test('native redrive after five transient receives retains original identity/body and no effects', async () => {
    const wallet = await h.wallet(); const envelope = wagerEnvelope(wagerBody(wallet)); const before = await h.state(wallet.id);
    await h.sql(`create function wagering.fail_retry_probe() returns trigger language plpgsql as $$ begin
      raise exception 'Retry probe' using errcode='40001'; end; $$;
      create trigger fail_retry_probe before insert on wagering.consumer_inbox for each row execute function wagering.fail_retry_probe()`);
    try {
      const sent = await h.send(envelope);
      for(let attempt=1;attempt<=5;attempt++) {
        const message = (await h.receive())!;
        expect(message.MessageId).toBe(sent.MessageId);
        expect(message.Attributes?.ApproximateReceiveCount).toBe(String(attempt));
        expect(await h.consumer.handle(message,h.queueUrl,h.dlqUrl)).toBe('RETRY');
        await h.release(message);
      }
      expect(await h.receive()).toBeUndefined();
      const dlq = (await h.receive(true))!;
      expect(dlq.MessageId).toBe(sent.MessageId);
      expect(JSON.parse(dlq.Body!)).toEqual(envelope);
      expect(await h.inbox(envelope.messageId)).toBeUndefined();
      expect(await h.state(wallet.id)).toEqual(before);
    } finally { await h.sql('drop trigger fail_retry_probe on wagering.consumer_inbox;drop function wagering.fail_retry_probe()'); }
  });

  test('permanent invalid payload goes to DLQ; DLQ send failure never deletes source', async () => {
    const envelope = {messageId:crypto.randomUUID(),type:'bad',occurredAt:new Date().toISOString(),data:{}};
    const send = h.sqs.client.send.bind(h.sqs.client);
    const intercepted = spyOn(h.sqs.client,'send').mockImplementation((async (command: unknown, options: unknown) => {
      if(command instanceof SendMessageCommand && command.input.QueueUrl===h.dlqUrl) throw new Error('DLQ unavailable');
      return send(command as never,options as never);
    }) as typeof h.sqs.client.send);
    let delivery;
    try { delivery=await h.deliver(envelope); } finally { intercepted.mockRestore(); }
    expect(delivery.outcome).toBe('RETRY');
    expect((await h.inbox(envelope.messageId))?.status).toBe('REJECTED');
    await h.release(delivery.message); const message=(await h.receive())!;
    expect(message.MessageId).toBe(delivery.message.MessageId);
    expect(await h.consumer.handle(message,h.queueUrl,h.dlqUrl)).toBe('DLQ');
    expect(JSON.parse((await h.receive(true))!.Body!)).toEqual(envelope);
    expect(await h.receive()).toBeUndefined();
  });

  test('DLQ confirmed but failed source ack resumes without resending dead letter', async () => {
    const envelope={messageId:crypto.randomUUID(),type:'bad'};
    const send=h.sqs.client.send.bind(h.sqs.client);
    const intercepted=spyOn(h.sqs.client,'send').mockImplementation((async(command:unknown,options:unknown)=>{
      if(command instanceof DeleteMessageCommand)throw new Error('Crash before source delete');
      return send(command as never,options as never);
    }) as typeof h.sqs.client.send);
    let delivery;
    try{delivery=await h.deliver(envelope);}finally{intercepted.mockRestore();}
    expect(delivery.outcome).toBe('RETRY');
    const forwarded=(await h.receive(true))!;
    await h.release(delivery.message);
    expect(await h.consumer.handle((await h.receive())!,h.queueUrl,h.dlqUrl)).toBe('DLQ');
    expect(await h.sql('select count(*)::text as count from wagering.consumer_dead_letters where sent_at is not null')).toEqual([{count:'1'}]);
    await h.sqs.client.send(new DeleteMessageCommand({QueueUrl:h.dlqUrl,ReceiptHandle:forwarded.ReceiptHandle!}));
    expect(await h.receive(true)).toBeUndefined();
  });

  test('ack waits for commit while financial transaction is blocked on wallet lock', async () => {
    const wallet=await h.wallet();const envelope=wagerEnvelope(wagerBody(wallet));
    await h.send(envelope); const message=(await h.receive())!;
    const lock=await holdWalletLock(h.orm,wallet.id);
    const original=h.sqs.client.send.bind(h.sqs.client);const ack=deferred<void>();let deleted=false;
    const intercepted=spyOn(h.sqs.client,'send').mockImplementation((async(command:unknown,options:unknown)=>{
      if(command instanceof DeleteMessageCommand){deleted=true;ack.resolve();expect((await h.inbox(envelope.messageId))?.status).toBe('PROCESSED');}
      return original(command as never,options as never);
    }) as typeof h.sqs.client.send);
    const work=h.consumer.handle(message,h.queueUrl,h.dlqUrl);
    try {
      await waitUntil(async()=> (await waitingWalletLocks(h.orm)).length>0,'wallet lock');
      expect(deleted).toBe(false);expect(await h.inbox(envelope.messageId)).toBeUndefined();
    } finally {await lock.release();}
    try{expect(await work).toBe('ACK');await ack.promise;}finally{intercepted.mockRestore();}
  });

  test('queue configuration has FIFO, visibility 30s, maxReceiveCount 5 and longer DLQ retention', async()=>{
    const main=(await h.sqs.client.send(new GetQueueAttributesCommand({QueueUrl:h.queueUrl,AttributeNames:['All']}))).Attributes!;
    const dlq=(await h.sqs.client.send(new GetQueueAttributesCommand({QueueUrl:h.dlqUrl,AttributeNames:['All']}))).Attributes!;
    expect(main.FifoQueue).toBe('true');expect(main.VisibilityTimeout).toBe('30');
    expect(String(JSON.parse(main.RedrivePolicy!).maxReceiveCount)).toBe('5');
    expect(Number(dlq.MessageRetentionPeriod)).toBeGreaterThan(Number(main.MessageRetentionPeriod));
  });

  test('valid envelope with invalid money is a permanent payload error, never a financial effect',async()=>{
    const wallet=await h.wallet();const before=await h.state(wallet.id);
    const envelope=wagerEnvelope({...wagerBody(wallet),money:{amount:'1e3',currency:'BRL'}});
    expect((await h.deliver(envelope)).outcome).toBe('DLQ');
    expect((await h.inbox(envelope.messageId))?.error_code).toBe('INVALID_PAYLOAD');
    expect((await h.receive(true))?.MessageAttributes?.FailureCode?.StringValue).toBe('INVALID_PAYLOAD');
    expect(await h.state(wallet.id)).toEqual(before);
  });

  test('permanent valid-envelope failure resumes forwarding after send fails; rejected inbox cannot hide pending DLQ',async()=>{
    const envelope=wagerEnvelope({providerId:'provider',externalTransactionId:crypto.randomUUID(),playerId:'player',
      walletId:crypto.randomUUID(),roundId:'round',gameId:'game',kind:'BET',money:{amount:'25.00',currency:'BRL'}});
    const send=h.sqs.client.send.bind(h.sqs.client);
    const intercepted=spyOn(h.sqs.client,'send').mockImplementation((async(command:unknown,options:unknown)=>{
      if(command instanceof SendMessageCommand && command.input.QueueUrl===h.dlqUrl)throw new Error('DLQ unavailable');
      return send(command as never,options as never);
    }) as typeof h.sqs.client.send);
    let delivery;
    try{delivery=await h.deliver(envelope);}finally{intercepted.mockRestore();}
    expect(delivery.outcome).toBe('RETRY');expect((await h.inbox(envelope.messageId))?.status).toBe('REJECTED');
    await h.release(delivery.message);
    expect(await h.consumer.handle((await h.receive())!,h.queueUrl,h.dlqUrl)).toBe('DLQ');
    expect((await h.receive(true))?.MessageAttributes?.FailureCode?.StringValue).toBe('INVALID_PAYLOAD');
  });

  test('long-running delivery renews visibility to 30 seconds without changing message identity',async()=>{
    const wallet=await h.wallet();const envelope=wagerEnvelope(wagerBody(wallet));
    await h.send(envelope);const message=(await h.receive())!;
    // Other redelivery tests accelerate visibility to 1s; heartbeat uses the production 30s lease.
    await h.sqs.client.send(new ChangeMessageVisibilityCommand({QueueUrl:h.queueUrl,
      ReceiptHandle:message.ReceiptHandle!,VisibilityTimeout:30}));
    const send=h.sqs.client.send.bind(h.sqs.client);const renewed=deferred<void>();
    await h.sql(`create function wagering.slow_ledger_probe() returns trigger language plpgsql as $$ begin
      perform pg_sleep(11);return new;end;$$;
      create trigger slow_ledger_probe before insert on wagering.wallet_ledger_entries for each row execute function wagering.slow_ledger_probe()`);
    const intercepted=spyOn(h.sqs.client,'send').mockImplementation((async(command:unknown,options:unknown)=>{
      const result=await send(command as never,options as never);
      if(command instanceof ChangeMessageVisibilityCommand){
        expect(command.input.ReceiptHandle).toBe(message.ReceiptHandle);
        expect(command.input.VisibilityTimeout).toBe(30);renewed.resolve();
      }
      return result;
    }) as typeof h.sqs.client.send);
    const processing=h.consumer.handle(message,h.queueUrl,h.dlqUrl);
    try{
      await withDeadline(renewed.promise,12000,'visibility renewal');
      expect(await h.receive()).toBeUndefined();
      expect(await processing).toBe('ACK');
    }finally{
      await processing;intercepted.mockRestore();
      await h.sql('drop trigger slow_ledger_probe on wagering.wallet_ledger_entries;drop function wagering.slow_ledger_probe()');
    }
    expect((await h.state(wallet.id)).balance).toBe('75.00');
  });

  test('direct SQL enforces inbox identity uniqueness, completed result immutability and valid states',async()=>{
    const wallet=await h.wallet();const envelope=wagerEnvelope(wagerBody(wallet));await h.deliver(envelope);
    for(const [statement,params,code] of [
      ['insert into wagering.consumer_inbox(consumer_name,message_id,payload_hash) select consumer_name,message_id,payload_hash from wagering.consumer_inbox where message_id=?',[envelope.messageId],'23505'],
      ["update wagering.consumer_inbox set payload_hash=repeat('b',64) where message_id=?",[envelope.messageId],'55000'],
      ["update wagering.consumer_inbox set result='{}'::jsonb where message_id=?",[envelope.messageId],'55000'],
      ["insert into wagering.consumer_inbox(consumer_name,message_id,payload_hash,status) values('probe','invalid',repeat('a',64),'UNKNOWN')",[],'23514'],
    ] as const){
      let error:unknown;try{await h.sql(statement,[...params]);}catch(caught){error=caught;}
      expect((error as {code:string}).code).toBe(code);
    }
  });

  test('same external operation with different keys is acknowledged as conflict, without duplicate effect',async()=>{
    const wallet=await h.wallet();const body=wagerBody(wallet);
    await h.deliver(wagerEnvelope(body));
    const conflicting=wagerEnvelope(body);
    expect((await h.deliver(conflicting)).outcome).toBe('ACK');
    expect((await h.inbox(conflicting.messageId))?.error_code).toBe('EXTERNAL_TRANSACTION_CONFLICT');
    expect((await h.state(wallet.id)).balance).toBe('75.00');
    expect((await h.state(wallet.id)).ledger).toBe('2');
  });

  test('cross-wallet SQL uniqueness race rolls back losing financial effect and recovers inbox in fresh transaction',async()=>{
    const wallets=[await h.wallet(),await h.wallet()];const key=crypto.randomUUID();const external=crypto.randomUUID();
    const envelopes=wallets.map((wallet)=>wagerEnvelope(wagerBody(wallet,undefined,'25.00',{externalTransactionId:external}),key));
    for(const envelope of envelopes)await h.send(envelope);
    const messages=[(await h.receive())!,(await h.receive())!];const barrier=deferred<void>();let arrivals=0;
    const guarded:TransactionManager={run:(work)=>h.manager.run((uow)=>{
      const add=uow.transactions.add.bind(uow.transactions);
      uow.transactions.add=async(...args)=>{
        arrivals++;if(arrivals===2)barrier.resolve();
        if(arrivals<=2)await withDeadline(barrier.promise,3000,'both wallets updated before competing inserts');
        return add(...args);
      };
      return work(uow);
    })};
    const consumer=new WagerConsumer(guarded,h.process,h.sqs);
    expect(await parallelRequests(2,(i)=>consumer.handle(messages[i]!,h.queueUrl,h.dlqUrl))).toEqual(['ACK','ACK']);
    expect(arrivals).toBe(2);
    const balances=await Promise.all(wallets.map(async(wallet)=>(await h.state(wallet.id)).balance));
    expect(balances.sort()).toEqual(['100.00','75.00']);
    expect(await h.sql("select status,count(*)::text as count from wagering.consumer_inbox group by status order by status"))
      .toEqual([{status:'PROCESSED',count:'1'},{status:'REJECTED',count:'1'}]);
    expect(await h.sql("select count(*)::text as count from wagering.wallet_ledger_entries where direction='DEBIT'")).toEqual([{count:'1'}]);
  });

  test('DLQ send confirmed before marker crash: retry preserves source and FIFO deduplicates forwarding',async()=>{
    const envelope={messageId:crypto.randomUUID(),type:'bad'};
    await h.sql(`create function wagering.fail_dlq_marker() returns trigger language plpgsql as $$ begin
      raise exception 'Marker crash probe' using errcode='40001';end;$$;
      create trigger fail_dlq_marker before update on wagering.consumer_dead_letters for each row execute function wagering.fail_dlq_marker()`);
    let delivery;
    try{delivery=await h.deliver(envelope);}finally{await h.sql('drop trigger fail_dlq_marker on wagering.consumer_dead_letters;drop function wagering.fail_dlq_marker()');}
    expect(delivery.outcome).toBe('RETRY');
    expect(await h.sql('select sent_at from wagering.consumer_dead_letters')).toEqual([{sent_at:null}]);
    await h.release(delivery.message);const replay=(await h.receive())!;
    expect(replay.MessageId).toBe(delivery.message.MessageId);
    expect(await h.consumer.handle(replay,h.queueUrl,h.dlqUrl)).toBe('DLQ');
    const forwarded=(await h.receive(true))!;expect(JSON.parse(forwarded.Body!)).toEqual(envelope);
    await h.sqs.client.send(new DeleteMessageCommand({QueueUrl:h.dlqUrl,ReceiptHandle:forwarded.ReceiptHandle!}));
    expect(await h.receive(true)).toBeUndefined();
  });
});
