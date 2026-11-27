import { describe, expect, it } from "vitest";
import { ChecksSummary } from "../app/components/pull-checks.js";
import PullChecks, { loader } from "../app/routes/repo.pull.checks.js";
import { json, ORIGIN } from "./helpers/context.js";
import { api, pathOf, pullRequest } from "./helpers/pulls.js";
import { ACTIVE_TAG, HOSTILE, renderPage } from "./helpers/render.js";

const HEAD = "b".repeat(40);
const RUN = "01JD0000000000000000000000";
const BASE = "/api/repos/ada/demo";

const checkRun = (name: string, more: Record<string, unknown> = {}) => ({
  name,
  head_sha: HEAD,
  status: "completed",
  conclusion: "success",
  attempt: 1,
  run: { id: RUN, run_attempt: 1, job_id: 3 },
  details_url: null,
  updated_at: 1,
  ...more,
});

const status = (context: string, more: Record<string, unknown> = {}) => ({
  id: 1,
  state: "success",
  context,
  description: null,
  target_url: null,
  created_at: 1,
  updated_at: 1,
  creator: { id: "usr_bot" },
  ...more,
});

const routes = (more: Record<string, () => Response> = {}) => ({
  [`GET ${BASE}/pulls/7`]: () => json(pullRequest()),
  [`GET ${BASE}/commits/${HEAD}/check-runs`]: () =>
    json({ total_count: 2, check_runs: [checkRun("build"), checkRun("lint")], next_cursor: "c2" }),
  [`GET ${BASE}/commits/${HEAD}/status`]: () =>
    json({
      state: "success",
      sha: HEAD,
      total_count: 1,
      statuses: [status("deploy")],
      next_cursor: null,
    }),
  [`GET ${BASE}/pulls/7/required-checks`]: () =>
    json({
      head_sha: HEAD,
      strict: false,
      blocking: false,
      checks: [
        { context: "BUILD", integration_id: null, state: "passed", rulesets: [], deciding: [] },
        {
          context: "deploy",
          integration_id: "usr_other",
          state: "expected",
          rulesets: [],
          deciding: [],
        },
      ],
    }),
  ...more,
});

const load = (context: unknown, query = "") =>
  loader({
    request: new Request(`${ORIGIN}/ada/demo/pull/7/checks${query}`),
    context,
    params: { owner: "ada", repo: "demo", number: "7" },
  } as never);

describe("the Checks tab", () => {
  it("lists the head's check runs and statuses, required ones marked, each linked", async () => {
    const { context, calls } = api(routes());
    const data = await load(context);
    expect(calls.map(pathOf)).toContain(`GET ${BASE}/commits/${HEAD}/check-runs?per_page=100`);
    const html = renderPage(PullChecks, "/ada/demo/pull/7/checks", data);
    expect(html).toMatch(/aria-current="page"[^>]*>Checks</);
    expect(html).toContain(`href="/ada/demo/actions/runs/${RUN}/job/3"`);
    expect(html.match(/>Required</g)).toHaveLength(1);
    expect(html).toContain(`href="/ada/demo/pull/7/checks?head=${HEAD}&amp;checks_cursor=c2"`);
  });

  it("shows a check allowed to fail as neutral, not as completed", async () => {
    const { context } = api(
      routes({
        [`GET ${BASE}/commits/${HEAD}/check-runs`]: () =>
          json({
            total_count: 1,
            check_runs: [checkRun("flaky", { conclusion: "neutral" })],
            next_cursor: null,
          }),
      }),
    );
    const html = renderPage(PullChecks, "/ada/demo/pull/7/checks", await load(context));
    expect(html).toContain("Neutral");
    expect(html).not.toContain("Completed");
  });

  it("starts again when the head moved since its cursors", async () => {
    const { context, calls } = api(routes());
    const data = await load(context, `?head=${"c".repeat(40)}&checks_cursor=old`);
    expect(data.moved).toBe(true);
    expect(calls.map(pathOf)).toContain(`GET ${BASE}/commits/${HEAD}/check-runs?per_page=100`);
  });

  it("marks nothing required from another head's answer", async () => {
    const { context } = api(
      routes({
        [`GET ${BASE}/pulls/7/required-checks`]: () =>
          json({ head_sha: "d".repeat(40), strict: false, blocking: false, checks: [] }),
      }),
    );
    expect((await load(context)).required).toBeNull();
  });

  it("keeps the page when a read fails or answers garbage", async () => {
    const { context } = api(
      routes({
        [`GET ${BASE}/commits/${HEAD}/check-runs`]: () => new Response("{", { status: 200 }),
        [`GET ${BASE}/commits/${HEAD}/status`]: () => json({ code: "busy" }, 503),
      }),
    );
    const data = await load(context);
    expect(data.checks).toEqual({ state: "unavailable" });
    expect(data.statuses).toEqual({ state: "unavailable" });
    expect(renderPage(PullChecks, "/x", data)).toContain("could not be read");
  });
});

