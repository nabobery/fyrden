// The pinned gitea/runner (RUNNER_VERSION, 6.0.0 by default) against
// fyrden-api under `wrangler dev`, in Docker, one runner container at a time:
// it registers with a token minted through the REST operation, takes a job
// of a run started through the run seam (a test Worker in front of the API),
// runs it in a job container, streams its log and reports the result. The
// run's job must succeed with its output, and its log must be stored whole:
// R2 chunks, named by the run object's manifest from row 0, holding every row
// the runner sent (the seam, its instance URL, records each UpdateLog on the
// way to the API) once and in order, and the final ack covering the final call.
// A second job prints one line larger than the API's 4 MiB request prefix and
// then more: the runner sends that line as one row, the API records it as
// omitted, the runner receives the ack past it (its next call starts there),
// the lines after it are stored, and the log ends incomplete while the job
// still succeeds.
//
// Needs Docker (the daemon's socket is handed to the runner, which starts the
// job container) and the job image; the binary is downloaded once, checked
// against its pinned SHA-256, into `$FYRDEN_RUNNER_CACHE` or
// `~/.cache/fyrden-runner`.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { mentionsToken } from "@fyrden/domain";
import { isFinalSentinel } from "@fyrden/domain/ci";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type DecodedUpdateLog,
  decodeUpdateLogRequest,
  Result,
} from "../../../apps/api/src/runner/proto/messages.js";
import { decodeUpdateLogResponse } from "../../../apps/api/test/helpers/runner-proto.js";
import { type Account, eventually, type Forge, Git, startForge } from "../e2e/forge.js";
import { hostArch, runnerBinary, runnerVersion } from "./binary.js";
import { storedLogShape } from "./log-accounting.js";
import { watchLog } from "./log-viewer.js";

const VERSION = runnerVersion(process.env.RUNNER_VERSION);
const ARCH = hostArch();
/**
 * The job image the runner's label names; the runner itself runs in it too
 * (it needs nothing else). Pinned to the multi-platform index (linux/amd64 and
 * linux/arm64) `node:24-slim` named on Docker Hub, read with
 * `docker buildx imagetools inspect node:24-slim` on 2026-11-15 (image created
 * 2026-11-11, docker-node 1274f3ee, bookworm-slim). The runner takes the
 * digest in a label (measured with both pinned releases).
 */
const IMAGE =
  "node:24-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54";
const LABEL = `ubuntu-latest:docker://${IMAGE}`;
const seam = join(import.meta.dirname, "../e2e/fixtures/run-seam/wrangler.jsonc");

/** Names this run's containers, and (in the workflow's name) the job containers the runner starts. */
const nonce = randomBytes(4).toString("hex");
const CONTAINER = `fyrden-runner-${nonce}`;
const WORKFLOW_NAME = `runner-${nonce}`;
const BURST = 120;
const TRICKLE = 5;
const WORKFLOW = [
  `name: ${WORKFLOW_NAME}`,
  "on: push",
  "jobs:",
  "  build:",
  "    runs-on: ubuntu-latest",
  "    outputs:",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a workflow expression, as plain text
  "      answer: ${{ steps.answer.outputs.value }}",
  "    steps:",
  // Past the runner's 100-row batch at once, then rows that arrive one by one.
  "      - name: burst",
  `        run: for i in $(seq 1 ${BURST}); do echo "burst $i"; done`,
  "      - name: trickle",
  `        run: for i in $(seq 1 ${TRICKLE}); do echo "trickle $i"; sleep 1; done`,
  "      - id: answer",
  '        run: echo "value=42" >> "$GITHUB_OUTPUT"',
].join("\n");
const PRINTED = [
  ...Array.from({ length: BURST }, (_, i) => `burst ${i + 1}`),
  ...Array.from({ length: TRICKLE }, (_, i) => `trickle ${i + 1}`),
];
/** One line of 5 MiB: past the API's 4 MiB request prefix even alone, so never readable. */
const HUGE = 5 * 1024 * 1024;
const BIG_NAME = `${WORKFLOW_NAME}-big`;
const BIG_WORKFLOW = [
  `name: ${BIG_NAME}`,
  "on: push",
  "jobs:",
  "  big:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - name: huge",
  `        run: node -e "process.stdout.write('h'.repeat(${HUGE}) + '\\n')"; echo '${"p".repeat(256)}'; echo "after ${nonce}"`,
  "      - name: tail",
  `        run: echo "tail ${nonce}"`,
].join("\n");

interface Exit {
  code: number | null;
  output: string;
}

/** A command's exit and its output, both streams; `onLine` sees each line as it comes. */
function exec(command: string, args: readonly string[], onLine?: (line: string) => void) {
  return new Promise<Exit>((done, fail) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let partial = "";
    const take = (chunk: Buffer) => {
      output += chunk;
      partial += chunk;
      const lines = partial.split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) onLine?.(line);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("error", fail);
    child.on("close", (code) => {
      if (partial) onLine?.(partial);
      done({ code, output });
    });
  });
}

