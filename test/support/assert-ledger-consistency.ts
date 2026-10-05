import { expect } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';

/** All arithmetic stays inside PostgreSQL NUMERIC; returned money remains text. */
export async function assertLedgerConsistency(orm: MikroORM) {
  const connection = orm.em.getConnection();
  const mismatches = await connection.execute<Array<{ id: string; balance: string; reconstructed: string }>>(`
    select w.id,w.balance::text,coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end),0)::text as reconstructed
    from wagering.wallets w left join wagering.wallet_ledger_entries l on l.wallet_id=w.id
    group by w.id,w.balance
    having w.balance <> coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end),0)`);
  expect(mismatches).toEqual([]);
  const duplicateEffects = await connection.execute(`select wallet_id,transaction_id from wagering.wallet_ledger_entries
    group by wallet_id,transaction_id having count(*)<>1`);
  expect(duplicateEffects).toEqual([]);
  const invalidLedger = await connection.execute(`select l.id from wagering.wallet_ledger_entries l
    join wagering.wager_transactions t on t.id=l.transaction_id
    where t.status<>'PROCESSED' or t.kind='LOSS' or l.currency<>t.currency or l.amount<>t.amount`);
  expect(invalidLedger).toEqual([]);
  expect(await connection.execute('select id from wagering.outbox_events where published_at is not null')).toEqual([]);
}
