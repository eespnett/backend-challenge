import 'reflect-metadata';
import { expect, test } from 'bun:test';
import { DeleteMessageCommand } from '@aws-sdk/client-sqs';
import { isolatedQueues, wagerEnvelope } from '../support/phase6-harness';
import { processHarness, processWagerBody } from '../support/process-harness';
import { waitUntil, holdWalletLock, waitingWalletLocks, reportScenario, parallelRequests } from '../support/concurrency-helpers';

test('three real consumers + HTTP: repeated messages and distinct IDs share one financial operation',async()=>{
  const started=performance.now();const q=await isolatedQueues();
  const h=await processHarness(3,{messagingEnabled:true,queueName:q.queueName,dlqName:q.dlqName});
  try{
    const wallet=await h.wallet();const body=processWagerBody(wallet);const key=crypto.randomUUID();
    const original=wagerEnvelope(body,key);
    const http=h.post(body,key,2);
    await parallelRequests(24,(i)=>q.send(i<12?original:wagerEnvelope(body,key)));
    expect((await http).httpStatus).toBe(200);
    await waitUntil(async()=> (await h.sql<Array<{count:string}>>("select count(*)::text as count from wagering.consumer_inbox where status='PROCESSED'"))[0]!.count==='13',
      'all unique inbox identities committed',15000);
    expect((await h.state(wallet.id)).balance).toBe('75.00');
    expect((await h.state(wallet.id)).ledger).toBe('2');
    expect((await h.state(wallet.id)).transactions).toBe('2');
    const ordered=await h.wallet('0.00');
    await q.send(wagerEnvelope(processWagerBody(ordered,'WIN','25.00')),ordered.id);
    await q.send(wagerEnvelope(processWagerBody(ordered,'BET','25.00')),ordered.id);
    await waitUntil(async()=>(await h.state(ordered.id)).transactions==='2','same-group FIFO order',10000);
    expect((await h.state(ordered.id)).balance).toBe('0.00');
    expect((await h.state(ordered.id)).ledger).toBe('2');
    expect(await h.sql("select status from wagering.wager_transactions where wallet_id=?",[ordered.id])).toEqual([{status:'PROCESSED'},{status:'PROCESSED'}]);
    expect(await q.receive(true)).toBeUndefined();
    await h.assertConsistent();
    reportScenario('phase6-three-consumers-http-sqs',started,{processes:3,deliveries:24,inbox:13,financialEffects:1});
  }finally{try{await h.close();}finally{await q.close();}}
});

test('real process dies after commit before ack; replacement replays original delivery once',async()=>{
  const started=performance.now();const q=await isolatedQueues();
  const h=await processHarness(3,{messagingEnabled:true,messagingInstances:[0],queueName:q.queueName,dlqName:q.dlqName,
    pauseBeforeAck:true,visibilitySeconds:1,shutdownMs:200});
  try{
    const wallet=await h.wallet();const envelope=wagerEnvelope(processWagerBody(wallet));
    await q.send(envelope);
    await waitUntil(async()=>h.diagnostics(0).includes('before-ack'),'committed before ack',10000);
    const before=await h.state(wallet.id);
    expect(before.balance).toBe('75.00');
    const pids=await h.crash(0);
    expect(pids.newPid).not.toBe(pids.oldPid);
    await waitUntil(async()=>h.diagnostics(0).includes('before-ack'),'replacement replay',10000);
    expect(await h.state(wallet.id)).toEqual(before);
    expect(await h.sql("select count(*)::text as count from wagering.consumer_inbox where status='PROCESSED'")).toEqual([{count:'1'}]);
    h.resumeAck(0);
    await waitUntil(async()=> {
      const message=await q.receive();
      if(message){await q.release(message);return false;}return true;
    },'source acknowledged',5000);
    await h.assertConsistent();
    reportScenario('phase6-crash-after-commit',started,{...pids,balance:'75.00',ledger:2});
  }finally{try{await h.close();}finally{await q.close();}}
});

