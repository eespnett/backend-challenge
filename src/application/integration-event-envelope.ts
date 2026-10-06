import { canonicalJson, sha256 } from './wager-envelope';
import { Money } from '../domain/money';

export const EVENT_RECEIPT_CONSUMER='WagerEventsAudit.v1';
export function validateIntegrationEvent(raw: string) {
  const event:unknown=JSON.parse(raw);
  if(!event||typeof event!=='object'||Array.isArray(event))throw new Error('Invalid integration event');
  const props=event as Record<string,unknown>;
  const uuid=(value:unknown)=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
  if(!uuid(props.eventId)||!uuid(props.aggregateId)||props.version!==1||
    !['WagerTransactionProcessed','WagerTransactionRejected','WalletBalanceChanged','WagerTransactionPendingReference'].includes(props.eventType as string)||
    typeof props.occurredAt!=='string'||!Number.isFinite(Date.parse(props.occurredAt))||
    typeof props.correlationId!=='string'||!props.correlationId||!props.data||typeof props.data!=='object'||Array.isArray(props.data)){
    throw new Error('Invalid integration event');
  }
  const data=props.data as Record<string,unknown>;
  if(!uuid(data.transactionId)||!uuid(data.walletId)||!data.money||typeof data.money!=='object')throw new Error('Invalid event data');
  const money=data.money as Record<string,unknown>;
  if(typeof money.amount!=='string'||typeof money.currency!=='string')throw new Error('Invalid event money');
  Money.from({amount:money.amount,currency:money.currency});
  return {eventId:props.eventId as string,eventType:props.eventType as string,payload:props,
    hash:sha256(canonicalJson(props))};
}
