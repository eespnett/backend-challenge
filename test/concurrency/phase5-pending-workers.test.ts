import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { processHarness, processWagerBody } from '../support/process-harness';
import { deferred, holdWalletLock, parallelRequests, reportScenario, waitingWalletLocks, waitUntil } from '../support/concurrency-helpers';
import { MikroOrmPendingReferenceClaimStore } from '../../src/infrastructure/persistence/pending-reference-repository';
import { MikroOrmTransactionManager } from '../../src/infrastructure/persistence/mikro-orm-transaction-manager';
import { ReprocessPendingReferenceUseCase } from '../../src/application/reprocess-pending-reference';

let h: Awaited<ReturnType<typeof processHarness>>;
beforeAll(async()=>{h=await processHarness(3,{pendingWorkerEnabled:true});});
afterEach(async()=>{if(h)await h.assertConsistent();});
afterAll(async()=>{if(h)await h.close();});
const txState=async(id:string)=>(await h.sql<Array<{status:string;failure_code:string|null}>>(
  'select status,failure_code from wagering.wager_transactions where id=?',[id]))[0]!;
async function resolved(id:string){await waitUntil(async()=>['PROCESSED','REJECTED'].includes((await txState(id)).status),`resolved ${id}`,10000);}

describe('durable reference workers in three real application processes',()=>{
  test('concurrent workers resolve a REFUND after later BET, with one effect and unchanged original replay',async()=>{
    const wallet=await h.wallet();
    const bet=processWagerBody(wallet);
    const body=processWagerBody(wallet,'REFUND','25.00',{referenceExternalTransactionId:bet.externalTransactionId});
    const key=crypto.randomUUID();
    const started=performance.now();
    const pending=await h.post(body,key,0);
    expect(pending.httpStatus).toBe(202);
    await h.post(bet,crypto.randomUUID(),1);
    await resolved(pending.body.transactionId);
    expect((await txState(pending.body.transactionId)).status).toBe('PROCESSED');
    expect(await h.state(wallet.id)).toEqual({balance:'100.00',version:'3',transactions:'3',ledger:'3',outbox:'7'});
    const replays=await parallelRequests(12,(i)=>h.post(body,key,i));
    expect(replays.every((r)=>r.httpStatus===202&&r.body.idempotentReplay&&r.body.balance.amount==='100.00')).toBe(true);
    expect(await h.sql('select status from wagering.pending_reference_jobs where transaction_id=?',[pending.body.transactionId]))
      .toEqual([{status:'COMPLETED'}]);
    expect(await h.sql('select count(*)::text as count from wagering.wallet_ledger_entries where transaction_id=?',[pending.body.transactionId]))
      .toEqual([{count:'1'}]);
    reportScenario('phase5-concurrent-workers',started,{workers:3,effects:1,replays:12,balance:'100.00'});
  });

  test('two distinct pending REFUNDs for the same BET cannot both credit',async()=>{
    const wallet=await h.wallet();
    const bet=processWagerBody(wallet);
    const pending=await parallelRequests(2,(i)=>h.post(processWagerBody(wallet,'REFUND','25.00',
      {referenceExternalTransactionId:bet.externalTransactionId}),crypto.randomUUID(),i));
    expect(pending.every((r)=>r.httpStatus===202)).toBe(true);
    await h.post(bet,crypto.randomUUID(),2);
    await Promise.all(pending.map((r)=>resolved(r.body.transactionId)));
    const states=await Promise.all(pending.map((r)=>txState(r.body.transactionId)));
    expect(states.map((s)=>s.status).sort()).toEqual(['PROCESSED','REJECTED']);
    expect(states.find((s)=>s.status==='REJECTED')?.failure_code).toBe('DUPLICATE_REVERSAL');
    expect(await h.state(wallet.id)).toEqual({balance:'100.00',version:'3',transactions:'4',ledger:'3',outbox:'9'});
  });

  test('restart during waiting recovers persisted attempts and resolves after reference arrives',async()=>{
    const wallet=await h.wallet();
    const bet=processWagerBody(wallet);
    const pending=await h.post(processWagerBody(wallet,'ROLLBACK','25.00',
      {referenceExternalTransactionId:bet.externalTransactionId}),crypto.randomUUID(),0);
    await waitUntil(async()=>{
      const rows=await h.sql<Array<{attempts:number;status:string}>>('select attempts,status from wagering.pending_reference_jobs where transaction_id=?',[pending.body.transactionId]);
      return rows[0]!.attempts>=1&&rows[0]!.status==='READY';
    },'persisted waiting attempt',8000);
    const started=performance.now();
    const restart=await h.restart(0);
    expect(restart.newPid).not.toBe(restart.oldPid);
    await h.post(bet,crypto.randomUUID(),0);
    await resolved(pending.body.transactionId);
    expect((await txState(pending.body.transactionId)).status).toBe('PROCESSED');
    expect((await h.state(wallet.id)).balance).toBe('100.00');
    expect(await h.sql('select count(*)::text as count from wagering.wallet_ledger_entries where transaction_id=?',[pending.body.transactionId]))
      .toEqual([{count:'1'}]);
    reportScenario('phase5-restart-pending',started,{...restart,effects:1,balance:'100.00'});
  });

  test('worker killed while waiting on wallet lock leaves recoverable lease, never duplicates',async()=>{
    const wallet=await h.wallet();
    const bet=processWagerBody(wallet);
    const pending=await h.post(processWagerBody(wallet,'REFUND','25.00',
      {referenceExternalTransactionId:bet.externalTransactionId}),crypto.randomUUID(),0);
    await h.post(bet,crypto.randomUUID(),1);
    const lock=await holdWalletLock(h.orm,wallet.id);
    const started=performance.now();
    let replacement: {oldPid:number;newPid:number}|undefined;
    try{
      await waitUntil(async()=>(await waitingWalletLocks(h.orm)).length>0,'claimed worker waiting on wallet',6000);
      const job=(await h.sql<Array<{lease_owner:string;lease_token:string;status:string}>>(
        'select lease_owner,lease_token,status from wagering.pending_reference_jobs where transaction_id=?',[pending.body.transactionId]))[0]!;
      expect(job.status).toBe('CLAIMED');
      const ownerPid=Number(job.lease_owner.split(':')[0]);
      const index=h.instances().findIndex((instance)=>instance.pid===ownerPid);
      expect(index>=0).toBe(true);
      replacement=await h.crash(index);
      expect(replacement.oldPid).toBe(ownerPid);
      expect((await txState(pending.body.transactionId)).status).toBe('PENDING_REFERENCE');
      expect((await h.state(wallet.id)).balance).toBe('75.00');
      // Expire the committed lease in the fixture instead of sleeping 30s.
      await h.sql("update wagering.pending_reference_jobs set lease_until=clock_timestamp()-interval '1 ms' where transaction_id=?",[pending.body.transactionId]);
    }finally{await lock.release();}
    await resolved(pending.body.transactionId);
    expect((await txState(pending.body.transactionId)).status).toBe('PROCESSED');
    expect(await h.state(wallet.id)).toEqual({balance:'100.00',version:'3',transactions:'3',ledger:'3',outbox:'7'});
    reportScenario('phase5-crash-recovery',started,{...replacement,effects:1,balance:'100.00'});
  });

  test('claim tokens fence a stale worker, including concurrent executions of the same recovered claim',async()=>{
    // Separate real processes with periodic polling disabled only for this
    // deterministic claim/fencing window; financial processing remains production code.
    const manual=await processHarness(3);
    try {
    const wallet=await manual.wallet();
    const bet=processWagerBody(wallet);
    const pending=await manual.post(processWagerBody(wallet,'REFUND','25.00',
      {referenceExternalTransactionId:bet.externalTransactionId}),crypto.randomUUID());
    await manual.post(bet,crypto.randomUUID());
    await manual.sql("update wagering.pending_reference_jobs set next_attempt_at=clock_timestamp()-interval '1 ms' where transaction_id=?",[pending.body.transactionId]);
    const store=new MikroOrmPendingReferenceClaimStore(manual.orm);
    const claimed=await Promise.all([store.claim('worker-a',1,30000),store.claim('worker-b',1,30000)]);
    const claims=claimed.flat().filter((c)=>c.transactionId===pending.body.transactionId);
    expect(claims).toHaveLength(1);
    const old=claims[0]!;
    await manual.sql("update wagering.pending_reference_jobs set lease_until=clock_timestamp()-interval '1 ms' where transaction_id=?",[pending.body.transactionId]);
    const recovered=(await store.claim('recovered-worker',1,30000))[0]!;
    expect(recovered.leaseToken).not.toBe(old.leaseToken);
    const reprocess=new ReprocessPendingReferenceUseCase(new MikroOrmTransactionManager(manual.orm));
    expect(await reprocess.execute(old)).toBe('STALE');
    const effects=await Promise.all([reprocess.execute(recovered),reprocess.execute(recovered)]);
    expect(effects.sort()).toEqual(['PROCESSED','STALE']);
    expect((await manual.state(wallet.id)).balance).toBe('100.00');
    await manual.assertConsistent();
    } finally { await manual.close(); }
  });

  test('hard crash after wallet update and before ledger insertion rolls back and recovers once',async()=>{
    const wallet=await h.wallet();
    const bet=processWagerBody(wallet);
    const pending=await h.post(processWagerBody(wallet,'REFUND','25.00',
      {referenceExternalTransactionId:bet.externalTransactionId}),crypto.randomUUID());
    await h.post(bet,crypto.randomUUID());
    const before=await h.state(wallet.id);
    const acquired=deferred<void>();const release=deferred<void>();
    const held=h.orm.em.fork({clear:true,useContext:false}).transactional(async(em)=>{
      await em.execute('select pg_advisory_xact_lock(500501)');acquired.resolve();await release.promise;
    });
    void held.catch((error)=>acquired.reject(error));
    await acquired.promise;
    let triggerInstalled=false;
    const started=performance.now();
    try{
      // Fixture-only pause: the production worker has already flushed wallet and
      // transaction changes before this real ledger INSERT blocks in PostgreSQL.
      await h.sql(`create function wagering.pause_resolution() returns trigger language plpgsql as $$ begin
        if new.transaction_id::text='${pending.body.transactionId}' then perform pg_advisory_xact_lock(500501); end if;
        return new; end; $$;
        create trigger pause_resolution before insert on wagering.wallet_ledger_entries for each row execute function wagering.pause_resolution()`);
      triggerInstalled=true;
      await h.sql("update wagering.pending_reference_jobs set next_attempt_at=clock_timestamp()-interval '1 ms' where transaction_id=?",[pending.body.transactionId]);
      await waitUntil(async()=>{
        const rows=await h.sql<Array<{waiting:boolean}>>(`select exists(select 1 from pg_stat_activity
          where datname=current_database() and wait_event='advisory') as waiting`);return rows[0]!.waiting;
      },'worker paused after financial update',6000);
      expect(await h.state(wallet.id)).toEqual(before);
      const job=(await h.sql<Array<{lease_owner:string}>>('select lease_owner from wagering.pending_reference_jobs where transaction_id=?',[pending.body.transactionId]))[0]!;
      const ownerPid=Number(job.lease_owner.split(':')[0]);
      const index=h.instances().findIndex((instance)=>instance.pid===ownerPid);
      expect(index>=0).toBe(true);
      const crashed=await h.crash(index);
      expect(crashed.oldPid).toBe(ownerPid);
      expect(await h.state(wallet.id)).toEqual(before);
      expect((await txState(pending.body.transactionId)).status).toBe('PENDING_REFERENCE');
      await h.sql('drop trigger pause_resolution on wagering.wallet_ledger_entries;drop function wagering.pause_resolution()');
      triggerInstalled=false;
      await h.sql("update wagering.pending_reference_jobs set lease_until=clock_timestamp()-interval '1 ms' where transaction_id=?",[pending.body.transactionId]);
    }finally{
      release.resolve();await held;
      if(triggerInstalled)await h.sql('drop trigger pause_resolution on wagering.wallet_ledger_entries;drop function wagering.pause_resolution()');
    }
    await resolved(pending.body.transactionId);
    expect(await h.state(wallet.id)).toEqual({balance:'100.00',version:'3',transactions:'3',ledger:'3',outbox:'7'});
    reportScenario('phase5-crash-after-update',started,{effects:1,rolledBackPartialWrites:true,balance:'100.00'});
  });
});
