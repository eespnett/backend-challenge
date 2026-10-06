export class CliInputError extends Error {}
export const DEMO_PLAYER = 'demo-player';

/** Operational errors must not dump a connection string, SDK input or financial body. */
export async function runCli(event: string, main: () => Promise<void>): Promise<void> {
  try { await main(); }
  catch (error) {
    console.error(JSON.stringify({ level: 'error', event,
      message: error instanceof CliInputError ? error.message : 'Operation failed; check configuration and dependency availability' }));
    process.exitCode = 1;
  }
}
