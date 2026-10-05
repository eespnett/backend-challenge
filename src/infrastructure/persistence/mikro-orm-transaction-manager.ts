import { MikroORM } from '@mikro-orm/postgresql';
import { FinancialUnitOfWork, TransactionManager } from '../../application/financial-unit-of-work';
import { IsolationLevel } from '@mikro-orm/core';
import { InfrastructureUnavailableError } from '../../application/processing-errors';
import { MikroOrmWalletRepository, MikroOrmWagerTransactionRepository, MikroOrmLedgerRepository, MikroOrmOutboxRepository } from './repositories';
import { MikroOrmPendingReferenceRepository } from './pending-reference-repository';

export function isTransientDatabaseError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: string }).code ?? '';
  return code.startsWith('08') || ['40001', '40P01', '55P03', '57014', '53300', '57P01', '57P02', '57P03',
    'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND'].includes(code) ||
    ['KnexTimeoutError', 'ConnectionException'].includes(error.name);
}

export class MikroOrmTransactionManager implements TransactionManager {
  constructor(private readonly orm: MikroORM) {}
  async run<T>(work: (repositories: FinancialUnitOfWork) => Promise<T>): Promise<T> {
    // Every invocation owns an isolated identity map and a single SQL transaction.
    try {
      return await this.orm.em.fork({ clear: true, useContext: false }).transactional(async (em) => {
        await em.execute("set local lock_timeout = '5s'");
        await em.execute("set local statement_timeout = '15s'");
        return work({ wallets: new MikroOrmWalletRepository(em),
          transactions: new MikroOrmWagerTransactionRepository(em), ledger: new MikroOrmLedgerRepository(em),
          outbox: new MikroOrmOutboxRepository(em), pendingReferences: new MikroOrmPendingReferenceRepository(em) });
      }, { isolationLevel: IsolationLevel.READ_COMMITTED });
    } catch (error) {
      if (isTransientDatabaseError(error)) throw new InfrastructureUnavailableError();
      throw error;
    }
  }
}
