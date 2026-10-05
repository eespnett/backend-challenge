export class InvalidWagerRequestError extends Error {
  readonly code = 'INVALID_REQUEST';
}
export class ProcessingConflictError extends Error {
  constructor(readonly code: 'IDEMPOTENCY_CONFLICT' | 'EXTERNAL_TRANSACTION_CONFLICT') { super(code); }
}
/** Internal signal: uniqueness lost to a concurrent commit; resolve after rollback. */
export class SubmissionUniquenessCollision extends Error {}
export class InfrastructureUnavailableError extends Error {
  readonly code = 'INFRASTRUCTURE_UNAVAILABLE';
  constructor() { super('Financial infrastructure is temporarily unavailable'); }
}
