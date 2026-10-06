import 'reflect-metadata';
import { MikroORM } from '@mikro-orm/postgresql';
import { AppConfig } from '../src/config/app-config';
import { createOrmConfig } from '../src/infrastructure/persistence/mikro-orm.config';
import { MikroOrmTransactionManager } from '../src/infrastructure/persistence/mikro-orm-transaction-manager';
import { OpenWallet } from '../src/application/open-wallet';
import { WalletAlreadyExistsError } from '../src/application/financial-unit-of-work';
import { DEMO_PLAYER, runCli } from './cli';

/** Idempotent seed through the existing financial use case; never resets a balance. */
export async function seed(): Promise<void> {
  const orm = await MikroORM.init(createOrmConfig(new AppConfig()));
  try {
    const manager = new MikroOrmTransactionManager(orm);
    const find = () => manager.run((uow) => uow.wallets.findByPlayerAndCurrency(DEMO_PLAYER, 'BRL'));
    let wallet = await find();
    if (!wallet) {
      try { wallet = await new OpenWallet(manager).execute({ playerId: DEMO_PLAYER, initialBalance: { amount: '100.00', currency: 'BRL' } }); }
      catch (error) { if (!(error instanceof WalletAlreadyExistsError)) throw error; wallet = await find(); }
    }
    if (!wallet) throw new Error('Seed wallet unavailable');
    console.log(JSON.stringify({ event: 'seed_ready', walletId: wallet.id, playerId: wallet.playerId, currency: wallet.currency }));
  } finally { await orm.close(true); }
}

void runCli('seed_failed', seed);
