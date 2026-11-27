import { describe, expect, it } from "vitest";
import { attemptOf, type Job, type Run, type RunGraph } from "../app/lib/runs.js";
import {
  REFRESH_FIRST_MS,
  REFRESH_FOR_MS,
  REFRESH_MAX_MS,
  RefreshSchedule,
} from "../app/lib/use-run-refresh.js";
import RunPage, { loader as runLoader } from "../app/routes/repo.run.js";
import JobPage, { loader as jobLoader } from "../app/routes/repo.run-job.js";
import JobLog, { loader as logLoader, TEXT_PAGE_BYTES } from "../app/routes/repo.run-job-log.js";
import { nextLink, loader as rawLoader } from "../app/routes/repo.run-job-raw.js";
import { fakeApi, json, ORIGIN } from "./helpers/context.js";
import { ACTIVE_TAG, escaped, HOSTILE, renderPage } from "./helpers/render.js";

const REPO = {
  id: "rep_1",
  owner: "acme",
  name: "web",
  description: null,
  default_branch: "main",
  permissions: { admin: false, maintain: false, push: true, triage: true, pull: true },
};
const RUN_ID = "01JD0000000000000000000000";
const API = `/api/repos/acme/web/actions/runs/${RUN_ID}`;

const run = (more: Partial<Run> = {}): Run => ({
  id: RUN_ID,
  run_number: 4,
  name: "ci",
  display_title: "Fix the build",
  run_attempt: 2,
  head_sha: "a".repeat(40),
  head_branch: "main",
  event: "push",
  path: ".github/workflows/ci.yml",
  pull_request: null,
  fork: false,
  status: "completed",
  conclusion: "failure",
  actor: { id: "usr_1" },
  triggering_actor: { id: "usr_2" },
  created_at: Date.UTC(2026, 10, 20, 9),
  updated_at: Date.UTC(2026, 10, 20, 9, 5),
  run_started_at: Date.UTC(2026, 10, 20, 9),
  completed_at: Date.UTC(2026, 10, 20, 9, 2, 5),
  approval: null,
  errors: [],
  faults: [],
  ...more,
});

const instance = (id: number, name: string, more: Record<string, unknown> = {}) => ({
  id,
  name,
  status: "completed",
  conclusion: "success",
  started_at: 1,
  completed_at: 2,
  waiting_for: null,
  error: null,
  name_cut: false,
  ...more,
});

const graph = (): RunGraph =>
  ({
    run_id: RUN_ID,
    run_attempt: 2,
    jobs: [
      {
        key: "build",
        name: "build",
        needs: [],
        status: "completed",
        conclusion: "success",
        name_cut: false,
        jobs: [instance(1, "build")],
      },
      {
        key: "test",
        name: "test",
        needs: ["build"],
        status: "completed",
        conclusion: "failure",
        name_cut: false,
        jobs: [
          instance(2, "test (1)", { conclusion: "failure", error: "exit 1" }),
          instance(3, "test (2)", {
            waiting_for: "ci_minutes",
            status: "queued",
            conclusion: null,
          }),
        ],
      },
      {
        key: "deploy",
        name: "deploy",
        needs: ["test"],
        status: "pending",
        conclusion: null,
        name_cut: false,
        jobs: [],
      },
    ],
  }) as unknown as RunGraph;

const job = (more: Partial<Job> = {}): Job =>
  ({
    id: 2,
    run_id: RUN_ID,
    run_attempt: 2,
    name: "test (1)",
    job_key: "test",
    status: "completed",
    conclusion: "failure",
    started_at: 1,
    completed_at: 61_001,
    check: { state: "failure", code: null },
    log_complete: true,
    error: null,
    steps: [
      {
        number: 1,
        name: "Set up job",
        stage: "setup",
        status: "completed",
        conclusion: "success",
        started_at: 1,
        completed_at: 2,
        log: { from: 0, rows: 3 },
      },
      {
        number: 2,
        name: "Run npm test",
        stage: "main",
        status: "completed",
        conclusion: "failure",
        started_at: 2,
        completed_at: 3,
        log: { from: 3, rows: 10 },
      },
    ],
    waiting_for: null,
    ...more,
  }) as Job;

type Reply = Response | ((request: Request) => Response);

function api(replies: Record<string, Reply>) {
  return fakeApi(async (request) => {
    const reply = replies[`${request.method} ${new URL(request.url).pathname}`];
    if (reply === undefined) return json({ status: 404, code: "not_found" }, 404);
    return typeof reply === "function" ? reply(request) : reply.clone();
  });
}

const args = (path: string, context: unknown, params: Record<string, string> = {}) =>
  ({
    request: new Request(`${ORIGIN}${path}`),
    context,
    params: { owner: "acme", repo: "web", run_id: RUN_ID, ...params },
  }) as never;

