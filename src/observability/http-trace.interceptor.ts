import { CallHandler, ExecutionContext, Inject, Injectable, NestInterceptor } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { tap } from 'rxjs';
import { TraceContext } from '../application/telemetry-port';
import { TelemetryService } from './telemetry.service';

@Injectable()
export class HttpTraceInterceptor implements NestInterceptor {
  constructor(@Inject(TelemetryService) private readonly telemetry: TelemetryService) {}
  intercept(context: ExecutionContext, next: CallHandler) {
    const request = context.switchToHttp().getRequest<{ headers: Record<string, unknown>; params: Record<string, string>; body?: unknown }>();
    const response = context.switchToHttp().getResponse<{ setHeader(name: string, value: string): void }>();
    const header = request.headers['x-correlation-id'];
    const correlationId = typeof header === 'string' && header.length > 0 && header.length <= 200 && !/[\u0000-\u001f]/.test(header) ? header : randomUUID();
    if (header === undefined) request.headers['x-correlation-id'] = correlationId;
    response.setHeader('x-correlation-id', correlationId);
    const trace: TraceContext = { correlationId, walletId: request.params.walletId, transactionId: request.params.transactionId,
      providerId: request.params.providerId };
    if (request.body && typeof request.body === 'object') {
      const body = request.body as Record<string, unknown>;
      if (typeof body.walletId === 'string') trace.walletId = body.walletId;
      if (typeof body.providerId === 'string') trace.providerId = body.providerId;
    }
    return next.handle().pipe(tap({
      next: (result: unknown) => {
        if (result && typeof result === 'object') {
          const value = result as Record<string, unknown>;
          if (typeof value.transactionId === 'string') trace.transactionId = value.transactionId;
          if (typeof value.walletId === 'string') trace.walletId = value.walletId;
          if (typeof value.id === 'string' && 'balance' in value) trace.walletId = value.id;
        }
        this.telemetry.log('info', 'http_request_completed', trace);
      },
      error: () => this.telemetry.log('warn', 'http_request_failed', trace),
    }));
  }
}
