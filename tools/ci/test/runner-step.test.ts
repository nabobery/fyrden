import { describe, expect, it } from "vitest";
import { runRunnerStep } from "../runner/run-step.js";

function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("a stock runner's mid-job step", () => {
  it("lets an exit-zero daemon wait for the viewer step", async () => {
    const started = gate<void>();
    const release = gate<void>();
    let aborted = false;
    let stops = 0;
    const running = runRunnerStep(
      Promise.resolve({ code: 0 }),
      async (signal) => {
        signal.addEventListener("abort", () => {
          aborted = true;
        });
        started.resolve();
        await release.promise;
      },
      async () => {
        stops++;
      },
    );
    const result = running.then(
      () => undefined,
      (error: unknown) => error,
    );
    await started.promise;
    release.resolve();
    expect(await result).toBeUndefined();
    expect(aborted).toBe(false);
    expect(stops).toBe(0);
  });

  it("stops and joins the daemon before propagating a failed step", async () => {
    const daemon = gate<{ code: number }>();
    const stopped = gate<void>();
    const failure = new Error("ticket refused");
    let settled = false;
    const result = runRunnerStep(
      daemon.promise,
      async () => {
        throw failure;
      },
      async () => {
        stopped.resolve();
      },
    ).then(
      () => undefined,
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    try {
      const stopRan = await Promise.race([
        stopped.promise.then(() => true),
        result.then(() => false),
      ]);
      expect(stopRan).toBe(true);
      expect(settled).toBe(false);
    } finally {
      daemon.resolve({ code: 0 });
      expect(await result).toBe(failure);
    }
  });

  it("cancels and settles the step on an unsuccessful daemon exit", async () => {
    const started = gate<void>();
    const daemon = gate<{ code: number }>();
    let stopped = false;
    let unwound = false;
    const result = runRunnerStep(
      daemon.promise,
      async (signal) => {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
          started.resolve();
        });
        unwound = true;
      },
      async () => {
        stopped = true;
      },
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    await started.promise;
    daemon.resolve({ code: 1 });
    expect(await result).toMatchObject({ message: expect.stringContaining("exited (1)") });
    expect(unwound).toBe(true);
    expect(stopped).toBe(true);
  });
});
