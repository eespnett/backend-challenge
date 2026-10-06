import { Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { decodeLedgerCursor, encodeLedgerCursor, ledgerLimit, uuidPattern } from '../application/ledger-cursor';
import { Money } from '../domain/money';
import { TelemetryService } from '../observability/telemetry.service';

const timestamp = "to_char(created_at at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')";
const missing = () => new NotFoundException({ failureCode: 'RESOURCE_NOT_FOUND', message: 'Resource not found' });
const money = (amount: string, currency: string) => {
  const [whole, fraction = ''] = amount.split('.');
  return Money.rehydrate({ amount: `${whole}.${fraction.padEnd(2, '0')}`, currency }).toJSON();
};
interface WalletRow { id: string; player_id: string; currency: string; balance: string; version: string; created_at: Date; updated_at: Date }
interface LedgerRow { id: string; transaction_id: string; transaction_kind: string; direction: string; amount: string; currency: string;
  balance_before: string; balance_after: string; cursor_time: string }
interface TransactionRow { id: string; provider_id: string; external_transaction_id: string; wallet_id: string; player_id: string;
  round_id: string; game_id: string; kind: string; amount: string; currency: string; status: string;
  reference_external_transaction_id: string | null; reference_transaction_id: string | null; failure_code: string | null;
  created_at: Date; processed_at: Date | null }
interface ReconciliationRow { id: string; currency: string; stored: string; calculated: string; difference: string; checked: string }

@Injectable()
export class QueryService {
  constructor(@Inject(MikroORM) private readonly orm: MikroORM,
    @Inject(TelemetryService) private readonly telemetry: TelemetryService) {}

  private id(id: string): string {
    if (!uuidPattern.test(id)) throw missing();
    return id.toLowerCase();
  }
  private async read<T>(query: (em: EntityManager) => Promise<T>): Promise<T> {
    try {
      return await this.orm.em.fork({ clear: true, useContext: false }).transactional(async (em) => {
        await em.execute("set local statement_timeout = '5s'");
        await em.execute('set transaction read only');
        return query(em);
      });
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      throw new ServiceUnavailableException({ failureCode: 'INFRASTRUCTURE_UNAVAILABLE', message: 'Query infrastructure unavailable' });
    }
  }

  async wallet(walletId: string) {
    const id = this.id(walletId);
    return this.read(async (em) => {
      const [row] = await em.execute<WalletRow[]>('select id,player_id,currency,balance::text,version::text,created_at,updated_at from wagering.wallets where id=?', [id]);
      if (!row) throw missing();
      return { id: row.id, playerId: row.player_id, balance: money(row.balance, row.currency), version: Number(row.version),
        createdAt: row.created_at, updatedAt: row.updated_at };
    });
  }

  async ledger(walletId: string, rawCursor: unknown, rawLimit: unknown) {
    const id = this.id(walletId);
    const cursor = decodeLedgerCursor(rawCursor, id); const limit = ledgerLimit(rawLimit);
    return this.read(async (em) => {
      // Wallet existence and page rows share one statement/snapshot, including empty pages.
      const rows = await em.execute<Array<LedgerRow | { id: null }>>(`select w.id as wallet_id,page.* from wagering.wallets w
        left join lateral (select id,transaction_id,transaction_kind,direction,amount::text,currency,
          balance_before::text,balance_after::text,${timestamp} as cursor_time
          from wagering.wallet_ledger_entries where wallet_id=w.id
          ${cursor ? 'and (created_at,id) < (?::timestamptz,?::uuid)' : ''}
          order by created_at desc,id desc limit ?) page on true where w.id=?`,
        [...(cursor ? [cursor.createdAt, cursor.id] : []), limit + 1, id]);
      if (!rows.length) throw missing();
      const entries = rows.filter((row): row is LedgerRow => row.id !== null);
      const selected = entries.slice(0, limit); const last = selected.at(-1);
      return { items: selected.map((row) => ({ id: row.id, walletId: id, transactionId: row.transaction_id,
        transactionKind: row.transaction_kind, direction: row.direction, money: money(row.amount, row.currency),
        balanceBefore: money(row.balance_before, row.currency), balanceAfter: money(row.balance_after, row.currency), createdAt: row.cursor_time })),
        nextCursor: entries.length > limit && last ? encodeLedgerCursor({ version: 1, walletId: id, createdAt: last.cursor_time, id: last.id }) : null };
    });
  }

  transaction(transactionId: string) { return this.findTransaction('id=?', [this.id(transactionId)]); }
  providerTransaction(providerId: string, externalTransactionId: string) {
    return this.findTransaction('provider_id=? and external_transaction_id=?', [providerId, externalTransactionId]);
  }
  private findTransaction(where: string, params: string[]) {
    return this.read(async (em) => {
      const [row] = await em.execute<TransactionRow[]>(`select id,provider_id,external_transaction_id,wallet_id,player_id,round_id,game_id,
        kind,amount::text,currency,status,reference_external_transaction_id,reference_transaction_id,failure_code,created_at,processed_at
        from wagering.wager_transactions where ${where}`, params);
      if (!row) throw missing();
      return { transactionId: row.id, providerId: row.provider_id, externalTransactionId: row.external_transaction_id,
        walletId: row.wallet_id, playerId: row.player_id, roundId: row.round_id, gameId: row.game_id, kind: row.kind,
        money: money(row.amount, row.currency), status: row.status, referenceExternalTransactionId: row.reference_external_transaction_id,
        referenceTransactionId: row.reference_transaction_id, failureCode: row.failure_code, createdAt: row.created_at, processedAt: row.processed_at };
    });
  }

  async reconcile(walletId: string, correlationId: string) {
    const id = this.id(walletId);
    const result = await this.read(async (em) => {
      // One SQL statement => one MVCC snapshot for stored balance AND every ledger entry.
      const [row] = await em.execute<ReconciliationRow[]>(`select w.id,w.currency,w.balance::text as stored,
        totals.calculated::text,(w.balance-totals.calculated)::text as difference,totals.checked::text
        from wagering.wallets w cross join lateral (
          select coalesce(sum(case direction when 'CREDIT' then amount else -amount end),0) as calculated,
            count(*) as checked from wagering.wallet_ledger_entries where wallet_id=w.id
        ) totals where w.id=?`, [id]);
      if (!row) throw missing();
      const difference = money(row.difference, row.currency);
      return { walletId: id, storedBalance: money(row.stored, row.currency), calculatedBalance: money(row.calculated, row.currency),
        difference, consistent: difference.amount === '0.00', checkedEntries: Number(row.checked) };
    });
    if (!result.consistent) this.telemetry.increment('reconciliation_inconsistencies', 'reconciliation');
    this.telemetry.log(result.consistent ? 'info' : 'error', result.consistent ? 'reconciliation_consistent' : 'reconciliation_inconsistent', { walletId: id, correlationId });
    return result;
  }
}
