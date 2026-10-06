import 'reflect-metadata';
import { expect,test } from 'bun:test';
import { processHarness,processWagerBody } from '../support/process-harness';
import { isolatedEventQueue,OutboxRow } from '../support/phase7-harness';
import { MikroOrmEventReceiptStore } from '../../src/infrastructure/persistence/event-receipt-store';
import { IntegrationEventConsumer } from '../../src/infrastructure/outbox/event-consumer';
import { parallelRequests,reportScenario,waitUntil,withDeadline } from '../support/concurrency-helpers';

test('event consumer process crash after receipt commit before ack preserves one durable effect',async()=>{
  const start=performance.now();const q=await isolatedEventQueue();
  const h=await processHarness(3,{outboxPublisherEnabled:true,publisherInstances:[0],eventConsumerEnabled:true,
    eventConsumerInstances:[1],eventQueueName:q.queueName,pauseBeforeAck:true,visibilitySeconds:1,shutdownMs:200});
  try{
    const wallet=await h.wallet('0.00');await h.post(processWagerBody(wallet,'LOSS','0.00'),crypto.randomUUID());
    await waitUntil(async()=>h.diagnostics(1).includes('before-ack'),'event receipt committed before ack',10000);
    const before=await h.state(wallet.id);
    const receipts=await h.sql('select * from wagering.integration_event_receipts');expect(receipts).toHaveLength(1);
    const pids=await h.crash(1);expect(pids.newPid).not.toBe(pids.oldPid);
    await waitUntil(async()=>h.diagnostics(1).includes('before-ack'),'event redelivered after consumer crash',10000);
    expect(await h.sql('select * from wagering.integration_event_receipts')).toEqual(receipts);
    h.resumeAck(1);await waitUntil(()=>q.empty(),'replayed event acknowledged',5000);
    expect(await h.state(wallet.id)).toEqual(before);await h.assertConsistent();
    reportScenario('phase7-consumer-crash-before-ack',start,{...pids,receipts:1,financialEffects:0});
  }finally{try{await h.close();}finally{await q.close();}}
});

test('three publisher processes claim disjoint events, send without blocking finance, and consume each event once',async()=>{
  const start=performance.now();const q=await isolatedEventQueue();
  const h=await processHarness(3,{outboxPublisherEnabled:true,eventConsumerEnabled:true,eventQueueName:q.queueName,
    pauseBeforePublish:true,outboxLeaseMs:1000,shutdownMs:200});
  try{
    const wallets=await parallelRequests(10,(i)=>h.wallet('100.00',i%3));
    await waitUntil(async()=>h.instances().every((_,i)=>h.diagnostics(i).includes('outbox-before-send')),'three publishers hold disjoint leases',10000);
    const leased=await h.sql<Array<{id:string;lease_owner:string;attempts:number}>>('select id,lease_owner,attempts from wagering.outbox_events where lease_token is not null');
    expect(leased).toHaveLength(15);expect(new Set(leased.map((row)=>row.id)).size).toBe(15);
    expect(new Set(leased.map((row)=>row.lease_owner)).size).toBe(3);expect(leased.every((row)=>row.attempts===1)).toBe(true);
    expect(await q.empty()).toBe(true);
    const bet=await withDeadline(h.post(processWagerBody(wallets[0]!),crypto.randomUUID(),2),2000,'HTTP progress with all publisher sends paused');
    expect(bet.httpStatus).toBe(200);expect(bet.body.balance.amount).toBe('75.00');
    for(let i=0;i<3;i++)h.resumePublish(i);
    await waitUntil(async()=> (await h.sql<Array<{count:string}>>('select count(*)::text as count from wagering.integration_event_receipts'))[0]!.count==='22',
      'all confirmed outbox events consumed',15000);
    expect(await h.sql('select id from wagering.outbox_events where published_at is null')).toEqual([]);
    await waitUntil(()=>q.empty(),'event queue drained',5000);
    const [event]=await h.sql<OutboxRow[]>('select * from wagering.outbox_events limit 1');
    await q.sendDuplicate(event!.payload);await waitUntil(()=>q.empty(),'duplicate acknowledged by real consumer',5000);
    expect(await h.sql('select count(*)::text as count from wagering.integration_event_receipts')).toEqual([{count:'22'}]);
    await h.assertConsistent();reportScenario('phase7-three-publishers',start,{publishers:3,events:22,receipts:22,financialProgress:true});
  }finally{try{await h.close();}finally{await q.close();}}
});

test('commit then process crash before SQS send: expired lease recovers the same event after restart',async()=>{
  const start=performance.now();const q=await isolatedEventQueue();
  const h=await processHarness(3,{outboxPublisherEnabled:true,publisherInstances:[0,1],eventQueueName:q.queueName,
    pauseBeforePublish:true,outboxLeaseMs:500,shutdownMs:200});
  try{
    const wallet=await h.wallet('0.00');await h.post(processWagerBody(wallet,'LOSS','0.00'),crypto.randomUUID());
    let owner=-1;
    await waitUntil(async()=>{owner=h.instances().findIndex((_,i)=>h.diagnostics(i).includes('outbox-before-send'));return owner>=0;},'claim before real send',10000);
    const [original]=await h.sql<OutboxRow[]>('select * from wagering.outbox_events');
    expect(original!.published_at).toBeNull();expect(original!.attempts).toBe(1);expect(await q.empty()).toBe(true);
    const other=owner===0?1:0;
    // The second live publisher cannot claim while the original lease is renewed.
    await new Promise((resolve)=>setTimeout(resolve,1100));
    expect((await h.sql<OutboxRow[]>('select * from wagering.outbox_events'))[0]!.attempts).toBe(1);
    const pids=await h.crash(owner);
    await waitUntil(async()=> (await h.sql<OutboxRow[]>('select * from wagering.outbox_events'))[0]!.attempts>=2,'lease taken by replacement publisher',10000);
    h.resumePublish(owner);h.resumePublish(other);
    await waitUntil(async()=> (await h.sql<OutboxRow[]>('select * from wagering.outbox_events'))[0]!.published_at!==null,'pending event finally published',10000);
    const [recovered]=await h.sql<OutboxRow[]>('select * from wagering.outbox_events');
    expect(recovered!.id).toBe(original!.id);expect(recovered!.payload).toEqual(original!.payload);
    const message=(await q.receive())!;expect(JSON.parse(message.Body!).eventId).toBe(original!.id);
    expect(await new IntegrationEventConsumer(new MikroOrmEventReceiptStore(h.orm),q.sqs).handle(message,q.queueUrl)).toBe('CONSUMED');
    await h.assertConsistent();reportScenario('phase7-crash-before-send',start,{...pids,eventId:original!.id,attempts:recovered!.attempts,lostEvents:0});
  }finally{try{await h.close();}finally{await q.close();}}
});

