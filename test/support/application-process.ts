// Test entry point: the production module and providers, with an OS-assigned port.
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { createInterface } from 'node:readline';
import { AppModule } from '../../src/app.module';
import { AppConfig } from '../../src/config/app-config';
import { SqsService } from '../../src/infrastructure/sqs/sqs.service';
import { DeleteMessageCommand, ReceiveMessageCommand } from '@aws-sdk/client-sqs';

async function main() {
  const app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
  let resumeAck!: () => void;
  const ackGate = new Promise<void>((resolve) => { resumeAck = resolve; });
  if (process.env.SQS_TEST_PAUSE_BEFORE_ACK === 'true' || process.env.SQS_TEST_VISIBILITY_SECONDS) {
    const client = app.get(SqsService).client;
    const send = client.send.bind(client);
    // Test-only crash window: real SQL has committed; DeleteMessage has not been sent.
    client.send = (async (command: unknown, options: unknown) => {
      if (command instanceof ReceiveMessageCommand && process.env.SQS_TEST_VISIBILITY_SECONDS) {
        command.input.VisibilityTimeout = Number(process.env.SQS_TEST_VISIBILITY_SECONDS);
      }
      if (command instanceof DeleteMessageCommand && process.env.SQS_TEST_PAUSE_BEFORE_ACK === 'true') {
        console.log(JSON.stringify({ type: 'before-ack', pid: process.pid }));
        const signal = (options as { abortSignal?: AbortSignal })?.abortSignal;
        await new Promise<void>((resolve, reject) => {
          const abort = () => reject(new Error('Shutdown'));
          signal?.addEventListener('abort', abort, { once: true });
          if (signal?.aborted) reject(new Error('Shutdown'));
          void ackGate.then(() => { signal?.removeEventListener('abort', abort); resolve(); });
        });
      }
      return send(command as never, options as never);
    }) as typeof client.send;
  }
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
  input.on('line', (line) => {
    if (line === 'shutdown') void close();
    if (line === 'sigterm') process.emit('SIGTERM', 'SIGTERM');
    if (line === 'resume-ack') resumeAck();
  });
  input.on('close', () => { void close(); });
}

main().catch(() => {
  // Never emit connection credentials in child diagnostics.
  console.error('Concurrency application process failed to bootstrap');
  process.exitCode = 1;
});
