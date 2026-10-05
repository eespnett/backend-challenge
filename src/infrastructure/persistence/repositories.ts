import { EntityManager } from '@mikro-orm/postgresql';
import { LockMode, UniqueConstraintViolationException } from '@mikro-orm/core';
import type { StoredProcessingResult, RecordedSubmission } from '../../application/processing-result';
import { SubmissionUniquenessCollision } from '../../application/processing-errors';
import type { IntegrationEvent } from '../../domain/events';
import { WagerTransactionKind as Kind, WagerTransactionStatus as Status } from '../../domain/wager-transaction';
import { OutboxEventEntity } from './entities/outbox-event.entity';
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
  private readonly lockedIds = new Set<string>();
  async lockById(id: string): Promise<Wallet | undefined> {
    const entity = await this.em.findOne(WalletEntity, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true });
    if (entity === null) return undefined;
    this.lockedIds.add(id);
    return WalletMapper.toDomain(entity);
  }
  async saveLocked(wallet: Wallet): Promise<void> {
    if (!this.lockedIds.has(wallet.id)) throw new Error('Wallet update requires its SQL row lock');
    const entity = await this.em.findOneOrFail(WalletEntity, { id: wallet.id });
    this.em.assign(entity, { balance: wallet.balance.toString(), version: wallet.version, updatedAt: wallet.updatedAt });
    await this.em.flush();
  }
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
  async saveState(tx: WagerTransaction): Promise<void> {
    const entity = await this.em.findOneOrFail(WagerTransactionEntity, { id: tx.id });
    this.em.assign(entity, { status: tx.status, referenceTransactionId: tx.referenceTransactionId ?? null,
      failureCode: tx.failureCode ?? null, processedAt: tx.processedAt ?? null });
    await this.em.flush();
  }
  async add(tx: WagerTransaction, result?: StoredProcessingResult): Promise<void> {
    const entity = WagerTransactionMapper.toPersistence(tx);
    entity.resultHttpStatus = result?.httpStatus ?? null;
    entity.resultBody = result === undefined ? null : structuredClone(result.body);
    try { await this.em.persistAndFlush(entity); } catch (error) {
      if (error instanceof UniqueConstraintViolationException &&
          ['transactions_idempotency_unique', 'transactions_provider_external_unique'].includes(
            (error as { constraint?: string }).constraint ?? '')) throw new SubmissionUniquenessCollision();
      throw error;
    }
  }
  async findSubmissionByIdempotencyKey(idempotencyKey: string): Promise<RecordedSubmission | undefined> {
    const entity = await this.em.findOne(WagerTransactionEntity, { idempotencyKey }, { refresh: true });
    if (entity === null) return undefined;
    return { transaction: WagerTransactionMapper.toDomain(entity), result:
      entity.resultHttpStatus === null || entity.resultBody === null ? undefined :
        { httpStatus: entity.resultHttpStatus, body: structuredClone(entity.resultBody) } };
  }
  async findProcessedReversals(referenceTransactionId: string): Promise<readonly WagerTransaction[]> {
    const entities = await this.em.find(WagerTransactionEntity, { referenceTransactionId,
      status: Status.Processed, kind: { $in: [Kind.Refund, Kind.Rollback] } });
    return entities.map(WagerTransactionMapper.toDomain);
  }
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

/** Persistence only; this repository has no transport dependency or publish operation. */
export class MikroOrmOutboxRepository {
  constructor(private readonly em: EntityManager) {}
  async enqueue(transactionId: string, events: readonly IntegrationEvent<unknown>[]): Promise<void> {
    const entities = events.map((event) => {
      const payload = event.toJSON();
      return Object.assign(new OutboxEventEntity(), { id: payload.eventId, transactionId,
        aggregateId: payload.aggregateId, eventType: payload.eventType, version: payload.version,
        occurredAt: new Date(payload.occurredAt), payload });
    });
    await this.em.persistAndFlush(entities);
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
