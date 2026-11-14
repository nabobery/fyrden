// The workflow run operations over REST and MCP: reading a run and its
// jobs by GitHub's paths (statuses named as GitHub names them), cancelling,
// force-cancelling and re-running, each refused with GitHub's codes when
// the run cannot; another repository's run answers as missing, and the
// actions permission is needed, apart from contents and statuses.
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { api, json } from "./helpers/api.js";
import { scopedToken } from "./helpers/principals.js";
import { drain, finish, job, repoWithCommit, started, workflow } from "./helpers/runs.js";

const source = workflow(
  [job("a"), job("b", ["needs: a", "strategy:", "  max-parallel: 1"])].join("\n"),
);

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
    result?: { structuredContent?: unknown; isError?: boolean };
  };
  return body.result;
}

describe("reading a run", () => {
  it("answers the run and its jobs by GitHub's paths and names", async () => {
    const f = await repoWithCommit();
    const runId = await started(f, source);
    const run = await json(api("GET", `${f.path}/actions/runs/${runId}`, f.owner.token));
    expect(run).toMatchObject({
      status: 200,
      body: {
        id: runId,
        run_attempt: 1,
        head_sha: f.sha,
        head_branch: "main",
        event: "push",
        path: ".github/workflows/ci.yml",
        status: "in_progress",
        conclusion: null,
        actor: { id: f.owner.principalId },
        triggering_actor: { id: f.owner.principalId },
        faults: [],
      },
    });
    const jobs = await json<{
      jobs: { name: string; status: string }[];
      next_cursor: string | null;
    }>(api("GET", `${f.path}/actions/runs/${runId}/jobs`, f.owner.token));
    expect(jobs.status).toBe(200);
    expect(jobs.body.jobs.map((j) => [j.name, j.status])).toEqual([["a", "queued"]]);
    expect(jobs.body.next_cursor).toBeNull();
  });

  it("pages a run's jobs with a cursor", async () => {
    const f = await repoWithCommit();
    const runId = await started(f, workflow([job("a"), job("b"), job("c")].join("\n")));
    const first = await json<{ jobs: { id: number }[]; next_cursor: string | null }>(
      api("GET", `${f.path}/actions/runs/${runId}/jobs?per_page=2`, f.owner.token),
    );
    expect(first.body.jobs).toHaveLength(2);
    const second = await json<{ jobs: { id: number }[]; next_cursor: string | null }>(
      api(
        "GET",
        `${f.path}/actions/runs/${runId}/jobs?per_page=2&cursor=${encodeURIComponent(first.body.next_cursor ?? "")}`,
        f.owner.token,
      ),
    );
    expect(second.body.jobs).toHaveLength(1);
    expect(second.body.next_cursor).toBeNull();
  });

  it("keeps a listing on its attempt when a re-run starts between pages", async () => {
    const f = await repoWithCommit();
    const runId = await started(f, workflow([job("a"), job("b")].join("\n")));
    await finish(runId, "a");
    await finish(runId, "b");
    const first = await json<{ jobs: { id: number; run_attempt: number }[]; next_cursor: string }>(
      api("GET", `${f.path}/actions/runs/${runId}/jobs?per_page=1`, f.owner.token),
    );
    expect(first.body.jobs.map((j) => j.run_attempt)).toEqual([1]);
    expect((await api("POST", `${f.path}/actions/runs/${runId}/rerun`, f.owner.token)).status).toBe(
      201,
    );
    await drain(runId);
    const cursor = encodeURIComponent(first.body.next_cursor);
    const second = await json<{ jobs: { name: string; run_attempt: number }[] }>(
      api("GET", `${f.path}/actions/runs/${runId}/jobs?per_page=1&cursor=${cursor}`, f.owner.token),
    );
    expect(second.body.jobs).toEqual([expect.objectContaining({ name: "b", run_attempt: 1 })]);
    const conflicting = await json(
      api("GET", `${f.path}/actions/runs/${runId}/jobs?attempt=2&cursor=${cursor}`, f.owner.token),
    );
    expect(conflicting).toMatchObject({ status: 422, body: { code: "invalid_cursor" } });
  });

  it("answers another repository's run as missing", async () => {
    const f = await repoWithCommit();
    const runId = await started(f, source);
    const other = await repoWithCommit();
    const res = await json(api("GET", `${other.path}/actions/runs/${runId}`, other.owner.token));
    expect(res).toMatchObject({ status: 404, body: { code: "run_not_found" } });
  });

  it("needs the actions permission, not contents or statuses", async () => {
    const f = await repoWithCommit();
    const runId = await started(f, source);
    const contents = await scopedToken(f.owner.principalId, ["contents:write", "statuses:write"]);
    const refused = await json(api("GET", `${f.path}/actions/runs/${runId}`, contents));
    expect(refused).toMatchObject({ status: 403, body: { code: "missing_permission" } });
    const reader = await scopedToken(f.owner.principalId, ["actions:read"]);
    expect((await json(api("GET", `${f.path}/actions/runs/${runId}`, reader))).status).toBe(200);
    const write = await json(api("POST", `${f.path}/actions/runs/${runId}/cancel`, reader));
    expect(write).toMatchObject({ status: 403, body: { code: "missing_permission" } });
  });

  it("is an MCP tool", async () => {
    const f = await repoWithCommit();
    const runId = await started(f, source);
    const result = await callTool(f.owner.token, "get_workflow_run", {
      owner: f.owner.handle,
      repo: f.repo.name,
      run_id: runId,
    });
    expect(result?.structuredContent).toMatchObject({ id: runId, status: "in_progress" });
  });
});

