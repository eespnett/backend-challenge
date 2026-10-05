import { Entity, PrimaryKey, Property, Unique } from '@mikro-orm/core';
import { FailureCode } from '../../../domain/failure-code';
import { WagerTransactionKind, WagerTransactionStatus } from '../../../domain/wager-transaction';
import { ExactMoneyType } from '../exact-money.type';

@Entity({ schema: 'wagering', tableName: 'wager_transactions' })
@Unique({ name: 'transactions_idempotency_unique', properties: ['idempotencyKey'] })
@Unique({ name: 'transactions_provider_external_unique', properties: ['providerId', 'externalTransactionId'] })
export class WagerTransactionEntity {
  @PrimaryKey({ type: 'uuid' }) id!: string;
  @Property({ type: 'text' }) providerId!: string;
  @Property({ type: 'text' }) externalTransactionId!: string;
  @Property({ type: 'text' }) idempotencyKey!: string;
  @Property({ type: 'text' }) payloadHash!: string;
  @Property({ type: 'uuid' }) walletId!: string;
  @Property({ type: 'text' }) playerId!: string;
  @Property({ type: 'text' }) roundId!: string;
  @Property({ type: 'text' }) gameId!: string;
  @Property({ type: 'text' }) kind!: WagerTransactionKind;
  @Property({ type: ExactMoneyType }) amount!: string;
  @Property({ type: 'text' }) currency!: string;
  @Property({ type: 'text', nullable: true }) referenceExternalTransactionId!: string | null;
  @Property({ type: 'text' }) status!: WagerTransactionStatus;
  @Property({ type: 'uuid', nullable: true }) referenceTransactionId!: string | null;
  @Property({ type: 'text', nullable: true }) failureCode!: FailureCode | null;
  @Property({ type: Date, columnType: 'timestamptz' }) createdAt!: Date;
  @Property({ type: Date, columnType: 'timestamptz', nullable: true }) processedAt!: Date | null;
}
