import { createHash, randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { isLogOmission, type StoredLogLine } from "@fyrden/domain/ci";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Result, type Runner, type Task } from "../../../apps/api/src/runner/proto/messages.js";
import {
  decodeFetchTaskResponse,
  decodeRunnerResponse,
  decodeUpdateLogResponse,
  encodeFetchTaskRequest,
  encodeRegisterRequest,
  encodeUpdateLogRequest,
  encodeUpdateTaskRequest,
} from "../../../apps/api/test/helpers/runner-proto.js";
import { type Account, eventually, type Forge, Git, startForge } from "../e2e/forge.js";

const nonce = randomBytes(5).toString("hex");
const org = `logs${nonce}`;
const REPO = "logs";
const seam = join(import.meta.dirname, "../e2e/fixtures/run-seam/wrangler.jsonc");
const WORKFLOW =
  "name: raw logs\non: push\njobs:\n  log:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo unused\n";
let forge: Forge;
let owner: Account;
let runner: Runner;
let repoId: string;
let sha: string;
const sockets = new Set<WebSocket>();

async function proto(method: string, body: Uint8Array, authenticated = true) {
  const response = await fetch(`${forge.origin}/api/actions/runner.v1.RunnerService/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/proto",
      "Connect-Protocol-Version": "1",
      ...(authenticated && { "X-Runner-Uuid": runner.uuid, "X-Runner-Token": runner.token }),
    },
    body: Buffer.from(body),
    signal: AbortSignal.timeout(30_000),
  });
  expect(response.status, `${method} status`).toBe(200);
  return new Uint8Array(await response.arrayBuffer());
}

async function startRun() {
  const response = await fetch(`${forge.origin}/__runs/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      repoId,
      sha,
      ref: "refs/heads/main",
      event: "push",
      actor: owner.id,
      workflow: { path: ".github/workflows/raw.yml", source: WORKFLOW },
      github: { repository: `${org}/${REPO}`, ref: "refs/heads/main", event_name: "push" },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  expect(response.status).toBe(200);
  const result = (await response.json()) as { runId: string; answer: { ok: boolean } };
  expect(result.answer.ok).toBe(true);
  return result.runId;
}

const jobsOf = (runId: string) =>
  owner.api.call("actions.runs.jobs.list", { owner: org, repo: REPO, run_id: runId });

async function takeTask(runId: string, attempt = 1) {
  const job = await eventually("raw log job queued", async () =>
    (await jobsOf(runId)).jobs.find((j) => j.run_attempt === attempt && j.status === "queued"),
  );
  const task = await eventually("scripted runner receives task", async () => {
    const answer = decodeFetchTaskResponse(
      await proto("FetchTask", encodeFetchTaskRequest({ tasksVersion: 0 })),
    );
    return answer.task;
  });
  expect(task.id > 0).toBe(true);
  return { runId, jobId: job.id, task };
}

type ActiveTask = Awaited<ReturnType<typeof takeTask>>;

async function upload(task: Task, index: number, contents: readonly string[], final = false) {
  const answer = decodeUpdateLogResponse(
    await proto(
      "UpdateLog",
      encodeUpdateLogRequest({
        taskId: task.id,
        index,
        rows: contents.map((content) => ({ content })),
        noMore: final,
      }),
    ),
  );
  return answer.ackIndex;
}

async function finish(task: Task) {
  await proto(
    "UpdateTask",
    encodeUpdateTaskRequest({
      state: { id: task.id, result: Result.SUCCESS, steps: [], reportedSteps: [] },
      outputs: new Map(),
    }),
  );
}

async function stored(runId: string): Promise<StoredLogLine[]> {
  const response = await fetch(`${forge.origin}/__runs/${runId}/chunks`, {
    signal: AbortSignal.timeout(30_000),
  });
  expect(response.status).toBe(200);
  const objects = (await response.json()) as { text: string | null }[];
  return objects.flatMap(({ text }) => {
    if (text === null) throw new Error("A manifest chunk was missing.");
    return text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as StoredLogLine);
  });
}

const ticket = (active: ActiveTask, account = owner) =>
  account.api.call("actions.runs.jobs.live_ticket", {
    owner: org,
    repo: REPO,
    run_id: active.runId,
    job_id: active.jobId,
  });

