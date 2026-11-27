import { describe, expect, it } from "vitest";
import { runActionError, runActions } from "../app/lib/run-actions.js";
import type { Run } from "../app/lib/runs.js";
import RunPage, { action, loader } from "../app/routes/repo.run.js";
import { fakeApi, formPost, json, ORIGIN } from "./helpers/context.js";
import { renderPage } from "./helpers/render.js";

const RUN_ID = "01JD0000000000000000000000";
const PAGE = `/acme/web/actions/runs/${RUN_ID}`;
const API = `/api/repos/acme/web/actions/runs/${RUN_ID}`;
const KEY = "0b6b9f3a-5d1e-4c2f-8a7b-0123456789ab";

const run = (more: Partial<Run> = {}): Run => ({
  id: RUN_ID,
  run_number: 1,
  name: "ci",
  display_title: "t",
  run_attempt: 2,
  head_sha: "a".repeat(40),
  head_branch: "main",
  event: "push",
  path: ".github/workflows/ci.yml",
  pull_request: null,
  fork: false,
  status: "completed",
  conclusion: "success",
  actor: { id: "usr_1" },
  triggering_actor: { id: "usr_1" },
  created_at: 1,
  updated_at: 1,
  run_started_at: 1,
  completed_at: 2,
  approval: null,
  errors: [],
  faults: [],
  ...more,
});

const approval = (state: string) =>
  ({ state, decided_by: null, decided_at: null }) as Run["approval"];

describe("what a writer may do to a run", () => {
  it.each([
    ["completed", run(), { rerun: true, cancel: false, approve: false }],
    [
      "running",
      run({ status: "in_progress", conclusion: null }),
      { rerun: false, cancel: true, approve: false },
    ],
    [
      "waiting for approval",
      run({ conclusion: "action_required", approval: approval("waiting") }),
      { rerun: false, cancel: true, approve: true },
    ],
    [
      "approval expired",
      run({ conclusion: "cancelled", approval: approval("expired") }),
      { rerun: false, cancel: false, approve: false },
    ],
    [
      "superseded",
      run({ conclusion: "cancelled", approval: approval("superseded") }),
      { rerun: false, cancel: false, approve: false },
    ],
    [
      "approval cancelled",
      run({ conclusion: "cancelled", approval: approval("cancelled") }),
      { rerun: false, cancel: false, approve: false },
    ],
    [
      "approved and done",
      run({ approval: approval("approved") }),
      { rerun: true, cancel: false, approve: false },
    ],
    [
      "a workflow that could not run",
      run({
        conclusion: "failure",
        errors: [{ code: "x", feature: "", path: "", line: 0, column: 0, message: "m" }],
      }),
      { rerun: false, cancel: false, approve: false },
    ],
  ])("%s", (_, shown, expected) => {
    expect(runActions(shown)).toEqual(expected);
  });

  it("names each refusal by its code", () => {
    expect(runActionError(409, "attempt_changed")).toContain("newer attempt");
    expect(runActionError(409, "approval_required")).toContain("never approved");
    expect(runActionError(409, "rerun_limit")).toContain("50 times");
    expect(runActionError(404, "repo_not_found")).toContain("permission");
    expect(runActionError(500, undefined, "boom")).toBe("boom");
  });
});

const post = (context: unknown, fields: Record<string, string>) =>
  action({
    request: formPost(PAGE, fields),
    context,
    params: { owner: "acme", repo: "web", run_id: RUN_ID },
  } as never);