test('real process dies during SQL processing; inbox rolls back and replacement applies once',async()=>{
  const started=performance.now();const q=await isolatedQueues();
  const h=await processHarness(3,{messagingEnabled:true,messagingInstances:[0],queueName:q.queueName,dlqName:q.dlqName,visibilitySeconds:1});
  try{
    const wallet=await h.wallet();const envelope=wagerEnvelope(processWagerBody(wallet));
    const lock=await holdWalletLock(h.orm,wallet.id);
    try{
      await q.send(envelope);
      await waitUntil(async()=>(await waitingWalletLocks(h.orm)).length>0,'consumer holds uncommitted inbox',5000);
      expect(await h.sql('select message_id from wagering.consumer_inbox')).toEqual([]);
      const pids=await h.crash(0);
      expect(pids.newPid).not.toBe(pids.oldPid);
    }finally{await lock.release();}
    await waitUntil(async()=>(await h.state(wallet.id)).balance==='75.00','replacement final effect',10000);
    expect((await h.state(wallet.id)).ledger).toBe('2');
    expect(await h.sql("select count(*)::text as count from wagering.consumer_inbox where status='PROCESSED'")).toEqual([{count:'1'}]);
    await h.assertConsistent();
    reportScenario('phase6-crash-in-transaction',started,{financialEffects:1,balance:'75.00'});
  }finally{try{await h.close();}finally{await q.close();}}
});

test('SIGTERM drains an active SQL transaction before ack and stops accepting work',async()=>{
  const started=performance.now();const q=await isolatedQueues();
  const h=await processHarness(3,{messagingEnabled:true,messagingInstances:[0],queueName:q.queueName,dlqName:q.dlqName,shutdownMs:3000});
  try{
    const wallet=await h.wallet();const envelope=wagerEnvelope(processWagerBody(wallet));
    const lock=await holdWalletLock(h.orm,wallet.id);
    let terminated:Promise<void>|undefined;
    try{
      await q.send(envelope);
      await waitUntil(async()=>(await waitingWalletLocks(h.orm)).length>0,'active delivery',5000);
      terminated=h.terminate(0);
      // Polling abort is immediate; release the active SQL work within the drain deadline.
    }finally{await lock.release();}
    await terminated;
    expect((await h.state(wallet.id)).balance).toBe('75.00');
    expect((await h.state(wallet.id)).ledger).toBe('2');
    expect(await q.receive()).toBeUndefined();
    const later=wagerEnvelope(processWagerBody(wallet));await q.send(later);
    const unaccepted=(await q.receive())!;expect(JSON.parse(unaccepted.Body!)).toEqual(later);
    await q.sqs.client.send(new DeleteMessageCommand({QueueUrl:q.queueUrl,ReceiptHandle:unaccepted.ReceiptHandle!}));
    await h.assertConsistent();
    reportScenario('phase6-sigterm-drain',started,{balance:'75.00',acked:true});
  }finally{try{await h.close();}finally{await q.close();}}
});

test('SIGTERM deadline abandons uncommitted work; visibility redelivery recovers after restart',async()=>{
  const started=performance.now();const q=await isolatedQueues();
  const h=await processHarness(3,{messagingEnabled:true,messagingInstances:[0],queueName:q.queueName,dlqName:q.dlqName,
    shutdownMs:100,visibilitySeconds:1});
  try{
    const wallet=await h.wallet();const before=await h.state(wallet.id);
    const lock=await holdWalletLock(h.orm,wallet.id);
    try{
      await q.send(wagerEnvelope(processWagerBody(wallet)));
      await waitUntil(async()=>(await waitingWalletLocks(h.orm)).length>0,'active transaction before deadline',5000);
      await h.terminate(0);
      expect(await h.state(wallet.id)).toEqual(before);
      expect(await h.sql('select message_id from wagering.consumer_inbox')).toEqual([]);
    }finally{await lock.release();}
    await h.restart(0);
    await waitUntil(async()=>(await h.state(wallet.id)).balance==='75.00','restart delivery recovery',10000);
    expect((await h.state(wallet.id)).ledger).toBe('2');
    await h.assertConsistent();
    reportScenario('phase6-sigterm-deadline',started,{recovered:true,financialEffects:1});
  }finally{try{await h.close();}finally{await q.close();}}
});
