// The REST API fuzzed from its own OpenAPI document by Schemathesis (pinned
// version) against fyrden-api under `wrangler dev`: every operation, through
// the coverage, fuzzing and stateful phases, as a signed-in user with a
// repository, an organization with a team, and an agent to point at. A
// response that is a server error, or that the document does not describe,
// fails the run; inputs the API rejects (4xx) are answers the document
// describes, so they pass. The rate limits are raised for the run, or most
// requests would be refused (429) before reaching an operation.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** Schemathesis, pinned: a new version is adopted deliberately. */
const SCHEMATHESIS = "schemathesis@4.28.0";

const root = resolve(import.meta.dirname, "../../..");
const apiConfig = join(root, "apps/api/wrangler.jsonc");
// Beside the original, so its relative paths still resolve (gitignored).
const fuzzConfig = join(root, `apps/api/wrangler.schemathesis-${crypto.randomUUID()}.jsonc`);
const wranglerBin = join(
  dirname(createRequire(import.meta.url).resolve("wrangler/package.json")),
  "bin",
  "wrangler.js",
);

/** What the run points path parameters at; set up before the run. */
const SEED = {
  owner: "fuzz",
  repo: "seed",
  org: "fuzzorg",
  team_slug: "core",
  agent: "fuzzbot",
  username: "fuzz",
  account: "fuzz",
  path: "README.md",
  branch: "main",
  ref: "main",
  tree_sha: "main",
  basehead: "main...main",
  template_owner: "fuzz",
  template_repo: "seed",
};

/**
 * Operations that would remove what the rest of the run points at get their
 * own disposable targets, so a delete or a transfer early in the run does
 * not turn every later request into a 404.
 */
const DISPOSABLE = [
  { path: "/repos/{owner}/{repo}", method: "DELETE", parameters: { repo: "doomed" } },
  { path: "/repos/{owner}/{repo}/transfer", method: "POST", parameters: { repo: "moving" } },
  { path: "/agents/{agent}", method: "DELETE", parameters: { agent: "doomedbot" } },
];

/** A port nothing listens on now: the system's pick, released for wrangler. */
function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address !== null
          ? done(address.port)
          : fail(new Error("no port")),
      );
    });
  });
}

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

const toml = (value: string) => JSON.stringify(value);
const table = (entries: Record<string, string>) =>
  `{ ${Object.entries(entries)
    .map(([k, v]) => `${toml(k)} = ${toml(v)}`)
    .join(", ")} }`;

