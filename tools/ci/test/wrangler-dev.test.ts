import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { stopper } from "../e2e/wrangler-dev.ts";

/** A Node process running `script`, once it has printed `ready` (its handlers installed). */
async function started(script: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["-e", `${script}; console.log("ready")`]);
  const [chunk] = (await once(child.stdout, "data")) as [Buffer];
  expect(String(chunk)).toContain("ready");
  return child;
}

const KEEP_RUNNING = "setInterval(() => {}, 1e6)";

describe("stopping wrangler dev", () => {
  it("ends a process that exits on SIGTERM, and resolves once it has closed", async () => {
    const child = await started(KEEP_RUNNING);
    const stop = stopper(child);
    await stop();
    expect(child.signalCode).toBe("SIGTERM");
    expect(child.stdout?.readableEnded).toBe(true);
  });

  it("kills a process that ignores SIGTERM", async () => {
    const child = await started(`process.on("SIGTERM", () => {}); ${KEEP_RUNNING}`);
    // Ignoring SIGTERM, it can only end by SIGKILL, however short the wait.
    const stop = stopper(child, 50);
    await stop();
    expect(child.signalCode).toBe("SIGKILL");
    expect(child.stdout?.readableEnded).toBe(true);
  });

  it("is safe to call again, and after the process has already exited", async () => {
    const child = await started("setImmediate(() => process.exit(0))");
    const stop = stopper(child);
    await once(child, "exit");
    expect(stop()).toBe(stop());
    await stop();
    expect(child.exitCode).toBe(0);
    expect(child.signalCode).toBeNull();
  });
});
