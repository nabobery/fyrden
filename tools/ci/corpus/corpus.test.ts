// The workflow corpus's runner cases on the pinned gitea/runner (RUNNER_VERSION, 6.0.0 by
// default), in Docker, one runner container per task. Each case gets its own repository; its
// workflow is pushed (or dispatched, or opened as a pull request), one `daemon --once` runs per
// task it expects, and the outcome is read only through the REST API: the run's conclusion,
// title and errors, each job's conclusion and failed steps, and lines its log must and must
// never hold. No secret value may appear in any log.
//
// With FYRDEN_CORPUS_CAPACITY=1 it runs the frozen capacity workloads instead, one task each with
// the runner's cache off, and prints each one's run, job ids and start and end times in UTC.
//
// Against `wrangler dev` by default. With FYRDEN_CORPUS_ORIGIN, FYRDEN_CORPUS_TOKEN and
// FYRDEN_CORPUS_ORG it runs against a deployed forge instead, in an organization the token
// administers; the token is read from the environment only and never printed.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mentionsToken } from "@fyrden/domain";
import { FyrdenClient } from "@fyrden/sdk";
import {
  CAPACITY_WORKLOADS,
  CASES,
  type CorpusCase,
  capacitySource,
  IMAGE_PINS,
  PULL_REQUEST_HEAD,
  workflowSource,
} from "@fyrden/testing/ci-corpus";
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { eventually, type Forge, startForge } from "../e2e/forge.js";
import { freePorts } from "../e2e/wrangler-dev.js";
import { hostArch, runnerBinary, runnerVersion } from "../runner/binary.js";
import { sealedBox } from "./seal.js";

const VERSION = runnerVersion(process.env.RUNNER_VERSION);
const CAPACITY = process.env.FYRDEN_CORPUS_CAPACITY === "1";
const LINUX = process.platform === "linux";
const LABEL = `ubuntu-latest:docker://${IMAGE_PINS.job}`;
const nonce = randomBytes(4).toString("hex");
const CONTAINER = `fyrden-corpus-${nonce}`;
const HOST = "host.docker.internal";

interface Exit {
  code: number | null;
  output: string;
}

function exec(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: Record<string, string>; onLine?: (line: string) => void } = {},
) {
  return new Promise<Exit>((done, fail) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...(options.cwd && { cwd: options.cwd }),
      ...(options.env && { env: options.env }),
    });
    let output = "";
    let partial = "";
    const take = (chunk: Buffer) => {
      output += chunk;
      partial += chunk;
      const lines = partial.split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) options.onLine?.(line);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("error", fail);
    child.on("close", (code) => {
      if (partial) options.onLine?.(partial);
      done({ code, output });
    });
  });
}

const docker = (args: readonly string[]) => exec("docker", args);
const secretValues = new Set<string>();
const shown = (text: string) =>
  text
    .split("\n")
    .map((line) => (mentionsToken(line) ? "[a line naming a token, left out]" : line))
    .map((line) => [...secretValues].reduce((l, value) => l.replaceAll(value, "[secret]"), line))
    .join("\n");
const note = (text: string) => process.stderr.write(`[corpus ${VERSION}] ${text}\n`);

interface Target {
  /** Where the driver calls the API and pushes. */
  readonly origin: string;
  /** Where the runner and job containers reach the forge. */
  readonly instance: string;
  readonly handle: string;
  readonly token: string;
  readonly api: FyrdenClient;
  readonly org: string;
  stop(): Promise<void>;
}

async function localTarget(): Promise<Target> {
  // On Linux the containers reach the host through the bridge gateway, so the forge listens
  // there too; Docker Desktop forwards its host name to the host's loopback.
  const forge: Forge = await startForge("corpus", {
    vars: { FYRDEN_CI_RUNNERS: "on", FYRDEN_CI_MAX_JOB_MINUTES: "10" },
    ...(LINUX && { listen: "0.0.0.0" }),
  });
  const owner = await forge.user(`corpus${nonce}`);
  const org = `corpusorg${nonce}`;
  await forge.admin.api.call("admin.orgs.create", { login: org, admin: owner.handle });
  return {
    origin: forge.origin,
    instance: `http://${HOST}:${forge.port}`,
    handle: owner.handle,
    token: owner.token,
    api: owner.api,
    org,
    stop: () => forge.stop(),
  };
}