function capture(url: string, headers: Record<string, string>) {
  const socket = new WebSocket(url, { headers });
  sockets.add(socket);
  const rows: StoredLogLine[] = [];
  const listeners = new Set<() => void>();
  let error: Error | undefined;
  let closed: number | undefined;
  let end: { log: string; durable: number } | undefined;
  let partial: { i: number; t: number | null; c: string } | undefined;
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const fail = () => {
    error = new Error("A raw log socket failed or sent invalid frames.");
    notify();
    socket.close();
  };
  const deadline = AbortSignal.timeout(300_000);
  deadline.addEventListener("abort", fail, { once: true });
  socket.addEventListener("error", fail);
  socket.addEventListener("open", notify);
  socket.addEventListener("close", (event) => {
    closed = event.code;
    sockets.delete(socket);
    deadline.removeEventListener("abort", fail);
    notify();
  });
  socket.addEventListener("message", (event) => {
    try {
      const frame = JSON.parse(String(event.data));
      if (frame.t === "rows" && Array.isArray(frame.rows)) {
        for (const row of frame.rows as StoredLogLine[]) {
          if (row.i !== rows.length || partial !== undefined) throw new Error();
          rows.push(row);
        }
        socket.send(JSON.stringify({ t: "ack", i: rows.length, o: 0 }));
      } else if (frame.t === "part") {
        if (frame.i !== rows.length || typeof frame.c !== "string") throw new Error();
        if (frame.o === 0) partial = { i: frame.i, t: frame.ts, c: "" };
        if (!partial || partial.c.length !== frame.o) throw new Error();
        partial.c += frame.c;
        if (frame.end) {
          rows.push(partial);
          partial = undefined;
        }
        socket.send(JSON.stringify({ t: "ack", i: rows.length, o: partial?.c.length ?? 0 }));
      } else if (frame.t === "end") {
        end = { log: frame.log, durable: frame.durable };
      } else throw new Error();
      notify();
    } catch {
      fail();
    }
  });
  const until = (predicate: () => boolean) =>
    new Promise<void>((resolve, reject) => {
      const check = () => {
        if (error || predicate() || closed !== undefined) {
          listeners.delete(check);
          if (error) reject(error);
          else if (predicate()) resolve();
          else reject(new Error("The log socket closed before the expected signal."));
        }
      };
      listeners.add(check);
      check();
    });
  return {
    rows,
    opened: () => until(() => socket.readyState === WebSocket.OPEN),
    count: (n: number) => until(() => rows.length >= n),
    closed: async () => {
      await until(() => closed !== undefined);
      return { code: closed, end };
    },
    close: () => socket.close(),
  };
}

async function view(active: ActiveTask, account = owner) {
  const issued = await ticket(active, account);
  const viewer = capture(issued.url, { Authorization: `Bearer ${account.token}` });
  await viewer.opened();
  return { ...viewer, url: issued.url };
}

