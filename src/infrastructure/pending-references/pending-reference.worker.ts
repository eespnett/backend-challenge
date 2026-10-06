import { Inject, Injectable, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { TelemetryService } from '../../observability/telemetry.service';
import { AppConfig } from '../../config/app-config';
import { RunPendingReferenceBatch } from '../../application/run-pending-reference-batch';
import { PENDING_REFERENCE_POLL_MS } from '../../application/pending-reference-schedule';

@Injectable()
export class PendingReferenceWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private timer: ReturnType<typeof setInterval> | undefined;
  private active: Promise<void> | undefined;
  private stopping = false;
  constructor(@Inject(AppConfig) private readonly config: AppConfig,
    @Inject(RunPendingReferenceBatch) private readonly batch: RunPendingReferenceBatch,
    @Inject(TelemetryService) private readonly telemetry: TelemetryService) {}

  onApplicationBootstrap() {
    if (!this.config.pendingReferenceWorkerEnabled) return;
    this.timer = setInterval(() => { void this.tick(); }, PENDING_REFERENCE_POLL_MS);
    this.timer.unref();
  }

  async tick(): Promise<void> {
    if (this.stopping || this.active !== undefined) return;
    this.active = (async () => {
      try {
        const results = await this.batch.execute();
        if (results.some((result) => result.status === 'rejected')) {
          this.telemetry.log('warn', 'pending_reference_attempt_failed');
        }
      } catch {
        this.telemetry.log('warn', 'pending_reference_poll_unavailable');
      }
    })();
    try { await this.active; } finally { this.active = undefined; }
  }

  async onModuleDestroy() {
    this.stopping = true;
    clearInterval(this.timer);
    await this.active;
  }
}
