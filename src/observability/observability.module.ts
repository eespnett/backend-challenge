import { Module } from '@nestjs/common';
import { TelemetryService } from './telemetry.service';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { HttpTraceInterceptor } from './http-trace.interceptor';

@Module({ providers: [{ provide: TelemetryService, useFactory: () => new TelemetryService() },
  { provide: APP_INTERCEPTOR, useClass: HttpTraceInterceptor }], exports: [TelemetryService] })
export class ObservabilityModule {}