const docker = (args: readonly string[]) => exec("docker", args);

/**
 * For the job's output: lines naming a token are left out, and so are the masking job's split
 * lines, each holding half the job token, which the runner prints unmasked in its own output.
 */
const shown = (text: string) =>
  text
    .split("\n")
    .map((line) =>
      mentionsToken(line) || line.includes("mask-split")
        ? "[a line naming a token, left out]"
        : line,
    )
    .join("\n");

const note = (text: string) => process.stderr.write(`[runner ${VERSION}] ${text}\n`);

let forge: Forge;
let owner: Account;
let org = "";
let repoId = "";
let sha = "";
let binary = "";
let data = "";

/** Removes this run's runner containers and whatever the runner left of its job container. */
async function cleanUp(): Promise<void> {
  for (const name of [CONTAINER, `${CONTAINER}-register`])
    await docker(["rm", "-f", name]).catch(() => undefined);
  const [containers, networks, volumes] = await Promise.all([
    docker(["ps", "-aq", "--filter", `name=WORKFLOW-${WORKFLOW_NAME}`]),
    docker(["network", "ls", "-q", "--filter", `name=WORKFLOW-${WORKFLOW_NAME}`]),
    docker(["volume", "ls", "-q", "--filter", `name=WORKFLOW-${WORKFLOW_NAME}`]),
  ]);
  const ids = (exit: Exit) => exit.output.split("\n").filter((id) => /^[0-9a-zA-Z_.-]+$/.test(id));
  const left = { containers: ids(containers), networks: ids(networks), volumes: ids(volumes) };
  if (left.containers.length) await docker(["rm", "-f", ...left.containers]);
  if (left.networks.length) await docker(["network", "rm", ...left.networks]);
  if (left.volumes.length) await docker(["volume", "rm", "-f", ...left.volumes]);
  note(
    `cleanup: removed ${left.containers.length} job containers, ${left.networks.length} networks, ${left.volumes.length} volumes the runner left`,
  );
}

/**
 * `docker run` of the runner binary with its config, on the host's network
 * on Linux (the server listens on 127.0.0.1) and through Docker Desktop's
 * host name elsewhere.
 */
function runnerArgs(name: string, extra: readonly string[], command: readonly string[]) {
  return [
    "run",
    "--rm",
    "--name",
    name,
    ...(process.platform === "linux" ? ["--network", "host"] : []),
    "-v",
    `${binary}:/usr/local/bin/gitea-runner:ro`,
    "-v",
    `${data}:/data`,
    // Its working files stay in the container; the mount holds only the config and credential.
    "-w",
    "/tmp",
    ...extra,
    IMAGE,
    "gitea-runner",
    "-c",
    "/data/config.yaml",
    ...command,
  ];
}

const instanceUrl = () =>
  `http://${process.platform === "linux" ? "127.0.0.1" : "host.docker.internal"}:${forge.port}`;

const MASK_NAME = `${WORKFLOW_NAME}-mask`;
const MASK_GATE = `mask-${nonce}`;
const BACKFILL = `viewer-backfill ${nonce}`;
const LIVE = `viewer-live ${nonce}`;
const runtimeMask = Buffer.from(`runtime-${nonce}`).toString("hex");

function maskingWorkflow(gateUrl: string): string {
  return [
    `name: ${MASK_NAME}`,
    "on: push",
    "jobs:",
    "  mask:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - name: wait for the log viewer",
    "        run: |",
    "          node --input-type=module <<'NODE'",
    `          console.log(${JSON.stringify(BACKFILL)});`,
    '          for (let i = 0; i < 120; i++) console.log("before-viewer " + i);',
    `          const response = await fetch(${JSON.stringify(gateUrl)}, { signal: AbortSignal.timeout(120000) });`,
    '          if (!response.ok) throw new Error("The local gate refused the job.");',
    "          NODE",
    "      - name: print masked values",
    "        env:",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a workflow expression, as plain text
    "          JOB_TOKEN: ${{ github.token }}",
    "        run: |",
    "          node <<'NODE'",
    "          const token = process.env.JOB_TOKEN;",
    '          if (!token) throw new Error("The job token was not provided.");',
    '          console.log("mask-plain:" + token);',
    '          console.log("mask-base64:" + Buffer.from(token).toString("base64"));',
    "          const half = Math.floor(token.length / 2);",
    '          console.log("mask-split:" + token.slice(0, half));',
    '          console.log(token.slice(half) + ":mask-split-end");',
    `          const runtime = Buffer.from(${JSON.stringify(`runtime-${nonce}`)}).toString("hex");`,
    '          console.log("::add-mask::" + runtime);',
    '          console.log("mask-runtime:" + runtime);',
    `          console.log(${JSON.stringify(LIVE)});`,
    '          for (let i = 0; i < 120; i++) console.log("after-viewer " + i);',
    "          NODE",
  ].join("\n");
}

