// A commit's check runs over REST and MCP: what Fyrden's CI runs published on
// it, each with the run and job it came from while the run is kept, in name
// order; and the route it shares with reading a commit.
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { RepoDO } from "../src/do/RepoDO.js";
import type { CheckStart } from "../src/do/repo/checks.js";
import {
  jobCheckKey,
  parseCheckKey,
  planCheckKey,
  settledCheckKey,
} from "../src/do/run/check-key.js";
import { api, json, user } from "./helpers/api.js";
import { scopedToken } from "./helpers/principals.js";
import { inRepo } from "./helpers/repo-git.js";
import {
  advance,
  drain,
  type Fixture,
  finish,
  job,
  jobNamed,
  repoWithCommit,
  runStub,
  started,
  workflow,
} from "./helpers/runs.js";

interface CheckRun {
  name: string;
  head_sha: string;
  status: string;
  conclusion: string | null;
  run: { id: string; run_attempt: number; job_id: number | null } | null;
}
interface Page {
  total_count: number;
  check_runs: CheckRun[];
  next_cursor: string | null;
}

const list = (f: Fixture, query = "", ref = f.sha, token = f.owner.token) =>
  json<Page>(api("GET", `${f.path}/commits/${ref}/check-runs${query}`, token));
const named = async (f: Fixture, query = "") =>
  (await list(f, query)).body.check_runs.map((c) => c.name);

/** Starts checks of `names` on the commit, as a run with no run behind it. */
const start = (f: Fixture, names: readonly string[], key = (n: string) => `other/${n}`) =>
  inRepo(env.REPO.getByName(f.repo.id), (r: RepoDO) =>
    r.startCheckAttempts(
      f.sha,
      names.map((name): CheckStart => ({ name, startKey: key(name) })),
    ),
  );

/** A run of `source`, its checks sent. */
async function ran(f: Fixture, source: string) {
  const runId = await started(f, source);
  await advance(runId, 2_000);
  return runId;
}