describe("the run page's reads", () => {
  it("pins one attempt for the graph", async () => {
    const { context, calls } = api({
      "GET /api/repos/acme/web": json(REPO),
      [`GET ${API}`]: json(run()),
      [`GET ${API}/graph`]: json(graph()),
    });
    const data = await runLoader(args(`/acme/web/actions/runs/${RUN_ID}`, context));
    expect(data.attempt).toBe(2);
    const read = calls.find((c) => c.url.includes("/graph"));
    expect(new URL((read as Request).url).searchParams.get("attempt")).toBe("2");
    expect(calls.some((c) => c.url.includes("/jobs"))).toBe(false);
  });

  it("answers 404 for an attempt the run does not have", async () => {
    const { context } = api({
      "GET /api/repos/acme/web": json(REPO),
      [`GET ${API}`]: json(run()),
    });
    await expect(
      runLoader(args(`/acme/web/actions/runs/${RUN_ID}?attempt=3`, context)),
    ).rejects.toMatchObject({ init: { status: 404 } });
    expect(attemptOf("0", 2)).toBeNull();
    expect(attemptOf("1", 2)).toBe(1);
    expect(attemptOf(null, 2)).toBe(2);
    expect(attemptOf("1e1", 20)).toBeNull();
  });

  it("draws the run without its graph when the graph is too large to read", async () => {
    const { context } = api({
      "GET /api/repos/acme/web": json(REPO),
      [`GET ${API}`]: json(run()),
      [`GET ${API}/graph`]: () =>
        new Response("x".repeat(10), { headers: { "Content-Length": String(3 * 1024 * 1024) } }),
    });
    const data = await runLoader(args(`/acme/web/actions/runs/${RUN_ID}`, context));
    expect(data.graph).toBeNull();
  });

  it("answers the API's status for a run it cannot read", async () => {
    const { context } = api({
      "GET /api/repos/acme/web": json(REPO),
      [`GET ${API}`]: json({ status: 404, code: "run_not_found" }, 404),
    });
    await expect(
      runLoader(args(`/acme/web/actions/runs/${RUN_ID}`, context)),
    ).rejects.toMatchObject({ init: { status: 404 } });
  });
});

describe("drawing a run", () => {
  const draw = (more: Record<string, unknown> = {}) =>
    renderPage(RunPage, `/acme/web/actions/runs/${RUN_ID}`, {
      repo: REPO,
      origin: ORIGIN,
      run: run(),
      attempt: 2,
      graph: graph(),
      canAct: true,
      ...more,
    });

  it("links each job the graph has, and none for a job not started", () => {
    const html = draw();
    expect(html).toContain(`href="/acme/web/actions/runs/${RUN_ID}/job/1"`);
    expect(html).toContain(`href="/acme/web/actions/runs/${RUN_ID}/job/2"`);
    expect(html).toContain(`href="/acme/web/actions/runs/${RUN_ID}/job/3"`);
    expect(html).toContain('href="#job-test"');
    expect(html).toMatch(/Waiting for (<!-- -->)?test/);
    expect(html).not.toContain('href="#job-deploy"');
    expect(html).toContain("Waiting for the account&#x27;s CI minutes");
    expect(html).toContain("exit 1");
    expect(html).toMatch(/aria-label="Stage 3"/);
  });

  it("names the API's jobs of the attempt when the graph cannot be drawn", () => {
    expect(draw({ graph: null, attempt: 1 })).toMatch(/\/jobs\?attempt=(<!-- -->)?1/);
  });

  it("draws a one-job card in its job's state", () => {
    const g = graph() as unknown as {
      jobs: { status: string; jobs: { status: string; conclusion: string | null }[] }[];
    };
    const build = g.jobs[0] as {
      status: string;
      jobs: { status: string; conclusion: string | null }[];
    };
    build.status = "in_progress";
    build.jobs = [{ ...(build.jobs[0] as object), status: "queued", conclusion: null } as never];
    const html = draw({ graph: g });
    const card = html.slice(html.indexOf('data-card="build"'), html.indexOf('data-card="test"'));
    expect(card).toContain("Queued");
    expect(card).not.toContain("In progress");
  });

  it("says a past attempt is one, and the run's state is the current one's", () => {
    const html = draw({ attempt: 1 });
    expect(html).toMatch(/Attempt (<!-- -->)?1(<!-- -->)? of (<!-- -->)?2/);
    expect(html).toContain("View the current attempt");
  });

  it("lists why a workflow could not run, and that a run waits for approval", () => {
    const html = draw({
      run: run({
        errors: [
          {
            code: "unsupported_key",
            feature: "",
            path: "jobs.a",
            line: 3,
            column: 5,
            message: "Nope",
          },
        ],
        approval: { state: "waiting", decided_by: null, decided_at: null },
      }),
      graph: { run_id: RUN_ID, run_attempt: 2, jobs: [] },
    });
    expect(html).toMatch(/\.github\/workflows\/ci\.yml(<!-- -->)?:3:5/);
    expect(html).toContain("maintainer&#x27;s approval");
  });

  it("escapes what a workflow author wrote", () => {
    const g = graph() as unknown as {
      jobs: { name: string; jobs: { name: string; error: string | null }[] }[];
    };
    for (const node of g.jobs) {
      node.name = HOSTILE;
      for (const j of node.jobs) {
        j.name = HOSTILE;
        j.error = HOSTILE;
      }
    }
    const html = draw({ run: run({ display_title: HOSTILE, head_branch: HOSTILE }), graph: g });
    expect(html.replace(/<svg class="graph-edges"[^>]*><\/svg>/, "")).not.toMatch(ACTIVE_TAG);
    expect(html).toContain(escaped(HOSTILE));
  });
});