async function createLogGate() {
  let arrive!: () => void;
  const ready = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  let waiting: ServerResponse | undefined;
  let released = false;
  const release = () => {
    released = true;
    waiting?.end("released");
  };
  const server = createServer((request, response) => {
    if (request.method !== "GET" || request.url !== `/${MASK_GATE}`) {
      response.writeHead(404).end();
      return;
    }
    waiting = response;
    arrive();
    if (released) response.end("released");
  });
  server.maxConnections = 4;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("The local log gate has no port.");
  return {
    async ready(signal: AbortSignal) {
      signal.throwIfAborted();
      let abort: () => void = () => undefined;
      try {
        await Promise.race([
          ready,
          new Promise<never>((_resolve, reject) => {
            abort = () => reject(signal.reason);
            signal.addEventListener("abort", abort, { once: true });
          }),
        ]);
        signal.throwIfAborted();
      } finally {
        signal.removeEventListener("abort", abort);
      }
    },
    release,
    url: `http://${process.platform === "linux" ? "127.0.0.1" : "host.docker.internal"}:${address.port}/${MASK_GATE}`,
    async close() {
      release();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}

beforeAll(async () => {
  binary = await runnerBinary(VERSION, ARCH);
  note(`binary ${binary} (SHA-256 checked)`);
  note("checking job image");
  if ((await docker(["image", "inspect", IMAGE])).code !== 0) {
    note("pulling job image");
    const pulled = await docker(["pull", IMAGE]);
    expect(pulled.code, pulled.output).toBe(0);
  }
  note("starting local forge");
  forge = await startForge("runner", { primary: seam, vars: { FYRDEN_CI_RUNNERS: "on" } });
  note("creating fixture repository");
  owner = await forge.user(`own${nonce}`);
  org = `org${nonce}`;
  await forge.admin.api.call("admin.orgs.create", { login: org, admin: owner.handle });
  const repo = await owner.api.call("orgs.repos.create", { org, name: "app" });
  repoId = repo.id;
  const git = new Git(forge, owner);
  const work = join(forge.scratch, "app");
  await git.ok(["init", "-q", "-b", "main", work]);
  await git.ok(["remote", "add", "origin", git.url(org, "app")], work);
  sha = await git.commit(work, { ".github/workflows/ci.yml": `${WORKFLOW}\n` }, "add the workflow");
  await git.ok(["push", "-q", "origin", "main"], work);
  data = await mkdtemp(join(tmpdir(), "fyrden-runner-data-"));
  await writeFile(
    join(data, "config.yaml"),
    [
      "log:",
      "  level: debug",
      "runner:",
      "  file: /data/.runner",
      "  capacity: 1",
      "  timeout: 10m",
      "  labels:",
      `    - "${LABEL}"`,
      "cache:",
      "  enabled: false",
      "container:",
      ...(process.platform === "linux" ? ["  network: host"] : []),
      "  force_pull: false",
      "",
    ].join("\n"),
  );
  note("fixture ready");
}, 300_000);

afterAll(async () => {
  note("cleaning up runner resources");
  await cleanUp();
  if (data) await rm(data, { recursive: true, force: true });
  note("stopping local forge");
  await forge?.stop();
  note("cleanup complete");
}, 120_000);

interface RecordedUpdateLog {
  readonly status: number;
  readonly request: DecodedUpdateLog;
  readonly ack: number;
  /** The API stopped reading the body before its end. */
  readonly cancelled: boolean;
  readonly sealed: boolean;
}

/**
 * The UpdateLog calls the seam recorded for wire task `wireId`, in arrival
 * order, decoded with the API's own codec (a body longer than the 4 MiB the
 * seam records as the prefix it is).
 */
async function recordedUpdateLogs(wireId: number): Promise<RecordedUpdateLog[]> {
  const res = await fetch(`${forge.origin}/__runs/recorded`);
  expect(res.status).toBe(200);
  const entries = (await res.json()) as {
    request: string;
    whole: boolean;
    cancelled: boolean;
    status: number | null;
    response: string | null;
    error: string | null;
    sealed?: boolean;
  }[];
  return entries
    .map((entry) => {
      expect(entry.error, "an UpdateLog the seam could not forward").toBeNull();
      expect(entry.status, "an UpdateLog still unanswered").not.toBeNull();
      const ok = entry.status === 200;
      return {
        status: entry.status as number,
        request: decodeUpdateLogRequest(Buffer.from(entry.request, "base64"), {
          truncated: !entry.whole,
        }),
        ack: ok
          ? decodeUpdateLogResponse(Buffer.from(entry.response ?? "", "base64")).ackIndex
          : -1,
        cancelled: entry.cancelled,
        sealed: entry.sealed ?? false,
      };
    })
    .filter((call) => call.request.taskId === wireId);
}

/** The run object's SQLite database in the local persistence, found by its run id. */
async function runDatabase(runId: string): Promise<DatabaseSync> {
  const dir = join(forge.scratch, "state", "v3", "do", "fyrden-api-RunDO");
  for (const file of (await readdir(dir)).filter((f) => f.endsWith(".sqlite"))) {
    const db = new DatabaseSync(join(dir, file), { readOnly: true });
    const row = db.prepare("SELECT run_id FROM runs").get() as { run_id: string } | undefined;
    if (row?.run_id === runId) return db;
    db.close();
  }
  throw new Error(`no run object database for ${runId} in ${dir}`);
}

let registration: Promise<void> | undefined;

/** Registers the runner, once: its credential stays in the data directory for every later job. */
function register(): Promise<void> {
  registration ??= (async () => {
    note("registering runner");
    const { token } = await owner.api.call("orgs.runners.registration_tokens.create", { org });
    const registered = await docker(
      runnerArgs(
        `${CONTAINER}-register`,
        [],
        [
          "register",
          "--no-interactive",
          "--instance",
          instanceUrl(),
          "--token",
          token,
          "--name",
          CONTAINER,
          "--labels",
          LABEL,
        ],
      ),
    );
    note(`register: exit ${registered.code}\n${shown(registered.output)}`);
    expect(registered.code, shown(registered.output)).toBe(0);
    const runners = await owner.api.call("orgs.runners.list", { org });
    expect(runners.runners).toMatchObject([{ name: CONTAINER, version: `v${VERSION}` }]);
  })();
  return registration;
}

/** Starts a run of `source` (workflow `name`) and lets the registered runner take its one job. */
async function runWorkflow(
  name: string,
  source: string,
  afterStart?: (runId: string, signal: AbortSignal) => Promise<void>,
) {
  await register();
  // --once: it polls until it gets a task, runs it, and exits.
  const daemon = exec(
    "docker",
    runnerArgs(
      CONTAINER,
      ["-v", "/var/run/docker.sock:/var/run/docker.sock"],
      ["daemon", "--once"],
    ),
    (line) => note(shown(line).slice(0, 2000)),
  );
  note(`starting workflow ${name}`);
  const started = await (
    await fetch(`${forge.origin}/__runs/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repoId,
        sha,
        ref: "refs/heads/main",
        event: "push",
        actor: owner.id,
        workflow: { path: ".github/workflows/ci.yml", source },
        // What a push trigger will give: the runner names its workspace after the repository.
        github: {
          server_url: forge.origin,
          repository: `${org}/app`,
          repository_owner: org,
          actor: owner.handle,
          workflow: name,
          sha,
          ref: "refs/heads/main",
          ref_name: "main",
          ref_type: "branch",
          event_name: "push",
          event: {},
        },
      }),
    })
  ).json();
  expect(started).toMatchObject({ answer: { ok: true } });
  const runId = (started as { runId: string }).runId;
  if (afterStart) {
    const controller = new AbortController();
    const step = afterStart(runId, controller.signal);
    let complete = false;
    try {
      await Promise.race([
        step,
        daemon.then((exit) => {
          throw new Error(`The runner exited (${exit.code}) before the test's step finished.`);
        }),
      ]);
      complete = true;
    } finally {
      if (!complete) controller.abort();
      await step.catch(() => undefined);
    }
  }

  note(`run ${runId}: waiting for runner exit`);
  const exit = await daemon;
  note(`daemon: exit ${exit.code}`);
  expect(exit.code, shown(exit.output)).toBe(0);

  note(`run ${runId}: checking completion`);
  const run = await eventually("the run completed", async () => {
    const r = await owner.api.call("actions.runs.get", {
      owner: org,
      repo: "app",
      run_id: runId,
    });
    return r.status === "completed" ? r : undefined;
  });
  const { jobs } = await owner.api.call("actions.runs.jobs.list", {
    owner: org,
    repo: "app",
    run_id: runId,
  });
  return { runId, run, jobs, exit };
}