async function remoteTarget(origin: string): Promise<Target> {
  const token = process.env.FYRDEN_CORPUS_TOKEN;
  const org = process.env.FYRDEN_CORPUS_ORG;
  if (!token || !org)
    throw new Error("FYRDEN_CORPUS_ORIGIN needs FYRDEN_CORPUS_TOKEN and FYRDEN_CORPUS_ORG.");
  const api = new FyrdenClient({ baseUrl: `${origin}/api`, token });
  const me = await api.call("meta.whoami", {});
  const handle = me.handle ?? "corpus";
  return { origin, instance: origin, handle, token, api, org, stop: async () => {} };
}

let target: Target;
let binary = "";
let data = "";
let scratch = "";
let cachePort = 0;

function gitUrl(repo: string): string {
  const url = new URL(`${target.origin}/${target.org}/${repo}.git`);
  url.username = "x-access-token";
  url.password = target.token;
  return url.toString();
}

async function git(args: readonly string[], cwd: string): Promise<string> {
  const result = await exec("git", args, {
    cwd,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: scratch,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: join(scratch, ".gitconfig"),
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: target.handle,
      GIT_AUTHOR_EMAIL: `${target.handle}@fyrden.invalid`,
      GIT_COMMITTER_NAME: target.handle,
      GIT_COMMITTER_EMAIL: `${target.handle}@fyrden.invalid`,
    },
  });
  const redacted = result.output.replace(/\/\/[^/@\s]*@/g, "//***@");
  expect(result.code, `git ${args[0]}\n${redacted}`).toBe(0);
  return result.output.trim();
}

async function commit(work: string, files: Readonly<Record<string, string>>, message: string) {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(work, path)), { recursive: true });
    await writeFile(join(work, path), content);
  }
  await git(["add", "-A"], work);
  await git(["commit", "-q", "-m", message], work);
  return git(["rev-parse", "HEAD"], work);
}

function runnerArgs(name: string, extra: readonly string[], command: readonly string[]) {
  return [
    "run",
    "--rm",
    "--name",
    name,
    ...(LINUX ? ["--network", "host", `--add-host=${HOST}:host-gateway`] : []),
    "-v",
    `${binary}:/usr/local/bin/gitea-runner:ro`,
    "-v",
    `${data}:/data`,
    "-w",
    "/tmp",
    ...extra,
    IMAGE_PINS.job,
    "gitea-runner",
    ...command,
  ];
}

function runnerConfig(cache: "on" | "off"): string {
  return [
    "log:",
    "  level: info",
    "runner:",
    "  file: /data/.runner",
    "  capacity: 1",
    "  timeout: 10m",
    "  labels:",
    `    - "${LABEL}"`,
    "cache:",
    `  enabled: ${cache === "on"}`,
    "  dir: /data/cache",
    `  host: ${HOST}`,
    `  port: ${cachePort}`,
    "container:",
    '  network: ""',
    ...(LINUX ? [`  options: --add-host=${HOST}:host-gateway`] : []),
    "  force_pull: false",
    "",
  ].join("\n");
}

/** A workflow's name for this invocation: the runner names its containers, networks and volumes after it. */
const invocationName = (id: string) => `${id}-${nonce}`;
const named = (id: string, source: string) =>
  source.replace(/^name: .*$/m, `name: ${invocationName(id)}`);

const configFile = (cache: "on" | "off") => `/data/config-${cache}.yaml`;