describe("cancelling and re-running", () => {
  it("cancels gracefully (202), then refuses a completed run (409)", async () => {
    const f = await repoWithCommit();
    const runId = await started(f, source);
    const res = await api("POST", `${f.path}/actions/runs/${runId}/cancel`, f.owner.token);
    expect(res.status).toBe(202);
    await drain(runId);
    const run = await json(api("GET", `${f.path}/actions/runs/${runId}`, f.owner.token));
    expect(run.body).toMatchObject({ status: "completed", conclusion: "cancelled" });
    const again = await json(api("POST", `${f.path}/actions/runs/${runId}/cancel`, f.owner.token));
    expect(again).toMatchObject({ status: 409, body: { code: "run_not_cancellable" } });
  });

  it("force-cancels (202)", async () => {
    const f = await repoWithCommit();
    const runId = await started(f, source);
    const res = await api("POST", `${f.path}/actions/runs/${runId}/force-cancel`, f.owner.token);
    expect(res.status).toBe(202);
    await drain(runId);
    const jobs = await json<{ jobs: { conclusion: string }[] }>(
      api("GET", `${f.path}/actions/runs/${runId}/jobs`, f.owner.token),
    );
    expect(jobs.body.jobs.map((j) => j.conclusion)).toEqual(["cancelled", "cancelled"]);
  });

  it("re-runs a completed run as a new attempt (201), refusing one still running (409)", async () => {
    const f = await repoWithCommit();
    const runId = await started(f, workflow(job("a")));
    const early = await json(api("POST", `${f.path}/actions/runs/${runId}/rerun`, f.owner.token));
    expect(early).toMatchObject({ status: 409, body: { code: "run_not_completed" } });
    await finish(runId, "a", "failure");
    const rerun = await json(api("POST", `${f.path}/actions/runs/${runId}/rerun`, f.owner.token));
    expect(rerun).toMatchObject({ status: 201, body: { run_attempt: 2 } });
    await drain(runId);
    const first = await json<{ jobs: { conclusion: string | null; run_attempt: number }[] }>(
      api("GET", `${f.path}/actions/runs/${runId}/jobs?attempt=1`, f.owner.token),
    );
    expect(first.body.jobs).toEqual([
      expect.objectContaining({ run_attempt: 1, conclusion: "failure" }),
    ]);
    const current = await json<{ jobs: { status: string; run_attempt: number }[] }>(
      api("GET", `${f.path}/actions/runs/${runId}/jobs`, f.owner.token),
    );
    expect(current.body.jobs).toEqual([
      expect.objectContaining({ run_attempt: 2, status: "queued" }),
    ]);
    const missing = await json(
      api("GET", `${f.path}/actions/runs/${runId}/jobs?attempt=3`, f.owner.token),
    );
    expect(missing).toMatchObject({ status: 404, body: { code: "attempt_not_found" } });
  });

  it("shows a job waiting for a slot as pending", async () => {
    const f = await repoWithCommit();
    const runId = await started(
      f,
      workflow(job("m", ["strategy:", "  max-parallel: 1", "  matrix:", "    n: [1, 2]"])),
    );
    const jobs = await json<{ jobs: { status: string }[] }>(
      api("GET", `${f.path}/actions/runs/${runId}/jobs`, f.owner.token),
    );
    expect(jobs.body.jobs.map((j) => j.status)).toEqual(["queued", "pending"]);
  });
});
