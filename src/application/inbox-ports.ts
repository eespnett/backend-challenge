import type { StoredProcessingResult } from './processing-result';

export const WAGER_CONSUMER = 'WagerConsumer.v1';
export interface InboxRecord {
  readonly payloadHash: string;
  readonly status: 'RECEIVED' | 'PROCESSED' | 'REJECTED';
  readonly result: StoredProcessingResult | { errorCode: string } | null;
}
export interface DeadLetterRecord { readonly sent: boolean }
export interface InboxRepository {
  /** INSERT ON CONFLICT + row lock serialize independent processes by persistent identity. */
  reserve(messageId: string, hash: string): Promise<InboxRecord>;
  finish(messageId: string, hash: string, result: StoredProcessingResult): Promise<void>;
  reject(messageId: string, hash: string, errorCode: string): Promise<void>;
  deadLetter(messageId: string, hash: string, body: string, transportId: string, errorCode: string): Promise<DeadLetterRecord>;
  markDeadLetterSent(messageId: string, hash: string): Promise<void>;
}
