import { Injectable } from '@nestjs/common';

type Environment = Readonly<Record<string, string | undefined>>;

function text(env: Environment, key: string, fallback: string): string {
  const value = env[key] ?? fallback;
  if (value.trim().length === 0) throw new Error(`Invalid configuration: ${key}`);
  return value;
}

function port(env: Environment, key: string, fallback: string): number {
  const value = text(env, key, fallback);
  if (!/^\d+$/.test(value)) throw new Error(`Invalid configuration: ${key}`);
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Invalid configuration: ${key}`);
  }
  return parsed;
}

@Injectable()
export class AppConfig {
  readonly outbox: Readonly<{ publisherEnabled: boolean; consumerEnabled: boolean; queueName: string; leaseMs: number }>;
  readonly messaging: Readonly<{ enabled: boolean; queueName: string; dlqName: string; shutdownMs: number }>;
  readonly pendingReferenceWorkerEnabled: boolean;
  readonly port: number;
  readonly database: Readonly<{
    host: string; port: number; dbName: string; user: string; password: string;
  }>;
  readonly sqs: Readonly<{
    endpoint: string; region: string; accessKeyId: string; secretAccessKey: string;
  }>;

  constructor() {
    const env = process.env;
    const publisher=env.OUTBOX_PUBLISHER_ENABLED??'true';
    const eventConsumer=env.EVENT_CONSUMER_ENABLED??'true';
    if(!['true','false'].includes(publisher)||!['true','false'].includes(eventConsumer))throw new Error('Invalid outbox worker configuration');
    const eventQueue=text(env,'SQS_EVENT_QUEUE_NAME','wager-events.fifo');
    const leaseMs=Number(env.OUTBOX_LEASE_MS??'30000');
    if(!Number.isInteger(leaseMs)||leaseMs<100||leaseMs>300000)throw new Error('Invalid configuration: OUTBOX_LEASE_MS');
    const messagingEnabled = env.SQS_CONSUMER_ENABLED ?? 'true';
    if (!['true', 'false'].includes(messagingEnabled)) throw new Error('Invalid configuration: SQS_CONSUMER_ENABLED');
    const shutdownMs = Number(env.SQS_SHUTDOWN_TIMEOUT_MS ?? '10000');
    if (!Number.isInteger(shutdownMs) || shutdownMs < 100 || shutdownMs > 30000) throw new Error('Invalid configuration: SQS_SHUTDOWN_TIMEOUT_MS');
    const queueName = text(env, 'SQS_TRANSACTION_QUEUE_NAME', 'wager-transactions.fifo');
    const dlqName = text(env, 'SQS_DLQ_QUEUE_NAME', 'wager-transactions-dlq.fifo');
    if (![queueName, dlqName].every((name) => name.length <= 80 && /^[\w-]+\.fifo$/.test(name)) || queueName === dlqName) throw new Error('Invalid FIFO queue configuration');
    if(eventQueue.length>80||! /^[\w-]+\.fifo$/.test(eventQueue)||[queueName,dlqName].includes(eventQueue))throw new Error('Event FIFO must be separate');
    this.outbox=Object.freeze({publisherEnabled:publisher==='true',consumerEnabled:eventConsumer==='true',queueName:eventQueue,leaseMs});
    this.messaging = Object.freeze({ enabled: messagingEnabled === 'true', queueName, dlqName, shutdownMs });
    const pendingWorker = env.PENDING_REFERENCE_WORKER_ENABLED ?? 'true';
    if (!['true', 'false'].includes(pendingWorker)) throw new Error('Invalid configuration: PENDING_REFERENCE_WORKER_ENABLED');
    this.pendingReferenceWorkerEnabled = pendingWorker === 'true';
    this.port = port(env, 'PORT', '3000');
    this.database = Object.freeze({
      host: text(env, 'DB_HOST', '127.0.0.1'),
      port: port(env, 'DB_PORT', '5432'),
      dbName: text(env, 'DB_NAME', 'wagering'),
      user: text(env, 'DB_USER', 'wagering'),
      password: text(env, 'DB_PASSWORD', 'wagering_local'),
    });
    const endpoint = text(env, 'SQS_ENDPOINT', 'http://127.0.0.1:4566');
    const url = new URL(endpoint);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('Invalid configuration: SQS_ENDPOINT');
    }
    this.sqs = Object.freeze({
      endpoint,
      region: text(env, 'AWS_REGION', 'us-east-1'),
      accessKeyId: text(env, 'AWS_ACCESS_KEY_ID', 'test'),
      secretAccessKey: text(env, 'AWS_SECRET_ACCESS_KEY', 'test'),
    });
  }
}
