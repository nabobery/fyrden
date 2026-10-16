// Push load: N agents each push small commits to their own branch of one
// repository, all at once, with stock git. Reports pushes per second,
// latency percentiles and failures, so push throughput under agent
// workloads is a measured number (locally, or against a deployment):
//   node tools/ci/src/push-load.ts <git-base-url> <token> <owner>/<repo> [agents] [pushes]
// <git-base-url> is the Worker's origin (git URLs are <origin>/<owner>/<repo>.git).
// The repository must exist and have a `main` branch; the token must push to it.
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export interface PushLoadOptions {
  readonly origin: string;
  readonly token: string;
  /** `owner/name`. */
  readonly repo: string;
  readonly agents: number;
  readonly pushesPerAgent: number;
  /** The run's branches are `<prefix>/agent-<n>`; by default unique to the run. */
  readonly prefix?: string;
}

export interface PushLoadReport {
  readonly agents: number;
  readonly pushes: number;
  readonly failed: number;
  readonly seconds: number;
  readonly pushesPerSecond: number;
  readonly latencyMs: { readonly p50: number; readonly p95: number; readonly max: number };
  /** The first few failures' git output, to see why. */
  readonly errors: readonly string[];
}

interface Run {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function run(args: readonly string[], cwd: string, home: string): Promise<Run> {
  return new Promise((done, fail) => {
    const child = spawn("git", args, {
      cwd,
      env: {
        ...process.env,
        HOME: home,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
        GIT_TERMINAL_PROMPT: "0",
        GIT_AUTHOR_NAME: "Push Load",
        GIT_AUTHOR_EMAIL: "load@fyrden.invalid",
        GIT_COMMITTER_NAME: "Push Load",
        GIT_COMMITTER_EMAIL: "load@fyrden.invalid",
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d;
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d;
    });
    // A spawn failure's own error names the arguments (a URL with the token): never passed on.
    child.on("error", (error: NodeJS.ErrnoException) =>
      fail(new Error(`git ${args[0]} could not start: ${error.code ?? "error"}`)),
    );
    child.on("close", (code) => done({ code, stdout, stderr }));
    child.stdin.end();
  });
}

/** The `q` quantile of sorted `values` (nearest rank). */
function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] as number;
}

/** Runs the load and reports it; the token never appears in what it returns. */
export async function runPushLoad(options: PushLoadOptions): Promise<PushLoadReport> {
  const scratch = await mkdtemp(join(tmpdir(), "fyrden-push-load-"));
  const home = join(scratch, "home");
  const redact = (text: string) => text.split(options.token).join("<token>");
  try {
    const init = await run(["init", "-q", home], scratch, home);
    if (init.code !== 0) throw new Error(`git init failed: ${init.stderr.trim()}`);
    const url = new URL(`/${options.repo}.git`, options.origin);
    url.username = "x-access-token";
    url.password = options.token;
    const latencies: number[] = [];
    const errors: string[] = [];
    let failed = 0;
    const prefix =
      options.prefix ?? `load/${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
    /** Runs git and throws (the token redacted) unless it succeeds. */
    const must = async (args: readonly string[], cwd: string) => {
      const result = await run(args, cwd, home);
      if (result.code !== 0)
        throw new Error(`git ${args[0]} failed: ${redact(result.stderr).trim()}`);
    };
    // Each agent its own clone and branch, made before the clock starts. Every task is awaited
    // (failed or not) before the scratch directory goes.
    const prepared = await Promise.allSettled(
      Array.from({ length: options.agents }, async (_, i) => {
        const work = join(scratch, `agent-${i}`);
        await must(["clone", "-q", "--branch", "main", url.href, work], scratch);
        const branch = `${prefix}/agent-${i}`;
        await must(["checkout", "-q", "-b", branch], work);
        return { work, branch };
      }),
    );
    const refused = prepared.find((p) => p.status === "rejected");
    if (refused) throw (refused as PromiseRejectedResult).reason;
    const agents = prepared.map(
      (p) => (p as PromiseFulfilledResult<{ work: string; branch: string }>).value,
    );
    const started = performance.now();
    const ran = await Promise.allSettled(
      agents.map(async ({ work, branch }, i) => {
        for (let n = 0; n < options.pushesPerAgent; n++) {
          await writeFile(join(work, `agent-${i}.txt`), `push ${n}\n`);
          await must(["add", "-A"], work);
          await must(["commit", "-q", "-m", `agent ${i} push ${n}`], work);
          const at = performance.now();
          const pushed = await run(
            ["push", "-q", "origin", `HEAD:refs/heads/${branch}`],
            work,
            home,
          );
          latencies.push(performance.now() - at);
          if (pushed.code !== 0) {
            failed++;
            if (errors.length < 5) errors.push(redact(pushed.stderr).trim());
          }
        }
      }),
    );
    const broken = ran.find((r) => r.status === "rejected");
    if (broken) throw (broken as PromiseRejectedResult).reason;
    const seconds = (performance.now() - started) / 1000;
    const sorted = [...latencies].sort((a, b) => a - b);
    const pushes = latencies.length;
    return {
      agents: options.agents,
      pushes,
      failed,
      seconds: Math.round(seconds * 100) / 100,
      pushesPerSecond: Math.round(((pushes - failed) / seconds) * 100) / 100,
      latencyMs: {
        p50: Math.round(quantile(sorted, 0.5)),
        p95: Math.round(quantile(sorted, 0.95)),
        max: Math.round(sorted.at(-1) ?? 0),
      },
      errors,
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [origin, token, repo, agents = "8", pushes = "5"] = process.argv.slice(2);
  const count = (text: string) => (/^[1-9][0-9]{0,4}$/.test(text) ? Number(text) : Number.NaN);
  if (!origin || !token || !repo || Number.isNaN(count(agents)) || Number.isNaN(count(pushes))) {
    console.error("usage: push-load.ts <git-base-url> <token> <owner>/<repo> [agents] [pushes]");
    process.exit(2);
  }
  const report = await runPushLoad({
    origin,
    token,
    repo,
    agents: count(agents),
    pushesPerAgent: count(pushes),
  });
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.failed > 0 ? 1 : 0);
}
