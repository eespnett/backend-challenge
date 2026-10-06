import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { SQSClient } from '@aws-sdk/client-sqs';
import { ProcessWagerTransactionUseCase } from '../../src/application/process-wager-transaction';
import { TransactionManager } from '../../src/application/financial-unit-of-work';
import { WagerTransactionKind as Kind, WagerTransactionStatus as Status } from '../../src/domain/wager-transaction';
import { phase3Harness, wagerBody } from '../support/phase3-harness';
import { isolatedPostgres } from '../support/isolated-postgres';
import { OpenWallet } from '../../src/application/open-wallet';
import { MikroOrmTransactionManager } from '../../src/infrastructure/persistence/mikro-orm-transaction-manager';

let h: Awaited<ReturnType<typeof phase3Harness>>;
beforeAll(async () => { h = await phase3Harness(); });
afterAll(async () => { if (h) await h.close(); });

async function events(transactionId: string) {
  return h.sql<Array<{ event_type: string; published_at: null; payload: Record<string, unknown> }>>(
    'select event_type,published_at,payload from wagering.outbox_events where transaction_id=? order by event_type', [transactionId]);
}

describe('Phase 3 processing via HTTP and real PostgreSQL', () => {
  test('BET debits with exact ledger, one version increment, persisted result and unpublished outbox', async () => {
    const wallet = await h.wallet();
    const key = crypto.randomUUID();
    const body = wagerBody(wallet);
    const result = await h.post(body, key);
    expect(result.httpStatus).toBe(200);
    expect(result.body).toEqual({ transactionId: expect.any(String), status: Status.Processed,
      balance: { amount: '75.00', currency: 'BRL' }, idempotentReplay: false });
    expect(await h.state(wallet.id)).toEqual({ balance: '75.00', version: '2', transactions: '2', ledger: '2', outbox: '4' });
    const ledger = await h.sql('select direction,amount::text,balance_before::text,balance_after::text from wagering.wallet_ledger_entries where transaction_id=?', [result.body.transactionId]);
    expect(ledger).toEqual([{ direction: 'DEBIT', amount: '25.00', balance_before: '100.00', balance_after: '75.00' }]);
    expect(await h.sql('select result_http_status,result_body from wagering.wager_transactions where id=?', [result.body.transactionId]))
      .toEqual([{ result_http_status: 200, result_body: result.body }]);
    const outbox = await events(result.body.transactionId);
    expect(outbox.map((e) => e.event_type)).toEqual(['WagerTransactionProcessed','WalletBalanceChanged']);
    expect(outbox.every((e) => e.published_at === null)).toBe(true);
  });

  test('BET without funds is persisted REJECTED; no debit, version change or balance event', async () => {
    const wallet = await h.wallet('10.00');
    const before = await h.state(wallet.id);
    const result = await h.post(wagerBody(wallet));
    expect(result.httpStatus).toBe(422);
    expect(result.body.status).toBe(Status.Rejected);
    expect(result.body.failureCode).toBe('INSUFFICIENT_BALANCE');
    expect(result.body.balance.amount).toBe('10.00');
    expect(await h.state(wallet.id)).toEqual({ ...before, transactions: '2', outbox: '3' });
    expect((await events(result.body.transactionId)).map((e) => e.event_type)).toEqual(['WagerTransactionRejected']);
  });

  test('WIN credits exact money above the safe integer limit', async () => {
    const wallet = await h.wallet('0.00');
    const result = await h.post(wagerBody(wallet, Kind.Win, '9007199254740993123456789.99'));
    expect(result.httpStatus).toBe(200);
    expect(result.body.balance.amount).toBe('9007199254740993123456789.99');
    expect(await h.state(wallet.id)).toEqual({ balance: result.body.balance.amount, version: '2', transactions: '1', ledger: '1', outbox: '2' });
  });

  test('LOSS and zero-valued operations do not change wallet/version or generate ledger', async () => {
    const wallet = await h.wallet();
    const before = await h.state(wallet.id);
    for (const [kind, amount] of [[Kind.Loss, '50.00'],[Kind.Bet,'0.00'],[Kind.Win,'0.00']] as const) {
      const result = await h.post(wagerBody(wallet, kind, amount));
      expect(result.httpStatus).toBe(200);
      expect(result.body.balance.amount).toBe('100.00');
      expect((await events(result.body.transactionId)).map((e) => e.event_type)).toEqual(['WagerTransactionProcessed']);
    }
    expect(await h.state(wallet.id)).toEqual({ ...before, transactions: '4', outbox: '5' });
  });

  test('REFUND credits a BET and a second REFUND is rejected', async () => {
    const wallet = await h.wallet();
    const bet = wagerBody(wallet);
    const betResult = await h.post(bet);
    const reversal = wagerBody(wallet, Kind.Refund, '25.00', { referenceExternalTransactionId: bet.externalTransactionId });
    const result = await h.post(reversal);
    expect(result.httpStatus).toBe(200);
    expect(result.body.balance.amount).toBe('100.00');
    expect(await h.sql('select reference_transaction_id from wagering.wager_transactions where id=?', [result.body.transactionId]))
      .toEqual([{ reference_transaction_id: betResult.body.transactionId }]);
    const duplicate = await h.post({ ...reversal, externalTransactionId: crypto.randomUUID() });
    expect(duplicate.httpStatus).toBe(422);
    expect(duplicate.body.failureCode).toBe('DUPLICATE_REVERSAL');
    expect(await h.state(wallet.id)).toEqual({ balance: '100.00', version: '3', transactions: '4', ledger: '3', outbox: '7' });
  });

  test.each([Kind.Bet, Kind.Win, Kind.Refund])('ROLLBACK reverses %s with the correct ledger direction', async (referenceKind) => {
    const wallet = await h.wallet();
    let reference = wagerBody(wallet, referenceKind);
    if (referenceKind === Kind.Refund) {
      const bet = wagerBody(wallet);
      await h.post(bet);
      reference = wagerBody(wallet, Kind.Refund, '25.00', { referenceExternalTransactionId: bet.externalTransactionId });
    }
    await h.post(reference);
    const rollback = wagerBody(wallet, Kind.Rollback, '25.00', { referenceExternalTransactionId: reference.externalTransactionId });
    const result = await h.post(rollback);
    expect(result.httpStatus).toBe(200);
    expect(result.body.balance.amount).toBe(referenceKind === Kind.Refund ? '75.00' : '100.00');
    expect(await h.sql('select direction from wagering.wallet_ledger_entries where transaction_id=?', [result.body.transactionId]))
      .toEqual([{ direction: referenceKind === Kind.Bet ? 'CREDIT' : 'DEBIT' }]);
    const duplicate = await h.post({ ...rollback, externalTransactionId: crypto.randomUUID() });
    expect(duplicate.body.failureCode).toBe('DUPLICATE_REVERSAL');
  });

  test('ROLLBACK that would create negative balance is rejected without ledger', async () => {
    const wallet = await h.wallet('0.00');
    const win = wagerBody(wallet, Kind.Win, '80.00');
    await h.post(win);
    await h.post(wagerBody(wallet, Kind.Bet, '70.00'));
    const before = await h.state(wallet.id);
    const result = await h.post(wagerBody(wallet, Kind.Rollback, '80.00', { referenceExternalTransactionId: win.externalTransactionId }));
    expect(result.httpStatus).toBe(422);
    expect(result.body.failureCode).toBe('REVERSAL_INSUFFICIENT_FUNDS');
    expect(await h.state(wallet.id)).toEqual({ ...before, transactions: '3', outbox: '5' });
  });

  test.each(['playerId','money','roundId','walletId','kind','amount'])('invalid reference %s is rejected', async (field) => {
    const wallet = await h.wallet();
    const other = await h.wallet();
    const overrides: Record<string, unknown> = field === 'playerId' ? { playerId: other.playerId, walletId: other.id } :
      field === 'walletId' ? { walletId: other.id, playerId: other.playerId } :
      field === 'roundId' ? { roundId: 'other-round' } : {};
    // Use a valid processed reference, including an actual different-currency wallet.
    let referenceWallet = wallet;
    if (field === 'money') referenceWallet = await h.wallet('100.00','USD');
    const ref = wagerBody(referenceWallet, field === 'kind' ? Kind.Win : Kind.Bet, '25.00', field === 'money' ? {} : overrides);
    if (field === 'playerId' || field === 'walletId') ref.playerId = other.playerId;
    await h.post(ref);
    const result = await h.post(wagerBody(wallet, Kind.Refund, field === 'amount' ? '24.00' : '25.00', { referenceExternalTransactionId: ref.externalTransactionId }));
    expect(result.httpStatus).toBe(422);
    expect(result.body.failureCode).toBe(field === 'amount' ? 'REFERENCE_AMOUNT_MISMATCH' : 'INVALID_REFERENCE');
  });

  test('provider scopes reference lookup: same external id under another provider remains pending', async () => {
    const wallet = await h.wallet();
    const bet = wagerBody(wallet, Kind.Bet, '25.00', { providerId: 'provider-b' });
    await h.post(bet);
    const result = await h.post(wagerBody(wallet, Kind.Refund, '25.00', { referenceExternalTransactionId: bet.externalTransactionId }));
    expect(result.httpStatus).toBe(202);
    expect(result.body.status).toBe(Status.PendingReference);
  });

  test.each([{ playerId: 'wrong-player' },{ money: { amount: '25.00', currency: 'USD' } }])('identity/currency mismatch is auditable REJECTED %j', async (overrides) => {
    const wallet = await h.wallet();
    const before = await h.state(wallet.id);
    const result = await h.post(wagerBody(wallet, Kind.Bet, '25.00', overrides));
    expect(result.httpStatus).toBe(422);
    expect(result.body.failureCode).toBe('playerId' in overrides ? 'WALLET_MISMATCH' : 'CURRENCY_MISMATCH');
    expect(result.body.balance).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(await h.state(wallet.id)).toEqual({ ...before, transactions: '2', outbox: '3' });
  });

  test('replay uses the committed snapshot after later movements and process recreation', async () => {
    const wallet = await h.wallet();
    const body = wagerBody(wallet);
    const key = crypto.randomUUID();
    const original = await h.post(body, key);
    await h.post(wagerBody(wallet, Kind.Win, '50.00'));
    const before = await h.state(wallet.id);
    // New use case instance: no in-memory idempotency state participates.
    const replayOnlyManager: TransactionManager = { run: (work) => h.manager.run((uow) => work({ ...uow,
      wallets: new Proxy(uow.wallets, { get() { throw new Error('Replay must never read or lock a wallet'); } }) })) };
    const replay = await new ProcessWagerTransactionUseCase(replayOnlyManager).execute(body, key);
    expect(replay as unknown).toEqual({ ...original, body: { ...original.body, idempotentReplay: true } });
    expect(replay.body.balance.amount).toBe('75.00');
    expect(before.balance).toBe('125.00');
    expect(await h.state(wallet.id)).toEqual(before);
    expect(await h.post(body, key)).toEqual(replay);
  });

  test('key with different hash and external identity with another key return distinct 409 conflicts', async () => {
    const wallet = await h.wallet();
    const body = wagerBody(wallet);
    const key = crypto.randomUUID();
    await h.post(body, key);
    const before = await h.state(wallet.id);
    const changed = await h.post({ ...body, money: { amount: '26.00', currency: 'BRL' } }, key);
    expect(changed.httpStatus).toBe(409);
    expect(changed.body.failureCode as string).toBe('IDEMPOTENCY_CONFLICT');
    const external = await h.post(body);
    expect(external.httpStatus).toBe(409);
    expect(external.body.failureCode as string).toBe('EXTERNAL_TRANSACTION_CONFLICT');
    expect(await h.state(wallet.id)).toEqual(before);
  });

  test('REJECTED replay stays rejected even after funds arrive', async () => {
    const wallet = await h.wallet('0.00');
    const key = crypto.randomUUID();
    const body = wagerBody(wallet);
    const original = await h.post(body,key);
    await h.post(wagerBody(wallet, Kind.Win, '100.00'));
    expect(await h.post(body,key)).toEqual({ ...original, body: { ...original.body,idempotentReplay:true } });
    expect((await h.state(wallet.id)).balance).toBe('100.00');
  });

  test.each([Kind.Refund, Kind.Rollback])('missing %s reference persists pending; arrival does not reprocess it', async (kind) => {
    const wallet = await h.wallet();
    const bet = wagerBody(wallet);
    const body = wagerBody(wallet,kind,'25.00',{ referenceExternalTransactionId: bet.externalTransactionId });
    const key = crypto.randomUUID();
    const result = await h.post(body,key);
    expect(result.httpStatus).toBe(202);
    expect(result.body.status).toBe(Status.PendingReference);
    expect((await events(result.body.transactionId)).map((e) => e.event_type)).toEqual(['WagerTransactionPendingReference']);
    expect(await h.state(wallet.id)).toEqual({ balance:'100.00',version:'1',transactions:'2',ledger:'1',outbox:'3' });
    await h.post(bet);
    expect(await h.post(body,key)).toEqual({ ...result,body:{ ...result.body,idempotentReplay:true } });
    expect((await h.state(wallet.id)).balance).toBe('75.00');
  });

  test('invalid payload/header and missing wallet return 400 with no writes', async () => {
    const wallet = await h.wallet();
    const body = wagerBody(wallet);
    const before = await h.state(wallet.id);
    for (const invalid of [null, {}, { ...body, kind:'OPENING' }, { ...body, providerId:'internal' },
      { ...body,money:{ amount:25,currency:'BRL' } },{ ...body,money:{ amount:'-1.00',currency:'BRL' } },
      { ...body,kind:'REFUND' },{ ...body,walletId:crypto.randomUUID() },{ ...body,extra:'ignored?' }]) {
      expect((await h.post(invalid)).httpStatus).toBe(400);
    }
    expect((await h.post(body,null)).httpStatus).toBe(400);
    expect((await h.post(body,'one, two')).httpStatus).toBe(400);
    expect(await h.state(wallet.id)).toEqual(before);
  });

  test('failure between wallet update and ledger insert rolls back all writes; safe retry succeeds', async () => {
    const wallet = await h.wallet();
    const body = wagerBody(wallet);
    const key = crypto.randomUUID();
    const before = await h.state(wallet.id);
    await h.sql(`create function wagering.test_fail_ledger() returns trigger language plpgsql as $$ begin
      if new.direction='DEBIT' then raise exception 'Injected transient failure' using errcode='40001'; end if;
      return new; end; $$;
      create trigger test_fail_ledger before insert on wagering.wallet_ledger_entries
        for each row execute function wagering.test_fail_ledger()`);
    try {
      const result = await h.post(body,key);
      expect(result.httpStatus).toBe(503);
      expect(result.body.failureCode as string).toBe('INFRASTRUCTURE_UNAVAILABLE');
      expect(await h.state(wallet.id)).toEqual(before);
      expect(await h.sql('select id from wagering.wager_transactions where idempotency_key=?',[key])).toEqual([]);
    } finally { await h.sql('drop trigger test_fail_ledger on wagering.wallet_ledger_entries; drop function wagering.test_fail_ledger()'); }
    const retry = await h.post(body,key);
    expect(retry.httpStatus).toBe(200);
    expect(retry.body.idempotentReplay).toBe(false);
    expect((await h.state(wallet.id)).balance).toBe('75.00');
  });

  test('outbox insert failure also rolls back wallet, transaction and ledger', async () => {
    const wallet = await h.wallet();
    const before = await h.state(wallet.id);
    await h.sql(`create function wagering.test_fail_outbox() returns trigger language plpgsql as $$ begin
      raise exception 'Injected outbox failure' using errcode='40001'; end; $$;
      create trigger test_fail_outbox before insert on wagering.outbox_events for each row execute function wagering.test_fail_outbox()`);
    try {
      expect((await h.post(wagerBody(wallet))).httpStatus).toBe(503);
      expect(await h.state(wallet.id)).toEqual(before);
    } finally { await h.sql('drop trigger test_fail_outbox on wagering.outbox_events; drop function wagering.test_fail_outbox()'); }
  });

  test('outbox is invisible before commit; execution performs no external publication', async () => {
    const wallet = await h.wallet();
    const before = await h.state(wallet.id);
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((resolve) => { release=resolve; });
    const ready = new Promise<void>((resolve) => { reached=resolve; });
    const pausedManager: TransactionManager = { run: (work) => h.manager.run((uow) => work({ ...uow,
      outbox:{ enqueue:async (id, ev) => { await uow.outbox.enqueue(id,ev); reached(); await gate; } } })) };
    const fetchSpy = spyOn(globalThis,'fetch');
    const sqsSpy = spyOn(SQSClient.prototype,'send');
    const pending = new ProcessWagerTransactionUseCase(pausedManager).execute(wagerBody(wallet),crypto.randomUUID());
    try {
      await ready;
      expect(await h.state(wallet.id)).toEqual(before);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(sqsSpy).not.toHaveBeenCalled();
    } finally { release(); }
    let result;
    try {
      result = await pending;
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(sqsSpy).not.toHaveBeenCalled();
    } finally { fetchSpy.mockRestore(); sqsSpy.mockRestore(); }
    expect(result.httpStatus).toBe(200);
    expect((await events(result.body.transactionId)).every((e) => e.published_at===null)).toBe(true);
  });

  test('SQL cannot rewrite original response or insert malformed outbox envelope', async () => {
    const wallet = await h.wallet();
    const result = await h.post(wagerBody(wallet));
    let error: unknown;
    try { await h.sql("update wagering.wager_transactions set result_body=jsonb_set(result_body,'{balance,amount}','\"999.00\"') where id=?",[result.body.transactionId]); }
    catch (caught) { error=caught; }
    expect((error as {code:string}).code).toBe('55000');
    try { await h.sql(`insert into wagering.outbox_events(id,transaction_id,aggregate_id,event_type,version,payload,occurred_at)
      values(?,?,?,'WagerTransactionRejected',1,'{}',now())`,[crypto.randomUUID(),result.body.transactionId,result.body.transactionId]); }
    catch (caught) { error=caught; }
    expect((error as {code:string}).code).toBe('23514');
  });

  test('DOWN refuses incompatible historical rejection and rolls back all its DDL', async () => {
    const fixture = await isolatedPostgres();
    try {
      await fixture.orm.getMigrator().up();
      const manager = new MikroOrmTransactionManager(fixture.orm);
      const wallet = await new OpenWallet(manager).execute({ playerId:'downgrade-probe',initialBalance:{amount:'100.00',currency:'BRL'} });
      const rejected = await new ProcessWagerTransactionUseCase(manager).execute(
        wagerBody(wallet,Kind.Bet,'25.00',{money:{amount:'25.00',currency:'USD'}}),crypto.randomUUID());
      expect(rejected.httpStatus).toBe(422);
      await fixture.orm.getMigrator().down(); // Phase 7 publisher metadata/receipts.
      await fixture.orm.getMigrator().down(); // Phase 6 messaging tables.
      await fixture.orm.getMigrator().down(); // Phase 5 has no incompatible codes in this fixture.
      await expect(fixture.orm.getMigrator().down()).rejects.toThrow();
      const connection=fixture.orm.em.getConnection();
      expect(await connection.execute('select result_http_status,result_body from wagering.wager_transactions where id=?',[rejected.body.transactionId]))
        .toEqual([{result_http_status:422,result_body:rejected.body}]);
      expect(await connection.execute('select count(*)::text as count from wagering.outbox_events')).toEqual([{count:'3'}]);
      expect(await fixture.orm.getMigrator().getExecutedMigrations()).toHaveLength(3);
    } finally { await fixture.dispose(); }
  });

  test('all processed wallet balances reconcile exactly with immutable ledger', async () => {
    expect(await h.sql(`select w.id from wagering.wallets w left join wagering.wallet_ledger_entries l on l.wallet_id=w.id
      group by w.id,w.balance having w.balance <> coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end),0)`)).toEqual([]);
  });
});
