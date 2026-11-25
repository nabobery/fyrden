// An organization's runner settings: what a token form and a runner's form
// send to the API, that a page left open changes only what was changed on
// it, each refusal on its field, a registration token shown once and kept
// nowhere else, and what each page shows of a runner.

import { matchRoutes } from "react-router";
import { describe, expect, it } from "vitest";
import { ORG_SETTINGS } from "../app/components/settings-shell.js";
import { accessText, type RunnerDetail, runnerErrors, runnerState } from "../app/lib/runners.js";
import RunnerPage, {
  action as runnerAction,
  loader as runnerLoader,
} from "../app/routes/org.runner.js";
import NewRunner, {
  action as newAction,
  loader as newLoader,
} from "../app/routes/org.runner-new.js";
import Runners, {
  action as runnersAction,
  loader as runnersLoader,
} from "../app/routes/org.runners.js";
import routes from "../app/routes.js";
import { fakeApi, formPost, json, ORIGIN } from "./helpers/context.js";
import { ACTIVE_TAG, escaped, HOSTILE, renderPage } from "./helpers/render.js";

const TOKEN = "fyrden_run_canary-4d1c";
const API = "/api/orgs/acme/actions/runners";
const PAGE = "/settings/orgs/acme/runners";

const runner = (more: Partial<RunnerDetail> = {}): RunnerDetail => ({
  id: 7,
  name: "build-1",
  labels: ["ubuntu-latest"],
  version: "v6.0.0",
  ephemeral: true,
  created_at: Date.UTC(2030, 0, 1),
  declared_at: Date.UTC(2030, 0, 2),
  revoked_at: null,
  revoked_reason: null,
  repository_access: "all",
  allows_public: false,
  allows_forks: false,
  selected_count: 0,
  task_assigned_at: null,
  repositories: [],
  ...more,
});

type Reply = Response | ((request: Request) => Response | Promise<Response>);

function api(replies: Record<string, Reply>) {
  return fakeApi(async (request) => {
    const reply = replies[`${request.method} ${new URL(request.url).pathname}`];
    if (reply === undefined) return json({ status: 404, code: "not_found" }, 404);
    return typeof reply === "function" ? reply(request) : reply.clone();
  });
}

const problem = (status: number, code: string, detail?: string) =>
  json({ status, code, ...(detail && { detail }) }, status);

const bodyOf = (call: Request | undefined) => (call as Request).clone().json();

// biome-ignore lint/suspicious/noExplicitAny: each action's own arguments
const run = async (action: any, context: unknown, path: string, fields: Record<string, string>) =>
  action({
    request: formPost(path, fields),
    context,
    params: { org: "acme", id: "7" },
  } as never);

