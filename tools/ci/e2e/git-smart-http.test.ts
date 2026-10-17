// Real git against fyrden-api under `wrangler dev`: create a repository
// through the REST API, then talk to it with stock git over smart HTTP
// (protocol v2 discovery and ls-refs, the receive-pack advertisement, auth
// challenges and errors). Storage is a fresh temporary directory.
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { mentionsToken } from "@fyrden/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startWranglerDev, type WranglerDev } from "./wrangler-dev.js";

const root = resolve(import.meta.dirname, "../../..");
const apiConfig = join(root, "apps/api/wrangler.jsonc");
const wranglerBin = join(
  dirname(createRequire(import.meta.url).resolve("wrangler/package.json")),
  "bin",
  "wrangler.js",
);
let port = 0;
let origin = "";
const bootstrapSecret = `e2e-${crypto.randomUUID()}`;

let scratch = "";
let server: WranglerDev | undefined;
let output = "";
let token = "";
let handle = "";

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
): Promise<Run> {
  return new Promise((done, fail) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? scratch,
      env: { ...process.env, ...options.env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d;
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d;
    });
    child.on("error", fail);
    child.on("close", (code) => done({ code, stdout, stderr }));
    child.stdin.end();
  });
}

/** git with no user or system config, never prompting. */
function git(args: string[], cwd = scratch): Promise<Run> {
  return run("git", args, {
    cwd,
    env: {
      HOME: join(scratch, "home"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: join(scratch, "home/.gitconfig"),
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "Fyrden E2E",
      GIT_AUTHOR_EMAIL: "e2e@fyrden.invalid",
      GIT_COMMITTER_NAME: "Fyrden E2E",
      GIT_COMMITTER_EMAIL: "e2e@fyrden.invalid",
    },
  });
}

/** The repository URL with the token as the Basic password (git sends it after the 401). */
const repoUrl = (name: string, secret = token) =>
  `http://x-access-token:${secret}@127.0.0.1:${port}/${handle}/${name}.git`;

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${origin}${path}`, init);
}

async function createRepo(name: string): Promise<void> {
  const res = await api("/api/user/repos", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Idempotency-Key": crypto.randomUUID(),
    },
    body: JSON.stringify({ name }),
  });
  expect(res.status, await res.clone().text()).toBe(201);
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "fyrden-e2e-git-"));
  await run("mkdir", ["-p", join(scratch, "home")]);
  const persist = join(scratch, "state");
  const migrate = await run(
    process.execPath,
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
    { cwd: join(root, "apps/api"), env: { NO_COLOR: "1", WRANGLER_SEND_METRICS: "false" } },
  );
  expect(migrate.code, migrate.stdout + migrate.stderr).toBe(0);

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
    onOutput: (text) => {
      output += text;
    },
  });
  port = server.port;
  origin = `http://127.0.0.1:${port}`;

  handle = `e2e${Date.now().toString(36)}`;
  const boot = await api("/v0/admin/bootstrap", {
    method: "POST",
    headers: { "X-Fyrden-Bootstrap-Secret": bootstrapSecret, "Content-Type": "application/json" },
    body: JSON.stringify({ handle }),
  });
  expect(boot.status, await boot.clone().text()).toBe(201);
  token = ((await boot.json()) as { token: string }).token;
}, 120_000);

afterAll(async () => {
  try {
    await server?.stop();
    // Neither the Workers nor wrangler's access log may print a token.
    expect(output.split("\n").filter(mentionsToken)).toEqual([]);
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }
});

describe("stock git against fyrden-api (wrangler dev)", () => {
  it("lists an empty repository with git ls-remote over protocol v2", async () => {
    await createRepo("empty");
    const listed = await git(["ls-remote", repoUrl("empty")]);
    expect(listed.code, listed.stderr).toBe(0);
    expect(listed.stdout).toBe("");

    // As against git's own server: an unborn HEAD is listed only to clients
    // that ask for it (git clone does), not by ls-remote.
    const symref = await git(["ls-remote", "--symref", repoUrl("empty"), "HEAD"]);
    expect(symref.code, symref.stderr).toBe(0);
    expect(symref.stdout).toBe("");
  });

  it("clones an empty repository and learns its default branch", async () => {
    await createRepo("clone-me");
    const cloned = await git(["clone", repoUrl("clone-me"), "clone-me"]);
    expect(cloned.code, cloned.stderr).toBe(0);
    expect(cloned.stderr).toMatch(/cloned an empty repository/);
    const head = await git(["symbolic-ref", "HEAD"], join(scratch, "clone-me"));
    expect(head.stdout.trim()).toBe("refs/heads/main");
  });

  it("parses the receive-pack advertisement (git push --dry-run)", async () => {
    await createRepo("push-target");
    const work = join(scratch, "work");
    expect((await git(["init", "-q", "-b", "main", work])).code).toBe(0);
    expect((await git(["commit", "-q", "--allow-empty", "-m", "first"], work)).code).toBe(0);
    const dry = await git(["push", "--dry-run", repoUrl("push-target"), "main"], work);
    expect(dry.code, dry.stderr).toBe(0);
    expect(dry.stderr).toMatch(/\* \[new branch\]\s+main -> main/);

    // Pushing for real (the push cases are in git-push.test.ts).
    const push = await git(["push", repoUrl("push-target"), "main"], work);
    expect(push.code, push.stderr).toBe(0);
  });

  it("names protocol v2 when a client asks for v0", async () => {
    await createRepo("v0");
    const res = await git(["-c", "protocol.version=0", "ls-remote", repoUrl("v0")]);
    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(
      /remote error: Fyrden serves fetch and clone over git protocol version 2 only/,
    );
  });

  it("fails authentication with a bad token and hides repositories it cannot see", async () => {
    await createRepo("private");
    const bad = await git(["ls-remote", repoUrl("private", "fyrden_git_not-a-real-token")]);
    expect(bad.code).not.toBe(0);
    expect(bad.stderr).toMatch(/Authentication failed/);

    const missing = await git(["ls-remote", repoUrl("does-not-exist")]);
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toMatch(/remote: Repository not found\./);
    expect(missing.stderr).toMatch(/repository '.*' not found/);
  });
});
