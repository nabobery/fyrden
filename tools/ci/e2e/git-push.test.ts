// Real `git push` against fyrden-api under `wrangler dev`: a new repository,
// more commits, a forced push, a stale lease, a deleted branch, tags, an
// atomic push with one refused ref, push options, and a body larger than
// git's http.postBuffer (sent chunked). After each, `git ls-remote` shows
// the refs expected. Storage is a fresh temporary directory.
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { mentionsToken } from "@fyrden/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const apiConfig = join(root, "apps/api/wrangler.jsonc");
const wranglerBin = join(
  dirname(createRequire(import.meta.url).resolve("wrangler/package.json")),
  "bin",
  "wrangler.js",
);
const port = 40_000 + Math.floor(Math.random() * 10_000);
const origin = `http://127.0.0.1:${port}`;
const bootstrapSecret = `e2e-${crypto.randomUUID()}`;
/** The Worker's push body limit for this run (a variable), small enough to exceed in a test. */
const BODY_LIMIT = 6 * 1024 * 1024;

let scratch = "";
let dev: ChildProcess | undefined;
let closed: Promise<void> = Promise.resolve();
let output = "";
let token = "";
let handle = "";
let clock = 1_767_225_600;

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

/** git with no user or system config, never prompting; each commit a day after the last. */
function git(args: string[], cwd = scratch): Promise<Run> {
  const date = `${clock} +0000`;
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
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    },
  });
}

async function ok(args: string[], cwd = scratch): Promise<string> {
  const result = await git(args, cwd);
  expect(result.code, `git ${args.join(" ")}\n${result.stderr}`).toBe(0);
  return result.stdout;
}

const repoUrl = (name: string) =>
  `http://x-access-token:${token}@127.0.0.1:${port}/${handle}/${name}.git`;

async function createRepo(name: string): Promise<void> {
  const res = await fetch(`${origin}/api/user/repos`, {
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

async function commit(cwd: string, file: string, content: string, message: string) {
  clock += 86_400;
  await writeFile(join(cwd, file), content);
  await ok(["add", "-A"], cwd);
  await ok(["commit", "-q", "-m", message], cwd);
  return (await ok(["rev-parse", "HEAD"], cwd)).trim();
}

/** `git ls-remote` as `{ ref: oid }`. */
async function remoteRefs(name: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const line of (await ok(["ls-remote", repoUrl(name)])).split("\n")) {
    if (!line) continue;
    const [oid, ref] = line.split("\t") as [string, string];
    out[ref] = oid;
  }
  return out;
}

/** A working repository with one commit on main, and an empty remote for it. */
async function workspace(name: string): Promise<string> {
  const work = join(scratch, name);
  await ok(["init", "-q", "-b", "main", work]);
  await ok(["remote", "add", "origin", repoUrl(name)], work);
  await commit(work, "README.md", "hello\n", "first");
  await createRepo(name);
  return work;
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "fyrden-e2e-push-"));
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
      "--var",
      `GIT_PUSH_MAX_BODY_BYTES:${BODY_LIMIT}`,
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      // Its own inspector port, so it can run beside the other suites' servers.
      "--inspector-port",
      String(port + 1),
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
      if (/Ready on/.test(output)) {
        clearTimeout(timer);
        ready();
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("exit", (code) => fail(new Error(`wrangler dev exited (${code}):\n${output}`)));
  });

  handle = `e2epush${Date.now().toString(36)}`;
  const boot = await fetch(`${origin}/v0/admin/bootstrap`, {
    method: "POST",
    headers: { "X-Fyrden-Bootstrap-Secret": bootstrapSecret, "Content-Type": "application/json" },
    body: JSON.stringify({ handle }),
  });
  expect(boot.status, await boot.clone().text()).toBe(201);
  token = ((await boot.json()) as { token: string }).token;
}, 120_000);

