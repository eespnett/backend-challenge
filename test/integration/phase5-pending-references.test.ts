import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { phase3Harness, wagerBody } from '../support/phase3-harness';
import { assertLedgerConsistency } from '../support/assert-ledger-consistency';
import { ReprocessPendingReferenceUseCase } from '../../src/application/reprocess-pending-reference';
import { MikroOrmPendingReferenceClaimStore } from '../../src/infrastructure/persistence/pending-reference-repository';
import { WagerTransaction, WagerTransactionKind as Kind } from '../../src/domain/wager-transaction';
import { Money } from '../../src/domain/money';
import { deferred, waitUntil } from '../support/concurrency-helpers';
import { TransactionManager } from '../../src/application/financial-unit-of-work';
import { isolatedPostgres } from '../support/isolated-postgres';
import { MikroOrmTransactionManager } from '../../src/infrastructure/persistence/mikro-orm-transaction-manager';
import { OpenWallet } from '../../src/application/open-wallet';
import { WagerTransactionPendingReference } from '../../src/domain/events';

let h: Awaited<ReturnType<typeof phase3Harness>>;
let store: MikroOrmPendingReferenceClaimStore;
let reprocess: ReprocessPendingReferenceUseCase;
beforeEach(async () => {
  h=await phase3Harness(); store=new MikroOrmPendingReferenceClaimStore(h.orm);
  reprocess=new ReprocessPendingReferenceUseCase(h.manager);
});
afterEach(async () => {
  if (h) try { await assertLedgerConsistency(h.orm); } finally { await h.close(); }
});

async function due(id: string) {
  await h.sql("update wagering.pending_reference_jobs set next_attempt_at=least(clock_timestamp()-interval '1 ms',expires_at) where transaction_id=?",[id]);
}
async function claim(id: string) {
  await due(id);
  const claims=await store.claim('integration-worker',10,30000);
  const found=claims.find((c)=>c.transactionId===id);
  expect(found).toBeDefined();
  return found!;
}
const txState = async (id: string) => (await h.sql<Array<{status:string;failure_code:string|null}>>(
  'select status,failure_code from wagering.wager_transactions where id=?',[id]))[0]!;
const jobState = async (id: string) => (await h.sql<Array<{status:string;attempts:number;lease_token:string|null}>>(
  'select status,attempts,lease_token from wagering.pending_reference_jobs where transaction_id=?',[id]))[0]!;
async function expire(id: string) {
  await h.sql(`update wagering.pending_reference_jobs set created_at=statement_timestamp()-interval '16 minutes',
    expires_at=statement_timestamp()-interval '1 minute',next_attempt_at=statement_timestamp()-interval '1 minute'
    where transaction_id=?`,[id]);
}
async function pendingRawBet(body: ReturnType<typeof wagerBody>) {
  const tx=WagerTransaction.create({...body,id:crypto.randomUUID(),idempotencyKey:crypto.randomUUID(),
    payloadHash:'a'.repeat(64),money:Money.from(body.money),createdAt:new Date()});
  await h.manager.run((uow)=>uow.transactions.add(tx));
  return tx;
}

