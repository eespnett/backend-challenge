import { Wallet } from '../domain/wallet';
import { WagerTransaction } from '../domain/wager-transaction';
import { WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import type { IntegrationEvent } from '../domain/events';
import type { RecordedSubmission, StoredProcessingResult } from './processing-result';
import type { PendingReferenceRepository } from './pending-reference-ports';

export interface WalletRepository {
  add(wallet: Wallet): Promise<void>;
  findById(id: string): Promise<Wallet | undefined>;
  findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | undefined>;
  lockById(id: string): Promise<Wallet | undefined>;
  saveLocked(wallet: Wallet): Promise<void>;
}
export interface WagerTransactionRepository {
  add(transaction: WagerTransaction, result?: StoredProcessingResult): Promise<void>;
  saveState(transaction: WagerTransaction): Promise<void>;
  findById(id: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(key: string): Promise<WagerTransaction | undefined>;
  findByProviderAndExternalId(providerId: string, externalId: string): Promise<WagerTransaction | undefined>;
  findSubmissionByIdempotencyKey(key: string): Promise<RecordedSubmission | undefined>;
  findProcessedReversals(referenceId: string): Promise<readonly WagerTransaction[]>;
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
  readonly pendingReferences: PendingReferenceRepository;
  readonly outbox: { enqueue(transactionId: string, events: readonly IntegrationEvent<unknown>[]): Promise<void> };
}
export interface TransactionManager {
  run<T>(work: (repositories: FinancialUnitOfWork) => Promise<T>): Promise<T>;
}
export const TRANSACTION_MANAGER = Symbol('TRANSACTION_MANAGER');

export class WalletAlreadyExistsError extends Error {
  readonly code = 'WALLET_ALREADY_EXISTS';
  constructor() { super('A wallet already exists for this player and currency'); }
}
