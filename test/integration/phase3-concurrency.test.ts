import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ProcessWagerTransactionUseCase } from '../../src/application/process-wager-transaction';
import { TransactionManager } from '../../src/application/financial-unit-of-work';
import { ProcessingConflictError } from '../../src/application/processing-errors';
import { WagerTransactionKind as Kind, WagerTransactionStatus as Status } from '../../src/domain/wager-transaction';
import { phase3Harness, wagerBody } from '../support/phase3-harness';

let h: Awaited<ReturnType<typeof phase3Harness>>;
beforeAll(async () => { h=await phase3Harness(); });
afterAll(async () => { if(h) await h.close(); });

describe('Phase 3 concurrent independent SQL transactions', () => {
  test('two parallel HTTP BETs of 80 on 100 produce one debit and safe retries', async () => {
    const wallet=await h.wallet();
    const bodies=[wagerBody(wallet,Kind.Bet,'80.00'),wagerBody(wallet,Kind.Bet,'80.00')];
    const keys=[crypto.randomUUID(),crypto.randomUUID()];
    const results=await Promise.all(bodies.map((body,i)=>h.post(body,keys[i]!)));
    expect(results.map((r)=>r.httpStatus).sort()).toEqual([200,422]);
    expect(results.map((r)=>r.body.status).sort()).toEqual([Status.Processed,Status.Rejected]);
    expect(results.find((r)=>r.httpStatus===422)?.body.failureCode).toBe('INSUFFICIENT_BALANCE');
    expect(await h.state(wallet.id)).toEqual({balance:'20.00',version:'2',transactions:'3',ledger:'2',outbox:'5'});
    expect(await h.sql("select amount::text,direction from wagering.wallet_ledger_entries where wallet_id=? and direction='DEBIT'",[wallet.id]))
      .toEqual([{amount:'80.00',direction:'DEBIT'}]);
    const before=await h.state(wallet.id);
    const retries=await Promise.all(bodies.map((body,i)=>h.post(body,keys[i]!)));
    retries.forEach((retry,i)=>expect(retry).toEqual({...results[i]!,body:{...results[i]!.body,idempotentReplay:true}}));
    expect(await h.state(wallet.id)).toEqual(before);
  });

  test('ten simultaneous identical submissions debit once and return the same original result', async () => {
    const wallet=await h.wallet();
    const body=wagerBody(wallet,Kind.Bet,'80.00');
    const key=crypto.randomUUID();
    const results=await Promise.all(Array.from({length:10},()=>h.post(body,key)));
    expect(results.every((r)=>r.httpStatus===200)).toBe(true);
    expect(results.filter((r)=>!r.body.idempotentReplay)).toHaveLength(1);
    expect(new Set(results.map((r)=>r.body.transactionId)).size).toBe(1);
    expect(results.every((r)=>r.body.balance.amount==='20.00')).toBe(true);
    expect(await h.state(wallet.id)).toEqual({balance:'20.00',version:'2',transactions:'2',ledger:'2',outbox:'4'});
  });

  test('parallel same-type reversals are serialized and only one succeeds', async () => {
    const wallet=await h.wallet();
    const bet=wagerBody(wallet,Kind.Bet,'80.00');
    await h.post(bet);
    const results=await Promise.all(Array.from({length:2},()=>h.post(wagerBody(wallet,Kind.Refund,'80.00',
      {referenceExternalTransactionId:bet.externalTransactionId}))));
    expect(results.map((r)=>r.httpStatus).sort()).toEqual([200,422]);
    expect(results.find((r)=>r.httpStatus===422)?.body.failureCode).toBe('DUPLICATE_REVERSAL');
    expect(await h.state(wallet.id)).toEqual({balance:'100.00',version:'3',transactions:'4',ledger:'3',outbox:'7'});
  });

  test.each(['key','external'])('cross-wallet %s collision rolls back the loser before resolving 409',async (identity)=>{
    const wallets=await Promise.all([h.wallet(),h.wallet()]);
    const commonKey=crypto.randomUUID();
    const commonExternal=crypto.randomUUID();
    // Deterministic rendezvous: both transactions have passed prechecks and flushed
    // their locked wallet update before either attempts the unique transaction INSERT.
    let arrived=0;
    let release!:()=>void;
    const gate=new Promise<void>((resolve)=>{release=resolve;});
    const racedManager:TransactionManager={run:(work)=>h.manager.run((uow)=>work({...uow,
      transactions:{...uow.transactions,
        findById:(id)=>uow.transactions.findById(id),
        findByIdempotencyKey:(key)=>uow.transactions.findByIdempotencyKey(key),
        findByProviderAndExternalId:(p,e)=>uow.transactions.findByProviderAndExternalId(p,e),
        findSubmissionByIdempotencyKey:(key)=>uow.transactions.findSubmissionByIdempotencyKey(key),
        findProcessedReversals:(id)=>uow.transactions.findProcessedReversals(id),
        add:async(tx,result)=>{if(++arrived===2)release();await gate;await uow.transactions.add(tx,result);},
      }}))};
    const process=new ProcessWagerTransactionUseCase(racedManager);
    const bodies=wallets.map((wallet)=>wagerBody(wallet,Kind.Bet,'80.00',identity==='external'?{externalTransactionId:commonExternal}:{}));
    const keys=wallets.map(()=>identity==='key'?commonKey:crypto.randomUUID());
    const results=await Promise.allSettled(bodies.map((body,i)=>process.execute(body,keys[i]!)));
    expect(results.filter((r)=>r.status==='fulfilled')).toHaveLength(1);
    const rejected=results.find((r)=>r.status==='rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(ProcessingConflictError);
    expect(rejected.reason.code).toBe(identity==='key'?'IDEMPOTENCY_CONFLICT':'EXTERNAL_TRANSACTION_CONFLICT');
    const states=await Promise.all(wallets.map((w)=>h.state(w.id)));
    expect(states.map((s)=>s.balance).sort()).toEqual(['100.00','20.00']);
    const losingIndex=results.findIndex((r)=>r.status==='rejected');
    expect(states[losingIndex]).toEqual({balance:'100.00',version:'1',transactions:'1',ledger:'1',outbox:'2'});
    expect(arrived).toBe(2);
  });

  test('held wallet lock blocks its competitor while an unrelated wallet can commit',async()=>{
    const wallet=await h.wallet();
    const other=await h.wallet();
    let release!:()=>void;
    let reached!:()=>void;
    const gate=new Promise<void>((resolve)=>{release=resolve;});
    const ready=new Promise<void>((resolve)=>{reached=resolve;});
    const holder:TransactionManager={run:(work)=>h.manager.run((uow)=>work({...uow,wallets:{
      add:(w)=>uow.wallets.add(w),findById:(id)=>uow.wallets.findById(id),
      findByPlayerAndCurrency:(p,c)=>uow.wallets.findByPlayerAndCurrency(p,c),saveLocked:(w)=>uow.wallets.saveLocked(w),
      lockById:async(id)=>{const locked=await uow.wallets.lockById(id);reached();await gate;return locked;},
    }}))};
    const first=new ProcessWagerTransactionUseCase(holder).execute(wagerBody(wallet,Kind.Bet,'80.00'),crypto.randomUUID());
    let second:ReturnType<typeof h.post>|undefined;
    try{
      await ready;
      second=h.post(wagerBody(wallet,Kind.Bet,'80.00'));
      expect((await h.post(wagerBody(other))).httpStatus).toBe(200);
      expect((await h.state(wallet.id)).balance).toBe('100.00');
      // PostgreSQL itself proves a backend is waiting for a lock, without timing sleeps.
      let blocked=false;
      for(let attempt=0;attempt<100&&!blocked;attempt++){
        const rows=await h.sql<Array<{waiting:boolean}>>(`select exists(select 1 from pg_stat_activity
          where datname=current_database() and wait_event_type='Lock' and query ilike '%wallets%') as waiting`);
        blocked=rows[0]!.waiting;
      }
      expect(blocked).toBe(true);
    }finally{release();}
    expect((await first).httpStatus).toBe(200);
    expect((await second!).httpStatus).toBe(422);
    expect((await h.state(wallet.id)).balance).toBe('20.00');
  });

  test('concurrent winners and losing rollbacks all reconcile with ledger',async()=>{
    expect(await h.sql(`select w.id from wagering.wallets w left join wagering.wallet_ledger_entries l on l.wallet_id=w.id
      group by w.id,w.balance having w.balance <> coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end),0)`)).toEqual([]);
  });
});
