import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { OpenWallet } from '../../src/application/open-wallet';
import { WalletAlreadyExistsError } from '../../src/application/financial-unit-of-work';
import { AppConfig } from '../../src/config/app-config';
import { WagerTransactionKind as Kind, WagerTransactionStatus as Status } from '../../src/domain/wager-transaction';
import { WalletsModule } from '../../src/wallets/wallets.module';
import { MikroOrmTransactionManager } from '../../src/infrastructure/persistence/mikro-orm-transaction-manager';
import { isolatedPostgres } from '../support/isolated-postgres';

type SqlValue = string | Date | null;
let fixture: Awaited<ReturnType<typeof isolatedPostgres>>;
let manager: MikroOrmTransactionManager;
let open: OpenWallet;
let app: INestApplication;

beforeAll(async () => {
  fixture = await isolatedPostgres();
  await fixture.orm.getMigrator().up();
  manager = new MikroOrmTransactionManager(fixture.orm);
  open = new OpenWallet(manager);
  const module = await Test.createTestingModule({ imports: [WalletsModule] })
    .overrideProvider(AppConfig).useValue(fixture.config).compile();
  app = module.createNestApplication({ logger: false });
  await app.listen(0, '127.0.0.1');
});

afterAll(async () => {
  try { if (app) await app.close(); } finally { if (fixture) await fixture.dispose(); }
});

const sql = <T extends object[] = Record<string, unknown>[]>(statement: string, params: unknown[] = []) =>
  fixture.orm.em.getConnection().execute<T>(statement, params);

async function insert(table: 'wallets' | 'wager_transactions' | 'wallet_ledger_entries', row: Record<string, SqlValue>) {
  const keys = Object.keys(row);
  if (keys.some((key) => !/^[a-z_]+$/.test(key))) throw new Error('Invalid test column');
  await sql(`insert into wagering.${table} (${keys.join(',')}) values (${keys.map(() => '?').join(',')})`, Object.values(row));
}

async function rawWallet(overrides: Record<string, SqlValue> = {}) {
  const row = { id: crypto.randomUUID(), player_id: crypto.randomUUID(), currency: 'BRL',
    balance: '0.00', version: '1', created_at: new Date(), updated_at: new Date(), ...overrides };
  await insert('wallets', row);
  return row;
}

async function rawTransaction(wallet: Awaited<ReturnType<typeof rawWallet>>, overrides: Record<string, SqlValue> = {}) {
  const row = { id: crypto.randomUUID(), provider_id: 'provider', external_transaction_id: crypto.randomUUID(),
    idempotency_key: crypto.randomUUID(), payload_hash: 'a'.repeat(64), wallet_id: wallet.id,
    player_id: wallet.player_id, round_id: 'round', game_id: 'game', kind: 'BET', amount: '10.00', currency: wallet.currency,
    status: 'PENDING', reference_external_transaction_id: null as string | null, reference_transaction_id: null as string | null,
    failure_code: null as string | null, created_at: new Date(), processed_at: null as Date | null, ...overrides };
  await insert('wager_transactions', row);
  return row;
}

function ledgerRow(tx: Awaited<ReturnType<typeof rawTransaction>>, overrides: Record<string, SqlValue> = {}) {
  return { id: crypto.randomUUID(), wallet_id: tx.wallet_id, transaction_id: tx.id, transaction_kind: tx.kind,
    transaction_status: 'PROCESSED', direction: 'CREDIT', amount: tx.amount, currency: tx.currency,
    balance_before: '0.00', balance_after: tx.amount, created_at: new Date(), ...overrides };
}

