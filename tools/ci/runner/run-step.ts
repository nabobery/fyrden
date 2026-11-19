export async function runRunnerStep(
  daemon: Promise<{ code: number | null }>,
  afterStart: (signal: AbortSignal) => Promise<void>,
  stop: () => Promise<unknown>,
): Promise<void> {
  const controller = new AbortController();
  const step = Promise.resolve().then(() => afterStart(controller.signal));
  try {
    await Promise.race([
      step,
      daemon.then((exit) => {
        if (exit.code === 0) return step;
        throw new Error(`The runner exited (${exit.code}) before the test's step finished.`);
      }),
    ]);
  } catch (error) {
    controller.abort();
    await step.catch(() => undefined);
    await stop().catch(() => undefined);
    await daemon.catch(() => undefined);
    throw error;
  }
}
