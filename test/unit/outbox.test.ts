import { describe, expect, test } from 'bun:test';
import { outboxBackoffMs, OutboxClaim, OutboxClaimStore } from '../../src/application/outbox-ports';
import { OutboxPublisher } from '../../src/application/outbox-publisher';
import { validateIntegrationEvent } from '../../src/application/integration-event-envelope';

describe('outbox scheduling and ownership',()=>{
  test('backoff starts at 1s and caps at 30s without attempt exhaustion',()=>{
    expect([1,2,3,4,5,6,1000].map(outboxBackoffMs)).toEqual([1000,2000,4000,8000,16000,30000,30000]);
    for(const attempts of [0,-1,1.5,NaN])expect(()=>outboxBackoffMs(attempts)).toThrow();
  });
  test('publication occurs after claim commits and keeps the stored event identity',async()=>{
    const calls:string[]=[];const claim:OutboxClaim={eventId:crypto.randomUUID(),payload:{eventId:'stored'},leaseToken:crypto.randomUUID(),attempts:1};
    const store:OutboxClaimStore={claim:async()=>{calls.push('claim-committed');return[claim];},renew:async()=>true,
      published:async(received)=>{expect(received).toBe(claim);calls.push('confirmed');return true;},retry:async()=>false};
    const publisher=new OutboxPublisher(store,{send:async(received)=>{expect(received.eventId).toBe(claim.eventId);calls.push('sent');}},'worker');
    expect(await publisher.run()).toEqual(['PUBLISHED']);expect(calls).toEqual(['claim-committed','sent','confirmed']);
  });
  test('unconfirmed send schedules retry rather than marking published',async()=>{
    let confirmed=false;let failure:unknown;
    const claim:OutboxClaim={eventId:crypto.randomUUID(),payload:{},leaseToken:crypto.randomUUID(),attempts:6};
    const store:OutboxClaimStore={claim:async()=>[claim],renew:async()=>true,published:async()=>{confirmed=true;return true;},
      retry:async(received,code,delay)=>{failure={received,code,delay};return true;}};
    const publisher=new OutboxPublisher(store,{send:async()=>{throw new Error('SQS down');}},'worker');
    expect(await publisher.run()).toEqual(['RETRY']);expect(confirmed).toBe(false);
    expect(failure).toEqual({received:claim,code:'SQS_SEND_FAILED',delay:30000});
  });
  test('worker with stale confirmation cannot mark event published',async()=>{
    const claim:OutboxClaim={eventId:crypto.randomUUID(),payload:{},leaseToken:crypto.randomUUID(),attempts:2};
    const store:OutboxClaimStore={claim:async()=>[claim],renew:async()=>false,published:async()=>false,retry:async()=>false};
    expect(await new OutboxPublisher(store,{send:async()=>{}},'worker').run()).toEqual(['STALE']);
  });
  test('event validation preserves decimal money and rejects financial numbers',()=>{
    const payload={eventId:crypto.randomUUID(),aggregateId:crypto.randomUUID(),eventType:'WagerTransactionProcessed',version:1,
      correlationId:'correlation',occurredAt:new Date().toISOString(),data:{transactionId:crypto.randomUUID(),walletId:crypto.randomUUID(),
        money:{amount:'9007199254740993.01',currency:'BRL'}}};
    expect(validateIntegrationEvent(JSON.stringify(payload)).payload.data).toEqual(payload.data);
    expect(()=>validateIntegrationEvent(JSON.stringify({...payload,data:{...payload.data,money:{amount:25,currency:'BRL'}}}))).toThrow();
  });
});
