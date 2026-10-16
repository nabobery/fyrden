import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { spawnOwned } from "../e2e/wrangler-dev.ts";

/** A Node process running `script`, owned as wrangler dev is, once it has printed `ready`. */
async function started(script: string, graceMs?: number) {
  const owned = spawnOwned(process.execPath, ["-e", script], {}, graceMs);
  const ready = await firstLine(owned.child);
  expect(ready).toMatch(/^ready/);
  return { ...owned, ready };
}

async function firstLine(child: ChildProcess): Promise<string> {
  const [chunk] = (await once(child.stdout as NodeJS.ReadableStream, "data")) as [Buffer];
  return String(chunk).split("\n")[0] as string;
}

/** Whether process `pid` still exists. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const KEEP_RUNNING = "setInterval(() => {}, 1e6)";
const IGNORE_SIGTERM = 'process.on("SIGTERM", () => {})';

/**
 * As wrangler's launcher: runs a child sharing its output pipes, which
 * prints `ready <pid>` and runs `childScript`; forwards SIGTERM to it and
 * exits when it does, or at once after the start when `leave` is set.
 */
function launcher(childScript: string, leave = false): string {
  const child = `console.log("ready " + process.pid); ${childScript}`;
  return [
    'const { spawn } = require("node:child_process");',
    `const kid = spawn(process.execPath, ["-e", ${JSON.stringify(child)}], { stdio: "inherit" });`,
    'process.on("SIGTERM", () => kid.kill());',
    'kid.on("exit", (code) => process.exit(code ?? 0));',
    leave ? "kid.on('spawn', () => setTimeout(() => process.exit(0), 200));" : KEEP_RUNNING,
  ].join("\n");
}

describe("stopping wrangler dev", () => {
  it("ends a process that exits on SIGTERM, and resolves once it has closed", async () => {
    const { child, stop } = await started(`console.log("ready"); ${KEEP_RUNNING}`);
    await stop();
    expect(child.signalCode).toBe("SIGTERM");
    expect(child.stdout?.readableEnded).toBe(true);
  });

  it("kills a process that ignores SIGTERM", async () => {
    // Ignoring SIGTERM, it can only end by SIGKILL, however short the wait.
    const { child, stop } = await started(
      `${IGNORE_SIGTERM}; console.log("ready"); ${KEEP_RUNNING}`,
      50,
    );
    await stop();
    expect(child.signalCode).toBe("SIGKILL");
    expect(child.stdout?.readableEnded).toBe(true);
  });

  it("kills a launched child that ignores SIGTERM and holds the output pipes", async () => {
    const { child, stop, ready } = await started(
      launcher(`${IGNORE_SIGTERM}; ${KEEP_RUNNING}`),
      50,
    );
    const pid = Number(ready.split(" ")[1]);
    await stop();
    expect(child.signalCode).toBe("SIGKILL");
    expect(alive(pid)).toBe(false);
  });

  it("ends what a launcher left running after it exited", async () => {
    const { child, stop, ready } = await started(launcher(KEEP_RUNNING, true));
    const pid = Number(ready.split(" ")[1]);
    await once(child, "exit");
    expect(alive(pid)).toBe(true);
    await stop();
    expect(alive(pid)).toBe(false);
  });

  it("is safe to call again, and after the process has already exited", async () => {
    const { child, stop } = await started(
      'setImmediate(() => process.exit(0)); console.log("ready")',
    );
    await once(child, "exit");
    expect(stop()).toBe(stop());
    await stop();
    expect(child.exitCode).toBe(0);
    expect(child.signalCode).toBeNull();
  });
});