describe("the REST API under Schemathesis", () => {
  let port = 0;
  let base = "";
  const bootstrapSecret = `schemathesis-${crypto.randomUUID()}`;
  let scratch = "";
  let dev: ChildProcess | undefined;
  let closed: Promise<void> = Promise.resolve();
  let output = "";
  let token = "";

  async function call(method: string, path: string, body?: unknown): Promise<void> {
    const res = await fetch(`${base}/api${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    expect(res.status, `${method} ${path}: ${await res.text()}`).toBeLessThan(300);
  }

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), "fyrden-schemathesis-"));
    port = await freePort();
    base = `http://127.0.0.1:${port}`;
    const original = await readFile(apiConfig, "utf8");
    const raised = original.replaceAll(/"limit": \d+/g, '"limit": 1000000');
    expect(raised.match(/"limit": 1000000/g)?.length).toBe(original.match(/"limit"/g)?.length);
    await writeFile(fuzzConfig, raised);
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
        fuzzConfig,
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
    closed = new Promise((done) => child.once("close", () => done()));
    await new Promise<void>((ready, fail) => {
      const timer = setTimeout(
        () => fail(new Error(`wrangler dev did not start:\n${output}`)),
        60_000,
      );
      const onData = (d: Buffer) => {
        output += d;
        // Ready on the port asked for, not one wrangler fell back to.
        if (output.includes(`Ready on ${base}`)) {
          clearTimeout(timer);
          ready();
        }
      };
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      child.on("exit", (code) => fail(new Error(`wrangler dev exited (${code}):\n${output}`)));
    });
    const boot = await fetch(`${base}/v0/admin/bootstrap`, {
      method: "POST",
      headers: { "X-Fyrden-Bootstrap-Secret": bootstrapSecret, "Content-Type": "application/json" },
      body: JSON.stringify({ handle: SEED.owner }),
    });
    expect(boot.status, await boot.clone().text()).toBe(201);
    token = ((await boot.json()) as { token: string }).token;
    for (const name of [SEED.repo, "doomed", "moving"]) await call("POST", "/user/repos", { name });
    await call("PUT", `/repos/${SEED.owner}/${SEED.repo}/contents/${SEED.path}`, {
      message: "Add README.md",
      content: btoa("# Seed\n"),
    });
    await call("POST", "/admin/organizations", { login: SEED.org, admin: SEED.owner });
    await call("POST", `/orgs/${SEED.org}/teams`, { name: SEED.team_slug });
    for (const handle of [SEED.agent, "doomedbot"]) await call("POST", "/agents", { handle });
  }, 180_000);

  afterAll(async () => {
    if (dev && dev.exitCode === null && dev.signalCode === null) {
      dev.kill("SIGTERM");
      // Its state is removed next: make sure it is gone first.
      const stopped = await Promise.race([
        closed.then(() => true),
        new Promise<boolean>((give) => setTimeout(() => give(false), 10_000)),
      ]);
      if (!stopped) {
        dev.kill("SIGKILL");
        await closed;
      }
    }
    if (scratch) await rm(scratch, { recursive: true, force: true });
    await rm(fuzzConfig, { force: true });
  });

  it("answers every generated request without a server error, as documented", async () => {
    // The token goes in the config file (in the scratch directory, removed
    // afterwards), not on a command line other processes can read.
    const config = join(scratch, "schemathesis.toml");
    await writeFile(
      config,
      [
        `headers = ${table({ Authorization: `Bearer ${token}` })}`,
        `[parameters]`,
        ...Object.entries(SEED).map(([k, v]) => `${toml(k)} = ${toml(v)}`),
        ...DISPOSABLE.flatMap((op) => [
          "[[operations]]",
          `include-path = ${toml(op.path)}`,
          `include-method = ${toml(op.method)}`,
          `parameters = ${table(op.parameters)}`,
        ]),
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    const result = await run(
      "uvx",
      [
        SCHEMATHESIS,
        "--config-file",
        config,
        "run",
        `${base}/api/openapi.json`,
        "--url",
        `${base}/api`,
        "--checks",
        "not_a_server_error,response_schema_conformance",
        "--max-examples",
        "20",
        "--workers",
        "1",
        // Most operations need a path that names something real, so most
        // generated inputs are rejected before they reach one; that is
        // expected here, not a problem with the strategy.
        "--suppress-health-check",
        "filter_too_much",
        "--no-color",
        "--report",
        "har",
        "--report-dir",
        join(scratch, "report"),
      ],
      scratch,
    );
    const report = result.output.replaceAll(token, "<token>");
    expect(result.code, report).toBe(0);
    // It ran: every operation in the document.
    const total = Number(/Selected: \d+\/(\d+)/.exec(report)?.[1]);
    expect(total, report).toBeGreaterThan(0);
    expect(report).toContain(`Selected: ${total}/${total}`);
    expect(report).toContain(`Tested: ${total}`);
    expect(report).toMatch(/\d+ generated, \d+ passed/);
    // And the requests reached the operations: none refused by a rate
    // limit, and some answered with success.
    const [har] = (await readdir(join(scratch, "report"))).filter((f) => f.endsWith(".json"));
    expect(har, report).toBeDefined();
    const { log } = JSON.parse(await readFile(join(scratch, "report", har ?? ""), "utf8")) as {
      log: { entries: { response: { status: number } }[] };
    };
    const statuses = log.entries.map((e) => e.response.status);
    expect(statuses.filter((s) => s === 429).length, report).toBe(0);
    expect(statuses.filter((s) => s < 300).length, report).toBeGreaterThan(100);
  }, 600_000);
});