describe('durable pending references on real PostgreSQL',()=>{
  test('initial scheduling failure rolls back pending transaction and event; retry inserts once',async()=>{
    const wallet=await h.wallet();
    const before=await h.state(wallet.id);
    const body=wagerBody(wallet,Kind.Refund,'25.00',{referenceExternalTransactionId:'missing'});
    const key=crypto.randomUUID();
    await h.sql(`create function wagering.fail_schedule() returns trigger language plpgsql as $$ begin
      raise exception 'Schedule failure' using errcode='40001'; end; $$;
      create trigger fail_schedule before insert on wagering.pending_reference_jobs for each row execute function wagering.fail_schedule()`);
    try{
      expect((await h.post(body,key)).httpStatus).toBe(503);
      expect(await h.state(wallet.id)).toEqual(before);
      expect(await h.sql('select id from wagering.wager_transactions where idempotency_key=?',[key])).toEqual([]);
    }finally{await h.sql('drop trigger fail_schedule on wagering.pending_reference_jobs;drop function wagering.fail_schedule()');}
    expect((await h.post(body,key)).httpStatus).toBe(202);
    expect(await h.sql('select transaction_id from wagering.pending_reference_jobs')).toHaveLength(1);
  });

  test('job TTL, lease shape, attempt count and wallet identity are enforced by direct SQL',async()=>{
    const wallet=await h.wallet();
    const other=await h.wallet();
    const pending=await h.post(wagerBody(wallet,Kind.Refund,'25.00',{referenceExternalTransactionId:'missing'}));
    for(const [assignment,value,code] of [
      ['attempts=?',-1,'23514'],["expires_at=created_at+interval '16 minutes'",null,'23514'],
      ["status='CLAIMED'",null,'23514'],['wallet_id=?',other.id,'23503'],
    ] as const){
      let error:unknown;
      try{await h.sql(`update wagering.pending_reference_jobs set ${assignment} where transaction_id=?`,
        value===null?[pending.body.transactionId]:[value,pending.body.transactionId]);}catch(caught){error=caught;}
      expect((error as {code:string}).code).toBe(code);
    }
    expect(await jobState(pending.body.transactionId)).toEqual({status:'READY',attempts:0,lease_token:null});
  });
  test('migration backfills existing Phase 3 pending records and DOWN/UP preserves financial history and snapshot',async()=>{
    const fixture=await isolatedPostgres();
    try{
      await fixture.orm.getMigrator().up({to:'Migration20261005030000'});
      const manager=new MikroOrmTransactionManager(fixture.orm);
      const wallet=await new OpenWallet(manager).execute({playerId:'legacy-pending',initialBalance:{amount:'100.00',currency:'BRL'}});
      const tx=WagerTransaction.create({...wagerBody(wallet,Kind.Refund,'25.00',{referenceExternalTransactionId:'legacy-reference'}),
        id:crypto.randomUUID(),idempotencyKey:crypto.randomUUID(),payloadHash:'a'.repeat(64),createdAt:new Date(),money:Money.from({amount:'25.00',currency:'BRL'})});
      tx.markPendingReference();
      const result={httpStatus:202 as const,body:{transactionId:tx.id,status:tx.status,balance:wallet.balance.toJSON(),idempotentReplay:false}};
      await manager.run(async(uow)=>{
        await uow.transactions.add(tx,result);
        await uow.outbox.enqueue(tx.id,[WagerTransactionPendingReference.from(tx,{eventId:crypto.randomUUID(),correlationId:'legacy-correlation',occurredAt:new Date()})]);
      });
      const sql=fixture.orm.em.getConnection();
      for(let cycle=0;cycle<2;cycle++){
        await fixture.orm.getMigrator().up({to:'Migration20261005050000'});
        expect(await sql.execute('select transaction_id,status,attempts,correlation_id from wagering.pending_reference_jobs'))
          .toEqual([{transaction_id:tx.id,status:'READY',attempts:0,correlation_id:'legacy-correlation'}]);
        expect(await sql.execute('select result_body from wagering.wager_transactions where id=?',[tx.id])).toEqual([{result_body:result.body}]);
        expect(await sql.execute('select count(*)::text as count from wagering.outbox_events where transaction_id=?',[tx.id])).toEqual([{count:'1'}]);
        await fixture.orm.getMigrator().down();
        expect(await sql.execute("select to_regclass('wagering.pending_reference_jobs') as table")).toEqual([{table:null}]);
      }
      await fixture.orm.getMigrator().up();
      await assertLedgerConsistency(fixture.orm);
    }finally{await fixture.dispose();}
  });
  test('REFUND before BET persists one pending event and schedule without financial effects',async()=>{
    const wallet=await h.wallet();
    const body=wagerBody(wallet,Kind.Refund,'25.00',{referenceExternalTransactionId:'missing-bet'});
    const key=crypto.randomUUID();
    const original=await h.post(body,key);
    expect(original.httpStatus).toBe(202);
    expect(await h.post(body,key)).toEqual({...original,body:{...original.body,idempotentReplay:true}});
    expect(await h.state(wallet.id)).toEqual({balance:'100.00',version:'1',transactions:'2',ledger:'1',outbox:'3'});
    expect(await h.sql(`select status,attempts,extract(epoch from(expires_at-created_at))::text as ttl,
      extract(epoch from(next_attempt_at-created_at))::text as delay from wagering.pending_reference_jobs where transaction_id=?`,[original.body.transactionId]))
      .toEqual([{status:'READY',attempts:0,ttl:'900.000000',delay:'1.000000'}]);
    expect(await h.sql('select event_type from wagering.outbox_events where transaction_id=?',[original.body.transactionId]))
      .toEqual([{event_type:'WagerTransactionPendingReference'}]);
  });

  test('later BET resolves REFUND once; current state changes while original replay stays 202',async()=>{
    const wallet=await h.wallet();
    const bet=wagerBody(wallet);
    const body=wagerBody(wallet,Kind.Refund,'25.00',{referenceExternalTransactionId:bet.externalTransactionId});
    const key=crypto.randomUUID();
    const original=await h.post(body,key);
    await h.post(bet);
    const owned=await claim(original.body.transactionId);
    expect(await reprocess.execute(owned)).toBe('PROCESSED');
    expect(await reprocess.execute(owned)).toBe('STALE');
    expect(await txState(original.body.transactionId)).toEqual({status:'PROCESSED',failure_code:null});
    expect(await jobState(original.body.transactionId)).toEqual({status:'COMPLETED',attempts:1,lease_token:null});
    expect(await h.state(wallet.id)).toEqual({balance:'100.00',version:'3',transactions:'3',ledger:'3',outbox:'7'});
    expect(await h.post(body,key)).toEqual({...original,body:{...original.body,idempotentReplay:true}});
    expect(await h.sql('select event_type from wagering.outbox_events where transaction_id=? order by event_type',[original.body.transactionId]))
      .toEqual(['WagerTransactionPendingReference','WagerTransactionProcessed','WalletBalanceChanged'].map((event_type)=>({event_type})));
  });

  test.each([Kind.Bet,Kind.Win,Kind.Refund])('ROLLBACK before %s applies the inverse exactly once',async(kind)=>{
    const wallet=await h.wallet();
    const bet=wagerBody(wallet);
    const reference=wagerBody(wallet,kind,'25.00',kind===Kind.Refund?{referenceExternalTransactionId:bet.externalTransactionId}:{});
    const pending=await h.post(wagerBody(wallet,Kind.Rollback,'25.00',{referenceExternalTransactionId:reference.externalTransactionId}));
    expect(pending.httpStatus).toBe(202);
    if(kind===Kind.Refund)await h.post(bet);
    await h.post(reference);
    const owned=await claim(pending.body.transactionId);
    expect(await reprocess.execute(owned)).toBe('PROCESSED');
    expect(await reprocess.execute(owned)).toBe('STALE');
    expect((await h.state(wallet.id)).balance).toBe(kind===Kind.Refund?'75.00':'100.00');
    expect(await h.sql('select direction from wagering.wallet_ledger_entries where transaction_id=?',[pending.body.transactionId]))
      .toEqual([{direction:kind===Kind.Bet?'CREDIT':'DEBIT'}]);
  });

  test('still-PENDING reference retries with durable backoff and no new events',async()=>{
    const wallet=await h.wallet();
    const bet=wagerBody(wallet);
    const pending=await h.post(wagerBody(wallet,Kind.Refund,'25.00',{referenceExternalTransactionId:bet.externalTransactionId}));
    await pendingRawBet(bet);
    const before=await h.state(wallet.id);
    for(const [attempt,seconds] of [[1,'2'],[2,'4'],[3,'8'],[4,'16'],[5,'30'],[6,'30']] as const){
      expect(await reprocess.execute(await claim(pending.body.transactionId))).toBe('WAITING');
      expect(await jobState(pending.body.transactionId)).toEqual({status:'READY',attempts:attempt,lease_token:null});
      const rows=await h.sql<Array<{seconds:string}>>(`select round(extract(epoch from(next_attempt_at-updated_at)))::text as seconds
        from wagering.pending_reference_jobs where transaction_id=?`,[pending.body.transactionId]);
      expect(rows[0]!.seconds).toBe(seconds);
    }
    expect(await h.state(wallet.id)).toEqual(before);
    expect(await store.claim('not-due',10,30000)).toEqual([]);
  });

  test('a PENDING_REFERENCE reference keeps its ROLLBACK pending',async()=>{
    const wallet=await h.wallet();
    const reference=wagerBody(wallet,Kind.Refund,'25.00',{referenceExternalTransactionId:'still-missing-bet'});
    const rollback=await h.post(wagerBody(wallet,Kind.Rollback,'25.00',{referenceExternalTransactionId:reference.externalTransactionId}));
    expect((await h.post(reference)).httpStatus).toBe(202);
    expect(await reprocess.execute(await claim(rollback.body.transactionId))).toBe('WAITING');
    expect((await txState(rollback.body.transactionId)).status).toBe('PENDING_REFERENCE');
    expect((await h.state(wallet.id)).balance).toBe('100.00');
  });

  test('expired lease cannot be reclaimed while the resolution holds the job row lock',async()=>{
    const wallet=await h.wallet();
    const bet=wagerBody(wallet);
    const pending=await h.post(wagerBody(wallet,Kind.Refund,'25.00',{referenceExternalTransactionId:bet.externalTransactionId}));
    await h.post(bet);await due(pending.body.transactionId);
    const owned=(await store.claim('slow-worker',1,1000))[0]!;
    const reached=deferred<void>();const release=deferred<void>();
    const paused:TransactionManager={run:(work)=>h.manager.run((uow)=>work({...uow,
      outbox:{enqueue:async(id,events)=>{await uow.outbox.enqueue(id,events);reached.resolve();await release.promise;}}}))};
    const processing=new ReprocessPendingReferenceUseCase(paused).execute(owned);
    try{
      await reached.promise;
      await waitUntil(async()=>{
        const rows=await h.sql<Array<{expired:boolean}>>('select lease_until<=clock_timestamp() as expired from wagering.pending_reference_jobs where transaction_id=?',[pending.body.transactionId]);
        return rows[0]!.expired;
      },'expired lease on a row locked by resolution');
      expect(await store.claim('competing-worker',1,30000)).toEqual([]);
      expect((await h.state(wallet.id)).balance).toBe('75.00'); // Uncommitted credit remains invisible.
    }finally{release.resolve();await processing;}
    expect(await processing).toBe('PROCESSED');
    expect((await h.state(wallet.id)).balance).toBe('100.00');
    expect(await store.claim('after-commit',1,30000)).toEqual([]);
  });

  test.each(['round','kind','amount','wallet'])('incompatible reference %s is rejected on final revalidation',async(field)=>{
    const wallet=await h.wallet();
    const other=field==='wallet'?await h.wallet():wallet;
    const reference=wagerBody(other,field==='kind'?Kind.Win:Kind.Bet,'25.00',field==='round'?{roundId:'other-round'}:{});
    const pending=await h.post(wagerBody(wallet,Kind.Refund,field==='amount'?'24.00':'25.00',
      {referenceExternalTransactionId:reference.externalTransactionId}));
    await h.post(reference);
    const before=await h.state(wallet.id);
    expect(await reprocess.execute(await claim(pending.body.transactionId))).toBe('REJECTED');
    expect(await txState(pending.body.transactionId)).toEqual({status:'REJECTED',
      failure_code:field==='amount'?'REFERENCE_AMOUNT_MISMATCH':'INVALID_REFERENCE'});
    const after=await h.state(wallet.id);
    expect(after.balance).toBe(before.balance);expect(after.version).toBe(before.version);expect(after.ledger).toBe(before.ledger);
  });

  test('another provider cannot satisfy the reference',async()=>{
    const wallet=await h.wallet();
    const bet=wagerBody(wallet,Kind.Bet,'25.00',{providerId:'other-provider'});
    const pending=await h.post(wagerBody(wallet,Kind.Refund,'25.00',{referenceExternalTransactionId:bet.externalTransactionId}));
    await h.post(bet);
    expect(await reprocess.execute(await claim(pending.body.transactionId))).toBe('WAITING');
    expect((await txState(pending.body.transactionId)).status).toBe('PENDING_REFERENCE');
    expect((await h.state(wallet.id)).balance).toBe('75.00');
  });

  test('rejected reference is not refundable',async()=>{
    const wallet=await h.wallet('0.00');
    const bet=wagerBody(wallet);
    const pending=await h.post(wagerBody(wallet,Kind.Refund,'25.00',{referenceExternalTransactionId:bet.externalTransactionId}));
    expect((await h.post(bet)).httpStatus).toBe(422);
    expect(await reprocess.execute(await claim(pending.body.transactionId))).toBe('REJECTED');
    expect((await txState(pending.body.transactionId)).failure_code).toBe('INVALID_REFERENCE');
    expect((await h.state(wallet.id)).ledger).toBe('0');
  });

  test('already processed same-kind reversal blocks the pending reversal',async()=>{
    const wallet=await h.wallet();
    const bet=wagerBody(wallet);
    const body=wagerBody(wallet,Kind.Refund,'25.00',{referenceExternalTransactionId:bet.externalTransactionId});
    const pending=await h.post(body);
    await h.post(bet);
    await h.post({...body,externalTransactionId:crypto.randomUUID()});
    const before=await h.state(wallet.id);
    expect(await reprocess.execute(await claim(pending.body.transactionId))).toBe('REJECTED');
    expect((await txState(pending.body.transactionId)).failure_code).toBe('DUPLICATE_REVERSAL');
    expect((await h.state(wallet.id)).balance).toBe(before.balance);
    expect((await h.state(wallet.id)).ledger).toBe(before.ledger);
  });

  test('ROLLBACK rechecks available balance and rejects with REVERSAL_INSUFFICIENT_FUNDS',async()=>{
    const wallet=await h.wallet('0.00');
    const win=wagerBody(wallet,Kind.Win,'80.00');
    const pending=await h.post(wagerBody(wallet,Kind.Rollback,'80.00',{referenceExternalTransactionId:win.externalTransactionId}));
    await h.post(win);await h.post(wagerBody(wallet,Kind.Bet,'70.00'));
    expect(await reprocess.execute(await claim(pending.body.transactionId))).toBe('REJECTED');
    expect((await txState(pending.body.transactionId)).failure_code).toBe('REVERSAL_INSUFFICIENT_FUNDS');
    expect((await h.state(wallet.id)).balance).toBe('10.00');
    expect(await h.sql('select id from wagering.wallet_ledger_entries where transaction_id=?',[pending.body.transactionId])).toEqual([]);
  });

  test.each([false,true])('TTL expiry has distinct missing/non-processable code; existing=%j',async(existing)=>{
    const wallet=await h.wallet();
    const bet=wagerBody(wallet);
    const pending=await h.post(wagerBody(wallet,Kind.Refund,'25.00',{referenceExternalTransactionId:bet.externalTransactionId}));
    if(existing)await pendingRawBet(bet);
    await expire(pending.body.transactionId);
    expect(await reprocess.execute(await claim(pending.body.transactionId))).toBe('EXPIRED');
    expect(await txState(pending.body.transactionId)).toEqual({status:'REJECTED',failure_code:existing?'REFERENCE_NOT_PROCESSABLE':'REFERENCE_NOT_FOUND'});
    expect((await jobState(pending.body.transactionId)).status).toBe('EXPIRED');
    expect((await h.state(wallet.id)).balance).toBe('100.00');
  });

  test('DOWN refuses new rejection codes and rolls back the entire downgrade',async()=>{
    const wallet=await h.wallet();
    const pending=await h.post(wagerBody(wallet,Kind.Refund,'25.00',{referenceExternalTransactionId:'missing'}));
    await expire(pending.body.transactionId);
    // REFERENCE_NOT_FOUND is an older code; use an existing unprocessable reference for the new code.
    await pendingRawBet(wagerBody(wallet,Kind.Bet,'25.00',{externalTransactionId:'missing'}));
    expect(await reprocess.execute(await claim(pending.body.transactionId))).toBe('EXPIRED');
    await h.orm.getMigrator().down(); // Phase 6 has no inbox deliveries in this fixture.
    await expect(h.orm.getMigrator().down()).rejects.toThrow();
    expect((await jobState(pending.body.transactionId)).status).toBe('EXPIRED');
    expect((await txState(pending.body.transactionId)).failure_code).toBe('REFERENCE_NOT_PROCESSABLE');
    expect(await h.orm.getMigrator().getExecutedMigrations()).toHaveLength(4);
  });

  test.each(['ledger','outbox'])('failure inserting %s rolls back all resolution effects and lease recovers',async(target)=>{
    const wallet=await h.wallet();
    const bet=wagerBody(wallet);
    const pending=await h.post(wagerBody(wallet,Kind.Refund,'25.00',{referenceExternalTransactionId:bet.externalTransactionId}));
    await h.post(bet);
    const owned=await claim(pending.body.transactionId);
    const before=await h.state(wallet.id);
    const table=target==='ledger'?'wallet_ledger_entries':'outbox_events';
    await h.sql(`create function wagering.fail_resolution() returns trigger language plpgsql as $$ begin
      raise exception 'Resolution failure' using errcode='40001'; end; $$;
      create trigger fail_resolution before insert on wagering.${table} for each row execute function wagering.fail_resolution()`);
    try{
      await expect(reprocess.execute(owned)).rejects.toThrow();
      expect(await h.state(wallet.id)).toEqual(before);
      expect((await txState(pending.body.transactionId)).status).toBe('PENDING_REFERENCE');
      expect((await jobState(pending.body.transactionId)).status).toBe('CLAIMED');
    }finally{await h.sql(`drop trigger fail_resolution on wagering.${table};drop function wagering.fail_resolution()`);}
    await h.sql("update wagering.pending_reference_jobs set lease_until=clock_timestamp()-interval '1 ms' where transaction_id=?",[pending.body.transactionId]);
    const reclaimed=(await store.claim('replacement-worker',10,30000))[0]!;
    expect(reclaimed.leaseToken).not.toBe(owned.leaseToken);
    expect(await reprocess.execute(owned)).toBe('STALE');
    expect(await reprocess.execute(reclaimed)).toBe('PROCESSED');
    expect((await h.state(wallet.id)).balance).toBe('100.00');
  });
});
