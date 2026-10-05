import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { AppConfig } from '../../src/config/app-config';
import { OpenWallet } from '../../src/application/open-wallet';
import { ProcessWagerTransactionUseCase } from '../../src/application/process-wager-transaction';
import { StoredProcessingResult } from '../../src/application/processing-result';
import { Wallet } from '../../src/domain/wallet';
import { WagerTransactionKind as Kind } from '../../src/domain/wager-transaction';
import { MikroOrmTransactionManager } from '../../src/infrastructure/persistence/mikro-orm-transaction-manager';
import { WageringModule } from '../../src/wagering/wagering.module';
import { isolatedPostgres } from './isolated-postgres';

export async function phase3Harness() {
  const fixture = await isolatedPostgres();
  try {
    await fixture.orm.getMigrator().up();
    const module = await Test.createTestingModule({ imports: [WageringModule] })
      .overrideProvider(AppConfig).useValue(fixture.config).compile();
    const app = module.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    const manager = new MikroOrmTransactionManager(fixture.orm);
    const open = new OpenWallet(manager);
    const process = new ProcessWagerTransactionUseCase(manager);
    const sql = <T extends object[] = Record<string, unknown>[]>(statement: string, params: unknown[] = []) =>
      fixture.orm.em.getConnection().execute<T>(statement, params);
    return { ...fixture, app, manager, process, sql,
      wallet: (amount = '100.00', currency = 'BRL') => open.execute({ playerId: crypto.randomUUID(), initialBalance: { amount, currency } }),
      async post(body: unknown, key: string | null = crypto.randomUUID()) {
        const response = await fetch(`${await app.getUrl()}/wagering/transactions`, { method: 'POST',
          headers: { 'content-type': 'application/json', ...(key === null ? {} : { 'idempotency-key': key }) },
          body: JSON.stringify(body) });
        return { httpStatus: response.status, body: await response.json() as
          Omit<StoredProcessingResult['body'], 'failureCode'> & { failureCode?: string } };
      },
      async state(walletId: string) {
        return (await sql<Array<{ balance: string; version: string; transactions: string; ledger: string; outbox: string }>>(`
          select w.balance::text, w.version::text,
            (select count(*)::text from wagering.wager_transactions t where t.wallet_id=w.id) as transactions,
            (select count(*)::text from wagering.wallet_ledger_entries l where l.wallet_id=w.id) as ledger,
            (select count(*)::text from wagering.outbox_events o join wagering.wager_transactions t
              on t.id=o.transaction_id where t.wallet_id=w.id) as outbox
          from wagering.wallets w where w.id=?`, [walletId]))[0]!;
      },
      async close() { try { await app.close(); } finally { await fixture.dispose(); } },
    };
  } catch (error) { await fixture.dispose(); throw error; }
}

export function wagerBody(wallet: Wallet, kind = Kind.Bet, amount = '25.00', overrides: Record<string, unknown> = {}) {
  return { providerId: 'provider-a', externalTransactionId: crypto.randomUUID(), playerId: wallet.playerId,
    walletId: wallet.id, roundId: 'round-1', gameId: 'game-1', kind, money: { amount, currency: wallet.currency }, ...overrides };
}
