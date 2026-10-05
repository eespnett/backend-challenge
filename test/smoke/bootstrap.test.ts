import 'reflect-metadata';
import { expect, test } from 'bun:test';
import { Test } from '@nestjs/testing';
import { HealthController } from '../../src/health/health.controller';
import { HealthService } from '../../src/health/health.service';

test('Bun boots NestJS and serves HTTP liveness', async () => {
  // This isolated smoke test checks the runtime/HTTP wiring only.
  // Real PostgreSQL and SQS are exercised by test:integration.
  const module = await Test.createTestingModule({
    controllers: [HealthController],
    providers: [{ provide: HealthService, useValue: {} }],
  }).compile();
  const app = module.createNestApplication();
  try {
    await app.listen(0, '127.0.0.1');
    const response = await fetch(`${await app.getUrl()}/health/live`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  } finally {
    await app.close();
  }
});
