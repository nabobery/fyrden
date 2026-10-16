// Concurrent agents pushing to their own branches of one repository, with
// stock git against fyrden-api under `wrangler dev`: every push lands, and
// the throughput and latency are reported (local numbers; a deployment's
// come from running tools/ci/src/push-load.ts against it).
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runPushLoad } from "../src/push-load.js";
import { startWranglerDev, type WranglerDev } from "./wrangler-dev.js";

const root = resolve(import.meta.dirname, "../../..");
const apiConfig = join(root, "apps/api/wrangler.jsonc");
const wranglerBin = join(
  dirname(createRequire(import.meta.url).resolve("wrangler/package.json")),
  "bin",
  "wrangler.js",
);
const bootstrapSecret = `e2e-${crypto.randomUUID()}`;
let scratch = "";
let server: WranglerDev | undefined;
let origin = "";
let token = "";
let handle = "";

function node(args: string[], cwd: string): Promise<number | null> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env: { ...process.env, NO_COLOR: "1", WRANGLER_SEND_METRICS: "false" },
      stdio: "ignore",
    });
    child.on("error", fail);
    child.on("close", done);
  });
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "fyrden-e2e-load-"));
  const persist = join(scratch, "state");
  expect(
    await node(
      [
        wranglerBin,
        "d1",
        "migrations",
        "apply",
        "DIRECTORY",
        "--local",
        "--persist-to",
        persist,
        "-c",
        apiConfig,
      ],
      join(root, "apps/api"),
    ),
  ).toBe(0);
  server = await startWranglerDev({
    args: [
      "-c",
      apiConfig,
      "--persist-to",
      persist,
      "--var",
      `BOOTSTRAP_SECRET:${bootstrapSecret}`,
    ],
    cwd: join(root, "apps/api"),
    onOutput: () => {},
  });
  origin = `http://127.0.0.1:${server.port}`;
  handle = `e2eload${Date.now().toString(36)}`;
  const boot = await fetch(`${origin}/v0/admin/bootstrap`, {
    method: "POST",
    headers: { "X-Fyrden-Bootstrap-Secret": bootstrapSecret, "Content-Type": "application/json" },
    body: JSON.stringify({ handle }),
  });
  expect(boot.status).toBe(201);
  token = ((await boot.json()) as { token: string }).token;
  const made = await fetch(`${origin}/api/user/repos`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Idempotency-Key": crypto.randomUUID(),
    },
    body: JSON.stringify({ name: "load" }),
  });
  expect(made.status, await made.clone().text()).toBe(201);
  // A first commit on main, for the agents to branch from.
  const first = await fetch(`${origin}/api/repos/${handle}/load/file-commits`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Idempotency-Key": crypto.randomUUID(),
    },
    body: JSON.stringify({ message: "first", changes: [{ path: "README.md", content: "load\n" }] }),
  });
  expect(first.status, await first.clone().text()).toBe(201);
}, 120_000);

afterAll(async () => {
  const child = server?.child;
  if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  if (server) await Promise.race([server.closed, new Promise((give) => setTimeout(give, 10_000))]);
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

describe("agents pushing at once", () => {
  it("land every push to their own branches, and report the rate", async () => {
    const report = await runPushLoad({
      origin,
      token,
      repo: `${handle}/load`,
      agents: 4,
      pushesPerAgent: 3,
      prefix: "load/e2e",
    });
    console.log(`push load (wrangler dev): ${JSON.stringify(report)}`);
    expect(report.errors).toEqual([]);
    expect(report).toMatchObject({ pushes: 12, failed: 0 });
    expect(report.pushesPerSecond).toBeGreaterThan(0);
    // Every push made a commit: each branch is three commits past main.
    for (let i = 0; i < 4; i++) {
      const commits = await fetch(
        `${origin}/api/repos/${handle}/load/commits?sha=load/e2e/agent-${i}&per_page=10`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      expect(commits.status).toBe(200);
      expect(((await commits.json()) as { commits: unknown[] }).commits.length).toBe(4);
    }
  }, 300_000);
});
