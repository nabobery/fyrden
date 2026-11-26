// Listing CI runs over REST and MCP, from what the repository records of
// them: GitHub's filters, pages bounded by the rows they read, workflows with
// runs, and a run's job graph; and who may read them.
import { env, exports } from "cloudflare:workers";
import { newUlid } from "@fyrden/adapters-cloudflare/git";
import { describe, expect, it } from "vitest";
import type { RepoDO } from "../src/do/RepoDO.js";
import { RUN_PAGE_SCAN, type RunReport } from "../src/do/repo/run-history.js";
import { api, json, user } from "./helpers/api.js";
import { scopedToken } from "./helpers/principals.js";
import { inRepo } from "./helpers/repo-git.js";
import {
  advance,
  drain,
  expr,
  type Fixture,
  finish,
  inRun,
  job,
  repoWithCommit,
  runStub,
  started,
  workflow,
} from "./helpers/runs.js";

const CI = ".github/workflows/ci.yml";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

interface Run {
  id: string;
  status: string;
  conclusion: string | null;
}
interface Page {
  workflow_runs: Run[];
  next_cursor: string | null;
}

const list = (f: Fixture, query = "", token = f.owner.token) =>
  json<Page>(api("GET", `${f.path}/actions/runs${query}`, token));
const ids = (page: { body: Page }) => page.body.workflow_runs.map((r) => r.id);

async function all(f: Fixture, query: string) {
  const runs: Run[] = [];
  let pages = 0;
  let cursor: string | null = null;
  do {
    const page: { status: number; body: Page } = await list(
      f,
      `?${query}${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`,
    );
    expect(page.status).toBe(200);
    runs.push(...page.body.workflow_runs);
    cursor = page.body.next_cursor;
    pages++;
  } while (cursor !== null);
  return { ids: runs.map((r) => r.id), pages };
}

/**
 * Records runs as reported, without the runs themselves: the repository's
 * rows alone are what a list reads. Each is triggered a minute after the
 * one before, the last at `Date.now()`.
 */
async function record(
  f: Fixture,
  reports: readonly (Partial<RunReport> & { readonly at?: number })[],
): Promise<string[]> {
  const now = Date.now();
  const rows = reports.map(({ at, ...extra }, i): RunReport => {
    const createdAt = at ?? now - (reports.length - 1 - i) * 60_000;
    return {
      runId: newUlid(createdAt),
      sha: f.sha,
      path: CI,
      event: "push",
      actor: f.owner.principalId,
      fork: false,
      createdAt,
      attempt: 1,
      phase: "completed",
      conclusion: "success",
      triggeringActor: f.owner.principalId,
      updatedAt: createdAt,
      startedAt: createdAt,
      completedAt: createdAt,
      runNumber: i + 1,
      name: "ci",
      title: `run ${i + 1}`,
      headBranch: "main",
      pullNumber: null,
      ...extra,
    };
  });
  await inRepo(env.REPO.getByName(f.repo.id), (r: RepoDO) => {
    for (const row of rows) {
      r.git.context.storage.sql.exec(
        "INSERT INTO ci_runs (run_id, sha, workflow_path, created_at) VALUES (?, ?, ?, ?)",
        row.runId,
        row.sha,
        row.path,
        row.createdAt,
      );
      r.runs.apply(row);
    }
  });
  return rows.map((row) => row.runId);
}

const live = (phase: "waiting" | "queued" | "pending" | "in_progress") =>
  ({ phase, conclusion: null, completedAt: null }) as const;