describe("a commit's check runs", () => {
  it("shows each check with its run and job, by name, whatever the ref names the commit", async () => {
    const f = await repoWithCommit();
    const runId = await ran(f, workflow([job("test"), job("build")].join("\n")));
    const [build, test] = [await jobNamed(runId, "build"), await jobNamed(runId, "test")];
    await finish(runId, "build");
    await advance(runId, 2_000);
    const page = await list(f);
    expect(page).toMatchObject({ status: 200, body: { total_count: 2, next_cursor: null } });
    expect(page.body.check_runs).toEqual([
      {
        name: "build",
        head_sha: f.sha,
        status: "completed",
        conclusion: "success",
        attempt: 1,
        run: { id: runId, run_attempt: 1, job_id: build.jobId },
        details_url: null,
        updated_at: expect.any(Number),
      },
      expect.objectContaining({
        name: "test",
        status: "queued",
        conclusion: null,
        run: { id: runId, run_attempt: 1, job_id: test.jobId },
      }),
    ]);
    expect((await list(f, "", "main")).body).toEqual(page.body);
  });

  it("leaves commit statuses to their own operations", async () => {
    const f = await repoWithCommit();
    await api("POST", `${f.path}/statuses/${f.sha}`, f.owner.token, {
      state: "success",
      context: "lint",
    });
    await start(f, ["build"]);
    expect(await named(f)).toEqual(["build"]);
    expect((await list(f)).body.total_count).toBe(1);
  });

  it("shows the job of the re-run that replaced the one it came from", async () => {
    const f = await repoWithCommit();
    const source = workflow(
      [job("plan", ["outputs:", "  n: x"]), job("a", ["needs: plan"])].join("\n"),
    );
    const runId = await ran(f, source);
    await finish(runId, "plan");
    await finish(runId, "a", "failure");
    await advance(runId, 2_000);
    const first = await jobNamed(runId, "a", 1);
    expect((await runStub(runId).rerun(f.owner.principalId)).ok).toBe(true);
    await drain(runId);
    await advance(runId, 2_000);
    // The attempt fails before `a`, which is skipped under a job of its own.
    await finish(runId, "plan", "failure");
    await advance(runId, 2_000);
    const check = (await list(f)).body.check_runs.find((c) => c.name === "a");
    const second = await jobNamed(runId, "a", 2);
    expect(second.jobId).not.toBe(first.jobId);
    expect(check?.run).toEqual({ id: runId, run_attempt: 2, job_id: second.jobId });
  });

  it("names the run of a settled or a workflow file's check, with no job", async () => {
    const f = await repoWithCommit();
    const runId = await ran(f, "name: ci\non: push\njobs: {}\n");
    const page = await list(f);
    expect(page.body.check_runs).toMatchObject([
      { conclusion: "failure", run: { id: runId, run_attempt: 1, job_id: null } },
    ]);
    await start(f, ["gone"], () => settledCheckKey(runId, 2, 7));
    expect((await list(f, "?check_name=gone")).body.check_runs[0]?.run).toEqual({
      id: runId,
      run_attempt: 2,
      job_id: null,
    });
  });

  it("names no run once it is no longer kept, nor for a key that names none", async () => {
    const f = await repoWithCommit();
    const runId = await ran(f, workflow(job("build")));
    await start(f, ["odd"]);
    expect((await list(f, "?check_name=odd")).body.check_runs[0]?.run).toBeNull();
    expect((await list(f, "?check_name=build")).body.check_runs[0]?.run?.id).toBe(runId);
    expect(await env.REPO.getByName(f.repo.id).forgetRun({ runId })).toEqual({ ok: true });
    expect((await list(f, "?check_name=build")).body.check_runs[0]).toMatchObject({
      status: "queued",
      run: null,
    });
  });

  it("names no run whose retention ended, before it is forgotten", async () => {
    const f = await repoWithCommit();
    const runId = await ran(f, workflow(job("build")));
    await finish(runId, "build");
    await advance(runId, 2_000);
    const check = async () => (await list(f)).body.check_runs[0]?.run;
    expect((await check())?.id).toBe(runId);
    await inRepo(env.REPO.getByName(f.repo.id), (r: RepoDO) => {
      r.git.context.storage.sql.exec(
        "UPDATE ci_runs SET completed_at = ? WHERE run_id = ?",
        Date.now() - 91 * 86_400_000,
        runId,
      );
    });
    expect(await check()).toBeNull();
  });

  it("filters by name, ignoring case, and by status, counting what matches", async () => {
    const f = await repoWithCommit();
    const runId = await ran(f, workflow([job("build"), job("test")].join("\n")));
    await finish(runId, "build", "failure");
    await advance(runId, 2_000);
    expect(await named(f, "?check_name=BUILD")).toEqual(["build"]);
    expect(await named(f, "?check_name=none")).toEqual([]);
    expect(await named(f, "?status=completed")).toEqual(["build"]);
    expect(await named(f, "?status=queued&filter=latest")).toEqual(["test"]);
    expect((await list(f, "?status=in_progress")).body).toEqual({
      total_count: 0,
      check_runs: [],
      next_cursor: null,
    });
    for (const name of ["filter=all", "app_id=1"])
      expect(await list(f, `?${name}`)).toMatchObject({
        status: 422,
        body: { code: "unsupported_parameter" },
      });
    expect(await list(f, "?status=failure")).toMatchObject({
      status: 422,
      body: { code: "invalid_input" },
    });
  });

  it("pages in name order, a check whose name differs past the BMP in its place", async () => {
    const f = await repoWithCommit();
    const names = ["b", "a", "z\u{10000}", "z￮", "c"];
    await start(f, names);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: { body: Page } = await list(
        f,
        `?per_page=2${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`,
      );
      expect(page.body.total_count).toBe(5);
      seen.push(...page.body.check_runs.map((c) => c.name));
      cursor = page.body.next_cursor;
    } while (cursor !== null);
    expect(seen).toEqual([...names].sort());
    expect(await list(f, "?cursor=x")).toMatchObject({
      status: 422,
      body: { code: "invalid_cursor" },
    });
  });

  it("pages past a name as long as names may be, however much longer it folds", async () => {
    const f = await repoWithCommit();
    // U+1D160 folds to three characters, each two UTF-16 units.
    const long = "\u{1d160}".repeat(255);
    // Sorts after it, so the long name is what a page ends at.
    const last = String.fromCodePoint(0x20000);
    const answers = await start(f, [long, "a", last], (n) => `other/${n.length}${n.at(-1)}`);
    expect(answers.every((answer) => answer.ok)).toBe(true);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: { status: number; body: Page } = await list(
        f,
        `?per_page=1${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`,
      );
      expect(page.status).toBe(200);
      seen.push(...page.body.check_runs.map((c) => c.name));
      cursor = page.body.next_cursor;
    } while (cursor !== null);
    expect(seen).toEqual(["a", long, last]);
  });

  it("reads a row a check or status and two more for each shown, not each check's history", async () => {
    const f = await repoWithCommit();
    for (const context of ["lint", "docs"])
      await api("POST", `${f.path}/statuses/${f.sha}`, f.owner.token, {
        state: "success",
        context,
      });
    const names = Array.from({ length: 100 }, (_, i) => `check ${String(i).padStart(3, "0")}`);
    for (let attempt = 1; attempt <= 3; attempt++)
      await start(f, names, (n) => `run${attempt}/${n}`);
    const read = await inRepo(env.REPO.getByName(f.repo.id), (r: RepoDO) => {
      const { sql } = r.git.context.storage;
      const exec = sql.exec.bind(sql);
      const cursors: { rowsRead: number }[] = [];
      sql.exec = ((query: string, ...bindings: unknown[]) => {
        const cursor = exec(query, ...(bindings as []));
        cursors.push(cursor);
        return cursor;
      }) as typeof sql.exec;
      r.checks.checkRunsOn(f.sha, {}, null, 10);
      return cursors.reduce((sum, c) => sum + c.rowsRead, 0);
    });
    expect(read).toBeLessThanOrEqual(100 + 2 + 2 * 10);
  });
});

