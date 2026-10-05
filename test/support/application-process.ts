// Test entry point: the production module and providers, with an OS-assigned port.
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { createInterface } from 'node:readline';
import { AppModule } from '../../src/app.module';
import { AppConfig } from '../../src/config/app-config';

async function main() {
  const app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
  app.enableShutdownHooks();
  await app.listen(0, '127.0.0.1');
  console.log(JSON.stringify({ type: 'ready', pid: process.pid, url: await app.getUrl(),
    dbName: app.get(AppConfig).database.dbName }));
  const input = createInterface({ input: process.stdin });
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    input.close();
    await app.close();
    process.exit(0);
  };
  input.on('line', (line) => { if (line === 'shutdown') void close(); });
  input.on('close', () => { void close(); });
}

main().catch(() => {
  // Never emit connection credentials in child diagnostics.
  console.error('Concurrency application process failed to bootstrap');
  process.exitCode = 1;
});