test('real SQS send then process crash before published marker: same eventId is republished and persistently deduplicated',async()=>{
  const start=performance.now();const q=await isolatedEventQueue();
  const h=await processHarness(3,{outboxPublisherEnabled:true,publisherInstances:[0],eventQueueName:q.queueName,
    pauseAfterPublish:true,outboxLeaseMs:500,shutdownMs:200});
  try{
    const wallet=await h.wallet('0.00');await h.post(processWagerBody(wallet,'LOSS','0.00'),crypto.randomUUID());
    await waitUntil(async()=>h.diagnostics(0).includes('outbox-after-send'),'SQS confirmed before published marker',10000);
    const [original]=await h.sql<OutboxRow[]>('select * from wagering.outbox_events');
    expect(original!.published_at).toBeNull();expect(await q.empty()).toBe(false);
    const pids=await h.crash(0);
    await waitUntil(async()=>h.diagnostics(0).includes('outbox-after-send'),'replacement sent same event',10000);
    const [republished]=await h.sql<OutboxRow[]>('select * from wagering.outbox_events');
    expect(republished!.id).toBe(original!.id);expect(republished!.payload).toEqual(original!.payload);expect(republished!.attempts).toBe(2);
    expect(h.diagnostics(0)).toContain(original!.id);h.resumePublish(0);
    await waitUntil(async()=> (await h.sql<OutboxRow[]>('select * from wagering.outbox_events'))[0]!.published_at!==null,'publication marker committed',5000);
    const consumer=new IntegrationEventConsumer(new MikroOrmEventReceiptStore(h.orm),q.sqs);
    expect(await consumer.handle((await q.receive())!,q.queueUrl)).toBe('CONSUMED');
    await q.sendDuplicate(original!.payload);
    expect(await new IntegrationEventConsumer(new MikroOrmEventReceiptStore(h.orm),q.sqs).handle((await q.receive())!,q.queueUrl)).toBe('REPLAY');
    expect(await h.sql('select count(*)::text as count from wagering.integration_event_receipts')).toEqual([{count:'1'}]);
    await h.assertConsistent();reportScenario('phase7-crash-after-send',start,{...pids,eventId:original!.id,attempts:2,receipts:1});
  }finally{try{await h.close();}finally{await q.close();}}
});

test('full service restart with pending events recovers publication and event deduplication without changing finance',async()=>{
  const start=performance.now();const q=await isolatedEventQueue();
  const h=await processHarness(3,{outboxPublisherEnabled:true,eventConsumerEnabled:true,eventQueueName:q.queueName,
    pauseBeforePublish:true,outboxLeaseMs:500,shutdownMs:200,visibilitySeconds:1});
  try{
    const wallets=[await h.wallet(),await h.wallet()];
    await waitUntil(async()=> (await h.sql<Array<{count:string}>>('select count(*)::text as count from wagering.outbox_events where lease_token is not null'))[0]!.count==='4',
      'all pending events leased',10000);
    const before=await Promise.all(wallets.map((wallet)=>h.state(wallet.id)));
    const original=await h.sql<OutboxRow[]>('select * from wagering.outbox_events order by id');
    const firstRestart=await h.restartAll();expect(firstRestart.newPids.some((pid)=>firstRestart.oldPids.includes(pid))).toBe(false);
    for(let i=0;i<3;i++)h.resumePublish(i);
    await waitUntil(async()=> (await h.sql<Array<{count:string}>>('select count(*)::text as count from wagering.integration_event_receipts'))[0]!.count==='4',
      'all events recovered after full restart',15000);
    expect(await h.sql('select id from wagering.outbox_events where published_at is null')).toEqual([]);
    expect((await h.sql<OutboxRow[]>('select * from wagering.outbox_events order by id')).map((row)=>row.id)).toEqual(original.map((row)=>row.id));
    expect(await Promise.all(wallets.map((wallet)=>h.state(wallet.id)))).toEqual(before);
    await waitUntil(()=>q.empty(),'first event deliveries acknowledged',5000);
    await h.restartAll();
    await q.sendDuplicate(original[0]!.payload);await waitUntil(()=>q.empty(),'post-restart replay acknowledged',5000);
    expect(await h.sql('select count(*)::text as count from wagering.integration_event_receipts')).toEqual([{count:'4'}]);
    await h.assertConsistent();reportScenario('phase7-full-restart',start,{processes:3,events:4,receipts:4,lostEvents:0});
  }finally{try{await h.close();}finally{await q.close();}}
});
