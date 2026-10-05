import { afterEach, describe, expect, test } from 'bun:test';
import { AppConfig } from '../../src/config/app-config';

const originalPort = process.env.PORT;
const originalEndpoint = process.env.SQS_ENDPOINT;
const originalPendingWorker = process.env.PENDING_REFERENCE_WORKER_ENABLED;
afterEach(() => {
  if (originalPort === undefined) delete process.env.PORT;
  else process.env.PORT = originalPort;
  if (originalEndpoint === undefined) delete process.env.SQS_ENDPOINT;
  else process.env.SQS_ENDPOINT = originalEndpoint;
  if (originalPendingWorker === undefined) delete process.env.PENDING_REFERENCE_WORKER_ENABLED;
  else process.env.PENDING_REFERENCE_WORKER_ENABLED = originalPendingWorker;
});

describe('AppConfig', () => {
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