describe("making a registration token", () => {
  const mint = `POST ${API}/registration-token`;
  const post = (context: unknown, fields: Record<string, string>) =>
    run(newAction, context, `${PAGE}/new`, fields);

  it("sends the access chosen, and the token is in the answer alone", async () => {
    const { context, calls } = api({ [mint]: json({ token: TOKEN, expires_at: 1 }, 201) });
    const made = await post(context, { repository_access: "all", allows_forks: "on" });
    expect(made).toEqual({ token: TOKEN, forks: true });
    expect(await bodyOf(calls[0])).toEqual({
      repository_access: "all",
      allows_public: false,
      allows_forks: true,
    });
    const page = renderPage(NewRunner, `${PAGE}/new`, { org: "acme", origin: ORIGIN }, made);
    expect(page).toContain(`--instance ${ORIGIN} --token ${TOKEN} --ephemeral`);
    // The runner reads no configuration it is not given, so both commands give it.
    expect(page).toContain("gitea-runner register --config config.yaml ");
    expect(page).toContain("gitea-runner daemon --config config.yaml");
    // A token that takes forks shows no long-lived command.
    expect(page.split(TOKEN)).toHaveLength(2);
  });

  it("shows both commands for a token without forks", () => {
    const page = renderPage(
      NewRunner,
      `${PAGE}/new`,
      { org: "acme", origin: ORIGIN },
      { token: TOKEN, forks: false },
    );
    expect(page.split(TOKEN)).toHaveLength(3);
  });

  it("looks up selected repositories by name, each once", async () => {
    const { context, calls } = api({
      "GET /api/repos/acme/web": json({ id: "rep_1" }),
      "GET /api/repos/acme/api": json({ id: "rep_2" }),
      [mint]: json({ token: TOKEN }, 201),
    });
    await post(context, { repository_access: "selected", repositories: "web\r\napi, web\r\n" });
    expect(calls).toHaveLength(3);
    expect(await bodyOf(calls[2])).toMatchObject({
      repository_access: "selected",
      selected_repository_ids: ["rep_1", "rep_2"],
    });
  });

  it.each([
    [{}, "access"],
    [{ repository_access: "some" }, "access"],
    [{ repository_access: "all", repositories: "web" }, "repositories"],
    [{ repository_access: "selected", repositories: "missing" }, "repositories"],
    [{ repository_access: "selected", repositories: "../x" }, "repositories"],
    [
      {
        repository_access: "selected",
        repositories: Array.from({ length: 21 }, (_, i) => `r${i}`).join("\n"),
      },
      "repositories",
    ],
  ])("refuses %j on its field, minting nothing and keeping what was typed", async (fields, at) => {
    const { context, calls } = api({ [mint]: json({ token: TOKEN }, 201) });
    const refused = await post(context, fields as Record<string, string>);
    expect(refused.errors[at]).toEqual(expect.any(String));
    expect(refused.repositories).toBe((fields as { repositories?: string }).repositories ?? "");
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("a signed-out post goes to sign in, and a failure says why", async () => {
    const out = api({ [mint]: problem(401, "unauthorized") });
    await expect(post(out.context, { repository_access: "all" })).rejects.toMatchObject({
      status: 302,
    });
    const off = api({ [mint]: problem(409, "runners_off") });
    expect((await post(off.context, { repository_access: "all" })).errors.form).toMatch(
      /turned off/,
    );
  });

  it("a member gets the API's refusal, not the form", async () => {
    const { context } = api({ [`GET ${API}`]: problem(403, "forbidden") });
    await expect(
      newLoader({
        request: new Request(`${ORIGIN}${PAGE}/new`),
        context,
        params: { org: "acme" },
      } as never),
    ).rejects.toMatchObject({ init: { status: 403 } });
  });

  it("a post from another site is refused", async () => {
    const { context, calls } = api({ [mint]: json({ token: TOKEN }, 201) });
    const request = formPost(`${PAGE}/new`, { repository_access: "all" });
    request.headers.set("Origin", "https://evil.test");
    await expect(
      newAction({ request, context, params: { org: "acme" } } as never),
    ).rejects.toBeDefined();
    expect(calls).toHaveLength(0);
  });
});

describe("cancelling unused tokens", () => {
  const path = `DELETE ${API}/registration-token`;
  const cancel = (context: unknown, fields: Record<string, string>) =>
    run(runnersAction, context, PAGE, fields);

  it("asks the API once, and says how many", async () => {
    const { context, calls } = api({ [path]: json({ cancelled: 2 }) });
    const done = await cancel(context, { intent: "cancel-tokens" });
    expect(calls).toHaveLength(1);
    expect(done.headers.get("Location")).toBe(`${PAGE}?cancelled=2`);
    const list = (query: string) =>
      renderPage(Runners, `${PAGE}${query}`, {
        org: "acme",
        revoked: false,
        runners: [],
        pages: { next: null, first: null },
      });
    expect(list("?cancelled=2")).toContain("Cancelled 2 unused tokens.");
    expect(list("?cancelled=1")).toContain("Cancelled 1 unused token.");
    expect(list("?cancelled=0")).toContain("There was no unused token.");
    expect(list("?cancelled=%3Cb%3E")).not.toContain('role="status"');
  });

  it("does nothing for another intent, and shows a refusal", async () => {
    const none = api({ [path]: json({ cancelled: 2 }) });
    expect(await cancel(none.context, { intent: "other" })).toHaveProperty("errors");
    expect(none.calls).toHaveLength(0);
    const refused = api({ [path]: problem(403, "forbidden") });
    expect(await cancel(refused.context, { intent: "cancel-tokens" })).toMatchObject({
      errors: { form: expect.any(String) },
    });
    const out = api({ [path]: problem(401, "unauthorized") });
    await expect(cancel(out.context, { intent: "cancel-tokens" })).rejects.toMatchObject({
      status: 302,
    });
  });

  it("a post from another site is refused", async () => {
    const { context, calls } = api({ [path]: json({ cancelled: 1 }) });
    const request = formPost(PAGE, { intent: "cancel-tokens" });
    request.headers.set("Origin", "https://evil.test");
    await expect(
      runnersAction({ request, context, params: { org: "acme" } } as never),
    ).rejects.toBeDefined();
    expect(calls).toHaveLength(0);
  });
});

describe("a runner's access form", () => {
  const patch = `PATCH ${API}/7/access`;
  const was = { was_repository_access: "all", was_allows_public: "off", was_allows_forks: "off" };
  const save = (context: unknown, fields: Record<string, string>) =>
    run(runnerAction, context, `${PAGE}/7`, { intent: "access", ...fields });

  it("sends only what changed on it", async () => {
    const { context, calls } = api({ [patch]: json(runner()) });
    const saved = await save(context, { ...was, repository_access: "all", allows_public: "on" });
    expect(await bodyOf(calls[0])).toEqual({ allows_public: true });
    expect((saved as Response).headers.get("Location")).toBe(`${PAGE}/7?changed=wider`);
  });

  it("a page left open narrows without sending back the access it was shown", async () => {
    const { context, calls } = api({ [patch]: json(runner()) });
    const saved = await save(context, {
      was_repository_access: "all",
      was_allows_public: "on",
      was_allows_forks: "on",
      repository_access: "all",
      allows_public: "on",
    });
    expect(await bodyOf(calls[0])).toEqual({ allows_forks: false });
    expect((saved as Response).headers.get("Location")).toBe(`${PAGE}/7?changed=narrower`);
  });

  it("a long-lived runner's form never sends fork access", async () => {
    const { context, calls } = api({ [patch]: json(runner()) });
    await save(context, {
      was_repository_access: "all",
      was_allows_public: "off",
      repository_access: "selected",
      allows_forks: "on",
    });
    expect(await bodyOf(calls[0])).toEqual({ repository_access: "selected" });
  });

  it("sends nothing when nothing changed, and shows each refusal on its field", async () => {
    const none = api({ [patch]: json(runner()) });
    expect(await save(none.context, { ...was, repository_access: "all" })).toMatchObject({
      errors: { form: expect.any(String) },
    });
    expect(none.calls).toHaveLength(0);
    const forks = api({ [patch]: problem(422, "forks_need_ephemeral") });
    expect(
      await save(forks.context, { ...was, repository_access: "all", allows_forks: "on" }),
    ).toMatchObject({ errors: { forks: expect.any(String) }, change: { allows_forks: true } });
  });

  it("adds a repository by name and removes one by id", async () => {
    const { context, calls } = api({
      "GET /api/repos/acme/web": json({ id: "rep_1" }),
      [`PUT ${API}/7/repositories/rep_1`]: new Response(null, { status: 204 }),
      [`DELETE ${API}/7/repositories/rep_1`]: new Response(null, { status: 204 }),
    });
    const added = await run(runnerAction, context, `${PAGE}/7`, {
      intent: "add-repository",
      repository: "web",
    });
    expect(added.headers.get("Location")).toBe(`${PAGE}/7?added=web&changed=wider`);
    const removed = await run(runnerAction, context, `${PAGE}/7`, {
      intent: "remove-repository",
      repository: "web",
      repository_id: "rep_1",
    });
    expect(removed.headers.get("Location")).toBe(`${PAGE}/7?removed=web&changed=narrower`);
    expect(calls.map((c) => c.method)).toEqual(["GET", "PUT", "DELETE"]);
    expect(
      await run(runnerAction, context, `${PAGE}/7`, {
        intent: "add-repository",
        repository: "nope",
      }),
    ).toMatchObject({ errors: { repository: expect.stringContaining("nope") } });
  });

  it("deletes only with the runner's name typed", async () => {
    const { context, calls } = api({
      [`GET ${API}/7`]: json(runner()),
      [`DELETE ${API}/7`]: new Response(null, { status: 204 }),
    });
    expect(
      await run(runnerAction, context, `${PAGE}/7`, { intent: "delete", confirm: "build" }),
    ).toMatchObject({ errors: { confirm: expect.stringContaining("build-1") } });
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
    const done = await run(runnerAction, context, `${PAGE}/7`, {
      intent: "delete",
      confirm: "build-1",
    });
    expect(done.headers.get("Location")).toBe(`${PAGE}?deleted=build-1`);
  });
});

describe("the pages", () => {
  const render = (value: RunnerDetail, path = `${PAGE}/7`, result?: unknown) =>
    renderPage(RunnerPage, path, { org: "acme", runner: value }, result);

  it("offer fork access on an ephemeral runner alone, saying why not on another", () => {
    expect(render(runner())).toContain('name="allows_forks"');
    const long = render(runner({ ephemeral: false }));
    expect(long).not.toContain('name="allows_forks"');
    expect(long).not.toContain("was_allows_forks");
    expect(long).toContain("need an ephemeral runner");
    // The warnings stand beside the controls.
    expect(long).toContain(escaped("A long-lived runner keeps what a job leaves behind"));
    expect(long).toContain("fresh, disposable machine");
    expect(render(runner())).toContain("register a fresh machine each time");
  });

  it("list selected repositories, and say how soon a change counts", () => {
    const selected = runner({
      repository_access: "selected",
      selected_count: 1,
      repositories: [{ id: "rep_1", name: "web", full_name: "acme/web", visibility: "private" }],
    });
    const page = render(selected, `${PAGE}/7?changed=wider`);
    expect(page).toContain("acme/web");
    expect(page).toContain("within five minutes");
    expect(render(runner(), `${PAGE}/7?changed=narrower`)).toContain("from the next job");
  });

  it("offer nothing to change on a runner that no longer serves", () => {
    const page = render(runner({ revoked_at: 5, revoked_reason: "spent" }));
    expect(page).toContain("Had its one job");
    expect(page).not.toContain("<form");
  });

  it("offer no access to change once an ephemeral runner has its job, also before it is stamped ended", () => {
    const page = render(
      runner({ task_assigned_at: 5, repository_access: "selected", selected_count: 0 }),
    );
    expect(page).toContain("Given its one job");
    expect(page).not.toContain("Which jobs it takes");
    expect(page).not.toContain("Add repository");
    expect(page).toContain("Delete runner");
  });

  it("keep what a refused save changed, over the access as it is now, for a retry", () => {
    const now = runner({ allows_public: true, allows_forks: false });
    const page = render(now, `${PAGE}/7`, {
      errors: { form: "Too many requests." },
      change: { allows_public: false },
    });
    const box = (name: string) => new RegExp(`<input[^>]*name="${name}"[^>]*>`).exec(page)?.[0];
    expect(box("allows_public")).not.toContain("checked");
    expect(box("was_allows_public")).toContain('value="on"');
    expect(box("allows_forks")).not.toContain("checked");
  });

  it("show a runner's own text as text", () => {
    const hostile = runner({ name: HOSTILE, labels: [HOSTILE], version: HOSTILE });
    const list = renderPage(Runners, PAGE, {
      org: "acme",
      revoked: false,
      runners: [hostile],
      pages: { next: null, first: null },
    });
    for (const page of [render(hostile), list]) {
      expect(page).not.toMatch(ACTIVE_TAG);
      expect(page).toContain(escaped(HOSTILE));
    }
  });

  it("ask the API for the runners in use, or for the past ones", async () => {
    for (const [query, status] of [
      ["", "serving"],
      ["?show=revoked", "revoked"],
    ]) {
      const { context, calls } = api({ [`GET ${API}`]: json({ runners: [], next_cursor: null }) });
      const data = await runnersLoader({
        request: new Request(`${ORIGIN}${PAGE}${query}`),
        context,
        params: { org: "acme" },
      } as never);
      expect(new URL((calls[0] as Request).url).searchParams.get("status")).toBe(status);
      expect(renderPage(Runners, PAGE, data)).toContain(
        status === "serving" ? "No runners." : "No past runners.",
      );
    }
  });

  it("answer a runner that is not the organization's as the API does", async () => {
    const { context } = api({});
    await expect(
      runnerLoader({
        request: new Request(`${ORIGIN}${PAGE}/7`),
        context,
        params: { org: "acme", id: "7" },
      } as never),
    ).rejects.toMatchObject({ init: { status: 404 } });
  });

  it("are routed, and reached from the organization's settings", () => {
    const routeOf = (path: string) =>
      matchRoutes(
        routes.map((r) => ({ path: r.path ?? "", id: r.id ?? r.file })),
        path,
      )?.at(-1)?.route.id;
    expect(routeOf(PAGE)).toBe("routes/org.runners.tsx");
    expect(routeOf(`${PAGE}/new`)).toBe("routes/org.runner-new.tsx");
    expect(routeOf(`${PAGE}/7`)).toBe("routes/org.runner.tsx");
    expect(
      ORG_SETTINGS.find((e) => e.key === "runners")?.path({ kind: "organization", org: "acme" }),
    ).toBe(PAGE);
  });
});

describe("what a runner reads as", () => {
  it("names its access and its state, never whether it is connected", () => {
    expect(accessText(runner())).toBe("Private and internal repositories");
    expect(accessText(runner({ allows_public: true, allows_forks: true }))).toBe(
      "All repositories, fork pull requests",
    );
    expect(
      accessText(runner({ repository_access: "selected", selected_count: 2, allows_public: true })),
    ).toBe("2 repositories, public ones too");
    expect(runnerState(runner())).toBe("Registered");
    expect(runnerState(runner({ declared_at: null }))).toBe("Never started");
    expect(runnerState(runner({ task_assigned_at: 5 }))).toBe("Given its one job");
    expect(runnerState(runner({ revoked_at: 5, revoked_reason: "poll_rate" }))).toMatch(/Revoked/);
  });

  it.each([
    ["runner_revoked", 409],
    ["access_not_selected", 409],
    ["runner_fleet_full", 409],
    ["rate_limited", 429],
    ["anything", 403],
    ["anything", 500],
  ])("says what %s (%d) means", (code, status) => {
    expect(runnerErrors({ code, status }).form).toEqual(expect.any(String));
  });
});
