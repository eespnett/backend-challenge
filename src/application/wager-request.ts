import { createHash } from 'node:crypto';
import { Money } from '../domain/money';
import { WagerTransactionKind as Kind } from '../domain/wager-transaction';
import { InvalidWagerRequestError } from './processing-errors';

export interface ValidatedWagerRequest {
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: Kind;
  readonly money: Money;
  readonly referenceExternalTransactionId?: string;
  readonly idempotencyKey: string;
}

export function requestText(value: unknown, name: string): string {
  if (typeof value !== 'string' || value === '' || value.trim() !== value || /[\x00-\x1f\x7f]/.test(value) || Buffer.byteLength(value, 'utf8') > 200) {
    throw new InvalidWagerRequestError(`Invalid ${name}`);
  }
  return value;
}

export function validateWagerRequest(body: unknown, key: unknown): ValidatedWagerRequest {
  const idempotencyKey = requestText(key, 'Idempotency-Key');
  if (!/^[\x21-\x7e]+$/.test(idempotencyKey) || idempotencyKey.includes(',')) {
    throw new InvalidWagerRequestError('Invalid or repeated Idempotency-Key');
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new InvalidWagerRequestError('Expected an object');
  const props = body as Record<string, unknown>;
  const allowed = ['providerId','externalTransactionId','playerId','walletId','roundId','gameId','kind','money','referenceExternalTransactionId'];
  if (Object.keys(props).some((name) => !allowed.includes(name))) throw new InvalidWagerRequestError('Unknown payload field');
  const providerId = requestText(props.providerId, 'providerId');
  if (providerId === 'internal') throw new InvalidWagerRequestError('Reserved provider');
  const walletId = requestText(props.walletId, 'walletId').toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(walletId)) {
    throw new InvalidWagerRequestError('Invalid wallet UUID');
  }
  if (![Kind.Bet, Kind.Win, Kind.Loss, Kind.Refund, Kind.Rollback].includes(props.kind as Kind)) {
    throw new InvalidWagerRequestError('Invalid external transaction kind');
  }
  const value = props.money;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new InvalidWagerRequestError('Money is required');
  const moneyProps = value as Record<string, unknown>;
  if (Object.keys(moneyProps).some((name) => !['amount','currency'].includes(name)) ||
      typeof moneyProps.amount !== 'string' || typeof moneyProps.currency !== 'string' || moneyProps.amount.length > 1000) {
    throw new InvalidWagerRequestError('Money must contain decimal amount and currency strings');
  }
  return { providerId, walletId, externalTransactionId: requestText(props.externalTransactionId, 'externalTransactionId'),
    playerId: requestText(props.playerId, 'playerId'), roundId: requestText(props.roundId, 'roundId'),
    gameId: requestText(props.gameId, 'gameId'), kind: props.kind as Kind,
    money: Money.from({ amount: moneyProps.amount, currency: moneyProps.currency }), idempotencyKey,
    ...(props.referenceExternalTransactionId === undefined ? {} : {
      referenceExternalTransactionId: requestText(props.referenceExternalTransactionId, 'referenceExternalTransactionId'),
    }) };
}

/** Fixed lexicographic business keys and nested Money keys, without transport metadata. */
export function canonicalWagerPayload(request: ValidatedWagerRequest): string {
  return JSON.stringify({ externalTransactionId: request.externalTransactionId, gameId: request.gameId,
    kind: request.kind, money: { amount: request.money.toString(), currency: request.money.currency },
    playerId: request.playerId, providerId: request.providerId,
    referenceExternalTransactionId: request.referenceExternalTransactionId ?? null,
    roundId: request.roundId, walletId: request.walletId });
}
export function wagerPayloadHash(request: ValidatedWagerRequest): string {
  return createHash('sha256').update(canonicalWagerPayload(request)).digest('hex');
}
