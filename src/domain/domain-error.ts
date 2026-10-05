import { FailureCode } from './failure-code';

export class DomainError extends Error {
  constructor(readonly code: FailureCode, message: string) {
    super(message);
    this.name = 'DomainError';
  }
}

export class InvalidTransactionStateError extends DomainError {
  constructor() {
    super(FailureCode.InvalidTransactionState, 'Transaction cannot transition from this state');
    this.name = 'InvalidTransactionStateError';
  }
}