async function register(): Promise<void> {
  const { token } = await target.api.call("orgs.runners.registration_tokens.create", {
    org: target.org,
  });
  const registered = await docker(
    runnerArgs(
      `${CONTAINER}-register`,
      [],
      [
        "-c",
        configFile("on"),
        "register",
        "--no-interactive",
        "--instance",
        target.instance,
        "--token",
        token,
        "--name",
        CONTAINER,
        "--labels",
        LABEL,
      ],
    ),
  );
  expect(registered.code, shown(registered.output)).toBe(0);
}

async function runTask(cache: "on" | "off", workflow: string, signal: AbortSignal): Promise<void> {
  // A test that timed out keeps running its body: it must not start a daemon after its cleanup.
  signal.throwIfAborted();
  // The runner's cache server listens on the runner's host; Docker Desktop reaches it through
  // the published port, Linux through the host network.
  const publish = LINUX || cache === "off" ? [] : ["-p", `${cachePort}:${cachePort}`];
  const daemon = exec(
    "docker",
    runnerArgs(
      CONTAINER,
      ["-v", "/var/run/docker.sock:/var/run/docker.sock", ...publish],
      ["-c", configFile(cache), "daemon", "--once"],
    ),
    { onLine: (line) => note(shown(line).slice(0, 2000)) },
  );
  // A daemon still polling when the test ends (its timeout, a failure) is stopped with it.
  onTestFinished(async () => {
    await docker(["rm", "-f", CONTAINER]);
    await daemon;
    await removeWorkflowResources(workflow);
  });
  const exit = await daemon;
  expect(exit.code, shown(exit.output).slice(-20_000)).toBe(0);
}

async function removeWorkflowResources(workflow: string): Promise<void> {
  const ids = (exit: Exit) => exit.output.split("\n").filter((id) => /^[0-9a-zA-Z_.-]+$/.test(id));
  const filter = `name=WORKFLOW-${workflow}-JOB-`;
  const [containers, networks, volumes] = await Promise.all([
    docker(["ps", "-aq", "--filter", filter]),
    docker(["network", "ls", "-q", "--filter", filter]),
    docker(["volume", "ls", "-q", "--filter", filter]),
  ]);
  if (ids(containers).length) await docker(["rm", "-f", ...ids(containers)]);
  if (ids(networks).length) await docker(["network", "rm", ...ids(networks)]);
  if (ids(volumes).length) await docker(["volume", "rm", "-f", ...ids(volumes)]);
}

/** The runner writes its cache as root, so the data directory is emptied from a container. */
async function emptyData(): Promise<void> {
  const emptied = await docker([
    "run",
    "--rm",
    "-v",
    `${data}:/data`,
    IMAGE_PINS.job,
    "sh",
    "-c",
    "rm -rf /data/* /data/.[!.]*",
  ]);
  expect(emptied.code, emptied.output).toBe(0);
}

async function pull(image: string) {
  if ((await docker(["image", "inspect", image])).code === 0) return;
  note(`pulling ${image}`);
  const pulled = await docker(["pull", image]);
  expect(pulled.code, pulled.output).toBe(0);
}

beforeAll(async () => {
  binary = await runnerBinary(VERSION, hostArch());
  for (const image of Object.values(IMAGE_PINS)) await pull(image);
  const origin = process.env.FYRDEN_CORPUS_ORIGIN;
  target = origin ? await remoteTarget(origin) : await localTarget();
  scratch = await mkdtemp(join(tmpdir(), "fyrden-corpus-"));
  data = await mkdtemp(join(tmpdir(), "fyrden-corpus-data-"));
  [cachePort] = (await freePorts(1)) as [number];
  await writeFile(join(data, "config-on.yaml"), runnerConfig("on"));
  await writeFile(join(data, "config-off.yaml"), runnerConfig("off"));
  await register();
  note(`registered with ${target.instance}`);
}, 600_000);

