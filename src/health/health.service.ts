import { Inject, Injectable } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/core';
import { SqsService } from '../infrastructure/sqs/sqs.service';

@Injectable()
export class HealthService {
  constructor(
    @Inject(MikroORM) private readonly orm: MikroORM,
    @Inject(SqsService) private readonly sqs: SqsService,
  ) {}

  async readiness(): Promise<{
    status: 'ok' | 'unavailable';
    checks: { postgres: 'up' | 'down'; sqs: 'up' | 'down' };
  }> {
    const [postgres, sqs] = await Promise.allSettled([
      this.bounded(this.orm.em.getConnection().execute('select 1 as ok')),
      this.bounded(this.sqs.check()),
    ]);
    const checks = {
      postgres: postgres.status === 'fulfilled' ? 'up' as const : 'down' as const,
      sqs: sqs.status === 'fulfilled' ? 'up' as const : 'down' as const,
    };
    return {
      status: checks.postgres === 'up' && checks.sqs === 'up' ? 'ok' : 'unavailable',
      checks,
    };
  }

  private async bounded<T>(probe: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([probe, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Readiness deadline')), 6000);
      })]);
    } finally { clearTimeout(timer); }
  }
}
