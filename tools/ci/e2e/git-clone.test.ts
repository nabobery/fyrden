// Real git cloning and fetching from fyrden-api under `wrangler dev`, once
// per plan mode (Free: pre-framed copies piped natively; Paid: framed while
// streaming). Content gets there by `git push`; setup checks that a push
// works and fails the suite if it does not, never skipping a case. Every
// clone and fetch is checked with `git fsck --full` and compared with the
// same operation against the source over file:// (git's own upload-pack,
// protocol v2). Storage is a fresh temporary directory per mode.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(
  command: string,
  args: string[],
  options: { cwd: string; env?: Record<string, string> },
): Promise<Run> {
  return new Promise((done, fail) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
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

describe.each(["free", "paid"] as const)("stock git clones and fetches (plan %s)", (plan) => {
  // Taken when the server starts (`beforeAll`).
  let port = 0;
  let origin = "";
  const bootstrapSecret = `e2e-${crypto.randomUUID()}`;
  let scratch = "";
  let server: WranglerDev | undefined;
  let output = "";
  let token = "";
  let handle = "";
  let clock = 1_767_225_600;

  /** git with no user or system config, never prompting; commits a day apart. */
  const git = (args: string[], cwd = scratch, extraEnv: Record<string, string> = {}) => {
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
        ...extraEnv,
      },
    });
  };
  const ok = async (args: string[], cwd = scratch) => {
    const result = await git(args, cwd);
    expect(result.code, `git ${args.join(" ")}\n${result.stderr}`).toBe(0);
    return result.stdout;
  };

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

  /** Writes files (null deletes) and commits, one day after the previous commit. */
  async function commit(cwd: string, files: Record<string, string | null>, message: string) {
    clock += 86_400;
    for (const [path, content] of Object.entries(files)) {
      const full = join(cwd, path);
      if (content === null) await rm(full, { force: true });
      else {
        await run("mkdir", ["-p", dirname(full)], { cwd });
        await writeFile(full, content);
      }
    }
    await ok(["add", "-A"], cwd);
    await ok(["commit", "-q", "-m", message], cwd);
    return (await ok(["rev-parse", "HEAD"], cwd)).trim();
  }

  const objects = async (cwd: string) =>
    (await ok(["rev-list", "--objects", "--all"], cwd))
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => l.slice(0, 40))
      .sort();
  const refs = async (cwd: string) =>
    (
      await ok(
        ["for-each-ref", "--format=%(objectname) %(refname)", "refs/heads", "refs/tags"],
        cwd,
      )
    )
      .trim()
      .split("\n")
      .sort();
  const shallow = async (cwd: string) =>
    (await readFile(join(cwd, ".git/shallow"), "utf8").catch(() => ""))
      .split("\n")
      .filter((l) => l.length > 0)
      .sort();
  const fsck = async (cwd: string) => {
    const result = await git(["fsck", "--full", "--strict", "--no-dangling"], cwd);
    expect(result.code, result.stdout + result.stderr).toBe(0);
  };

  /** The same command against the source over file:// with protocol v2: what git itself sends. */
  const oracle = (args: (url: string) => string[], source: string) =>
    ok(["-c", "protocol.version=2", ...args(`file://${source}`)]);

  /** A source repository: main with history spread over days, a branch, tags. Pushed to `name`. */
  async function pushedSource(name: string): Promise<string> {
    const source = join(scratch, `${name}-src`);
    await ok(["init", "-q", "-b", "main", source]);
    await commit(source, { "README.md": "hello\n", "src/a.txt": "a1\n" }, "one");
    await commit(source, { "src/a.txt": "a2\n", "src/b.txt": "b1\n" }, "two");
    await ok(["tag", "-a", "v1", "-m", "release one"], source);
    await ok(["checkout", "-q", "-b", "feature"], source);
    await commit(source, { "docs/guide.md": "guide\n" }, "feature");
    await ok(["checkout", "-q", "main"], source);
    await commit(source, { "src/b.txt": "b2\n", "src/deep/c.txt": "c\n" }, "three");
    await commit(source, { "src/a.txt": null, "big.txt": "x".repeat(200_000) }, "four");
    await createRepo(name);
    await ok(
      ["push", "-q", repoUrl(name), "refs/heads/*:refs/heads/*", "refs/tags/*:refs/tags/*"],
      source,
    );
    return source;
  }

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), `fyrden-e2e-clone-${plan}-`));
    await run("mkdir", ["-p", join(scratch, "home")], { cwd: scratch });
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
        "--var",
        `FYRDEN_PLAN:${plan}`,
      ],
      cwd: join(root, "apps/api"),
      onOutput: (text) => {
        output += text;
      },
    });
    port = server.port;
    origin = `http://127.0.0.1:${port}`;

    handle = `e2e${plan}${Date.now().toString(36)}`;
    const boot = await fetch(`${origin}/v0/admin/bootstrap`, {
      method: "POST",
      headers: { "X-Fyrden-Bootstrap-Secret": bootstrapSecret, "Content-Type": "application/json" },
      body: JSON.stringify({ handle }),
    });
    expect(boot.status, await boot.clone().text()).toBe(201);
    token = ((await boot.json()) as { token: string }).token;

    // Every case below needs a working push: a failed one fails the suite here.
    const probe = join(scratch, "probe");
    await ok(["init", "-q", "-b", "main", probe]);
    await commit(probe, { "probe.txt": "probe\n" }, "probe");
    await createRepo("probe");
    const pushed = await git(["push", "-q", repoUrl("probe"), "main"], probe);
    expect(pushed.code, `the setup push failed:\n${pushed.stderr}`).toBe(0);
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

  it("refuses protocol v0 for clone with a message naming protocol v2", async () => {
    await createRepo("v0");
    const res = await git(["-c", "protocol.version=0", "clone", repoUrl("v0"), "v0"]);
    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/protocol version 2 only/);
  });

  it("push, then clone: same refs and objects, and fsck passes", async () => {
    const source = await pushedSource("round-trip");
    await ok(["clone", "-q", repoUrl("round-trip"), "round-trip"]);
    const clone = join(scratch, "round-trip");
    await fsck(clone);
    expect(await objects(clone)).toEqual(await objects(source));
    await oracle((url) => ["clone", "-q", url, "round-trip-oracle"], source);
    expect(await refs(clone)).toEqual(await refs(join(scratch, "round-trip-oracle")));
  });

  it("fetches new commits and follows a new annotated tag", async () => {
    const source = await pushedSource("fetch-new");
    await ok(["clone", "-q", repoUrl("fetch-new"), "fetch-new"]);
    const clone = join(scratch, "fetch-new");
    await commit(source, { "src/b.txt": "b3\n", "big.txt": `${"x".repeat(199_000)}y\n` }, "five");
    await ok(["tag", "-a", "v2", "-m", "release two"], source);
    await ok(["push", "-q", repoUrl("fetch-new"), "main", "v2"], source);
    await ok(["fetch", "-q", "origin"], clone);
    await fsck(clone);
    expect(await objects(clone)).toEqual(await objects(source));
    expect((await ok(["rev-parse", "refs/tags/v2"], clone)).trim()).toBe(
      (await ok(["rev-parse", "refs/tags/v2"], source)).trim(),
    );
  });

  it.for([
    ["--depth 1", async () => ["--depth", "1"]],
    // main~2's date: the cut falls inside main's history.
    [
      "--shallow-since",
      async (source: string) => [
        "--shallow-since",
        (await ok(["log", "-1", "--format=%cI", "main~2"], source)).trim(),
      ],
    ],
  ] as [string, (source: string) => Promise<string[]>][])(
    "shallow clone %s matches git's own server",
    async ([label, flagsFor]) => {
      const name = `shallow-${label.replace(/[^a-z0-9]/g, "")}`;
      const source = await pushedSource(name);
      const flags = await flagsFor(source);
      await ok(["clone", "-q", ...flags, "--no-single-branch", repoUrl(name), name]);
      await oracle(
        (url) => ["clone", "-q", ...flags, "--no-single-branch", url, `${name}-oracle`],
        source,
      );
      const clone = join(scratch, name);
      await fsck(clone);
      expect(await shallow(clone)).not.toEqual([]);
      expect(await shallow(clone)).toEqual(await shallow(join(scratch, `${name}-oracle`)));
      expect(await objects(clone)).toEqual(await objects(join(scratch, `${name}-oracle`)));
    },
  );

  it("deepens and then unshallows a depth-1 clone", async () => {
    const source = await pushedSource("deepen");
    await ok(["clone", "-q", "--depth", "1", repoUrl("deepen"), "deepen"]);
    await oracle((url) => ["clone", "-q", "--depth", "1", url, "deepen-oracle"], source);
    const clone = join(scratch, "deepen");
    const expected = join(scratch, "deepen-oracle");

    await ok(["fetch", "-q", "--deepen", "1"], clone);
    await ok(["fetch", "-q", "--deepen", "1"], expected);
    await fsck(clone);
    expect(await shallow(clone)).toEqual(await shallow(expected));
    expect(await objects(clone)).toEqual(await objects(expected));

    await ok(["fetch", "-q", "--unshallow"], clone);
    await ok(["fetch", "-q", "--unshallow"], expected);
    await fsck(clone);
    expect(await shallow(clone)).toEqual([]);
    expect(await objects(clone)).toEqual(await objects(expected));
    expect(await ok(["rev-list", "main"], clone)).toBe(await ok(["rev-list", "main"], source));
  });
});
