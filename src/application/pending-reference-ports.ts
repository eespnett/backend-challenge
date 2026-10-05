export interface PendingReferenceClaim {
  readonly transactionId: string;
  readonly walletId: string;
  readonly leaseToken: string;
}
export interface OwnedPendingReference extends PendingReferenceClaim {
  readonly attempts: number;
  readonly expiresAt: Date;
  readonly now: Date;
  readonly correlationId: string;
  readonly causationId: string;
}
export interface PendingReferenceRepository {
  schedule(transactionId: string, walletId: string, correlationId: string, causationId: string): Promise<void>;
  lockOwned(claim: PendingReferenceClaim): Promise<OwnedPendingReference | undefined>;
  retry(job: OwnedPendingReference, nextAttemptAt: Date): Promise<void>;
  finish(job: OwnedPendingReference, expired: boolean): Promise<void>;
}
export interface PendingReferenceClaimStore {
  claim(workerId: string, limit: number, leaseMs: number): Promise<readonly PendingReferenceClaim[]>;
}
export const PENDING_REFERENCE_CLAIM_STORE = Symbol('PENDING_REFERENCE_CLAIM_STORE');
