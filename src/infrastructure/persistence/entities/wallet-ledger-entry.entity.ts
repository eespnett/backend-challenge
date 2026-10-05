import { Entity, PrimaryKey, Property, Unique } from '@mikro-orm/core';
import { LedgerDirection } from '../../../domain/wallet-ledger-entry';
import { WagerTransactionKind, WagerTransactionStatus } from '../../../domain/wager-transaction';
import { ExactMoneyType } from '../exact-money.type';

@Entity({ schema: 'wagering', tableName: 'wallet_ledger_entries' })
@Unique({ name: 'ledger_wallet_transaction_unique', properties: ['walletId', 'transactionId'] })
export class WalletLedgerEntryEntity {
  @PrimaryKey({ type: 'uuid' }) id!: string;
  @Property({ type: 'uuid' }) walletId!: string;
  @Property({ type: 'uuid' }) transactionId!: string;
  @Property({ type: 'text' }) transactionKind!: WagerTransactionKind;
  @Property({ type: 'text' }) transactionStatus!: WagerTransactionStatus;
  @Property({ type: 'text' }) direction!: LedgerDirection;
  @Property({ type: ExactMoneyType }) amount!: string;
  @Property({ type: 'text' }) currency!: string;
  @Property({ type: ExactMoneyType }) balanceBefore!: string;
  @Property({ type: ExactMoneyType }) balanceAfter!: string;
  @Property({ type: Date, columnType: 'timestamptz' }) createdAt!: Date;
}
