export const PENDING_REFERENCE_TTL_MS = 15 * 60 * 1000;
export const PENDING_REFERENCE_LEASE_MS = 30 * 1000;
export const PENDING_REFERENCE_POLL_MS = 1000;
export const PENDING_REFERENCE_BATCH_SIZE = 5;

/** Attempt zero is the first scheduled retry (1s); claimed attempts start at one. */
export function pendingReferenceBackoffMs(attempt: number): number {
  if (!Number.isSafeInteger(attempt) || attempt < 0) throw new Error('Invalid pending reference attempt');
  return Math.min(2 ** Math.min(attempt, 5), 30) * 1000;
}

export function pendingReferenceNextAttempt(now: Date, expiresAt: Date, attempt: number): Date {
  return new Date(Math.min(now.getTime() + pendingReferenceBackoffMs(attempt), expiresAt.getTime()));
}