describe("the route and who may read it", () => {
  it("is read before the commit a raw branch name ending in it would name", async () => {
    const f = await repoWithCommit();
    expect((await list(f, "", "main")).body).toHaveProperty("check_runs");
    expect((await json(api("GET", `${f.path}/commits/main`, f.owner.token))).body).toHaveProperty(
      "commit",
    );
    expect(await list(f, "", "no-such-branch")).toMatchObject({
      status: 404,
      body: { code: "ref_not_found" },
    });
  });

  it("needs statuses:read on the repository, as commit statuses do", async () => {
    const f = await repoWithCommit();
    const stranger = await user();
    const actions = await scopedToken(f.owner.principalId, ["actions:read"]);
    const reader = await scopedToken(f.owner.principalId, ["statuses:read"]);
    expect(await list(f, "", f.sha, actions)).toMatchObject({
      status: 403,
      body: { code: "missing_permission" },
    });
    expect((await list(f, "", f.sha, reader)).status).toBe(200);
    expect(await list(f, "", f.sha, stranger.token)).toMatchObject({
      status: 404,
      body: { code: "repo_not_found" },
    });
    expect((await list(f, "", f.sha, "not-a-token")).status).toBe(401);
  });

  it("is an MCP tool answering the same", async () => {
    const f = await repoWithCommit();
    await ran(f, workflow(job("build")));
    const res = await exports.default.fetch("https://fyrden.test/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${f.owner.token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "tools/call",
        "Mcp-Name": "list_check_runs",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "list_check_runs",
          arguments: { owner: f.owner.handle, repo: f.repo.name, ref: "main" },
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": { name: "fyrden-test", version: "0.0.0" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });
    const text = await res.text();
    const body = JSON.parse(text.startsWith("{") ? text : (text.split("data: ")[1] ?? "{}"));
    expect(body.result.structuredContent).toEqual((await list(f)).body);
  });
});

describe("a check's key", () => {
  it("names the run, attempt and job it was made from, and nothing it was not", () => {
    const runId = "01J9ZZZZZZZZZZZZZZZZZZZZZZ";
    expect(parseCheckKey(jobCheckKey(runId, 2, 14))).toEqual({ runId, attempt: 2, jobId: 14 });
    expect(parseCheckKey(settledCheckKey(runId, 3, 14))).toEqual({
      runId,
      attempt: 3,
      jobId: null,
    });
    expect(parseCheckKey(planCheckKey(runId))).toEqual({ runId, attempt: 1, jobId: null });
    for (const bad of [
      "",
      "x",
      `${runId}/a1`,
      `${runId}/a0/j1`,
      `${runId}/a1/j0`,
      `${runId}/a1/j1/x`,
    ])
      expect(parseCheckKey(bad)).toBeUndefined();
  });
});