async function callTool(token: string, name: string, args: Record<string, unknown>) {
  const res = await exports.default.fetch("https://fyrden.test/mcp", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": "tools/call",
      "Mcp-Name": name,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name,
        arguments: args,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "fyrden-test", version: "0.0.0" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  const text = await res.text();
  const body = JSON.parse(text.startsWith("{") ? text : (text.split("data: ")[1] ?? "{}")) as {
    result?: { structuredContent?: unknown; isError?: boolean; content?: { text: string }[] };
  };
  return body.result;
}

describe("listing runs", () => {
  it("shows runs newest first, as getting each shows it", async () => {
    const f = await repoWithCommit();
    const source = workflow(job("a"));
    const done = await started(f, source, { github: { workflow: "CI", run_number: "8" } });
    await advance(done, 2_000);
    await finish(done, "a", "failure");
    await advance(done, 2_000);
    const running = await started(f, source);
    await advance(running, 2_000);
    const page = await list(f);
    expect(page.status).toBe(200);
    expect(ids(page)).toEqual([running, done].sort().reverse());
    for (const run of page.body.workflow_runs) {
      const got = await json<Run & Record<string, unknown>>(
        api("GET", `${f.path}/actions/runs/${run.id}`, f.owner.token),
      );
      const { approval, errors, faults, updated_at, ...same } = got.body;
      expect(run).toMatchObject(same);
      expect([approval, errors, faults]).toEqual([null, [], []]);
      expect(updated_at).toBeTypeOf("number");
    }
    expect(page.body.workflow_runs.find((r) => r.id === done)).toMatchObject({
      run_number: 8,
      name: "CI",
      display_title: "CI",
      run_attempt: 1,
      head_sha: f.sha,
      head_branch: "main",
      event: "push",
      path: CI,
      pull_request: null,
      fork: false,
      status: "completed",
      conclusion: "failure",
      actor: { id: f.owner.principalId },
    });
    expect(page.body.next_cursor).toBeNull();
  });

  it("pages by cursor through every run once, a run started meanwhile not repeated", async () => {
    const f = await repoWithCommit();
    const runs = await record(f, [{}, {}, {}, {}, {}]);
    const first = await list(f, "?per_page=2");
    expect(ids(first)).toEqual([runs[4], runs[3]]);
    await record(f, [{ at: Date.now() + 60_000 }]);
    const cursor = encodeURIComponent(first.body.next_cursor ?? "");
    const second = await list(f, `?per_page=2&cursor=${cursor}`);
    expect(ids(second)).toEqual([runs[2], runs[1]]);
    const third = await list(
      f,
      `?per_page=2&cursor=${encodeURIComponent(second.body.next_cursor ?? "")}`,
    );
    expect(ids(third)).toEqual([runs[0]]);
    expect(third.body.next_cursor).toBeNull();
    // A page that ends exactly at the last run has no next one.
    expect((await list(f, "?per_page=6")).body.next_cursor).toBeNull();
  });

  it("filters as GitHub does, filters together", async () => {
    const f = await repoWithCommit();
    const other = await user();
    const sha = "c".repeat(40);
    const [a, b, c, d, e, g, h] = await record(f, [
      { headBranch: "topic", event: "pull_request", pullNumber: 3 },
      { conclusion: "failure" },
      { conclusion: "cancelled", sha },
      { ...live("in_progress"), actor: other.principalId },
      live("queued"),
      { ...live("waiting"), fork: true, event: "pull_request", headBranch: "topic" },
      { ...live("pending"), path: ".github/workflows/deploy.yml", sha },
    ]);
    const matching = async (query: string) => (await all(f, query)).ids;
    expect(await matching("branch=topic")).toEqual([g, a]);
    expect(await matching("event=pull_request&branch=topic&status=success")).toEqual([a]);
    expect(await matching("status=failure")).toEqual([b]);
    expect(await matching("status=cancelled")).toEqual([c]);
    expect(await matching("status=completed")).toEqual([g, c, b, a]);
    expect(await matching("status=action_required")).toEqual([g]);
    expect(await matching("status=in_progress")).toEqual([d]);
    expect(await matching("status=queued")).toEqual([e]);
    expect(await matching("status=pending")).toEqual([h]);
    for (const none of ["neutral", "skipped", "stale", "timed_out", "requested", "waiting"])
      expect(await matching(`status=${none}`)).toEqual([]);
    expect(await matching(`actor=${other.handle.toUpperCase()}`)).toEqual([d]);
    expect(await matching("actor=nobody-has-this-handle")).toEqual([]);
    expect(await matching(`head_sha=${sha}`)).toEqual([h, c]);
    expect(await matching(`head_sha=${sha}&status=pending`)).toEqual([h]);
    expect(await matching(`head_sha=${sha}&branch=topic`)).toEqual([]);
    const shown = (await list(f, "?status=action_required")).body.workflow_runs[0];
    expect(shown).toMatchObject({ status: "completed", conclusion: "action_required", fork: true });
  });

  it("filters by when a run was triggered", async () => {
    const f = await repoWithCommit();
    const noon = Date.UTC(2026, 10, 18, 12);
    const [a, b, c] = await record(f, [
      { at: noon, completedAt: Date.now() },
      { at: noon + DAY, completedAt: Date.now() },
      { at: noon + 2 * DAY, completedAt: Date.now() },
    ]);
    const matching = async (created: string, more = "") =>
      (await all(f, `created=${encodeURIComponent(created)}${more}`)).ids;
    expect(await matching("2026-11-19")).toEqual([b]);
    expect(await matching(">=2026-11-19")).toEqual([c, b]);
    expect(await matching("<2026-11-19")).toEqual([a]);
    expect(await matching("2026-11-18..2026-11-19")).toEqual([b, a]);
    expect(await matching("2026-11-18T12:00:00Z")).toEqual([a]);
    expect(await matching(">2026-11-18T12:00:00Z")).toEqual([c, b]);
    expect(await matching("*..2026-11-19", "&per_page=1")).toEqual([b, a]);
    expect(await matching("2026-11-18..2026-11-20", `&head_sha=${f.sha}`)).toEqual([c, b, a]);
    expect(await list(f, "?created=yesterday")).toMatchObject({
      status: 422,
      body: { code: "invalid_filter" },
    });
  });

  it("refuses by name what it does not support, and a value that is no filter", async () => {
    const f = await repoWithCommit();
    for (const name of ["check_suite_id=5", "exclude_pull_requests=true"])
      expect(await list(f, `?${name}`)).toMatchObject({
        status: 422,
        body: { code: "unsupported_parameter" },
      });
    for (const bad of ["status=done", "head_sha=abc", "per_page=0", "per_page=101", "branch="])
      expect(await list(f, `?${bad}`)).toMatchObject({
        status: 422,
        body: { code: "invalid_input" },
      });
    for (const cursor of ["x", btoa("not a run id")])
      expect(await list(f, `?cursor=${cursor}`)).toMatchObject({
        status: 422,
        body: { code: "invalid_cursor" },
      });
  });

  it("leaves out a run not reported yet, and one whose retention ended", async () => {
    const f = await repoWithCommit();
    const long = Date.now() - 91 * DAY;
    const [old, kept] = await record(f, [
      { at: long, completedAt: long },
      { at: long, ...live("in_progress") },
    ]);
    const unreported = newUlid();
    expect(
      await env.REPO.getByName(f.repo.id).registerRun({ runId: unreported, sha: f.sha, path: CI }),
    ).toEqual({ ok: true });
    expect((await all(f, "per_page=1")).ids).toEqual([kept]);
    expect(old).toBeDefined();
  });

  it("ends a page at the rows it reads, however few match, and goes on from there", async () => {
    const f = await repoWithCommit();
    const total = RUN_PAGE_SCAN + 40;
    const rows = Array.from({ length: total }, (_, i) =>
      i === 0 ? { headBranch: "rare" } : { headBranch: "main" },
    );
    const runs = await record(f, rows);
    const first = await list(f, "?branch=rare");
    expect(first.body.workflow_runs).toEqual([]);
    expect(first.body.next_cursor).not.toBeNull();
    const followed = await all(f, "branch=rare");
    expect(followed).toEqual({ ids: [runs[0]], pages: 2 });
  });
});

describe("what a page reads", () => {
  const rowsRead = (f: Fixture, work: (r: RepoDO) => unknown) =>
    inRepo(env.REPO.getByName(f.repo.id), (r: RepoDO) => {
      const { sql } = r.git.context.storage;
      const exec = sql.exec.bind(sql);
      const cursors: { rowsRead: number }[] = [];
      sql.exec = ((query: string, ...bindings: unknown[]) => {
        const cursor = exec(query, ...(bindings as []));
        cursors.push(cursor);
        return cursor;
      }) as typeof sql.exec;
      work(r);
      return cursors.reduce((sum, c) => sum + c.rowsRead, 0);
    });

  it("reads a page's rows and at most two more, whichever index serves it", async () => {
    const f = await repoWithCommit();
    const sha = "d".repeat(40);
    const runs = await record(
      f,
      Array.from({ length: 300 }, (_, i) => ({
        sha: i % 30 === 0 ? sha : f.sha,
        path: i % 2 === 0 ? CI : ".fyrden/workflows/ci.yml",
        ...(i > 296 ? live("in_progress") : {}),
      })),
    );
    const paths = [".fyrden/workflows/ci.yml", CI] as const;
    const before = runs[150] ?? null;
    expect(await rowsRead(f, (r) => r.runs.list({}, null, 30))).toBeLessThanOrEqual(32);
    expect(await rowsRead(f, (r) => r.runs.list({}, before, 30))).toBeLessThanOrEqual(32);
    expect(await rowsRead(f, (r) => r.runs.list({ sha }, null, 30))).toBeLessThanOrEqual(20);
    expect(
      await rowsRead(f, (r) => r.runs.list({ phases: ["in_progress"] }, null, 30)),
    ).toBeLessThanOrEqual(6);
    // Two files' ranges, merged: a row more of each than the page holds.
    expect(await rowsRead(f, (r) => r.runs.list({ paths }, null, 30))).toBeLessThanOrEqual(64);
    expect(await rowsRead(f, (r) => r.runs.list({ branch: "none" }, null, 30))).toBe(300);
  });

  it("reads a few rows a workflow, however many runs it has", async () => {
    const f = await repoWithCommit();
    await record(
      f,
      Array.from({ length: 200 }, (_, i) => ({ path: `.github/workflows/w${i % 4}.yml` })),
    );
    expect(await rowsRead(f, (r) => r.runs.workflows("", 30))).toBeLessThanOrEqual(16);
  });
});

describe("a workflow's runs", () => {
  it("lists one file's runs, in either workflow directory, newest first", async () => {
    const f = await repoWithCommit();
    const [a, b, , d] = await record(f, [
      {},
      { path: ".fyrden/workflows/ci.yml", conclusion: "failure" },
      { path: ".github/workflows/deploy.yml" },
      {},
    ]);
    const runs = async (query: string) =>
      ids(await json<Page>(api("GET", `${f.path}/actions/workflows/${query}`, f.owner.token)));
    expect(await runs("ci.yml/runs")).toEqual([d, b, a]);
    expect(await runs("ci.yml/runs?status=failure")).toEqual([b]);
    expect(await runs("ci.yml/runs?per_page=1")).toEqual([d]);
    expect(await runs("never.yml/runs")).toEqual([]);
  });

  it("lists the workflows with runs, each with its latest, by path", async () => {
    const f = await repoWithCommit();
    const long = Date.now() - 91 * DAY;
    const runs = await record(f, [
      { path: ".github/workflows/b.yml", name: "Old name" },
      { path: ".github/workflows/b.yml", name: "B" },
      { path: ".github/workflows/a.yml", name: "A", ...live("queued") },
      { path: ".github/workflows/gone.yml", name: "Gone", at: long, completedAt: long },
    ]);
    const unreported = ".github/workflows/unreported.yml";
    await env.REPO.getByName(f.repo.id).registerRun({
      runId: newUlid(),
      sha: f.sha,
      path: unreported,
    });
    const page = (query = "") =>
      json<{
        workflows: { id: string; path: string; name: string; latest_run: Run | null }[];
        next_cursor: string | null;
      }>(api("GET", `${f.path}/actions/workflows${query}`, f.owner.token));
    const listed = await page();
    expect(listed.body).toMatchObject({
      workflows: [
        {
          id: "a.yml",
          path: ".github/workflows/a.yml",
          name: "A",
          latest_run: { id: runs[2], status: "queued" },
        },
        { id: "b.yml", name: "B", latest_run: { id: runs[1] } },
        { id: "gone.yml", name: "Gone", latest_run: null },
        { id: "unreported.yml", name: null, latest_run: null },
      ],
      next_cursor: null,
    });
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const next: Awaited<ReturnType<typeof page>> = await page(
        `?per_page=1${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`,
      );
      seen.push(...next.body.workflows.map((w) => w.id));
      cursor = next.body.next_cursor;
    } while (cursor !== null);
    expect(seen).toEqual(["a.yml", "b.yml", "gone.yml", "unreported.yml"]);
  });

  it("lists a workflow however many of its newest runs are not reported yet", async () => {
    const f = await repoWithCommit();
    const [reported] = await record(f, [{ at: Date.now() - HOUR }]);
    for (let i = 0; i < 60; i++)
      await env.REPO.getByName(f.repo.id).registerRun({ runId: newUlid(), sha: f.sha, path: CI });
    expect((await all(f, "per_page=1")).ids).toEqual([reported]);
    const page = await json<{ workflows: unknown[] }>(
      api("GET", `${f.path}/actions/workflows`, f.owner.token),
    );
    expect(page.body.workflows).toEqual([{ id: "ci.yml", path: CI, name: null, latest_run: null }]);
  });
});

