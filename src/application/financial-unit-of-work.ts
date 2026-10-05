import { Wallet } from '../domain/wallet';
import { WagerTransaction } from '../domain/wager-transaction';
import { WalletLedgerEntry } from '../domain/wallet-ledger-entry';

export interface WalletRepository {
  add(wallet: Wallet): Promise<void>;
  findById(id: string): Promise<Wallet | undefined>;
  findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | undefined>;
}
export interface WagerTransactionRepository {
  add(transaction: WagerTransaction): Promise<void>;
  findById(id: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(key: string): Promise<WagerTransaction | undefined>;
  findByProviderAndExternalId(providerId: string, externalId: string): Promise<WagerTransaction | undefined>;
}
export interface LedgerRepository {
  append(entry: WalletLedgerEntry): Promise<void>;
  findByWalletAndTransaction(walletId: string, transactionId: string): Promise<WalletLedgerEntry | undefined>;
  listForWallet(walletId: string): Promise<readonly WalletLedgerEntry[]>;
}
export interface FinancialUnitOfWork {
  readonly wallets: WalletRepository;
  readonly transactions: WagerTransactionRepository;
  readonly ledger: LedgerRepository;
}
export interface TransactionManager {
  run<T>(work: (repositories: FinancialUnitOfWork) => Promise<T>): Promise<T>;
}
export const TRANSACTION_MANAGER = Symbol('TRANSACTION_MANAGER');

export class WalletAlreadyExistsError extends Error {
  readonly code = 'WALLET_ALREADY_EXISTS';
  constructor() { super('A wallet already exists for this player and currency'); }
}
