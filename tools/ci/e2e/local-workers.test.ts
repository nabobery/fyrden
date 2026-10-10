// Runs both Workers locally (wrangler dev with two configs, so the web
// Worker's API service binding is real) and smoke-tests the web Worker:
// its page and its /healthz both go through the binding into fyrden-api.
// Needs `pnpm --filter @fyrden/web build` first (turbo does it).
import { type ChildProcess, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { generateToken, mentionsToken, secureRandomBytes } from "@fyrden/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runSmoke, webChecks } from "../src/smoke.ts";

const root = resolve(import.meta.dirname, "../../..");
const wranglerBin = join(
  dirname(createRequire(import.meta.url).resolve("wrangler/package.json")),
  "bin",
  "wrangler.js",
);
const port = 40_000 + Math.floor(Math.random() * 10_000);
let dev: ChildProcess | undefined;
// Resolves when wrangler dev has exited and its output pipes have closed.
let closed: Promise<void> = Promise.resolve();
// Everything both Workers write, for the whole run.
let output = "";

beforeAll(async () => {
  dev = spawn(
    process.execPath,
    [
      wranglerBin,
      "dev",
      "-c",
      join(root, "apps/web/build/server/wrangler.json"),
      "-c",
      join(root, "apps/api/wrangler.jsonc"),
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    {
      cwd: join(root, "apps/web"),
      env: { ...process.env, NO_COLOR: "1", WRANGLER_SEND_METRICS: "false" },
    },
  );
  const child = dev;
  closed = new Promise((done) => child.once("close", () => done()));
  await new Promise<void>((ready, fail) => {
    const timer = setTimeout(
      () => fail(new Error(`wrangler dev did not start:\n${output}`)),
      60_000,
    );
    const onData = (d: Buffer) => {
      output += d;
      if (/Ready on/.test(output)) {
        clearTimeout(timer);
        ready();
      }
    };
    dev?.stdout?.on("data", onData);
    dev?.stderr?.on("data", onData);
    dev?.on("exit", (code) => fail(new Error(`wrangler dev exited (${code}):\n${output}`)));
  });
}, 90_000);

/**
 * What the Workers wrote. `[wrangler:info]` lines are wrangler dev's own
 * local access log, which echoes request URLs and is not Worker output.
 */
const workerLines = (from = 0) =>
  output
    .slice(from)
    .split("\n")
    .filter((line) => !line.startsWith("[wrangler:info]"));

/** Polls the Worker output until `match` appears; fails after `timeoutMs`. */
async function waitForLine(from: number, match: RegExp, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!workerLines(from).some((line) => match.test(line))) {
    if (Date.now() > deadline) throw new Error(`no Worker log line matched ${match}`);
    await new Promise((tick) => setTimeout(tick, 100));
  }
}

afterAll(async () => {
  if (dev && dev.exitCode === null && dev.signalCode === null) dev.kill("SIGTERM");
  // `close`, not `exit`: output can still arrive between the two.
  await Promise.race([closed, new Promise((give) => setTimeout(give, 10_000))]);
  // Lines printed late, after the test that caused them, are checked too.
  expect(workerLines().filter(mentionsToken)).toEqual([]);
});

describe("fyrden-web and fyrden-api running together", () => {
  it("serves the page and health check through the API service binding", async () => {
    const results = await runSmoke(webChecks(`http://127.0.0.1:${port}/`));
    expect(results.filter((r) => !r.ok)).toEqual([]);
  });

  it("never logs a token from a URL React Router cannot match", async () => {
    const token = generateToken("pat", secureRandomBytes);
    const before = output.length;
    const res = await fetch(`http://127.0.0.1:${port}/no-such-page/${token}`);
    expect(res.status).toBe(404);
    await res.text();
    // This request's own error line: proves the log was written before checking it.
    await waitForLine(before, /"msg":"web server error".*no-such-page/);
    const written = workerLines(before);
    expect(written.filter(mentionsToken).map((l) => l.replaceAll(token, "<TOKEN>"))).toEqual([]);
  });
});