describe("a run's job graph", () => {
  const source = workflow(
    [
      job("build", [`name: Build ${expr("matrix.n")}`, "strategy:", "  matrix:", "    n: [1, 2]"]),
      job("test", ["needs: build"]),
      job("notify", ["needs: [build, test]", "if: always()"]),
    ].join("\n"),
  );
  const graph = (f: Fixture, runId: string, query = "") =>
    json<{ run_attempt: number; jobs: Record<string, unknown>[] }>(
      api("GET", `${f.path}/actions/runs/${runId}/graph${query}`, f.owner.token),
    );

  const queued = (id: number, name: string) => ({
    id,
    name,
    name_cut: false,
    status: "queued",
    conclusion: null,
    started_at: null,
    completed_at: null,
    waiting_for: null,
    error: null,
  });

  async function expectInstancesListed(f: Fixture, runId: string) {
    const nodes = (await graph(f, runId)).body.jobs as { key: string; jobs: unknown[] }[];
    const listed = await json<{ jobs: Record<string, unknown>[] }>(
      api("GET", `${f.path}/actions/runs/${runId}/jobs`, f.owner.token),
    );
    for (const node of nodes)
      expect(node.jobs).toEqual(
        listed.body.jobs
          .filter((j) => j.job_key === node.key)
          .map((j) => ({
            id: j.id,
            name: j.name,
            name_cut: false,
            status: j.status,
            conclusion: j.conclusion,
            started_at: j.started_at,
            completed_at: j.completed_at,
            waiting_for: j.waiting_for ?? null,
            error: j.error,
          })),
      );
    return nodes;
  }

  it("has the jobs not started, what each needs, how each ended, and each one's instances", async () => {
    const f = await repoWithCommit();
    const runId = await started(f, source);
    expect((await graph(f, runId)).body).toEqual({
      run_id: runId,
      run_attempt: 1,
      jobs: [
        {
          key: "build",
          name: "build",
          name_cut: false,
          needs: [],
          status: "in_progress",
          conclusion: null,
          jobs: [queued(1, "Build 1"), queued(2, "Build 2")],
        },
        {
          key: "test",
          name: "test",
          name_cut: false,
          needs: ["build"],
          status: "pending",
          conclusion: null,
          jobs: [],
        },
        {
          key: "notify",
          name: "notify",
          name_cut: false,
          needs: ["build", "test"],
          status: "pending",
          conclusion: null,
          jobs: [],
        },
      ],
    });
    const jobs = await json<{ jobs: { job_key: string; name: string }[] }>(
      api("GET", `${f.path}/actions/runs/${runId}/jobs`, f.owner.token),
    );
    expect(jobs.body.jobs.map((j) => [j.job_key, j.name])).toEqual([
      ["build", "Build 1"],
      ["build", "Build 2"],
    ]);
    // Failing fast, the other combination ends with it.
    await finish(runId, "Build 1", "failure");
    expect((await graph(f, runId)).body.jobs.map((j) => [j.key, j.status, j.conclusion])).toEqual([
      ["build", "completed", "failure"],
      ["test", "completed", "skipped"],
      ["notify", "in_progress", null],
    ]);
    const nodes = await expectInstancesListed(f, runId);
    expect(nodes.map((n) => n.jobs.length)).toEqual([2, 1, 1]);
  });

  it("has the instances of the attempt it is of", async () => {
    const f = await repoWithCommit();
    const runId = await started(f, workflow(job("a")));
    await finish(runId, "a", "failure");
    expect((await api("POST", `${f.path}/actions/runs/${runId}/rerun`, f.owner.token)).status).toBe(
      201,
    );
    await drain(runId);
    const ids = async (query: string) =>
      ((await graph(f, runId, query)).body.jobs as { jobs: { id: number; status: string }[] }[])
        .flatMap((n) => n.jobs)
        .map((j) => [j.id, j.status]);
    expect(await ids("?attempt=1")).toEqual([[1, "completed"]]);
    expect(await ids("")).toEqual([[2, "queued"]]);
  });

  it("shows a combination waiting for a slot as pending, as the jobs list does", async () => {
    const f = await repoWithCommit();
    const runId = await started(
      f,
      workflow(job("m", ["strategy:", "  max-parallel: 1", "  matrix:", "    n: [1, 2]"])),
    );
    const [node] = await expectInstancesListed(f, runId);
    expect(((node?.jobs ?? []) as { status: string }[]).map((j) => j.status)).toEqual([
      "queued",
      "pending",
    ]);
  });

  it("cuts names to 200 UTF-16 units and errors to 500, never inside a surrogate pair; one job read keeps its name", async () => {
    const f = await repoWithCommit();
    const at200 = "n".repeat(200);
    const straddling = `${"s".repeat(199)}\u{1F600}tail`;
    const ending = `${"e".repeat(198)}\u{1F600}tail`;
    const runId = await started(
      f,
      workflow(
        [
          job("exact", [`name: ${at200}`]),
          job("straddle", [`name: "${straddling}"`]),
          job("ending", [`name: "${ending}"`]),
        ].join("\n"),
      ),
    );
    await inRun(runId, (run) =>
      run.engine.exec(
        "UPDATE run_instances SET error = ? WHERE job_key = 'exact'",
        `${"x".repeat(499)}\u{1F600}`,
      ),
    );
    const nodes = (await graph(f, runId)).body.jobs as {
      key: string;
      name: string;
      name_cut: boolean;
      jobs: { id: number; name: string; name_cut: boolean; error: string | null }[];
    }[];
    const byKey = new Map(nodes.map((n) => [n.key, n]));
    for (const [key, name, cut] of [
      ["exact", at200, false],
      ["straddle", "s".repeat(199), true],
      ["ending", `${"e".repeat(198)}\u{1F600}`, true],
    ] as const) {
      const node = byKey.get(key);
      expect([node?.name, node?.name_cut]).toEqual([name, cut]);
      expect([node?.jobs[0]?.name, node?.jobs[0]?.name_cut]).toEqual([name, cut]);
    }
    expect(byKey.get("exact")?.jobs[0]?.error).toBe("x".repeat(499));
    const straddled = byKey.get("straddle")?.jobs[0];
    const one = await json<{ name: string }>(
      api("GET", `${f.path}/actions/runs/${runId}/jobs/${straddled?.id}`, f.owner.token),
    );
    expect(one.body.name).toBe(straddling);
  });

  it("keeps a name or error with a NUL in it whole up to its cut", async () => {
    const f = await repoWithCommit();
    const runId = await started(f, workflow(job("nul", ['name: "ab\\0cd"'])));
    await inRun(runId, (run) =>
      run.engine.exec(
        "UPDATE run_instances SET error = ? WHERE job_key = 'nul'",
        `x\u0000${"y".repeat(600)}`,
      ),
    );
    const [node] = (await graph(f, runId)).body.jobs as {
      name: string;
      jobs: { name: string; name_cut: boolean; error: string | null }[];
    }[];
    expect(node?.name).toBe("ab\u0000cd");
    expect([node?.jobs[0]?.name, node?.jobs[0]?.name_cut]).toEqual(["ab\u0000cd", false]);
    expect(node?.jobs[0]?.error).toBe(`x\u0000${"y".repeat(498)}`);
  });

  it("stays under 600 KB at its maxima: 256 instances of a very long name, each with a long error", async () => {
    const f = await repoWithCommit();
    const long = "L".repeat(9_000);
    const runId = await started(
      f,
      workflow(
        job("m", [
          `name: ${long} ${expr("matrix.n")}`,
          "strategy:",
          "  matrix:",
          `    n: [${Array.from({ length: 256 }, (_, i) => i + 1).join(", ")}]`,
        ]),
      ),
    );
    await inRun(runId, (run) =>
      run.engine.exec("UPDATE run_instances SET error = ?", "E".repeat(9_000)),
    );
    const res = await api("GET", `${f.path}/actions/runs/${runId}/graph`, f.owner.token);
    const bytes = (await res.arrayBuffer()).byteLength;
    const [node] = (await graph(f, runId)).body.jobs as {
      jobs: { name: string; name_cut: boolean; error: string }[];
    }[];
    expect(node?.jobs).toHaveLength(256);
    expect(node?.jobs.every((j) => j.name_cut && j.name.length === 200)).toBe(true);
    expect(node?.jobs.every((j) => j.error.length === 500)).toBe(true);
    expect(bytes).toBeLessThan(600_000);
    const read = await runStub(runId).graph(f.repo.id, undefined, { name: 201, error: 501 });
    const instances = read.ok ? read.jobs.flatMap((j) => j.jobs) : [];
    expect(instances.map((j) => [j.name.length, j.error?.length])).toEqual(
      Array.from({ length: 256 }, () => [201, 501]),
    );
  });

  it("is empty for a workflow that could not run", async () => {
    const f = await repoWithCommit();
    const runId = await started(f, "name: ci\non: push\njobs: {}\n");
    expect((await graph(f, runId)).body).toMatchObject({ run_attempt: 1, jobs: [] });
  });

  it("is refused for another repository's run, an unknown one and an attempt there is not", async () => {
    const f = await repoWithCommit();
    const runId = await started(f, source);
    const other = await repoWithCommit();
    for (const [where, id, code] of [
      [other, runId, "run_not_found"],
      [f, newUlid(), "run_not_found"],
    ] as const)
      expect(await graph(where, id)).toMatchObject({ status: 404, body: { code } });
    expect(await graph(f, runId, "?attempt=2")).toMatchObject({
      status: 404,
      body: { code: "attempt_not_found" },
    });
  });
});

