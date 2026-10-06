import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { AppConfig } from './config/app-config';
import { JsonLogger } from './observability/json-logger';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: new JsonLogger() });
  app.enableShutdownHooks();
  await app.listen(app.get(AppConfig).port, '0.0.0.0');
}

bootstrap().catch(() => {
  console.error(JSON.stringify({ level: 'error', message: 'Application bootstrap failed' }));
  process.exitCode = 1;
});
