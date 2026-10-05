import { Entity, PrimaryKey, Property } from '@mikro-orm/core';

@Entity({ schema: 'wagering', tableName: 'outbox_events' })
export class OutboxEventEntity {
  @PrimaryKey({ type: 'uuid' }) id!: string;
  @Property({ type: 'uuid' }) transactionId!: string;
  @Property({ type: 'uuid' }) aggregateId!: string;
  @Property({ type: 'text' }) eventType!: string;
  @Property({ type: 'integer' }) version = 1;
  @Property({ type: 'json', columnType: 'jsonb' }) payload!: Record<string, unknown>;
  @Property({ type: Date, columnType: 'timestamptz' }) occurredAt!: Date;
  @Property({ type: Date, columnType: 'timestamptz' }) createdAt = new Date();
  @Property({ type: Date, columnType: 'timestamptz', nullable: true }) publishedAt: Date | null = null;
}
