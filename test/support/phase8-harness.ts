import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { AppConfig } from '../../src/config/app-config';
import { WalletsModule } from '../../src/wallets/wallets.module';
import { WageringModule } from '../../src/wagering/wagering.module';
import { HealthModule } from '../../src/health/health.module';
import { MetricsModule } from '../../src/observability/metrics.module';
import { TelemetryService } from '../../src/observability/telemetry.service';
import { QueryService } from '../../src/queries/query.service';
import { TRANSACTION_MANAGER, TransactionManager } from '../../src/application/financial-unit-of-work';
import { ProcessWagerTransactionUseCase } from '../../src/application/process-wager-transaction';
import { SqsService } from '../../src/infrastructure/sqs/sqs.service';
import { isolatedPostgres } from './isolated-postgres';
import { isolatedQueues } from './phase6-harness';
import { isolatedEventQueue } from './phase7-harness';
import type { TestWallet } from './process-harness';

export async function phase8Harness() {
  const fixture = await isolatedPostgres();
  const queues = await isolatedQueues(); const events = await isolatedEventQueue();
  const lines: string[] = []; const telemetry = new TelemetryService((line) => lines.push(line));
  const config: AppConfig = { ...fixture.config, messaging: { ...fixture.config.messaging, queueName: queues.queueName, dlqName: queues.dlqName },
    outbox: { ...fixture.config.outbox, queueName: events.queueName } };
  const module = await Test.createTestingModule({ imports: [WalletsModule, WageringModule, HealthModule, MetricsModule] })
    .overrideProvider(AppConfig).useValue(config).overrideProvider(TelemetryService).useValue(telemetry).compile();
  const app = module.createNestApplication({ logger: false });
  try {
    await fixture.orm.getMigrator().up(); await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    async function request(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
      return fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    }
    return { ...fixture, config, app, base, request, lines, telemetry, queues, events,
      queries: module.get(QueryService), manager: module.get<TransactionManager>(TRANSACTION_MANAGER),
      process: module.get(ProcessWagerTransactionUseCase), sqs: module.get(SqsService),
      sql: <T extends object[] = Record<string, unknown>[]>(statement: string, params: unknown[] = []) => fixture.orm.em.getConnection().execute<T>(statement, params),
      async wallet(amount = '100.00'): Promise<TestWallet> {
        const response = await request('/wallets', 'POST', { playerId: crypto.randomUUID(), initialBalance: { amount, currency: 'BRL' } });
        if (response.status !== 201) throw new Error(`Wallet creation failed: ${response.status}`);
        return await response.json() as TestWallet;
      },
      async close() { try { await app.close(); } finally { try { await events.close(); } finally { try { await queues.close(); } finally { await fixture.dispose(); } } } },
    };
  } catch (error) {
    try { await app.close(); } finally { try { await events.close(); } finally { try { await queues.close(); } finally { await fixture.dispose(); } } }
    throw error;
  }
}