afterAll(async () => {
  if (dev && dev.exitCode === null && dev.signalCode === null) dev.kill("SIGTERM");
  await Promise.race([closed, new Promise((give) => setTimeout(give, 10_000))]);
  // Neither the Workers nor wrangler's access log may print a token.
  expect(output.split("\n").filter(mentionsToken)).toEqual([]);
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

describe("stock git push against fyrden-api (wrangler dev)", () => {
  it("pushes a new repository, then more commits", async () => {
    const work = await workspace("new-repo");
    await commit(work, "a.txt", "a\n", "second");
    const first = await git(["push", "origin", "main"], work);
    expect(first.code, first.stderr).toBe(0);
    expect(first.stderr).toMatch(/\* \[new branch\]\s+main -> main/);
    const head1 = (await ok(["rev-parse", "HEAD"], work)).trim();
    expect(await remoteRefs("new-repo")).toEqual({ HEAD: head1, "refs/heads/main": head1 });

    await commit(work, "a.txt", "a\nb\n", "third");
    await commit(work, "b.txt", "b\n", "fourth");
    await ok(["push", "origin", "main"], work);
    const head2 = (await ok(["rev-parse", "HEAD"], work)).trim();
    expect((await remoteRefs("new-repo"))["refs/heads/main"]).toBe(head2);
  });

  it("force-pushes, and refuses a stale --force-with-lease", async () => {
    const work = await workspace("force");
    const base = (await ok(["rev-parse", "HEAD"], work)).trim();
    await commit(work, "a.txt", "one\n", "to be rewritten");
    await ok(["push", "origin", "main"], work);
    const rewritten = (await ok(["rev-parse", "HEAD"], work)).trim();

    await ok(["reset", "-q", "--hard", base], work);
    const replacement = await commit(work, "a.txt", "two\n", "replacement");
    const plain = await git(["push", "origin", "main"], work);
    expect(plain.code).not.toBe(0);
    expect(plain.stderr).toMatch(/\[rejected\]|non-fast-forward/);

    const stale = await git(["push", `--force-with-lease=main:${base}`, "origin", "main"], work);
    expect(stale.code).not.toBe(0);
    expect(stale.stderr).toMatch(/stale info|rejected/);
    expect((await remoteRefs("force"))["refs/heads/main"]).toBe(rewritten);

    const forced = await git(["push", "--force", "origin", "main"], work);
    expect(forced.code, forced.stderr).toBe(0);
    expect(forced.stderr).toMatch(/\+ \S+\.\.\.\S+ main -> main \(forced update\)/);
    expect((await remoteRefs("force"))["refs/heads/main"]).toBe(replacement);
  });

  it("deletes a branch and pushes tags", async () => {
    const work = await workspace("branches");
    await ok(["branch", "feature"], work);
    await ok(["push", "origin", "main", "feature"], work);
    const head = (await ok(["rev-parse", "HEAD"], work)).trim();
    expect(Object.keys(await remoteRefs("branches")).sort()).toEqual([
      "HEAD",
      "refs/heads/feature",
      "refs/heads/main",
    ]);

    const deleted = await git(["push", "origin", "--delete", "feature"], work);
    expect(deleted.code, deleted.stderr).toBe(0);
    expect(deleted.stderr).toMatch(/- \[deleted\]\s+feature/);

    await ok(["tag", "light"], work);
    clock += 86_400;
    await ok(["tag", "-a", "v1", "-m", "release one"], work);
    const tagged = await git(["push", "origin", "--tags"], work);
    expect(tagged.code, tagged.stderr).toBe(0);
    const v1 = (await ok(["rev-parse", "v1"], work)).trim();
    expect(await remoteRefs("branches")).toEqual({
      HEAD: head,
      "refs/heads/main": head,
      "refs/tags/light": head,
      "refs/tags/v1": v1,
      "refs/tags/v1^{}": head,
    });
  });

  it("fails an --atomic push as a whole when one ref is refused", async () => {
    const work = await workspace("atomic");
    await ok(["push", "origin", "main"], work);
    const before = await remoteRefs("atomic");
    await commit(work, "a.txt", "a\n", "second");
    // Pull request refs are moved by the server only.
    const atomic = await git(
      ["push", "--atomic", "origin", "main", "HEAD:refs/heads/other", "HEAD:refs/pull/1/head"],
      work,
    );
    expect(atomic.code).not.toBe(0);
    expect(atomic.stderr).toMatch(/refs\/pull\/1\/head \(deny updating a hidden ref\)/);
    expect(atomic.stderr).toMatch(/atomic push failure/);
    expect(await remoteRefs("atomic")).toEqual(before);
  });

  it("accepts push options", async () => {
    const work = await workspace("options");
    const pushed = await git(["push", "-o", "ci.skip", "-o", "topic=e2e", "origin", "main"], work);
    expect(pushed.code, pushed.stderr).toBe(0);
    const head = (await ok(["rev-parse", "HEAD"], work)).trim();
    expect((await remoteRefs("options"))["refs/heads/main"]).toBe(head);
  });

  it("pushes a body larger than http.postBuffer (sent chunked)", async () => {
    const work = await workspace("chunked");
    // Incompressible content, so the pack is larger than git's 1 MiB post buffer.
    const random = randomBytes(3 * 1024 * 1024);
    await writeFile(join(work, "random.bin"), random);
    await ok(["add", "random.bin"], work);
    await ok(["commit", "-q", "-m", "random"], work);
    const pushed = await git(["push", "origin", "main"], work);
    expect(pushed.code, pushed.stderr).toBe(0);
    const head = (await ok(["rev-parse", "HEAD"], work)).trim();
    expect((await remoteRefs("chunked"))["refs/heads/main"]).toBe(head);
  });

  it("refuses a push over the body limit with a message git shows, and keeps the refs", async () => {
    const work = await workspace("too-large");
    await ok(["push", "origin", "main"], work);
    const before = await remoteRefs("too-large");
    const random = randomBytes(BODY_LIMIT + 1024 * 1024);
    await writeFile(join(work, "big.bin"), random);
    await ok(["add", "big.bin"], work);
    await ok(["commit", "-q", "-m", "too big"], work);
    const pushed = await git(["push", "origin", "main"], work);
    expect(pushed.code).not.toBe(0);
    expect(pushed.stderr).toMatch(/the push is larger than this server accepts in one request/);
    expect(await remoteRefs("too-large")).toEqual(before);
  });
});
