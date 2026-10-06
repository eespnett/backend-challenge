export interface OutboxClaim {
  readonly eventId: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly leaseToken: string;
  readonly attempts: number;
}
export interface OutboxClaimStore {
  claim(owner: string, limit: number, leaseMs: number): Promise<readonly OutboxClaim[]>;
  renew(claim: OutboxClaim, leaseMs: number): Promise<boolean>;
  published(claim: OutboxClaim): Promise<boolean>;
  retry(claim: OutboxClaim, errorCode: string, delayMs: number): Promise<boolean>;
}
export interface EventTransport { send(claim: OutboxClaim, signal: AbortSignal): Promise<void> }
export const OUTBOX_CLAIM_STORE = Symbol('OUTBOX_CLAIM_STORE');

export function outboxBackoffMs(attempts: number): number {
  if (!Number.isInteger(attempts) || attempts < 1) throw new Error('Invalid outbox attempt count');
  return Math.min(30000, 1000 * 2 ** Math.min(5, attempts - 1));
}