async function refusedUpgrade(url: string, headers: Record<string, string>) {
  return new Promise<number>((resolve, reject) => {
    const target = new URL(url.replace(/^ws/, "http"));
    const request = httpRequest(target, {
      headers: {
        ...headers,
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
      },
      signal: AbortSignal.timeout(30_000),
    });
    request.on("response", (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.on("upgrade", (_response, socket) => {
      socket.destroy();
      resolve(101);
    });
    request.on("error", reject);
    request.end();
  });
}

function report(name: string, rows: readonly StoredLogLine[]) {
  const digest = createHash("sha256").update(JSON.stringify(rows)).digest("hex");
  process.stderr.write(
    `[raw-live-logs] ${name}: ${rows.length} ordered records, sha256 ${digest}\n`,
  );
}

beforeAll(async () => {
  forge = await startForge("rawlogs", { primary: seam, vars: { FYRDEN_CI_RUNNERS: "on" } });
  owner = await forge.user(`own${nonce}`);
  await forge.admin.api.call("admin.orgs.create", { login: org, admin: owner.handle });
  const repo = await owner.api.call("orgs.repos.create", { org, name: REPO });
  repoId = repo.id;
  const git = new Git(forge, owner);
  const work = join(forge.scratch, REPO);
  await git.ok(["init", "-q", "-b", "main", work]);
  await git.ok(["remote", "add", "origin", git.url(org, REPO)], work);
  sha = await git.commit(work, { ".github/workflows/raw.yml": WORKFLOW }, "raw log fixture");
  await git.ok(["push", "-u", "origin", "main"], work);
  const minted = await owner.api.call("orgs.runners.registration_tokens.create", { org });
  const response = decodeRunnerResponse(
    await proto(
      "Register",
      encodeRegisterRequest({
        name: `scripted-${nonce}`,
        token: minted.token,
        agentLabels: [],
        customLabels: [],
        version: "v6.0.0",
        labels: ["ubuntu-latest"],
        ephemeral: false,
        capabilities: ["cancelling"],
      }),
      false,
    ),
  );
  if (!response.runner) throw new Error("The scripted runner was not registered.");
  runner = response.runner;
}, 180_000);

afterAll(async () => {
  for (const socket of sockets) socket.close();
  await forge?.stop();
});

describe("raw runner logs through wrangler dev", () => {
  it("masks plain, base64, split and raw add-mask values in backfill and live rows", async () => {
    const active = await takeTask(await startRun());
    const token = active.task.secrets.get("GITHUB_TOKEN");
    if (!token) throw new Error("The task did not carry a job token.");
    const runtime = randomBytes(16).toString("hex");
    const first = [
      token,
      Buffer.from(token).toString("base64"),
      token.slice(0, 20),
      token.slice(20),
      `::add-mask::${runtime}`,
      runtime,
    ];
    while (first.length < 50) first.push(`backfill ${first.length}`);
    expect(await upload(active.task, 0, first)).toBe(50);
    const viewer = await view(active);
    await viewer.count(50);
    const next = Array.from({ length: 5 }, (_, i) => (i === 0 ? `live ${token}` : `live ${i}`));
    expect(await upload(active.task, 50, next)).toBe(50);
    await viewer.count(55);
    expect((await stored(active.runId)).length).toBe(50);
    expect(await upload(active.task, 50, next, true)).toBe(55);
    expect(await viewer.closed()).toEqual({ code: 1000, end: { log: "complete", durable: 55 } });
    const lines = await stored(active.runId);
    const text = lines.map((line) => (isLogOmission(line) ? "" : line.c)).join("\n");
    expect(
      [
        token,
        Buffer.from(token).toString("base64"),
        token.slice(0, 20),
        token.slice(20),
        runtime,
      ].every((secret) => !text.includes(secret)),
    ).toBe(true);
    expect(JSON.stringify(lines) === JSON.stringify(viewer.rows)).toBe(true);
    expect(lines.slice(0, 6).every((line) => !isLogOmission(line) && line.c.includes("***"))).toBe(
      true,
    );
    report("server-only masking, backfill and live", lines);
    await finish(active.task);
  });

  it("streams omission gaps whole and masks the following unknown suffix", async () => {
    const active = await takeTask(await startRun());
    const token = active.task.secrets.get("GITHUB_TOKEN");
    if (!token) throw new Error("The task did not carry a job token.");
    expect(await upload(active.task, 0, ["h".repeat(5 * 1024 * 1024)])).toBe(1);
    const viewer = await view(active);
    await viewer.count(1);
    expect(
      await upload(active.task, 1, [token.slice(-8), "x".repeat(4096), "visible tail"], true),
    ).toBe(4);
    await viewer.count(4);
    expect(await viewer.closed()).toEqual({ code: 1000, end: { log: "incomplete", durable: 4 } });
    const lines = await stored(active.runId);
    expect(isLogOmission(lines[0] as StoredLogLine)).toBe(true);
    expect(
      !isLogOmission(lines[1] as StoredLogLine) && (lines[1] as { c: string }).c === "***",
    ).toBe(true);
    expect(JSON.stringify(lines) === JSON.stringify(viewer.rows)).toBe(true);
    report("omission gap", lines);
    await finish(active.task);
  });

  it.each([
    ["zero-row", [], 50, 50],
    ["sentinel", [""], 51, 50],
    ["one-row", ["last"], 51, 51],
    ["many-row", ["last one", "last two"], 52, 52],
  ] as const)("seals a %s final without storing its sentinel", async (_name, final, ack, count) => {
    const active = await takeTask(await startRun());
    expect(
      await upload(
        active.task,
        0,
        Array.from({ length: 50 }, (_, i) => `row ${i}`),
      ),
    ).toBe(50);
    const viewer = await view(active);
    await viewer.count(50);
    expect(await upload(active.task, 50, final, true)).toBe(ack);
    expect(await viewer.closed()).toEqual({ code: 1000, end: { log: "complete", durable: count } });
    const beforeLateUpload = await stored(active.runId);
    expect(beforeLateUpload.length).toBe(count);
    expect(await upload(active.task, ack, ["not stored"], true)).toBe(ack);
    expect(JSON.stringify(await stored(active.runId)) === JSON.stringify(beforeLateUpload)).toBe(
      true,
    );
    await finish(active.task);
  });

  it("keeps rerun attempts apart and refuses a reused ticket", async () => {
    const first = await takeTask(await startRun());
    expect(await upload(first.task, 0, ["attempt one"], true)).toBe(1);
    await finish(first.task);
    await eventually("first attempt complete", async () => {
      const run = await owner.api.call("actions.runs.get", {
        owner: org,
        repo: REPO,
        run_id: first.runId,
      });
      return run.status === "completed" || undefined;
    });
    await owner.api.call("actions.runs.rerun", { owner: org, repo: REPO, run_id: first.runId });
    const second = await takeTask(first.runId, 2);
    expect(first.jobId !== second.jobId).toBe(true);
    const viewer = await view(second);
    expect(await refusedUpgrade(viewer.url, { Authorization: `Bearer ${owner.token}` })).toBe(401);
    expect(await upload(first.task, 1, ["old attempt late"], true)).toBe(1);
    expect(await upload(second.task, 0, ["attempt two"], true)).toBe(1);
    expect(await viewer.closed()).toEqual({ code: 1000, end: { log: "complete", durable: 1 } });
    expect(
      viewer.rows.length === 1 &&
        !isLogOmission(viewer.rows[0] as StoredLogLine) &&
        (viewer.rows[0] as { c: string }).c === "attempt two",
    ).toBe(true);
    report("attempt isolation", viewer.rows);
    await finish(second.task);
  });

  it("refuses a foreign Origin for a valid session without spending its ticket", async () => {
    const active = await takeTask(await startRun());
    const response = await fetch(`${forge.origin}/auth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: forge.origin },
      body: JSON.stringify({ token: owner.token }),
      signal: AbortSignal.timeout(30_000),
    });
    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie")?.split(";")[0];
    if (!cookie) throw new Error("The sign-in did not set a session cookie.");
    const issued = await fetch(
      `${forge.origin}/api/repos/${org}/${REPO}/actions/runs/${active.runId}/jobs/${active.jobId}/logs/live`,
      {
        method: "POST",
        headers: {
          "X-Fyrden-Session": "1",
          Cookie: cookie,
          "Idempotency-Key": crypto.randomUUID(),
          "Content-Type": "application/json",
        },
        body: "{}",
        signal: AbortSignal.timeout(30_000),
      },
    );
    expect(issued.status).toBe(200);
    const { url } = (await issued.json()) as { url: string };
    expect(await refusedUpgrade(url, { Cookie: cookie, Origin: "https://foreign.invalid" })).toBe(
      401,
    );
    const viewer = capture(url, { Cookie: cookie, Origin: forge.origin });
    await viewer.opened();
    expect(await upload(active.task, 0, ["session accepted"], true)).toBe(1);
    expect((await viewer.closed()).code).toBe(1000);
    await finish(active.task);
  });

  it("closes revoked token and removed collaborator viewers after a fresh check", async () => {
    const active = await takeTask(await startRun());
    const collaborator = await forge.user(`read${nonce}`);
    await owner.api.call("repos.collaborators.set", {
      owner: org,
      repo: REPO,
      username: collaborator.handle,
      permission: "pull",
    });
    const pat = await owner.api.call("users.tokens.create", {
      scopes: ["actions:read"],
      expires_in_days: 1,
    });
    const tokenAccount = { ...owner, token: pat.token, api: forge.client(pat.token) };
    const revoked = await view(active, tokenAccount);
    const removed = await view(active, collaborator);
    expect(
      await upload(
        active.task,
        0,
        Array.from({ length: 50 }, (_, i) => `before ${i}`),
      ),
    ).toBe(50);
    await Promise.all([revoked.count(50), removed.count(50)]);
    await owner.api.call("users.tokens.revoke", { token_id: pat.id });
    await owner.api.call("repos.collaborators.remove", {
      owner: org,
      repo: REPO,
      username: collaborator.handle,
    });
    // biome-ignore lint/style/noRestrictedGlobals: this integration probe crosses the real server's 60 s credential freshness boundary; the close events, not the timer, prove the checks ran.
    await new Promise<void>((resolve) => setTimeout(resolve, 61_100));
    expect(
      await upload(
        active.task,
        50,
        Array.from({ length: 50 }, (_, i) => `after ${i}`),
      ),
    ).toBe(100);
    expect((await revoked.closed()).code).toBe(4401);
    expect((await removed.closed()).code).toBe(4403);
    expect(revoked.rows.length).toBe(50);
    expect(removed.rows.length).toBe(50);
    process.stderr.write(
      "[raw-live-logs] rechecks: 4401 and 4403, zero rows delivered after the recheck\n",
    );
    expect(await upload(active.task, 100, [], true)).toBe(100);
    await finish(active.task);
  });
});