describe("the run page's actions", () => {
  it("re-runs with the page's key and the attempt it was drawn for", async () => {
    const { context, calls } = fakeApi(() => json({ run_attempt: 3 }, 201));
    const answer = (await post(context, { intent: "rerun", key: KEY, attempt: "2" })) as Response;
    expect(answer.status).toBe(302);
    expect(answer.headers.get("Location")).toBe(`${PAGE}?rerun=1`);
    expect(new URL(calls[0]?.url as string).pathname).toBe(`${API}/rerun`);
    expect(calls[0]?.headers.get("Idempotency-Key")).toBe(KEY);
    expect(await calls[0]?.json()).toEqual({ attempt: 2 });
  });

  it("asks before cancelling, and sends nothing until confirmed", async () => {
    const { context, calls } = fakeApi(() => json({}, 202));
    expect(await post(context, { intent: "cancel", key: KEY, attempt: "2" })).toEqual({
      confirm: true,
      attempt: 2,
    });
    expect(calls).toHaveLength(0);
    const done = (await post(context, {
      intent: "cancel",
      key: KEY,
      attempt: "2",
      confirm: "yes",
    })) as Response;
    expect(done.headers.get("Location")).toBe(`${PAGE}?cancelled=1`);
    expect(new URL(calls[0]?.url as string).pathname).toBe(`${API}/cancel`);
  });

  it("shows a refusal in words", async () => {
    const { context } = fakeApi(() => json({ status: 409, code: "attempt_changed" }, 409));
    expect(await post(context, { intent: "rerun", key: KEY, attempt: "1" })).toEqual({
      error: "The run has a newer attempt; review it before acting.",
    });
  });

  it("answers a second send of the same form while the first still runs without calling it a failure", async () => {
    const { context, calls } = fakeApi(() =>
      json({ status: 409, code: "idempotency_key_in_use", detail: "Idempotency-Key" }, 409),
    );
    const answer = (await post(context, { intent: "rerun", key: KEY, attempt: "2" })) as Response;
    expect(answer.status).toBe(302);
    expect(answer.headers.get("Location")).toBe(`${PAGE}?pending=1`);
    expect(calls).toHaveLength(1);
  });

  it("names an earlier send whose outcome is unknown, and a rate limit, in words", async () => {
    for (const [status, code, words] of [
      [409, "idempotent_outcome_unknown", "may or may not have taken effect"],
      [429, "rate_limited", "Too many requests"],
    ] as const) {
      const { context } = fakeApi(() => json({ status, code, detail: "Idempotency-Key" }, status));
      const answer = (await post(context, { intent: "rerun", key: KEY, attempt: "2" })) as {
        error: string;
      };
      expect(answer.error).toContain(words);
      expect(answer.error).not.toContain("Idempotency-Key");
    }
  });

  it("says after that redirect that the request is still being handled", async () => {
    const { context } = fakeApi((request) => {
      const path = new URL(request.url).pathname;
      if (path === API) return json(run());
      if (path === `${API}/graph`) return json({ run_id: RUN_ID, run_attempt: 2, jobs: [] });
      return json({ id: "rep_1", owner: "acme", name: "web", permissions: { push: true } });
    });
    const data = await loader({
      request: new Request(`${ORIGIN}${PAGE}?pending=1`),
      context,
      params: { owner: "acme", repo: "web", run_id: RUN_ID },
    } as never);
    expect(data.notice).toContain("still being handled");
  });

  it("refuses a form it does not understand without calling the API", async () => {
    const { context, calls } = fakeApi(() => json({}, 201));
    expect(await post(context, { intent: "delete", key: KEY, attempt: "1" })).toMatchObject({
      error: expect.any(String),
    });
    expect(await post(context, { intent: "rerun", key: "x", attempt: "1" })).toMatchObject({
      error: expect.any(String),
    });
    expect(calls).toHaveLength(0);
  });

  const draw = (more: Record<string, unknown>, actionData?: unknown) =>
    renderPage(
      RunPage,
      PAGE,
      {
        repo: {
          id: "rep_1",
          owner: "acme",
          name: "web",
          description: null,
          default_branch: "main",
        },
        origin: ORIGIN,
        run: run(),
        attempt: 2,
        graph: { run_id: RUN_ID, run_attempt: 2, jobs: [] },
        canAct: true,
        key: KEY,
        notice: null,
        ...more,
      },
      actionData,
    );

  it("draws the actions a writer may take, and none for a reader or a past attempt", () => {
    expect(draw({})).toContain("Re-run all jobs");
    expect(draw({ canAct: false })).not.toContain("Re-run all jobs");
    expect(draw({ attempt: 1 })).not.toContain("Re-run all jobs");
    const waiting = draw({
      run: run({
        conclusion: "action_required",
        approval: approval("waiting"),
        pull_request: { number: 4 },
      }),
    });
    expect(waiting).toContain("Approve and run");
    expect(waiting).toContain('href="/acme/web/pull/4/files"');
    expect(waiting).toContain("Cancel run");
  });

  it("confirms a cancel for the attempt it was asked for, not a newer one", () => {
    const html = draw(
      { run: run({ status: "in_progress", conclusion: null, run_attempt: 3 }), attempt: 3 },
      {
        confirm: true,
        attempt: 2,
      },
    );
    const confirm = html.slice(html.indexOf('role="alert"'));
    expect(confirm).toContain('name="attempt" value="2"');
    expect(confirm).not.toContain('name="attempt" value="3"');
  });
});
