import { Injectable } from '@nestjs/common';
import { Counter, TelemetryPort, TraceContext } from '../application/telemetry-port';

const sources = ['http', 'sqs', 'pending', 'outbox', 'events', 'database', 'reconciliation', 'unknown'];
const buckets = [0.005, 0.025, 0.1, 0.5, 1, 5, 15];

/** IDs are log fields only. Metrics have a fixed, bounded label vocabulary. */
@Injectable()
export class TelemetryService implements TelemetryPort {
  private readonly counters = new Map<string, number>();
  private readonly durations = new Map<string, { count: number; sum: number; buckets: number[] }>();
  constructor(private readonly write: (line: string) => void = (line) => console.log(line)) {}

  log(level: 'info' | 'warn' | 'error', event: string, context: TraceContext = {}): void {
    const fields: Record<string, string> = {};
    for (const key of ['correlationId', 'messageId', 'transactionId', 'walletId', 'providerId'] as const) {
      const value = context[key];
      if (typeof value === 'string' && value.length <= 200 && !/[\u0000-\u001f]/.test(value)) fields[key] = value;
    }
    this.write(JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...fields }));
  }

  increment(name: Counter, source = 'unknown'): void {
    const label = sources.includes(source) ? source : 'unknown';
    const key = `${name}{source="${label}"}`;
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
  }

  latency(seconds: number, source: 'http' | 'sqs' | 'pending'): void {
    if (!Number.isFinite(seconds) || seconds < 0) return;
    const value = this.durations.get(source) ?? { count: 0, sum: 0, buckets: buckets.map(() => 0) };
    value.count++; value.sum += seconds;
    buckets.forEach((bound, i) => { if (seconds <= bound) value.buckets[i] = value.buckets[i]! + 1; });
    this.durations.set(source, value);
  }

  render(): string {
    const lines: string[] = [];
    for (const name of ['duplicates_detected', 'retries_total', 'lock_conflicts', 'reconciliation_inconsistencies'] as const) {
      lines.push(`# TYPE ${name} counter`);
      for (const source of sources) lines.push(`${name}{source="${source}"} ${this.counters.get(`${name}{source="${source}"}`) ?? 0}`);
    }
    lines.push('# TYPE processing_latency histogram');
    for (const source of ['http', 'sqs', 'pending']) {
      const value = this.durations.get(source) ?? { count: 0, sum: 0, buckets: buckets.map(() => 0) };
      buckets.forEach((bound, i) => lines.push(`processing_latency_bucket{source="${source}",le="${bound}"} ${value.buckets[i]}`));
      lines.push(`processing_latency_bucket{source="${source}",le="+Inf"} ${value.count}`,
        `processing_latency_sum{source="${source}"} ${value.sum}`, `processing_latency_count{source="${source}"} ${value.count}`);
    }
    return lines.join('\n') + '\n';
  }
}