describe("who may read runs", () => {
  it("needs the actions permission and the repository, missing and unreadable alike", async () => {
    const f = await repoWithCommit();
    await record(f, [{}]);
    const contents = await scopedToken(f.owner.principalId, ["contents:write", "statuses:write"]);
    const reader = await scopedToken(f.owner.principalId, ["actions:read"]);
    const stranger = await user();
    const paths = [
      "/actions/runs",
      "/actions/workflows",
      "/actions/workflows/ci.yml/runs",
      `/actions/runs/${newUlid()}/graph`,
    ];
    for (const path of paths) {
      expect(await json(api("GET", `${f.path}${path}`, contents))).toMatchObject({
        status: 403,
        body: { code: "missing_permission" },
      });
      const unreadable = await json<{ code: string; detail: string }>(
        api("GET", `${f.path}${path}`, stranger.token),
      );
      const missing = await json<{ code: string; detail: string }>(
        api("GET", `/repos/${f.owner.handle}/no-such-repo${path}`, stranger.token),
      );
      expect([unreadable.status, unreadable.body.code]).toEqual([404, "repo_not_found"]);
      expect([missing.status, missing.body.code]).toEqual([404, "repo_not_found"]);
      expect((await api("GET", `${f.path}${path}`, "not-a-token")).status).toBe(401);
    }
    expect(ids(await list(f, "", reader))).toHaveLength(1);
  });

  it("answers an agent the same over MCP, refusals by the same codes", async () => {
    const f = await repoWithCommit();
    const [first, second] = await record(f, [{ conclusion: "failure" }, {}]);
    const where = { owner: f.owner.handle, repo: f.repo.name };
    const page = await callTool(f.owner.token, "list_workflow_runs", { ...where, per_page: 1 });
    expect(page?.structuredContent).toEqual((await list(f, "?per_page=1")).body);
    expect(page?.structuredContent).toMatchObject({ workflow_runs: [{ id: second }] });
    const failed = await callTool(f.owner.token, "list_runs_of_workflow", {
      ...where,
      workflow_id: "ci.yml",
      status: "failure",
    });
    expect(failed?.structuredContent).toMatchObject({ workflow_runs: [{ id: first }] });
    const workflows = await callTool(f.owner.token, "list_workflows", where);
    expect(workflows?.structuredContent).toMatchObject({ workflows: [{ id: "ci.yml" }] });
    const refused = await callTool(f.owner.token, "list_workflow_runs", {
      ...where,
      check_suite_id: 1,
    });
    expect(refused?.isError).toBe(true);
    expect(refused?.content?.[0]?.text).toContain("unsupported_parameter");
    const graph = await callTool(f.owner.token, "get_workflow_run_graph", {
      ...where,
      run_id: newUlid(),
    });
    expect(graph?.content?.[0]?.text).toContain("run_not_found");
  });
});