afterAll(async () => {
  const steps: (() => Promise<unknown>)[] = [
    () => docker(["rm", "-f", CONTAINER, `${CONTAINER}-register`]),
    async () => {
      if (data) await emptyData();
    },
    async () => {
      if (data) await rm(data, { recursive: true, force: true });
    },
    async () => {
      if (scratch) await rm(scratch, { recursive: true, force: true });
    },
    async () => target?.stop(),
  ];
  const failures: unknown[] = [];
  for (const step of steps) await step().catch((error: unknown) => failures.push(error));
  if (failures.length) throw new AggregateError(failures, "the corpus fixture was not cleaned up");
}, 120_000);

async function setUp(c: CorpusCase, repo: string): Promise<void> {
  for (const [name, value] of Object.entries(c.setup?.vars ?? {}))
    await target.api.call("repos.actions.variables.create", {
      owner: target.org,
      repo,
      name,
      value,
    });
  if (c.setup?.secrets?.length) {
    const key = await target.api.call("repos.actions.secrets.public_key", {
      owner: target.org,
      repo,
    });
    for (const name of c.setup.secrets) {
      const value = `corpus-${randomBytes(12).toString("hex")}`;
      secretValues.add(value);
      const sealed = sealedBox(Buffer.from(key.key, "base64"), value);
      await target.api.call("repos.actions.secrets.set", {
        owner: target.org,
        repo,
        secret_name: name,
        encrypted_value: Buffer.from(sealed).toString("base64"),
        key_id: key.key_id,
      });
    }
  }
}

async function newWork(repo: string): Promise<string> {
  await target.api.call("orgs.repos.create", { org: target.org, name: repo });
  const work = join(scratch, repo);
  await git(["init", "-q", "-b", "main", work], scratch);
  await git(["remote", "add", "origin", gitUrl(repo)], work);
  return work;
}

async function start(c: CorpusCase, repo: string, work: string): Promise<string> {
  const workflow = {
    [`.github/workflows/${c.id}.yml`]: named(c.id, workflowSource(c.id)),
    ...c.setup?.files,
  };
  if (c.trigger === "pull_request") {
    await commit(work, { "README.md": "corpus\n" }, "first");
    await git(["push", "-q", "origin", "main"], work);
    await git(["checkout", "-q", "-b", PULL_REQUEST_HEAD], work);
    const sha = await commit(work, workflow, c.id);
    await git(["push", "-q", "origin", PULL_REQUEST_HEAD], work);
    await target.api.call("pulls.create", {
      owner: target.org,
      repo,
      title: c.id,
      head: PULL_REQUEST_HEAD,
      base: "main",
    });
    return runOf(repo, "pull_request", sha);
  }
  const sha = await commit(work, workflow, c.id);
  await git(["push", "-q", "origin", "main"], work);
  if (c.trigger === "workflow_dispatch") {
    const dispatched = await target.api.call("actions.workflows.dispatch", {
      owner: target.org,
      repo,
      workflow_id: `${c.id}.yml`,
      ref: "main",
      inputs: { ...c.setup?.inputs },
    });
    return dispatched.workflow_run_id;
  }
  return runOf(repo, "push", sha);
}

async function runOf(repo: string, event: string, sha: string): Promise<string> {
  const runs = await eventually(`a ${event} run of ${repo} at ${sha}`, async () => {
    const { workflow_runs } = await target.api.call("actions.runs.list", {
      owner: target.org,
      repo,
    });
    const found = workflow_runs.filter((r) => r.event === event && r.head_sha === sha);
    return found.length > 0 ? found : undefined;
  });
  expect(runs).toHaveLength(1);
  return (runs[0] as { id: string }).id;
}

async function nextTask(id: string, scope: { owner: string; repo: string; run_id: string }) {
  await eventually(`a queued job of ${id}`, async () => {
    const { jobs } = await target.api.call("actions.runs.jobs.list", scope);
    return jobs.some((j) => j.status === "queued") ? jobs : undefined;
  });
}

async function completed(id: string, scope: { owner: string; repo: string; run_id: string }) {
  return eventually(`${id} completed`, async () => {
    const r = await target.api.call("actions.runs.get", scope);
    return r.status === "completed" ? r : undefined;
  });
}