describe("the job page", () => {
  it("reads the job by its id and keeps a bare link after a re-run", async () => {
    const { context, calls } = api({
      "GET /api/repos/acme/web": json(REPO),
      [`GET ${API}`]: json(run({ run_attempt: 3 })),
      [`GET ${API}/jobs/2`]: json(job()),
    });
    const data = await jobLoader(
      args(`/acme/web/actions/runs/${RUN_ID}/job/2`, context, { job_id: "2" }),
    );
    expect(data.job.run_attempt).toBe(2);
    expect(calls.map((c) => new URL(c.url).pathname)).toContain(`${API}/jobs/2`);
    const html = renderPage(JobPage, `/acme/web/actions/runs/${RUN_ID}/job/2`, data);
    expect(html).toMatch(/Attempt (<!-- -->)?2(<!-- -->)? of (<!-- -->)?3/);
    expect(html).toContain("Run npm test");
    expect(html).toMatch(/lines (<!-- -->)?4(<!-- -->)? to (<!-- -->)?13/);
    expect(html).toContain(`href="/acme/web/actions/runs/${RUN_ID}/job/2/log"`);
  });

  it("answers 404 for an attempt that is not the job's, and for a malformed id", async () => {
    const { context } = api({
      "GET /api/repos/acme/web": json(REPO),
      [`GET ${API}`]: json(run()),
      [`GET ${API}/jobs/2`]: json(job()),
    });
    await expect(
      jobLoader(args(`/acme/web/actions/runs/${RUN_ID}/job/2?attempt=1`, context, { job_id: "2" })),
    ).rejects.toMatchObject({ init: { status: 404 } });
    await expect(
      jobLoader(args(`/acme/web/actions/runs/${RUN_ID}/job/02`, context, { job_id: "02" })),
    ).rejects.toMatchObject({ init: { status: 404 } });
  });
});

describe("reading a log as text", () => {
  const base = {
    "GET /api/repos/acme/web": json(REPO),
    [`GET ${API}/jobs/2`]: json(job()),
  };
  const read = (context: unknown, query = "") =>
    logLoader(args(`/acme/web/actions/runs/${RUN_ID}/job/2/log${query}`, context, { job_id: "2" }));

  it("asks for one bounded page from its cursor, and links the next", async () => {
    const { context, calls } = api({
      ...base,
      [`GET ${API}/jobs/2/logs/rows`]: json({
        rows: [
          { i: 0, t: 1, c: "\u001b[31mred\u001b[0m and \u001b]8;;x\u0007link" },
          { i: 1, omitted: "row_too_large", bytes: 9 },
          { i: 2, t: 1, c: "part", o: 4, end: false },
        ],
        state: "streaming",
        end: 3,
        next_cursor: "n2",
      }),
    });
    const data = await read(context, "?cursor=n1");
    const query = new URL(calls.find((c) => c.url.includes("/logs/rows"))?.url as string)
      .searchParams;
    expect(Object.fromEntries(query)).toEqual({ max_bytes: String(TEXT_PAGE_BYTES), cursor: "n1" });
    const html = renderPage(JobLog, `/acme/web/actions/runs/${RUN_ID}/job/2/log`, data);
    expect(html).toContain("red and ␛link");
    expect(html).toMatch(/\[row omitted: (<!-- -->)?9(<!-- -->)? bytes\]/);
    expect(html).toContain("(continued)");
    expect(html).toContain(`href="/acme/web/actions/runs/${RUN_ID}/job/2/log?cursor=n2"`);
  });

  it.each([
    [410, "log_unavailable", "before logs were masked"],
    [429, "log_reads_spent", "used up for today"],
    [503, "log_busy", "busy storing logs"],
    [422, "invalid_cursor", "no longer valid"],
  ])("says what a %i %s means", async (status, code, words) => {
    const { context } = api({
      ...base,
      [`GET ${API}/jobs/2/logs/rows`]: json(
        { status, code, retry_at: Date.UTC(2026, 10, 27) },
        status,
      ),
    });
    const data = await read(context);
    expect(data.reading).toMatchObject({ kind: "refused" });
    expect(renderPage(JobLog, "/x", data)).toContain(words);
  });

  it("tells a queued job from one that never got a runner", async () => {
    for (const [next, words] of [
      ["c", "Waiting for a runner."],
      [null, "never got a runner"],
    ] as const) {
      const { context } = api({
        ...base,
        [`GET ${API}/jobs/2/logs/rows`]: json({
          rows: [],
          state: "none",
          end: 0,
          next_cursor: next,
        }),
      });
      expect(renderPage(JobLog, "/x", await read(context))).toContain(words);
    }
  });
});

