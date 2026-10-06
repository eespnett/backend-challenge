import { resolve } from 'node:path';
import { runCli } from './cli';

/** Run sequentially: concurrent suites compete for Docker/database resources on small hosts. */
const steps = [
  ['typecheck', ['run', 'typecheck']],
  ['unit_and_smoke', ['test', 'test/unit', 'test/smoke']],
  ['integration_and_health', ['test', 'test/integration', '--timeout', '30000']],
  ['concurrency_and_crash_recovery', ['test', 'test/concurrency', '--timeout', '30000']],
  ['final_typecheck', ['run', 'typecheck']],
] as const;

async function main() {
  for (const [step, args] of steps) {
    console.log(JSON.stringify({ event: 'verification_started', step }));
    const child = Bun.spawn([process.execPath, ...args], { cwd: resolve(__dirname, '..'), stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
    const code = await child.exited;
    console.log(JSON.stringify({ event: 'verification_finished', step, exitCode: code }));
    if (code !== 0) { process.exitCode = code; break; }
  }
}
void runCli('verification_failed', main);
