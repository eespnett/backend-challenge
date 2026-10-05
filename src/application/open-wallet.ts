import { createHash, randomUUID } from 'node:crypto';
import { Money, MoneyProps } from '../domain/money';
import { Wallet } from '../domain/wallet';
import { WagerTransaction } from '../domain/wager-transaction';
import { WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import { TransactionManager } from './financial-unit-of-work';

export interface OpenWalletInput { readonly playerId: string; readonly initialBalance: MoneyProps }

export class OpenWallet {
  constructor(private readonly transactions: TransactionManager) {}

  async execute(input: OpenWalletInput): Promise<Wallet> {
    const initialBalance = Money.from(input.initialBalance);
    const at = new Date();
    const wallet = Wallet.open({ id: randomUUID(), playerId: input.playerId, initialBalance, at });
    return this.transactions.run(async (repositories) => {
      await repositories.wallets.add(wallet);
      if (wallet.openingMovement !== undefined) {
        // Fixed alphabetical keys form the canonical internal OPENING payload.
        const payloadHash = createHash('sha256').update(JSON.stringify({ currency: wallet.currency,
          initialBalance: initialBalance.toString(), playerId: wallet.playerId, walletId: wallet.id })).digest('hex');
        const opening = WagerTransaction.createOpening({ id: randomUUID(), walletId: wallet.id,
          playerId: wallet.playerId, money: initialBalance, payloadHash, createdAt: at });
        opening.markProcessed(undefined, at);
        await repositories.transactions.add(opening);
        const entry = WalletLedgerEntry.create({ ...wallet.openingMovement, id: randomUUID(),
          transactionId: opening.id, createdAt: at });
        await repositories.ledger.append(entry);
      }
      return wallet;
    });
  }
}
