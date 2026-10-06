import { afterEach, describe, expect, test } from 'bun:test';
import { AppConfig } from '../../src/config/app-config';

const originalPort = process.env.PORT;
const originalEndpoint = process.env.SQS_ENDPOINT;
const originalPendingWorker = process.env.PENDING_REFERENCE_WORKER_ENABLED;
const messagingKeys = ['SQS_CONSUMER_ENABLED','SQS_TRANSACTION_QUEUE_NAME','SQS_DLQ_QUEUE_NAME','SQS_SHUTDOWN_TIMEOUT_MS'] as const;
const originalMessaging = Object.fromEntries(messagingKeys.map((key) => [key,process.env[key]]));
afterEach(() => {
  if (originalPort === undefined) delete process.env.PORT;
  else process.env.PORT = originalPort;
  if (originalEndpoint === undefined) delete process.env.SQS_ENDPOINT;
  else process.env.SQS_ENDPOINT = originalEndpoint;
  if (originalPendingWorker === undefined) delete process.env.PENDING_REFERENCE_WORKER_ENABLED;
  else process.env.PENDING_REFERENCE_WORKER_ENABLED = originalPendingWorker;
  for (const key of messagingKeys) {
    if (originalMessaging[key] === undefined) delete process.env[key];
    else process.env[key] = originalMessaging[key];
  }
});

describe('AppConfig', () => {
  test('SQS consumer defaults and invalid worker/queue/shutdown settings', () => {
    for (const key of messagingKeys) delete process.env[key];
    expect(new AppConfig().messaging).toEqual({ enabled:true,queueName:'wager-transactions.fifo',
      dlqName:'wager-transactions-dlq.fifo',shutdownMs:10000 });
    process.env.SQS_CONSUMER_ENABLED='false';expect(new AppConfig().messaging.enabled).toBe(false);
    process.env.SQS_CONSUMER_ENABLED='yes';expect(()=>new AppConfig()).toThrow('SQS_CONSUMER_ENABLED');
    process.env.SQS_CONSUMER_ENABLED='true';process.env.SQS_TRANSACTION_QUEUE_NAME='not-fifo';
    expect(()=>new AppConfig()).toThrow('FIFO');delete process.env.SQS_TRANSACTION_QUEUE_NAME;
    process.env.SQS_SHUTDOWN_TIMEOUT_MS='0';expect(()=>new AppConfig()).toThrow('SQS_SHUTDOWN_TIMEOUT_MS');
  });
  test('pending worker defaults to enabled and rejects ambiguous configuration', () => {
    delete process.env.PENDING_REFERENCE_WORKER_ENABLED;
    expect(new AppConfig().pendingReferenceWorkerEnabled).toBe(true);
    process.env.PENDING_REFERENCE_WORKER_ENABLED = 'false';
    expect(new AppConfig().pendingReferenceWorkerEnabled).toBe(false);
    process.env.PENDING_REFERENCE_WORKER_ENABLED = 'yes';
    expect(() => new AppConfig()).toThrow('PENDING_REFERENCE_WORKER_ENABLED');
  });
  test('rejects invalid ports before opening connections', () => {
    for (const value of ['0', '65536', '1.5', 'abc', '']) {
      process.env.PORT = value;
      expect(() => new AppConfig()).toThrow('Invalid configuration: PORT');
    }
  });

  test('rejects non-HTTP SQS endpoints', () => {
    process.env.PORT = '3000';
    process.env.SQS_ENDPOINT = 'file:///tmp/sqs';
    expect(() => new AppConfig()).toThrow('Invalid configuration: SQS_ENDPOINT');
  });

  test('parses local configuration', () => {
    process.env.PORT = '3001';
    process.env.SQS_ENDPOINT = 'http://127.0.0.1:4566';
    const config = new AppConfig();
    expect(config.port).toBe(3001);
    expect(config.sqs.endpoint).toBe('http://127.0.0.1:4566');
  });
});
