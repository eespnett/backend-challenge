import { DomainError } from './domain-error';
import { FailureCode } from './failure-code';

export function assertIdentifier(value: string, code: FailureCode): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new DomainError(code, 'Identifier must not be empty');
  }
}

export function copyDate(value: Date, code: FailureCode): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new DomainError(code, 'Invalid date');
  }
  return new Date(value.getTime());
}