describe("the raw log", () => {
  const raw = (context: unknown, query = "") =>
    rawLoader(
      args(`/acme/web/actions/runs/${RUN_ID}/job/2/raw${query}`, context, { job_id: "2" }),
    ) as Promise<Response>;

  it("passes a page through with the API's safety headers and a next link of its own", async () => {
    const { context } = api({
      [`GET ${API}/jobs/2/logs`]: new Response("line\n", {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Security-Policy": "default-src 'none'; sandbox",
          "X-Content-Type-Options": "nosniff",
          "X-Fyrden-Log-State": "complete",
          "Set-Cookie": "a=b",
          Link: `<https://api.test${API}/jobs/2/logs?cursor=abc>; rel="next"`,
        },
      }),
    });
    const res = await raw(context);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("line\n");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("Content-Security-Policy")).toBe("default-src 'none'; sandbox");
    expect(res.headers.get("Set-Cookie")).toBeNull();
    expect(res.headers.get("Link")).toBe(
      `</acme/web/actions/runs/${RUN_ID}/job/2/raw?cursor=abc>; rel="next"`,
    );
  });

  it("answers refusals in words, never the API's problem, and never cached", async () => {
    for (const [status, code] of [
      [404, "log_not_found"],
      [429, "rate_limited"],
      [503, "log_busy"],
      [500, "internal"],
    ] as const) {
      const { context } = api({
        [`GET ${API}/jobs/2/logs`]: json({ status, code, request_id: "req_secret" }, status, {
          "Retry-After": "7",
        }),
      });
      const res = await raw(context);
      expect(res.status).toBe(status === 500 ? 502 : status);
      expect(res.headers.get("Cache-Control")).toBe("private, no-store");
      expect(res.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
      expect(await res.text()).not.toContain("req_secret");
    }
  });

  it("sends a signed-out reader to sign in, uncached", async () => {
    const { context } = api({ [`GET ${API}/jobs/2/logs`]: json({ status: 401 }, 401) });
    const res = await raw(context);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("sign-in");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("keeps only the cursor of the API's next link", () => {
    expect(nextLink('<https://x/a?cursor=c%2B1&tail=5>; rel="next"', "/p")).toBe(
      '</p?cursor=c%2B1>; rel="next"',
    );
    expect(nextLink(null, "/p")).toBeNull();
    expect(nextLink('<https://x/a>; rel="next"', "/p")).toBeNull();
  });
});

describe("refreshing an unfinished run", () => {
  it("backs off while nothing changes, and starts again after a change", () => {
    const schedule = new RefreshSchedule();
    expect(schedule.next("a", "s1", 0)).toBe(REFRESH_FIRST_MS);
    expect(schedule.next("a", "s1", 1)).toBe(2 * REFRESH_FIRST_MS);
    for (let k = 0; k < 10; k++) schedule.next("a", "s1", 2);
    expect(schedule.next("a", "s1", 3)).toBe(REFRESH_MAX_MS);
    expect(schedule.next("a", "s2", 4)).toBe(REFRESH_FIRST_MS);
  });

  it("stops after its bound, and starts afresh for another run", () => {
    const schedule = new RefreshSchedule();
    schedule.next("a", "s", 0);
    expect(schedule.next("a", "s", REFRESH_FOR_MS + 1)).toBeNull();
    expect(schedule.next("b", "s", REFRESH_FOR_MS + 2)).toBe(REFRESH_FIRST_MS);
    expect(schedule.expired(2 * REFRESH_FOR_MS + 2)).toBe(false);
    expect(schedule.expired(2 * REFRESH_FOR_MS + 3)).toBe(true);
    expect(schedule.next("b", "s", REFRESH_FOR_MS + 3)).toBe(2 * REFRESH_FIRST_MS);
  });
});