/** Every object under the run's prefix, and the lines of the chunks the manifest names, in its order. */
async function storedLines(
  runId: string,
  manifest: readonly { start_index: number; end_index: number; r2_key: string }[],
) {
  const res = await fetch(`${forge.origin}/__runs/${runId}/chunks`);
  expect(res.status).toBe(200);
  const objects = (await res.json()) as { key: string; text: string | null }[];
  const text = new Map(objects.map((o) => [o.key, o.text ?? ""]));
  const rows = manifest.flatMap((chunk) =>
    (text.get(chunk.r2_key) ?? "")
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => ({
        ...(JSON.parse(l) as { i: number; c?: string; omitted?: string; bytes?: number }),
        chunk,
      })),
  );
  return { objects, rows };
}

describe(`gitea/runner ${VERSION} against wrangler dev`, () => {
  it("registers, runs a job and stores its whole log", async () => {
    const { runId, run, jobs } = await runWorkflow(WORKFLOW_NAME, WORKFLOW);

    const db = await runDatabase(runId);
    try {
      const instance = db
        .prepare("SELECT task, outputs FROM run_instances WHERE job_key = 'build'")
        .get() as { task: number; outputs: string | null };
      const log = db
        .prepare("SELECT ack_index, state, rows FROM ci_logs WHERE task = ?")
        .get(instance.task) as { ack_index: number; state: string; rows: number };
      const manifest = db
        .prepare(
          "SELECT start_index, end_index, r2_key FROM ci_log_chunks WHERE task = ? ORDER BY start_index",
        )
        .all(instance.task) as { start_index: number; end_index: number; r2_key: string }[];
      const res = await fetch(`${forge.origin}/__runs/${runId}/chunks`);
      expect(res.status).toBe(200);
      const objects = (await res.json()) as { key: string; text: string | null }[];
      const text = new Map(objects.map((o) => [o.key, o.text ?? ""]));
      const rows = manifest.flatMap((chunk) =>
        (text.get(chunk.r2_key) ?? "")
          .split("\n")
          .filter((l) => l !== "")
          .map((l) => ({ ...(JSON.parse(l) as { i: number; c: string }), chunk })),
      );
      // The job's own log, as stored, explains a failure.
      const stored = shown(rows.map((r) => r.c).join("\n"));

      expect(run.conclusion, stored).toBe("success");
      expect(jobs).toMatchObject([
        { name: "build", status: "completed", conclusion: "success", log_complete: true },
      ]);
      expect(JSON.parse(instance.outputs ?? "null")).toEqual({ answer: "42" });
      expect(log.state).toBe("complete");
      // What the runner sent, as the seam recorded it on the way to the API.
      const { wire_id: wireId } = db
        .prepare("SELECT wire_id FROM ci_tasks WHERE task = ?")
        .get(instance.task) as { wire_id: number };
      const calls = await recordedUpdateLogs(wireId);
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) expect(call.status, "an UpdateLog refused").toBe(200);
      const sent = new Map<number, string>();
      for (const { request } of calls)
        request.rows.forEach((row, k) => {
          const position = request.index + k;
          const earlier = sent.get(position);
          // A resend carries the same row.
          if (earlier !== undefined) expect(row.content, `row ${position} resent`).toBe(earlier);
          sent.set(position, row.content);
        });
      const final = calls.findLast((call) => call.request.noMore);
      expect(final, "no final UpdateLog").toBeDefined();
      const last = (final as RecordedUpdateLog).request;
      const finalAck = (final as RecordedUpdateLog).ack;
      // The final answer covers the final request, and is the stored ack.
      expect(last.whole).toBe(true);
      expect(finalAck).toBe(last.index + last.rows.length);
      expect(log.ack_index).toBe(finalAck);
      // The older runner's sentinel: a final call of exactly one empty row, acked, never stored.
      const sentinel = last.rows.length === 1 && last.rows[0]?.content === "";
      const form = sentinel
        ? `a final call of one empty row at ${last.index} (acked, not stored)`
        : last.rows.length === 0
          ? `an empty final call at ${last.index}`
          : `a final call of ${last.rows.length} rows from ${last.index}`;
      note(`log end: ${form}`);
      expect(log.rows, form).toBe(sentinel ? finalAck - 1 : finalAck);
      // Every position below the final ack was sent, and each stored one holds what was sent.
      expect([...sent.keys()].sort((x, y) => x - y)).toEqual(
        Array.from({ length: finalAck }, (_, k) => k),
      );
      expect(rows.map((r) => r.c)).toEqual(Array.from({ length: log.rows }, (_, k) => sent.get(k)));

      // The manifest: contiguous from row 0 to the ack.
      let next = 0;
      for (const chunk of manifest) {
        expect(chunk.start_index, chunk.r2_key).toBe(next);
        expect(chunk.end_index).toBeGreaterThan(chunk.start_index);
        next = chunk.end_index;
      }
      expect(next).toBe(log.rows);
      // The objects under the run's prefix are the manifest's, each holding its range's rows in order.
      expect(objects.map((o) => o.key).sort()).toEqual(manifest.map((c) => c.r2_key).sort());
      expect(rows.map((r) => r.i)).toEqual(Array.from({ length: log.rows }, (_, k) => k));
      for (const row of rows) {
        expect(row.i).toBeGreaterThanOrEqual(row.chunk.start_index);
        expect(row.i).toBeLessThan(row.chunk.end_index);
      }
      // Every printed line once, in order; the runner's own lines (step headers, the
      // container's setup) around them.
      expect(rows.map((r) => r.c).filter((c) => /^(burst|trickle) \d+$/.test(c))).toEqual(PRINTED);

      const acks = manifest.map((c) => c.end_index).join(", ");
      note(
        `run ${runId}: ${calls.length} UpdateLog calls (acks ${calls.map((c) => c.ack).join(", ")}); ${manifest.length} chunks, acks ${acks}; ` +
          `${log.rows} rows stored, ack ${log.ack_index}, log ${log.state}; outputs ${instance.outputs}`,
      );
    } finally {
      db.close();
    }
  });

  it("omits a line too large for any request, receives the ack past it and stores the lines after it", async () => {
    const { runId, run, jobs, exit } = await runWorkflow(BIG_NAME, BIG_WORKFLOW);
    const db = await runDatabase(runId);
    try {
      const instance = db.prepare("SELECT task FROM run_instances WHERE job_key = 'big'").get() as {
        task: number;
      };
      const { wire_id: wireId } = db
        .prepare("SELECT wire_id FROM ci_tasks WHERE task = ?")
        .get(instance.task) as { wire_id: number };
      const log = db
        .prepare("SELECT ack_index, state, rows, omitted_rows FROM ci_logs WHERE task = ?")
        .get(instance.task) as {
        ack_index: number;
        state: string;
        rows: number;
        omitted_rows: number;
      };
      const manifest = db
        .prepare(
          "SELECT start_index, end_index, r2_key FROM ci_log_chunks WHERE task = ? ORDER BY start_index",
        )
        .all(instance.task) as { start_index: number; end_index: number; r2_key: string }[];
      const { objects, rows } = await storedLines(runId, manifest);
      const stored = shown(rows.map((r) => r.c ?? `[omitted: ${r.omitted}]`).join("\n"));

      // The job's result does not depend on its log; the log is incomplete for good.
      expect(run.conclusion, stored).toBe("success");
      expect(jobs).toMatchObject([
        { name: "big", status: "completed", conclusion: "success", log_complete: false },
      ]);
      expect(log).toMatchObject({ state: "incomplete", omitted_rows: 1 });

      // One position is an omission record, of a row the runner framed at the line's size or more.
      const omitted = rows.filter((r) => r.omitted !== undefined);
      expect(omitted).toHaveLength(1);
      const gap = omitted[0] as (typeof rows)[number];
      expect(gap).toMatchObject({ omitted: "row_too_large" });
      expect(gap.bytes).toBeGreaterThanOrEqual(HUGE);
      expect(gap.c).toBeUndefined();
      expect(gap.chunk).toMatchObject({ start_index: gap.i, end_index: gap.i + 1 });
      // The lines after it are stored, in order, each once.
      const after = rows.filter((r) => r.i > gap.i).map((r) => r.c);
      expect(after.filter((c) => c === `after ${nonce}` || c === `tail ${nonce}`)).toEqual([
        `after ${nonce}`,
        `tail ${nonce}`,
      ]);
      expect(rows.every((r) => (r.c ?? "").length < HUGE)).toBe(true);
      expect(objects.map((o) => o.key).sort()).toEqual(manifest.map((c) => c.r2_key).sort());

      // What the runner sent: the line as one row, cut by the API's prefix in every call that
      // carried it first, and the API's answer past it reaching the runner, whose next call
      // starts there.
      const calls = await recordedUpdateLogs(wireId);
      for (const call of calls) expect(call.status, "an UpdateLog refused").toBe(200);
      const final = calls.findLast((call) => call.request.noMore);
      expect(final, "no final UpdateLog").toBeDefined();
      const { request: last, ack: finalAck } = final as RecordedUpdateLog;
      expect(last.whole).toBe(true);
      expect(finalAck).toBe(log.ack_index);
      // Contiguous from 0 to the ack: every position a row or the one omission, but for the
      // older runner's sentinel, which either runner form may end with after the gap.
      const shape = storedLogShape(last, finalAck, omitted.length);
      note(
        `log end: ${isFinalSentinel(last) ? `the sentinel at ${last.index} (acked, not stored)` : `a final call of ${last.rows.length} rows from ${last.index}`}`,
      );
      expect(rows.map((r) => r.i)).toEqual(shape.positions);
      expect(log.rows).toBe(shape.rows);
      const proven = calls.filter((c) => c.request.oversizedFirstRow !== undefined);
      expect(proven.length).toBeGreaterThan(0);
      for (const call of proven) {
        expect(call.request.index).toBe(gap.i);
        expect(call.ack).toBe(gap.i + 1);
        expect(call.request.oversizedFirstRow?.bytes).toBe(gap.bytes);
      }
      const firstPast = calls.findIndex((c) => c.request.index > gap.i);
      expect(firstPast, "no call after the omission started past it").toBeGreaterThan(
        calls.indexOf(proven[0] as RecordedUpdateLog),
      );

      const cut = calls.filter((c) => !c.request.whole);
      note(
        `run ${runId}: ${calls.length} UpdateLog calls (index→ack ${calls.map((c) => `${c.request.index}→${c.ack}`).join(", ")}); ` +
          `${cut.length} cut by the prefix (API stopped reading: ${cut.map((c) => c.cancelled).join(", ")}); ` +
          `${proven.length} proving row ${gap.i} oversized (${gap.bytes} bytes declared); ` +
          `${log.rows} rows stored, ${log.omitted_rows} omitted, ack ${log.ack_index}, log ${log.state}; ` +
          `runner errors reporting logs: ${exit.output.split("\n").filter((l) => /update ?log|report ?log|not all logs/i.test(l) && /error|fail/i.test(l)).length}`,
      );
    } finally {
      db.close();
    }
  });

  it("reports its real result when a sealed log stops acknowledging new rows", async () => {
    const gate = await createLogGate();
    const marker = `before-sealed-log ${nonce}`;
    let sealedRun: string | undefined;
    const source = [
      `name: ${WORKFLOW_NAME}-sealed`,
      "on: push",
      "jobs:",
      "  sealed:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: before upgrade",
      "        run: |",
      "          node --input-type=module <<'NODE'",
      `          console.log(${JSON.stringify(marker)});`,
      '          for (let i = 0; i < 120; i++) console.log("before-seal " + i);',
      `          const gate = await fetch(${JSON.stringify(gate.url)}, { signal: AbortSignal.timeout(120000) });`,
      '          if (!gate.ok) throw new Error("The sealed-log gate refused the job.");',
      "          NODE",
      "      - name: after upgrade",
      "        env:",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a workflow expression, as plain text
      "          JOB_TOKEN: ${{ github.token }}",
      "        run: |",
      "          node --input-type=module <<'NODE'",
      `          const url = ${JSON.stringify(`${instanceUrl()}/${org}/app.git/info/refs?service=git-upload-pack`)};`,
      '          const auth = Buffer.from("x-access-token:" + process.env.JOB_TOKEN).toString("base64");',
      '          const response = await fetch(url, { headers: { Authorization: "Basic " + auth, "Git-Protocol": "version=2" }, signal: AbortSignal.timeout(30000) });',
      '          if (response.status !== 200) throw new Error("The legacy job token could not read git: " + response.status);',
      '          if (!(await response.text()).startsWith("000eversion 2\\n")) throw new Error("The v2 git advertisement was missing.");',
      '          console.log("legacy-job-token-still-works");',
      '          for (let i = 0; i < 20; i++) console.log("discarded-after-seal " + i);',
      "          NODE",
    ].join("\n");
    try {
      const { runId, run, jobs } = await runWorkflow(
        `${WORKFLOW_NAME}-sealed`,
        source,
        async (runId, signal) => {
          await gate.ready(signal);
          const taskId = await eventually("a durable log before sealing", async () => {
            signal.throwIfAborted();
            const response = await fetch(`${forge.origin}/__runs/recorded`, { signal });
            const entries = (await response.json()) as {
              request: string;
              whole: boolean;
              status: number | null;
              response: string | null;
            }[];
            for (const entry of entries) {
              if (entry.status !== 200 || !entry.whole) continue;
              const request = decodeUpdateLogRequest(Buffer.from(entry.request, "base64"));
              const position = request.rows.findIndex((row) => row.content === marker);
              if (position < 0) continue;
              const ack = decodeUpdateLogResponse(
                Buffer.from(entry.response ?? "", "base64"),
              ).ackIndex;
              if (ack > request.index + position) return request.taskId;
            }
            return undefined;
          });
          const sealed = await fetch(`${forge.origin}/__runs/${runId}/seal`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ taskId }),
            signal,
          });
          expect(sealed.status).toBe(200);
          sealedRun = runId;
          gate.release();
        },
      );
      expect(run.conclusion).toBe("success");
      expect(jobs).toMatchObject([{ name: "sealed", conclusion: "success", log_complete: false }]);
      const response = await fetch(`${forge.origin}/__runs/${runId}/sealstate`);
      expect(response.status).toBe(200);
      const control = (await response.json()) as {
        taskId: number;
        ackIndex: number;
        results: { result: number; status: number }[];
      };
      expect(control.ackIndex).toBeGreaterThan(0);
      expect(control.results).toEqual([{ result: Result.SUCCESS, status: 200 }]);
      const calls = (await recordedUpdateLogs(control.taskId)).filter((call) => call.sealed);
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every((call) => call.ack === control.ackIndex)).toBe(true);
      expect(calls.some((call) => call.request.rows.length > 0)).toBe(true);
      const final = calls.filter((call) => call.request.noMore);
      expect(final.length).toBeGreaterThan(0);
      expect(final.length).toBeLessThanOrEqual(10);
      expect(
        calls.some((call) =>
          call.request.rows.some((row) => row.content === "legacy-job-token-still-works"),
        ),
      ).toBe(true);
      const db = await runDatabase(runId);
      try {
        const log = db.prepare("SELECT state, ack_index FROM ci_logs WHERE task = 1").get() as {
          state: string;
          ack_index: number;
        };
        expect(log).toEqual({ state: "incomplete", ack_index: control.ackIndex });
        const manifest = db
          .prepare("SELECT start_index, end_index, r2_key FROM ci_log_chunks ORDER BY start_index")
          .all() as { start_index: number; end_index: number; r2_key: string }[];
        const { rows } = await storedLines(runId, manifest);
        expect(rows.length).toBe(control.ackIndex);
        expect(rows.some((row) => row.c?.includes("discarded-after-seal"))).toBe(false);
        expect(rows.some((row) => row.c === "legacy-job-token-still-works")).toBe(false);
      } finally {
        db.close();
      }
      note(
        `run ${runId}: frozen log ack ${control.ackIndex}, ${calls.length} uploads (${final.length} final), job-token git read and final SUCCESS accepted, log incomplete`,
      );
    } finally {
      if (sealedRun) await fetch(`${forge.origin}/__runs/${sealedRun}/unseal`, { method: "POST" });
      await gate.close();
    }
  });

  it("masks stored and live rows from a stock runner, with backfill before the job resumes", async () => {
    let viewer: Awaited<ReturnType<typeof watchLog>> | undefined;
    const gate = await createLogGate();
    let backfillCount = 0;
    try {
      const { runId, run, jobs } = await runWorkflow(
        MASK_NAME,
        maskingWorkflow(gate.url),
        async (runId, signal) => {
          await gate.ready(signal);
          // The marker is acked (so stored) before the viewer joins: it reaches the viewer as backfill.
          await eventually("the backfill marker acked", async () => {
            signal.throwIfAborted();
            const res = await fetch(`${forge.origin}/__runs/recorded`, { signal });
            const entries = (await res.json()) as {
              request: string;
              whole: boolean;
              status: number | null;
              response: string | null;
            }[];
            return (
              entries.some((entry) => {
                if (entry.status !== 200 || !entry.whole) return false;
                const request = decodeUpdateLogRequest(Buffer.from(entry.request, "base64"), {
                  truncated: false,
                });
                const k = request.rows.findIndex((row) => row.content === BACKFILL);
                if (k < 0) return false;
                const ack = decodeUpdateLogResponse(
                  Buffer.from(entry.response ?? "", "base64"),
                ).ackIndex;
                return ack > request.index + k;
              }) || undefined
            );
          });
          const listed = await owner.api.call(
            "actions.runs.jobs.list",
            { owner: org, repo: "app", run_id: runId },
            { signal },
          );
          const job = listed.jobs.find((job) => job.name === "mask");
          if (!job) throw new Error("The masking job was not listed.");
          const ticket = await owner.api.call(
            "actions.runs.jobs.live_ticket",
            { owner: org, repo: "app", run_id: runId, job_id: job.id },
            { signal },
          );
          viewer = await watchLog(ticket.url, owner.token, signal);
          await viewer.waitForRows((rows) => rows.some((row) => row.c === BACKFILL));
          backfillCount = viewer.rows.length;
          expect(viewer.rows.some((row) => row.c === LIVE)).toBe(false);
          gate.release();
          await viewer.waitForRows((rows) => rows.some((row) => row.c === LIVE));
        },
      );
      expect(run.conclusion).toBe("success");
      expect(jobs).toMatchObject([{ name: "mask", conclusion: "success", log_complete: true }]);
      if (!viewer) throw new Error("The masking viewer did not open.");
      const delivered = await viewer.completed();
      expect(delivered.code).toBe(1000);
      expect(delivered.end?.log).toBe("complete");
      const db = await runDatabase(runId);
      try {
        const instance = db.prepare("SELECT task FROM run_instances WHERE name = 'mask'").get() as {
          task: number;
        };
        const manifest = db
          .prepare(
            "SELECT start_index, end_index, r2_key FROM ci_log_chunks WHERE task = ? ORDER BY start_index",
          )
          .all(instance.task) as { start_index: number; end_index: number; r2_key: string }[];
        const { rows } = await storedLines(runId, manifest);
        expect(viewer.rows.length).toBe(rows.length);
        const mismatch = viewer.rows.findIndex(
          (row, index) => row.i !== rows[index]?.i || row.c !== rows[index]?.c,
        );
        expect(mismatch, "the first differing stored/live row index").toBe(-1);
        const contents = rows.map((row) => row.c ?? "");
        expect(contents.includes("mask-plain:***")).toBe(true);
        expect(contents.includes("mask-base64:***")).toBe(true);
        expect(contents.includes("mask-split:***")).toBe(true);
        expect(contents.includes("***:mask-split-end")).toBe(true);
        expect(contents.includes("mask-runtime:***")).toBe(true);
        expect(contents.some((content) => content.includes(runtimeMask))).toBe(false);
        expect(delivered.end?.durable).toBe(rows.length);
        expect(viewer.rows.findIndex((row) => row.c === LIVE)).toBeGreaterThanOrEqual(
          backfillCount,
        );
        note(
          `run ${runId}: stock masking, ${backfillCount} backfill rows, ${rows.length} identical stored/live rows, ${delivered.frames} frames`,
        );
      } finally {
        db.close();
      }
    } finally {
      viewer?.close();
      await gate.close();
    }
  });
});
