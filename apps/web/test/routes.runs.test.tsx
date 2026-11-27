import { matchRoutes } from "react-router";
import { describe, expect, it } from "vitest";
import type { RunSummary } from "../app/lib/runs.js";
import Actions, { loader as actionsLoader } from "../app/routes/repo.actions.js";
import routes from "../app/routes.js";
import { fakeApi, json, ORIGIN } from "./helpers/context.js";
import { ACTIVE_TAG, escaped, HOSTILE, renderPage } from "./helpers/render.js";

const REPO = { id: "rep_1", owner: "acme", name: "web", description: null, default_branch: "main" };
const RUN_ID = "01JD0000000000000000000000";

const summary = (more: Partial<RunSummary> = {}): RunSummary => ({
  id: RUN_ID,
  run_number: 4,
  name: "ci",
  display_title: "Fix the build",
  run_attempt: 1,
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
  created_at: Date.UTC(2026, 10, 20, 9),
  updated_at: Date.UTC(2026, 10, 20, 9, 5),
  run_started_at: Date.UTC(2026, 10, 20, 9),
  completed_at: Date.UTC(2026, 10, 20, 9, 2, 5),
  ...more,
});

type Reply = Response | ((request: Request) => Response);

function api(replies: Record<string, Reply>) {
  return fakeApi(async (request) => {
    const reply = replies[`${request.method} ${new URL(request.url).pathname}`];
    if (reply === undefined) return json({ status: 404, code: "not_found" }, 404);
    return typeof reply === "function" ? reply(request) : reply.clone();
  });
}

const base = {
  "GET /api/repos/acme/web": json(REPO),
  "GET /api/repos/acme/web/actions/workflows": json({
    workflows: [{ id: "ci.yml", path: ".github/workflows/ci.yml", name: "ci", latest_run: null }],
    next_cursor: null,
  }),
};

const load = (context: unknown, path: string, params: Record<string, string> = {}) =>
  actionsLoader({
    request: new Request(`${ORIGIN}${path}`),
    context,
    params: { owner: "acme", repo: "web", ...params },
  } as never);

const queryOf = (call: Request | undefined) => new URL((call as Request).url).searchParams;

describe("the runs list", () => {
  it("is routed under the repository's actions", () => {
    const ids = (path: string) =>
      matchRoutes(
        routes.map((r) => ({ path: r.path ?? "", id: r.id ?? r.file })),
        path,
      )?.map((m) => m.route.id);
    expect(ids("/acme/web/actions")).toEqual(["routes/repo.actions.tsx"]);
    expect(ids("/acme/web/actions/workflows/ci.yml")).toEqual(["repo.actions.workflow"]);
  });

  it("asks the API for one page with the filters it takes", async () => {
    const { context, calls } = api({
      ...base,
      "GET /api/repos/acme/web/actions/runs": json({
        workflow_runs: [summary()],
        next_cursor: "c2",
      }),
    });
    const data = await load(
      context,
      `/acme/web/actions?status=failure&branch=main&sha=${"B".repeat(40)}&cursor=c1&bogus=1`,
    );
    const runs = calls.find((c) => new URL(c.url).pathname.endsWith("/actions/runs"));
    expect(Object.fromEntries(queryOf(runs))).toEqual({
      per_page: "30",
      status: "failure",
      branch: "main",
      head_sha: "b".repeat(40),
      cursor: "c1",
    });
    expect(data.listing).toEqual({ kind: "runs", runs: [summary()], next: "c2" });
    expect(data.workflows?.workflows).toHaveLength(1);
  });

  it("reads one workflow's runs on its page", async () => {
    const { context, calls } = api({
      ...base,
      "GET /api/repos/acme/web/actions/workflows/ci.yml/runs": json({
        workflow_runs: [],
        next_cursor: null,
      }),
    });
    const data = await load(context, "/acme/web/actions/workflows/ci.yml", { workflow: "ci.yml" });
    expect(calls.some((c) => c.url.endsWith("/actions/workflows/ci.yml/runs?per_page=30"))).toBe(
      true,
    );
    expect(data.workflow).toBe("ci.yml");
  });

  it("sends nothing for filters it cannot send, and names them", async () => {
    const { context, calls } = api(base);
    const data = await load(context, "/acme/web/actions?sha=nope");
    expect(calls.some((c) => c.url.includes("/actions/runs"))).toBe(false);
    expect(data.listing).toMatchObject({ kind: "filter-errors" });
  });

  it("leads back from a cursor that no longer holds", async () => {
    const { context } = api({
      ...base,
      "GET /api/repos/acme/web/actions/runs": json({ status: 422, code: "invalid_cursor" }, 422),
    });
    expect((await load(context, "/acme/web/actions?cursor=old")).listing).toEqual({
      kind: "stale-cursor",
    });
  });

  it("shows the API's words for filters it refuses", async () => {
    const { context } = api({
      ...base,
      "GET /api/repos/acme/web/actions/runs": json(
        { status: 422, code: "invalid_input", detail: "created: not a date range" },
        422,
      ),
    });
    expect((await load(context, "/acme/web/actions")).listing).toEqual({
      kind: "refused",
      detail: "created: not a date range",
    });
  });

  it("answers the API's status for a repository it cannot read", async () => {
    const { context } = api({
      "GET /api/repos/acme/web": json({ status: 404, code: "repo_not_found" }, 404),
      "GET /api/repos/acme/web/actions/runs": json({ status: 404, code: "repo_not_found" }, 404),
    });
    await expect(load(context, "/acme/web/actions")).rejects.toMatchObject({
      init: { status: 404 },
    });
  });

  it("still lists runs when the workflows cannot be read", async () => {
    const { context } = fakeApi(async (request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/workflows")) throw new Error("binding down");
      if (path.endsWith("/actions/runs")) return json({ workflow_runs: [], next_cursor: null });
      return json(REPO);
    });
    const data = await load(context, "/acme/web/actions");
    expect(data.workflows).toBeNull();
    expect(data.listing).toMatchObject({ kind: "runs" });
  });
});

