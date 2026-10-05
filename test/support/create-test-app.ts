import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';

export async function createTestApp() {
  const app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
  await app.listen(0, '127.0.0.1');
  return app;
}
