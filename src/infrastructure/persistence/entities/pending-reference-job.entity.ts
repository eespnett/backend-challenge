import { Entity, PrimaryKey, Property } from '@mikro-orm/core';

@Entity({ schema: 'wagering', tableName: 'pending_reference_jobs' })
export class PendingReferenceJobEntity {
  @PrimaryKey({ type: 'uuid' }) transactionId!: string;
  @Property({ type: 'uuid' }) walletId!: string;
  @Property({ type: 'text' }) status!: string;
  @Property({ type: 'integer' }) attempts!: number;
  @Property({ type: Date, columnType: 'timestamptz' }) nextAttemptAt!: Date;
  @Property({ type: Date, columnType: 'timestamptz' }) createdAt!: Date;
  @Property({ type: Date, columnType: 'timestamptz' }) expiresAt!: Date;
  @Property({ type: Date, columnType: 'timestamptz' }) updatedAt!: Date;
  @Property({ type: Date, columnType: 'timestamptz', nullable: true }) completedAt!: Date | null;
  @Property({ type: 'uuid', nullable: true }) leaseToken!: string | null;
  @Property({ type: 'text', nullable: true }) leaseOwner!: string | null;
  @Property({ type: Date, columnType: 'timestamptz', nullable: true }) leaseUntil!: Date | null;
  @Property({ type: 'text' }) correlationId!: string;
  @Property({ type: 'text' }) causationId!: string;
}
