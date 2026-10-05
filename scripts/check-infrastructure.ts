import 'reflect-metadata';
import { MikroORM } from '@mikro-orm/postgresql';
import { AppConfig } from '../src/config/app-config';
import { createOrmConfig } from '../src/infrastructure/persistence/mikro-orm.config';
import { SqsService } from '../src/infrastructure/sqs/sqs.service';

async function main(): Promise<void> {
  const config = new AppConfig();
  const orm = await MikroORM.init(createOrmConfig(config));
  const sqs = new SqsService(config);
  try {
    const result: Array<{ ok: number }> = await orm.em.getConnection().execute('select 1 as ok');
    if (result[0]?.ok !== 1) throw new Error('PostgreSQL probe failed');
    console.log('PostgreSQL: SELECT 1 passed');
    await sqs.check();
    console.log('SQS: required FIFO queues reachable');
  } finally {
    sqs.onModuleDestroy();
    await orm.close(true);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
