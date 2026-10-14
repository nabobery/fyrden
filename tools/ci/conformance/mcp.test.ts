// The MCP conformance suite (requirements of the 2026-07-28 revision) against
// fyrden-api under `wrangler dev`, with a known-failure baseline: checks that
// need the suite's own fixture tools, resources and prompts, or features
// Fyrden does not offer, are excused one by one; any other failure, or a
// baselined check that starts passing, fails this test. The suite sends no
// token, so a local proxy adds one (Fyrden's MCP server takes no anonymous
// request). And the authorization server's metadata scenario.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, request, type Server } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** The suite's version, pinned: a new one is adopted deliberately, with its baseline. */
const CONFORMANCE = "@modelcontextprotocol/conformance@0.2.0-alpha.12";
const REVISION = "2026-07-28";

const root = resolve(import.meta.dirname, "../../..");
const apiConfig = join(root, "apps/api/wrangler.jsonc");
const baseline = join(import.meta.dirname, "mcp-expected-failures.yml");
const wranglerBin = join(
  dirname(createRequire(import.meta.url).resolve("wrangler/package.json")),
  "bin",
  "wrangler.js",
);

interface Run {
  code: number | null;
  output: string;
}

function run(command: string, args: string[], cwd: string): Promise<Run> {
  return new Promise((done, fail) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, NO_COLOR: "1", WRANGLER_SEND_METRICS: "false" },
    });
    let output = "";
    child.stdout.on("data", (d: Buffer) => {
      output += d;
    });
    child.stderr.on("data", (d: Buffer) => {
      output += d;
    });
    child.on("error", fail);
    child.on("close", (code) => done({ code, output }));
    child.stdin.end();
  });
}

describe("MCP conformance", () => {
  const port = 40_000 + Math.floor(Math.random() * 10_000);
  let proxyPort = 0;
  const bootstrapSecret = `conformance-${crypto.randomUUID()}`;
  let scratch = "";
  let dev: ChildProcess | undefined;
  let proxy: Server | undefined;
  let output = "";

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), "fyrden-conformance-"));
    const persist = join(scratch, "state");
    for (const db of ["DIRECTORY", "ORG_READ"]) {
      const migrated = await run(
        process.execPath,
        [
          wranglerBin,
          "d1",
          "migrations",
          "apply",
          db,
          "--local",
          "--persist-to",
          persist,
          "-c",
          apiConfig,
        ],
        join(root, "apps/api"),
      );
      expect(migrated.code, migrated.output).toBe(0);
    }
    dev = spawn(
      process.execPath,
      [
        wranglerBin,
        "dev",
        "-c",
        apiConfig,
        "--persist-to",
        persist,
        "--var",
        `BOOTSTRAP_SECRET:${bootstrapSecret}`,
        "--ip",
        "127.0.0.1",
        "--port",
        String(port),
      ],
      {
        cwd: join(root, "apps/api"),
        env: { ...process.env, NO_COLOR: "1", WRANGLER_SEND_METRICS: "false" },
      },
    );
    const child = dev;
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
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      child.on("exit", (code) => fail(new Error(`wrangler dev exited (${code}):\n${output}`)));
    });
    const boot = await fetch(`http://127.0.0.1:${port}/v0/admin/bootstrap`, {
      method: "POST",
      headers: { "X-Fyrden-Bootstrap-Secret": bootstrapSecret, "Content-Type": "application/json" },
      body: JSON.stringify({ handle: `conformance${Date.now().toString(36)}` }),
    });
    expect(boot.status, await boot.clone().text()).toBe(201);
    const { token } = (await boot.json()) as { token: string };
    // Every request the suite makes, with the token (and the suite's own Host and Origin).
    proxy = createServer((req, res) => {
      const upstream = request(
        {
          host: "127.0.0.1",
          port,
          path: req.url,
          method: req.method,
          headers: { ...req.headers, authorization: `Bearer ${token}` },
        },
        (answer) => {
          res.writeHead(answer.statusCode ?? 502, answer.headers);
          answer.pipe(res);
        },
      );
      upstream.on("error", () => {
        res.writeHead(502);
        res.end();
      });
      req.pipe(upstream);
    });
    // A port the system picks, so it cannot collide.
    await new Promise<void>((ready, fail) => {
      proxy?.once("error", fail);
      proxy?.listen(0, "127.0.0.1", ready);
    });
    const address = proxy.address();
    if (address === null || typeof address === "string") throw new Error("the proxy has no port");
    proxyPort = address.port;
  }, 180_000);

  afterAll(async () => {
    proxy?.close();
    if (dev && dev.exitCode === null) dev.kill("SIGTERM");
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  it("passes every check of the revision's requirements but the baselined ones", async () => {
    const result = await run(
      "npx",
      [
        "-y",
        CONFORMANCE,
        "server",
        "--url",
        `http://127.0.0.1:${proxyPort}/mcp`,
        "--requirements",
        REVISION,
        "--expected-failures",
        baseline,
        "-o",
        join(scratch, "results"),
      ],
      scratch,
    );
    expect(result.code, result.output).toBe(0);
    // It ran: every scenario of the revision, judged against the baseline.
    expect(result.output).toContain(`Running requirements ${REVISION}`);
    expect(result.output).toContain("Baseline check passed");
  }, 600_000);

  it("serves authorization server metadata the suite accepts", async () => {
    const result = await run(
      "npx",
      [
        "-y",
        CONFORMANCE,
        "authorization",
        "--url",
        `http://127.0.0.1:${port}`,
        "--scenario",
        "authorization-server-metadata-endpoint",
        "--spec-version",
        REVISION,
        "-o",
        join(scratch, "results-as"),
      ],
      scratch,
    );
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("0 failed");
  }, 300_000);
});
