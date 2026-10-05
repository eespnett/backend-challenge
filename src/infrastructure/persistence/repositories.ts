import { EntityManager } from '@mikro-orm/postgresql';
import { UniqueConstraintViolationException } from '@mikro-orm/core';
import { WalletRepository, WagerTransactionRepository, LedgerRepository, WalletAlreadyExistsError } from '../../application/financial-unit-of-work';
import { Wallet } from '../../domain/wallet';
import { WagerTransaction } from '../../domain/wager-transaction';
import { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';
import { WalletMapper, WagerTransactionMapper, WalletLedgerEntryMapper } from './domain-mappers';
import { WalletEntity } from './entities/wallet.entity';
import { WagerTransactionEntity } from './entities/wager-transaction.entity';
import { WalletLedgerEntryEntity } from './entities/wallet-ledger-entry.entity';

export class MikroOrmWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}
  async add(wallet: Wallet): Promise<void> {
    try {
      await this.em.persistAndFlush(WalletMapper.toPersistence(wallet));
    } catch (error) {
      if (error instanceof UniqueConstraintViolationException &&
          (error as { constraint?: string }).constraint === 'wallets_player_currency_unique') {
        throw new WalletAlreadyExistsError();
      }
      throw error;
    }
  }
  async findById(id: string): Promise<Wallet | undefined> {
    const entity = await this.em.findOne(WalletEntity, { id });
    return entity === null ? undefined : WalletMapper.toDomain(entity);
  }
  async findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | undefined> {
    const entity = await this.em.findOne(WalletEntity, { playerId, currency });
    return entity === null ? undefined : WalletMapper.toDomain(entity);
  }
}

export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}
  async add(tx: WagerTransaction): Promise<void> { await this.em.persistAndFlush(WagerTransactionMapper.toPersistence(tx)); }
  async findById(id: string): Promise<WagerTransaction | undefined> {
    const entity = await this.em.findOne(WagerTransactionEntity, { id });
    return entity === null ? undefined : WagerTransactionMapper.toDomain(entity);
  }
  async findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined> {
    const entity = await this.em.findOne(WagerTransactionEntity, { idempotencyKey });
    return entity === null ? undefined : WagerTransactionMapper.toDomain(entity);
  }
  async findByProviderAndExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined> {
    const entity = await this.em.findOne(WagerTransactionEntity, { providerId, externalTransactionId });
    return entity === null ? undefined : WagerTransactionMapper.toDomain(entity);
  }
}

export class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}
  async append(entry: WalletLedgerEntry): Promise<void> {
    const transaction = await this.em.findOneOrFail(WagerTransactionEntity, { id: entry.transactionId });
    await this.em.persistAndFlush(WalletLedgerEntryMapper.toPersistence(entry, transaction.kind));
  }
  async findByWalletAndTransaction(walletId: string, transactionId: string): Promise<WalletLedgerEntry | undefined> {
    const entity = await this.em.findOne(WalletLedgerEntryEntity, { walletId, transactionId });
    return entity === null ? undefined : WalletLedgerEntryMapper.toDomain(entity);
  }
  async listForWallet(walletId: string): Promise<readonly WalletLedgerEntry[]> {
    const entities = await this.em.find(WalletLedgerEntryEntity, { walletId }, { orderBy: { createdAt: 'asc', id: 'asc' } });
    return entities.map(WalletLedgerEntryMapper.toDomain);
  }
}
