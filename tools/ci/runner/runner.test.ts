// The pinned gitea/runner (RUNNER_VERSION, 6.0.0 by default) against
// fyrden-api under `wrangler dev`, in Docker, one runner container at a time:
// it registers with a token minted through the REST operation, takes a job
// of a run started through the run seam (a test Worker in front of the API),
// runs it in a job container, streams its log and reports the result. The
// run's job must succeed with its output, and its log must be stored whole:
// R2 chunks, named by the run object's manifest from row 0, holding every row
// the runner sent (the seam, its instance URL, records each UpdateLog on the
// way to the API) once and in order, and the final ack covering the final call.
//
// Needs Docker (the daemon's socket is handed to the runner, which starts the
// job container) and the job image; the binary is downloaded once, checked
// against its pinned SHA-256, into `$FYRDEN_RUNNER_CACHE` or
// `~/.cache/fyrden-runner`.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { mentionsToken } from "@fyrden/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type DecodedUpdateLog,
  decodeUpdateLogRequest,
} from "../../../apps/api/src/runner/proto/messages.js";
import { decodeUpdateLogResponse } from "../../../apps/api/test/helpers/runner-proto.js";
import { type Account, eventually, type Forge, Git, startForge } from "../e2e/forge.js";
import { hostArch, runnerBinary, runnerVersion } from "./binary.js";

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

/** For the job's output: lines naming a token are left out. */
const shown = (text: string) =>
  text
    .split("\n")
    .map((line) => (mentionsToken(line) ? "[a line naming a token, left out]" : line))
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

beforeAll(async () => {
  binary = await runnerBinary(VERSION, ARCH);
  note(`binary ${binary} (SHA-256 checked)`);
  if ((await docker(["image", "inspect", IMAGE])).code !== 0) {
    const pulled = await docker(["pull", IMAGE]);
    expect(pulled.code, pulled.output).toBe(0);
  }
  forge = await startForge("runner", { primary: seam, vars: { FYRDEN_CI_RUNNERS: "on" } });
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
      "  force_pull: false",
      "",
    ].join("\n"),
  );
}, 300_000);

afterAll(async () => {
  await cleanUp();
  if (data) await rm(data, { recursive: true, force: true });
  await forge?.stop();
}, 120_000);

interface RecordedUpdateLog {
  readonly status: number;
  readonly request: DecodedUpdateLog;
  readonly ack: number;
}

/** The UpdateLog calls the seam recorded, in arrival order, decoded with the API's own codec. */
async function recordedUpdateLogs(): Promise<RecordedUpdateLog[]> {
  const res = await fetch(`${forge.origin}/__runs/recorded`);
  expect(res.status).toBe(200);
  const entries = (await res.json()) as {
    request: string;
    status: number | null;
    response: string | null;
  }[];
  return entries.map((entry) => {
    expect(entry.status, "an UpdateLog still unanswered").not.toBeNull();
    const ok = entry.status === 200;
    return {
      status: entry.status as number,
      request: decodeUpdateLogRequest(Buffer.from(entry.request, "base64")),
      ack: ok ? decodeUpdateLogResponse(Buffer.from(entry.response ?? "", "base64")).ackIndex : -1,
    };
  });
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

describe(`gitea/runner ${VERSION} against wrangler dev`, () => {
  it("registers, runs a job and stores its whole log", async () => {
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

    // --once: it polls until it gets a task, runs it, and exits.
    const daemon = exec(
      "docker",
      runnerArgs(
        CONTAINER,
        ["-v", "/var/run/docker.sock:/var/run/docker.sock"],
        ["daemon", "--once"],
      ),
    );
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
          workflow: { path: ".github/workflows/ci.yml", source: WORKFLOW },
          // What a push trigger will give: the runner names its workspace after the repository.
          github: {
            server_url: forge.origin,
            repository: `${org}/app`,
            repository_owner: org,
            actor: owner.handle,
            workflow: WORKFLOW_NAME,
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

    const exit = await daemon;
    note(`daemon: exit ${exit.code}\n${shown(exit.output)}`);
    expect(exit.code, shown(exit.output)).toBe(0);

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
      const calls = await recordedUpdateLogs();
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
});