describe("the runs list's sidebar and names", () => {
  it("reads a workflow file's name from its own path segment, decoded once", async () => {
    const { context, calls } = api({
      ...base,
      "GET /api/repos/acme/web/actions/workflows/a%252Fb.yml/runs": json({
        workflow_runs: [],
        next_cursor: null,
      }),
    });
    const data = await load(context, "/acme/web/actions/workflows/a%252Fb.yml", {
      workflow: "a/b.yml",
    });
    expect(data.workflow).toBe("a%2Fb.yml");
    expect(calls.some((c) => new URL(c.url).pathname.endsWith("/workflows/a%252Fb.yml/runs"))).toBe(
      true,
    );
  });

  it("reads the workflow's name from a client navigation's data request too", async () => {
    const { context, calls } = api({
      ...base,
      "GET /api/repos/acme/web/actions/workflows/lint.yml/runs": json({
        workflow_runs: [],
        next_cursor: null,
      }),
    });
    const data = await load(context, "/acme/web/actions/workflows/lint.yml.data", {
      workflow: "lint.yml",
    });
    expect(data.workflow).toBe("lint.yml");
    expect(calls.some((c) => new URL(c.url).pathname.endsWith("/workflows/lint.yml/runs"))).toBe(
      true,
    );
  });

  it("pages the workflows on their own cursor", async () => {
    const { context, calls } = api({
      ...base,
      "GET /api/repos/acme/web/actions/runs": json({ workflow_runs: [], next_cursor: null }),
    });
    await load(context, "/acme/web/actions?status=failure&workflows_cursor=w2&cursor=r9");
    const workflows = calls.find((c) => new URL(c.url).pathname.endsWith("/actions/workflows"));
    expect(Object.fromEntries(queryOf(workflows))).toEqual({ per_page: "100", cursor: "w2" });
    const runs = calls.find((c) => new URL(c.url).pathname.endsWith("/actions/runs"));
    expect(queryOf(runs).get("cursor")).toBe("r9");
  });
});

describe("drawing the runs list", () => {
  const page = (listing: unknown, more: Record<string, unknown> = {}) =>
    renderPage(Actions, "/acme/web/actions", {
      repo: REPO,
      origin: ORIGIN,
      workflow: null,
      filters: {},
      cursor: null,
      listing,
      workflows: { workflows: [], next_cursor: null },
      ...more,
    });

  it("escapes what a workflow author wrote", () => {
    const html = page({
      kind: "runs",
      runs: [summary({ display_title: HOSTILE, name: HOSTILE, head_branch: HOSTILE })],
      next: null,
    });
    expect(html).not.toMatch(ACTIVE_TAG);
    expect(html).toContain(escaped(HOSTILE));
  });

  it("links each run, its commit and its pull request, with its state in words", () => {
    const html = page({
      kind: "runs",
      runs: [
        summary({
          pull_request: { number: 9 },
          fork: true,
          status: "in_progress",
          conclusion: null,
        }),
      ],
      next: null,
    });
    expect(html).toContain(`href="/acme/web/actions/runs/${RUN_ID}"`);
    expect(html).toContain('href="/acme/web/pull/9"');
    expect(html).toContain(`href="/acme/web/tree/${"a".repeat(40)}"`);
    expect(html).toContain("In progress");
    expect(html).toContain("(fork)");
    expect(html).toMatch(/aria-current="page"[^>]*>Actions</);
  });

  it("pages on with the same filters, and an empty stretch still offers older runs", () => {
    const html = page(
      { kind: "runs", runs: [], next: "c9" },
      { filters: { status: "failure" }, cursor: "c1" },
    );
    expect(html).toContain("No runs matched in this stretch of history.");
    expect(html).toContain('href="/acme/web/actions?status=failure&amp;cursor=c9"');
    expect(html).toContain('href="/acme/web/actions?status=failure"');
  });

  it("says where workflows go when there are no runs", () => {
    expect(page({ kind: "runs", runs: [], next: null })).toContain(".github/workflows");
  });

  it("keeps the filters on the sidebar's links, and pages it", () => {
    const html = page(
      { kind: "runs", runs: [], next: null },
      {
        filters: { status: "failure", branch: "main" },
        workflows: {
          workflows: [
            { id: "a%2Fb.yml", path: ".github/workflows/a%2Fb.yml", name: null, latest_run: null },
          ],
          next_cursor: "w2",
        },
        workflow: "a%2Fb.yml",
      },
    );
    expect(html).toContain('href="/acme/web/actions?status=failure&amp;branch=main"');
    expect(html).toMatch(
      /aria-current="page" href="\/acme\/web\/actions\/workflows\/a%252Fb.yml\?status=failure&amp;branch=main"/,
    );
    expect(html).toContain(
      'href="/acme/web/actions/workflows/a%252Fb.yml?status=failure&amp;branch=main&amp;workflows_cursor=w2" data-discover="true">More workflows',
    );
  });

  it("marks the sidebar's cap", () => {
    const html = page(
      { kind: "runs", runs: [], next: null },
      { workflows: { workflows: [], next_cursor: "w2" } },
    );
    expect(html).toMatch(/Workflows with runs(<!-- -->)? \(100 a page\)/);
  });
});
