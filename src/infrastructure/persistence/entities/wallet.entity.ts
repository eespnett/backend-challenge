import { BigIntType, Entity, PrimaryKey, Property, Unique } from '@mikro-orm/core';
import { ExactMoneyType } from '../exact-money.type';

@Entity({ schema: 'wagering', tableName: 'wallets' })
@Unique({ name: 'wallets_player_currency_unique', properties: ['playerId', 'currency'] })
export class WalletEntity {
  @PrimaryKey({ type: 'uuid' }) id!: string;
  @Property({ type: 'text' }) playerId!: string;
  @Property({ type: 'text' }) currency!: string;
  @Property({ type: ExactMoneyType }) balance!: string;
  // Domain controls version increments; do not use ORM auto-versioning for opening.
  @Property({ type: new BigIntType('number') }) version!: number;
  @Property({ type: Date, columnType: 'timestamptz' }) createdAt!: Date;
  @Property({ type: Date, columnType: 'timestamptz' }) updatedAt!: Date;
}