describe("the conversation's checks box", () => {
  const draw = (checks: unknown, statuses: unknown) =>
    renderPage(
      () => (
        <ChecksSummary
          checks={checks as never}
          statuses={statuses as never}
          required={null}
          owner="ada"
          repo="demo"
          tab="/ada/demo/pull/7/checks"
        />
      ),
      "/",
      {},
    );

  it("counts, lists what has not passed, and says when it saw only a first page", () => {
    const html = draw(
      {
        state: "read",
        body: {
          total_count: 300,
          check_runs: [checkRun("ok"), checkRun(HOSTILE, { conclusion: "failure" })],
          next_cursor: "c",
        },
      },
      { state: "read", body: { total_count: 0, statuses: [], next_cursor: null } },
    );
    expect(html).toMatch(/1(<!-- -->)? failing/);
    expect(html).toContain("of the first 100 of each");
    expect(html).not.toMatch(ACTIVE_TAG);
    expect(html).toContain('href="/ada/demo/pull/7/checks"');
  });

  it("names failing and pending statuses, alone or beside check runs", () => {
    const only = draw(
      { state: "read", body: { total_count: 0, check_runs: [], next_cursor: null } },
      {
        state: "read",
        body: {
          total_count: 2,
          statuses: [
            status("deploy", { state: "failure" }),
            status("lint", { id: 2, state: "pending" }),
          ],
          next_cursor: null,
        },
      },
    );
    expect(only).toContain(">deploy<");
    expect(only).toContain(">lint<");
    const mixed = draw(
      {
        state: "read",
        body: {
          total_count: 1,
          check_runs: [checkRun("build", { conclusion: "failure" })],
          next_cursor: null,
        },
      },
      {
        state: "read",
        body: {
          total_count: 2,
          statuses: [status("ok"), status("deploy", { id: 3, state: "error" })],
          next_cursor: null,
        },
      },
    );
    expect(mixed).toContain(">build<");
    expect(mixed).toContain(">deploy<");
    expect(mixed).not.toContain(">ok<");
  });

  it("counts and names an errored check as failing, and a neutral one as passed", () => {
    const html = draw(
      {
        state: "read",
        body: {
          total_count: 2,
          check_runs: [
            checkRun("broke", { conclusion: "error" }),
            checkRun("allowed", { conclusion: "neutral" }),
          ],
          next_cursor: null,
        },
      },
      { state: "read", body: { total_count: 0, statuses: [], next_cursor: null } },
    );
    expect(html.replaceAll("<!-- -->", "")).toContain("1 failing, 0 running, 1 passed");
    expect(html).toContain(">broke<");
    expect(html).toContain("Error</span>");
    expect(html).not.toContain("Completed");
    expect(html).not.toContain(">allowed<");
  });

  it("is absent without checks, and says when it could not read them", () => {
    const empty = {
      state: "read",
      body: { total_count: 0, check_runs: [], statuses: [], next_cursor: null },
    };
    expect(draw(empty, empty)).toBe("");
    expect(draw({ state: "unavailable" }, empty)).toContain("could not be read");
  });
});
