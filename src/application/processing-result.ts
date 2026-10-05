import type { MoneyProps } from '../domain/money';
import type { FailureCode } from '../domain/failure-code';
import type { WagerTransaction, WagerTransactionStatus } from '../domain/wager-transaction';

export interface ProcessingBody {
  readonly transactionId: string;
  readonly status: WagerTransactionStatus;
  readonly balance: MoneyProps;
  readonly failureCode?: FailureCode;
  readonly idempotentReplay: boolean;
}
export interface StoredProcessingResult {
  readonly httpStatus: 200 | 202 | 422;
  readonly body: ProcessingBody;
}
export interface RecordedSubmission {
  readonly transaction: WagerTransaction;
  readonly result: StoredProcessingResult | undefined;
}
