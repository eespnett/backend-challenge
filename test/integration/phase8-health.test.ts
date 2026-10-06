import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { DeleteQueueCommand, CreateQueueCommand } from '@aws-sdk/client-sqs';
import { phase8Harness } from '../support/phase8-harness';
import { Test } from '@nestjs/testing';
import { HealthController } from '../../src/health/health.controller';
import { HealthService } from '../../src/health/health.service';
import { SqsService } from '../../src/infrastructure/sqs/sqs.service';
import { createOrmConfig } from '../../src/infrastructure/persistence/mikro-orm.config';

describe('Phase 8 health HTTP on real PostgreSQL and LocalStack', () => {
  let h: Awaited<ReturnType<typeof phase8Harness>>;
  beforeEach(async () => { h = await phase8Harness(); });
  afterEach(async () => { await h.close(); });

  test('live and ready succeed with PostgreSQL and all configured SQS queues available', async () => {
    expect(await (await h.request('/health/live')).json()).toEqual({ status: 'ok' });
    const ready = await h.request('/health/ready'); expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: 'ok', checks: { postgres: 'up', sqs: 'up' } });
  });

  test('ready reports PostgreSQL down and 503; liveness stays up', async () => {
    const orm = h.app.get(MikroORM);
    const broken = spyOn(orm.em.getConnection(), 'execute').mockRejectedValue(new Error('postgres://private:secret@host'));
    try {
      const ready = await h.request('/health/ready'); expect(ready.status).toBe(503);
      expect(await ready.json()).toMatchObject({ status: 'unavailable', checks: { postgres: 'down', sqs: 'up' } });
      expect((await h.request('/health/live')).status).toBe(200);
      expect((await (await h.request('/metrics')).text())).not.toContain('secret');
    } finally { broken.mockRestore(); }
  });

  test('ready fails when a real LocalStack event queue disappears and recovers when restored', async () => {
    await h.events.sqs.client.send(new DeleteQueueCommand({ QueueUrl: h.events.queueUrl }));
    try {
      const ready = await h.request('/health/ready'); expect(ready.status).toBe(503);
      expect(await ready.json()).toMatchObject({ status: 'unavailable', checks: { postgres: 'up', sqs: 'down' } });
      expect((await h.request('/health/live')).status).toBe(200);
    } finally {
      await h.events.sqs.client.send(new CreateQueueCommand({ QueueName: h.events.queueName,
        Attributes: { FifoQueue: 'true', VisibilityTimeout: '30', MessageRetentionPeriod: '1209600' } }));
    }
    expect((await h.request('/health/ready')).status).toBe(200);
  });

  test('SQS endpoint unavailable and both dependencies down remain sanitized 503 responses', async () => {
    const brokenSqs = spyOn(h.sqs, 'check').mockRejectedValue(new Error('AWS_SECRET_ACCESS_KEY=private'));
    const orm = h.app.get(MikroORM);
    const brokenPostgres = spyOn(orm.em.getConnection(), 'execute').mockRejectedValue(new Error('DB_PASSWORD=private'));
    try {
      const response = await h.request('/health/ready'); expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ checks: { postgres: 'down', sqs: 'down' } });
      expect((await h.request('/health/live')).status).toBe(200);
    } finally { brokenSqs.mockRestore(); brokenPostgres.mockRestore(); }
  });

  test('real refused PostgreSQL and SQS connections produce HTTP 503 without stopping shared services', async () => {
    const offlineOrm = await MikroORM.init({ ...createOrmConfig(h.config), host: '127.0.0.1', port: 1, connect: false });
    const offlineSqs = new SqsService({ ...h.config, sqs: { ...h.config.sqs, endpoint: 'http://127.0.0.1:1' } });
    const module = await Test.createTestingModule({ controllers: [HealthController],
      providers: [{ provide: HealthService, useValue: new HealthService(offlineOrm, offlineSqs) }] }).compile();
    const app = module.createNestApplication({ logger: false });
    try {
      await app.listen(0, '127.0.0.1');
      const response = await fetch(`${await app.getUrl()}/health/ready`); expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ status: 'unavailable', checks: { postgres: 'down', sqs: 'down' } });
      expect((await fetch(`${await app.getUrl()}/health/live`)).status).toBe(200);
    } finally { try { await app.close(); } finally { offlineSqs.onApplicationShutdown(); await offlineOrm.close(true); } }
  });
});
