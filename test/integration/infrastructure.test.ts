import 'reflect-metadata';
import { expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import {
  DeleteMessageCommand, GetQueueAttributesCommand,
  ReceiveMessageCommand, SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { AppConfig } from '../../src/config/app-config';
import { createOrmConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { SqsService } from '../../src/infrastructure/sqs/sqs.service';
import { createTestApp } from '../support/create-test-app';

test('real PostgreSQL connection and versioned migration', async () => {
  const orm = await MikroORM.init(createOrmConfig(new AppConfig()));
  try {
    await orm.getMigrator().up();
    const rows: Array<{ ok: number }> = await orm.em.getConnection().execute('select 1 as ok');
    expect(rows[0]?.ok).toBe(1);
    const schemas: Array<{ exists: boolean }> = await orm.em.getConnection().execute(
      "select exists(select 1 from information_schema.schemata where schema_name = 'wagering')",
    );
    expect(schemas[0]?.exists).toBe(true);
    expect(await orm.getMigrator().getPendingMigrations()).toHaveLength(0);
  } finally {
    await orm.close(true);
  }
});

test('real LocalStack FIFO send, receive, delete and DLQ policy', async () => {
  const sqs = new SqsService(new AppConfig());
  let receipt: string | undefined;
  const QueueUrl = await sqs.queueUrl('wager-transactions.fifo');
  try {
    await sqs.check();
    const attributes = await sqs.client.send(new GetQueueAttributesCommand({
      QueueUrl, AttributeNames: ['FifoQueue', 'RedrivePolicy'],
    }));
    expect(attributes.Attributes?.FifoQueue).toBe('true');
    const policy = JSON.parse(attributes.Attributes?.RedrivePolicy ?? '{}') as {
      deadLetterTargetArn?: string; maxReceiveCount?: string;
    };
    expect(policy.deadLetterTargetArn).toContain('wager-transactions-dlq.fifo');
    expect(String(policy.maxReceiveCount)).toBe('5');
    const messageId = crypto.randomUUID();
    const body = JSON.stringify({ type: 'InfrastructureProbe', messageId });
    await sqs.client.send(new SendMessageCommand({
      QueueUrl, MessageBody: body,
      MessageGroupId: `probe-${messageId}`, MessageDeduplicationId: messageId,
    }));
    const received = await sqs.client.send(new ReceiveMessageCommand({
      QueueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 2,
    }));
    const message = received.Messages?.find((item) => item.Body === body);
    receipt = message?.ReceiptHandle;
    expect(message?.Body).toBe(body);
    expect(receipt).toBeDefined();
  } finally {
    if (receipt) await sqs.client.send(new DeleteMessageCommand({ QueueUrl, ReceiptHandle: receipt }));
    sqs.onModuleDestroy();
  }
});

test('full NestJS app readiness checks real PostgreSQL and SQS', async () => {
  const app = await createTestApp();
  try {
    const response = await fetch(`${await app.getUrl()}/health/ready`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'ok', checks: { postgres: 'up', sqs: 'up' },
    });
  } finally {
    await app.close();
  }
});