async function logText(repo: string, runId: string, jobId: number): Promise<string[]> {
  const rows: string[] = [];
  let cursor: string | null | undefined;
  do {
    const page = await target.api.call("actions.runs.jobs.logs.read", {
      owner: target.org,
      repo,
      run_id: runId,
      job_id: jobId,
      ...(cursor && { cursor }),
    });
    for (const row of page.rows) if ("c" in row) rows.push(row.c);
    cursor = page.next_cursor;
  } while (cursor);
  return rows;
}

const runnerCases = CASES.filter((c) => c.tiers.includes("runner"));

describe.skipIf(CAPACITY).each(runnerCases.map((c) => [c.id, c] as const))(
  `runner ${VERSION}: %s`,
  (id, c) => {
    it("runs to its expected outcome", async ({ signal }) => {
      const expected = c.expect.run;
      const runner = c.runner;
      if (!expected || !runner) throw new Error(`${id} has no runner expectations`);
      const repo = `${id}-${nonce}`;
      const work = await newWork(repo);
      await setUp(c, repo);
      const runId = await start(c, repo, work);
      const scope = { owner: target.org, repo, run_id: runId };

      for (let task = 0; task < runner.tasks; task++) {
        await nextTask(id, scope);
        await runTask(runner.cache, invocationName(id), signal);
      }
      const run = await completed(id, scope);
      expect(run.conclusion).toBe(expected.conclusion);
      if (expected.displayTitle !== undefined)
        expect(run.display_title).toBe(expected.displayTitle);
      expect(run.errors.map((e) => ({ code: e.code, feature: e.feature }))).toEqual(
        expected.errors ?? [],
      );

      const { jobs } = await target.api.call("actions.runs.jobs.list", scope);
      expect(jobs.map((j) => j.name).sort()).toEqual(Object.keys(expected.jobs).sort());
      expect(Object.fromEntries(jobs.map((j) => [j.name, j.conclusion]))).toEqual(
        Object.fromEntries(Object.entries(expected.jobs).map(([name, j]) => [name, j.conclusion])),
      );
      for (const job of jobs) {
        const want = expected.jobs[job.name];
        if (!want) continue;
        const failed = job.steps
          .filter((s) => s.stage === "main" && s.conclusion === "failure")
          .map((s) => s.name);
        expect(failed, `${job.name}: failed steps`).toEqual(want.failedSteps ?? []);
        if (job.conclusion === "skipped") continue;
        const lines = await logText(repo, runId, job.id);
        const tail = shown(lines.slice(-80).join("\n"));
        for (const text of want.log?.has ?? [])
          expect(
            lines.some((l) => l.includes(text)),
            `${job.name}: "${text}" not in its log, which ends:\n${tail}`,
          ).toBe(true);
        for (const text of [...(want.log?.never ?? []), ...secretValues])
          expect(
            lines.some((l) => l.includes(text)),
            `${job.name}: a forbidden text in its log`,
          ).toBe(false);
      }
    });
  },
);

describe.runIf(CAPACITY)(`capacity workloads on runner ${VERSION}`, () => {
  it.for(CAPACITY_WORKLOADS)("%s", async (id, { signal }) => {
    const repo = `${id}-${nonce}`;
    const work = await newWork(repo);
    const sha = await commit(
      work,
      { [`.github/workflows/${id}.yml`]: named(id, capacitySource(id)) },
      id,
    );
    await git(["push", "-q", "origin", "main"], work);
    const scope = { owner: target.org, repo, run_id: await runOf(repo, "push", sha) };
    await nextTask(id, scope);
    const started = new Date().toISOString();
    await runTask("off", invocationName(id), signal);
    const run = await completed(id, scope);
    const ended = new Date().toISOString();
    const { jobs } = await target.api.call("actions.runs.jobs.list", scope);
    note(
      `workload ${JSON.stringify({ id, run: scope.run_id, jobs: jobs.map((j) => j.id), started, ended })}`,
    );
    expect(run.conclusion).toBe("success");
  });
});
