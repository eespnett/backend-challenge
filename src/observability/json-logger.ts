import { LoggerService } from '@nestjs/common';

/** Nest/internal messages can contain SQL or SDK errors: emit only a fixed event. */
export class JsonLogger implements LoggerService {
  private emit(level: string, event: string) {
    console.log(JSON.stringify({ timestamp: new Date().toISOString(), level, event }));
  }
  log(..._args: unknown[]) { this.emit('info', 'framework_lifecycle'); }
  warn(..._args: unknown[]) { this.emit('warn', 'worker_or_framework_warning'); }
  error(..._args: unknown[]) { this.emit('error', 'worker_or_framework_error'); }
  debug(..._args: unknown[]) {}
  verbose(..._args: unknown[]) {}
  fatal(..._args: unknown[]) { this.emit('error', 'framework_fatal'); }
}
