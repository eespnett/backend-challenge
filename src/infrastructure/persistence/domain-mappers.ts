import { Money } from '../../domain/money';
import { Wallet } from '../../domain/wallet';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../../domain/wager-transaction';
import { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';
import { WalletEntity } from './entities/wallet.entity';
import { WagerTransactionEntity } from './entities/wager-transaction.entity';
import { WalletLedgerEntryEntity } from './entities/wallet-ledger-entry.entity';
import { canonicalDecimal } from './exact-money.type';

const restoreMoney = (amount: string, currency: string) => Money.rehydrate({ amount: canonicalDecimal(amount), currency });

export class WalletMapper {
  static toPersistence(wallet: Wallet): WalletEntity {
    return Object.assign(new WalletEntity(), { id: wallet.id, playerId: wallet.playerId, currency: wallet.currency,
      balance: wallet.balance.toString(), version: wallet.version, createdAt: wallet.createdAt, updatedAt: wallet.updatedAt });
  }
  static toDomain(entity: WalletEntity): Wallet {
    return Wallet.rehydrate({ id: entity.id, playerId: entity.playerId, currency: entity.currency,
      balance: restoreMoney(entity.balance, entity.currency), version: entity.version,
      createdAt: entity.createdAt, updatedAt: entity.updatedAt });
  }
}

export class WagerTransactionMapper {
  static toPersistence(tx: WagerTransaction): WagerTransactionEntity {
    return Object.assign(new WagerTransactionEntity(), { id: tx.id, providerId: tx.providerId,
      externalTransactionId: tx.externalTransactionId, idempotencyKey: tx.idempotencyKey, payloadHash: tx.payloadHash,
      walletId: tx.walletId, playerId: tx.playerId, roundId: tx.roundId, gameId: tx.gameId, kind: tx.kind,
      amount: tx.money.toString(), currency: tx.money.currency, status: tx.status,
      referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
      referenceTransactionId: tx.referenceTransactionId ?? null, failureCode: tx.failureCode ?? null,
      createdAt: tx.createdAt, processedAt: tx.processedAt ?? null });
  }
  static toDomain(entity: WagerTransactionEntity): WagerTransaction {
    return WagerTransaction.rehydrate({ id: entity.id, providerId: entity.providerId,
      externalTransactionId: entity.externalTransactionId, idempotencyKey: entity.idempotencyKey,
      payloadHash: entity.payloadHash, walletId: entity.walletId, playerId: entity.playerId,
      roundId: entity.roundId, gameId: entity.gameId, kind: entity.kind, status: entity.status,
      createdAt: entity.createdAt, money: restoreMoney(entity.amount, entity.currency),
      referenceExternalTransactionId: entity.referenceExternalTransactionId ?? undefined,
      referenceTransactionId: entity.referenceTransactionId ?? undefined, failureCode: entity.failureCode ?? undefined,
      processedAt: entity.processedAt ?? undefined });
  }
}

export class WalletLedgerEntryMapper {
  static toPersistence(entry: WalletLedgerEntry, transactionKind: WagerTransactionKind): WalletLedgerEntryEntity {
    return Object.assign(new WalletLedgerEntryEntity(), { id: entry.id, walletId: entry.walletId,
      transactionId: entry.transactionId, transactionKind, transactionStatus: WagerTransactionStatus.Processed,
      direction: entry.direction, amount: entry.money.toString(),
      currency: entry.money.currency, balanceBefore: entry.balanceBefore.toString(),
      balanceAfter: entry.balanceAfter.toString(), createdAt: entry.createdAt });
  }
  static toDomain(entity: WalletLedgerEntryEntity): WalletLedgerEntry {
    return WalletLedgerEntry.rehydrate({ id: entity.id, walletId: entity.walletId, transactionId: entity.transactionId,
      direction: entity.direction, createdAt: entity.createdAt, money: restoreMoney(entity.amount, entity.currency),
      balanceBefore: restoreMoney(entity.balanceBefore, entity.currency), balanceAfter: restoreMoney(entity.balanceAfter, entity.currency) });
  }
}
