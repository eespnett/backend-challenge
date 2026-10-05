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
  readonly port: number;
  readonly database: Readonly<{
    host: string; port: number; dbName: string; user: string; password: string;
  }>;
  readonly sqs: Readonly<{
    endpoint: string; region: string; accessKeyId: string; secretAccessKey: string;
  }>;

  constructor() {
    const env = process.env;
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
