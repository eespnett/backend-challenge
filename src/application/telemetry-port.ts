export interface TraceContext {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
}
export type Counter = 'duplicates_detected' | 'retries_total' | 'lock_conflicts' | 'reconciliation_inconsistencies';
export interface TelemetryPort {
  log(level: 'info' | 'warn' | 'error', event: string, context?: TraceContext): void;
  increment(name: Counter, source?: string): void;
  latency(seconds: number, source: 'http' | 'sqs' | 'pending'): void;
}
export const silentTelemetry: TelemetryPort = { log() {}, increment() {}, latency() {} };
