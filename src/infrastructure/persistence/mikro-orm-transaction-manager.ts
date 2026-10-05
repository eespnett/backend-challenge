import { MikroORM } from '@mikro-orm/postgresql';
import { FinancialUnitOfWork, TransactionManager } from '../../application/financial-unit-of-work';
import { MikroOrmWalletRepository, MikroOrmWagerTransactionRepository, MikroOrmLedgerRepository } from './repositories';

export class MikroOrmTransactionManager implements TransactionManager {
  constructor(private readonly orm: MikroORM) {}
  async run<T>(work: (repositories: FinancialUnitOfWork) => Promise<T>): Promise<T> {
    // Every invocation owns an isolated identity map and a single SQL transaction.
    return this.orm.em.fork({ clear: true, useContext: false }).transactional(async (em) => work({
      wallets: new MikroOrmWalletRepository(em), transactions: new MikroOrmWagerTransactionRepository(em),
      ledger: new MikroOrmLedgerRepository(em),
    }));
  }
}