async function expectSqlFailure(action: () => Promise<unknown>, code: string, constraint?: string) {
  let error: unknown;
  try { await action(); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(Error);
  expect((error as { code?: string }).code).toBe(code);
  if (constraint !== undefined) expect((error as { constraint?: string }).constraint).toBe(constraint);
}

const counts = () => sql<Array<{ wallets: string; transactions: string; entries: string }>>(`select
  (select count(*)::text from wagering.wallets) as wallets,
  (select count(*)::text from wagering.wager_transactions) as transactions,
  (select count(*)::text from wagering.wallet_ledger_entries) as entries`);

describe('OpenWallet with real PostgreSQL', () => {
  test('zero opening persists only the wallet and rehydrates version 1', async () => {
    const wallet = await open.execute({ playerId: 'zero-opening', initialBalance: { amount: '0.00', currency: 'BRL' } });
    await manager.run(async (repositories) => {
      const restored = await repositories.wallets.findById(wallet.id);
      expect(restored?.balance.toString()).toBe('0.00');
      expect(restored?.version).toBe(1);
      expect(restored?.openingMovement).toBeUndefined();
      expect((await repositories.wallets.findByPlayerAndCurrency(wallet.playerId, wallet.currency))?.id).toBe(wallet.id);
      expect(await repositories.ledger.listForWallet(wallet.id)).toHaveLength(0);
    });
    expect(await sql('select id from wagering.wager_transactions where wallet_id = ?', [wallet.id])).toHaveLength(0);
  });

  test('positive opening atomically commits wallet, internal PROCESSED OPENING and CREDIT ledger', async () => {
    const amount = '9007199254740993123456789.99';
    const wallet = await open.execute({ playerId: 'positive-opening', initialBalance: { amount, currency: 'BRL' } });
    // Independent read after execute resolves sees all three committed rows.
    const rows = await sql<Array<{ balance: string; version: string; kind: string; status: string;
      amount: string; before: string; after: string; direction: string; provider: string }>>(`
      select w.balance::text, w.version::text, t.kind, t.status, t.amount::text,
        l.balance_before::text as before, l.balance_after::text as after, l.direction, t.provider_id as provider
      from wagering.wallets w join wagering.wager_transactions t on t.wallet_id=w.id
      join wagering.wallet_ledger_entries l on l.transaction_id=t.id where w.id=?`, [wallet.id]);
    expect(rows).toEqual([{ balance: amount, version: '1', kind: 'OPENING', status: 'PROCESSED',
      amount, before: '0.00', after: amount, direction: 'CREDIT', provider: 'internal' }]);
    await manager.run(async (repositories) => {
      const entries = await repositories.ledger.listForWallet(wallet.id);
      expect(entries).toHaveLength(1);
      const entry = entries[0]!;
      expect(entry.isBalanced()).toBe(true);
      expect(entry.money.equals(wallet.balance)).toBe(true);
      const tx = await repositories.transactions.findById(entry.transactionId);
      expect(tx?.kind).toBe(Kind.Opening);
      expect(tx?.status).toBe(Status.Processed);
      expect(tx?.processedAt).toEqual(wallet.createdAt);
      expect(tx?.money.equals(wallet.balance)).toBe(true);
      expect(tx?.payloadHash).toMatch(/^[a-f0-9]{64}$/);
      expect((await repositories.transactions.findByIdempotencyKey(`opening:${wallet.id}`))?.id).toBe(tx?.id);
      expect((await repositories.transactions.findByProviderAndExternalId('internal', entry.transactionId))?.id).toBe(tx?.id);
      expect((await repositories.ledger.findByWalletAndTransaction(wallet.id, entry.transactionId))?.id).toBe(entry.id);
    });
  });

  test('duplicate player/currency is a conflict; same player with another currency is allowed', async () => {
    const input = { playerId: 'duplicate-opening', initialBalance: { amount: '5.00', currency: 'BRL' } };
    const wallet = await open.execute(input);
    const before = await counts();
    await expect(open.execute(input)).rejects.toBeInstanceOf(WalletAlreadyExistsError);
    expect(await counts()).toEqual(before);
    const other = await open.execute({ ...input, initialBalance: { amount: '0.00', currency: 'USD' } });
    expect(other.id).not.toBe(wallet.id);
  });

  test('failure during ledger INSERT rolls back already flushed wallet and OPENING', async () => {
    await sql(`create function wagering.phase2_fail_opening() returns trigger language plpgsql as $$
      begin
        if exists(select 1 from wagering.wallets where id=NEW.wallet_id and player_id='atomic-failure') then
          raise exception 'Intentional integration failure';
        end if;
        return NEW;
      end; $$`);
    await sql(`create trigger phase2_fail_opening before insert on wagering.wallet_ledger_entries
      for each row execute function wagering.phase2_fail_opening()`);
    try {
      const before = await counts();
      await expectSqlFailure(() => open.execute({ playerId: 'atomic-failure', initialBalance: { amount: '12.34', currency: 'BRL' } }), 'P0001');
      expect(await counts()).toEqual(before);
      expect(await sql("select id from wagering.wallets where player_id='atomic-failure'")).toHaveLength(0);
      expect(await sql("select id from wagering.wager_transactions where player_id='atomic-failure'")).toHaveLength(0);
    } finally {
      await sql('drop trigger phase2_fail_opening on wagering.wallet_ledger_entries');
      await sql('drop function wagering.phase2_fail_opening()');
    }
    // A clean retry succeeds: no orphan wallet or internal idempotency record remains.
    expect((await open.execute({ playerId: 'atomic-failure', initialBalance: { amount: '12.34', currency: 'BRL' } })).version).toBe(1);
  });
});

describe('constraints through direct SQL', () => {
  test.each(['-0.01', '0.001', 'NaN', 'Infinity', '-Infinity'])('blocks wallet balance %s', async (balance) => {
    await expectSqlFailure(() => rawWallet({ balance }), '23514', 'wallets_balance_check');
  });
  test.each(['0', '-1', '9007199254740992'])('blocks wallet version %s', async (version) => {
    await expectSqlFailure(() => rawWallet({ version }), '23514', 'wallets_version_check');
  });
  test('wallet UNIQUE and PK apply without the repositories', async () => {
    const wallet = await rawWallet();
    await expectSqlFailure(() => rawWallet({ player_id: wallet.player_id }), '23505', 'wallets_player_currency_unique');
    await expectSqlFailure(() => rawWallet({ id: wallet.id }), '23505', 'wallets_pkey');
  });
  test('transaction keys are unique and bound to the existing wallet identity/currency', async () => {
    const wallet = await rawWallet();
    const tx = await rawTransaction(wallet);
    await expectSqlFailure(() => rawTransaction(wallet, { id: tx.id }), '23505', 'wager_transactions_pkey');
    await expectSqlFailure(() => rawTransaction(wallet, { idempotency_key: tx.idempotency_key }), '23505', 'transactions_idempotency_unique');
    await expectSqlFailure(() => rawTransaction(wallet, { external_transaction_id: tx.external_transaction_id }), '23505', 'transactions_provider_external_unique');
    await expectSqlFailure(() => rawTransaction(wallet, { wallet_id: crypto.randomUUID() }), '23503', 'transactions_wallet_exists_fk');
    await expectSqlFailure(() => rawTransaction(wallet, { player_id: 'wrong-player' }), '23503', 'transactions_wallet_fk');
    await expectSqlFailure(() => rawTransaction(wallet, { currency: 'USD' }), '23503', 'transactions_wallet_fk');
  });
  test('transaction kind, status, reference, failure and timestamp shapes are checked', async () => {
    const wallet = await rawWallet();
    const invalid: Array<Record<string, SqlValue>> = [
      { kind: 'UNKNOWN' }, { status: 'UNKNOWN' }, { kind: 'REFUND' }, { status: 'PENDING_REFERENCE' },
      { status: 'PROCESSED' }, { status: 'REJECTED' }, { status: 'FAILED', failure_code: 'UNKNOWN' },
      { processed_at: new Date() }, { failure_code: 'INVALID_REFERENCE' }, { kind: 'OPENING' },
      { reference_external_transaction_id: 'ref' }, { amount: '-1.00' }, { amount: '0.001' },
      { amount: 'NaN' }, { amount: 'Infinity' }, { payload_hash: 'bad' },
    ];
    for (const overrides of invalid) await expectSqlFailure(() => rawTransaction(wallet, overrides), '23514');
  });
  test('resolved references require matching provider/player/wallet/currency/round/external id', async () => {
    const wallet = await rawWallet();
    const ref = await rawTransaction(wallet, { status: 'PROCESSED', processed_at: new Date() });
    const valid = { kind: 'REFUND', status: 'PROCESSED', processed_at: new Date(),
      reference_transaction_id: ref.id, reference_external_transaction_id: ref.external_transaction_id };
    const invalid: Array<Record<string, SqlValue>> = [{ reference_transaction_id: crypto.randomUUID() },
      { provider_id: 'other-provider' }, { round_id: 'other-round' }, { reference_external_transaction_id: 'other-external' }];
    for (const overrides of invalid) {
      await expectSqlFailure(() => rawTransaction(wallet, { ...valid, ...overrides }), '23503', 'transactions_reference_fk');
    }
    await rawTransaction(wallet, valid);
    await expectSqlFailure(() => rawTransaction(wallet, valid), '23505', 'transactions_processed_reversal_unique');
  });
  test('ledger UNIQUE, exact amounts and composite FKs are enforced', async () => {
    const wallet = await rawWallet();
    const tx = await rawTransaction(wallet, { kind: 'WIN', status: 'PROCESSED', processed_at: new Date() });
    const row = ledgerRow(tx);
    await insert('wallet_ledger_entries', row);
    await expectSqlFailure(() => insert('wallet_ledger_entries', { ...row, id: crypto.randomUUID() }), '23505', 'ledger_wallet_transaction_unique');
    const other = await rawTransaction(wallet, { kind: 'WIN', status: 'PROCESSED', processed_at: new Date() });
    await expectSqlFailure(() => insert('wallet_ledger_entries', ledgerRow(other, { id: row.id })), '23505', 'wallet_ledger_entries_pkey');
    await expectSqlFailure(() => insert('wallet_ledger_entries', ledgerRow(other, { transaction_id: crypto.randomUUID() })), '23503', 'ledger_transaction_fk');
    await expectSqlFailure(() => insert('wallet_ledger_entries', ledgerRow(other, { currency: 'USD' })), '23503', 'ledger_transaction_fk');
    await expectSqlFailure(() => insert('wallet_ledger_entries', ledgerRow(other, { amount: '20.00', balance_after: '20.00' })), '23503', 'ledger_transaction_fk');
    const different = await rawWallet();
    await expectSqlFailure(() => insert('wallet_ledger_entries', ledgerRow(other, { wallet_id: different.id })), '23503', 'ledger_transaction_fk');
    await expectSqlFailure(() => insert('wallet_ledger_entries', ledgerRow(other, { balance_after: '9.99' })), '23514', 'ledger_arithmetic_check');
    await expectSqlFailure(() => insert('wallet_ledger_entries', ledgerRow(other, { amount: '0.00', balance_after: '0.00' })), '23514', 'ledger_amount_check');
    await expectSqlFailure(() => insert('wallet_ledger_entries', ledgerRow(other, { balance_before: '-1.00', balance_after: '9.00' })), '23514', 'ledger_before_check');
  });
  test('ledger cannot represent LOSS, unprocessed/rejected transactions, or wrong kind direction', async () => {
    const wallet = await rawWallet();
    const pending = await rawTransaction(wallet, { kind: 'WIN' });
    await expectSqlFailure(() => insert('wallet_ledger_entries', ledgerRow(pending)), '23503', 'ledger_transaction_fk');
    const rejected = await rawTransaction(wallet, { kind: 'WIN', status: 'REJECTED', failure_code: 'INSUFFICIENT_BALANCE' });
    await expectSqlFailure(() => insert('wallet_ledger_entries', ledgerRow(rejected)), '23503', 'ledger_transaction_fk');
    const loss = await rawTransaction(wallet, { kind: 'LOSS', status: 'PROCESSED', processed_at: new Date() });
    await expectSqlFailure(() => insert('wallet_ledger_entries', ledgerRow(loss)), '23514', 'ledger_kind_direction_check');
    const win = await rawTransaction(wallet, { kind: 'WIN', status: 'PROCESSED', processed_at: new Date() });
    await expectSqlFailure(() => insert('wallet_ledger_entries', ledgerRow(win, { direction: 'DEBIT', balance_before: '10.00', balance_after: '0.00' })), '23514', 'ledger_kind_direction_check');
  });
  test('UPDATE/DELETE including no-op updates are blocked; parent rows cannot cascade away', async () => {
    const wallet = await open.execute({ playerId: 'immutable-ledger', initialBalance: { amount: '20.00', currency: 'BRL' } });
    const [row] = await sql<Array<{ id: string; transaction_id: string }>>('select id,transaction_id from wagering.wallet_ledger_entries where wallet_id=?', [wallet.id]);
    expect(row).toBeDefined();
    await expectSqlFailure(() => sql('update wagering.wallet_ledger_entries set created_at=created_at where id=?', [row!.id]), '55000');
    await expectSqlFailure(() => sql('delete from wagering.wallet_ledger_entries where id=?', [row!.id]), '55000');
    await expectSqlFailure(() => sql('delete from wagering.wager_transactions where id=?', [row!.transaction_id]), '23503');
    await expectSqlFailure(() => sql('delete from wagering.wallets where id=?', [wallet.id]), '23503');
    expect(await sql('select id from wagering.wallet_ledger_entries where id=?', [row!.id])).toHaveLength(1);
  });
});

describe('POST /wallets against PostgreSQL through production module wiring', () => {
  async function post(body: unknown) {
    const response = await fetch(`${await app.getUrl()}/wallets`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  }
  test('201 for zero and positive openings, with strings and version 1', async () => {
    for (const amount of ['0.00', '123456789012345678901234.56']) {
      const playerId = crypto.randomUUID();
      const response = await post({ playerId, initialBalance: { amount, currency: 'BRL' } });
      expect(response.status).toBe(201);
      expect(response.body).toEqual({ id: expect.any(String), playerId, balance: { amount, currency: 'BRL' }, version: 1 });
      const entries = await sql('select id from wagering.wallet_ledger_entries where wallet_id=?', [response.body.id]);
      expect(entries).toHaveLength(amount === '0.00' ? 0 : 1);
    }
  });
  test('duplicate opening returns 409 and preserves original records', async () => {
    const body = { playerId: 'http-duplicate', initialBalance: { amount: '5.00', currency: 'BRL' } };
    expect((await post(body)).status).toBe(201);
    const before = await counts();
    const response = await post(body);
    expect(response.status).toBe(409);
    expect(response.body.failureCode).toBe('WALLET_ALREADY_EXISTS');
    expect(await counts()).toEqual(before);
  });
  test('malformed input, monetary numbers, negative and invalid decimals return 400 without writes', async () => {
    const before = await counts();
    for (const body of [{}, [], null, { playerId: 'p', initialBalance: { amount: 0.01, currency: 'BRL' } },
      ...['-1.00', '', 'NaN', 'Infinity', '1e2', '1.001', '1.0'].map((amount) => ({ playerId: 'p', initialBalance: { amount, currency: 'BRL' } })),
      { playerId: 'p', initialBalance: { amount: '1.00', currency: 'brl' } }]) {
      expect((await post(body)).status).toBe(400);
    }
    expect(await counts()).toEqual(before);
  });
});
