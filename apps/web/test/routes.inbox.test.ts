// The inbox and the pages choosing how one hears of a repository or a
// thread: each reads what it shows in its few calls, links a thread to its
// page, and does each intent with one call, saying what the API answered.

import { describe, expect, it } from "vitest";
import { action as inboxAction, loader as inboxLoader } from "../app/routes/notifications.js";
import {
  action as threadAction,
  loader as threadLoader,
} from "../app/routes/repo.issue.subscription.js";
import { action as watchAction, loader as watchLoader } from "../app/routes/repo.watching.js";
import { fakeApi, formPost, json } from "./helpers/context.js";

const ORIGIN = "https://fyrden.test";
const get = (path: string) =>
  new Request(`${ORIGIN}${path}`, { headers: { Cookie: "fyrden_session=s" } });
/** The API calls made, the session checks left out. */
const paths = (calls: Request[]) =>
  calls
    .filter((c) => new URL(c.url).pathname !== "/auth/session")
    .map((c) => `${c.method} ${new URL(c.url).pathname}${new URL(c.url).search}`);

/** The API calls themselves, the session checks left out. */
const apiOnly = (calls: Request[]) =>
  calls.filter((c) => new URL(c.url).pathname !== "/auth/session");

/** The API answering `answer`, and the session as ada's. */
const api = (answer: (req: Request) => Response) =>
  fakeApi((req) =>
    new URL(req.url).pathname === "/auth/session"
      ? json({ user: { id: "usr_ada", handle: "ada" } })
      : answer(req),
  );
const post = (path: string, fields: Record<string, string>) =>
  formPost(path, { viewer: "usr_ada", ...fields });

const thread = (n: number, type: "Issue" | "PullRequest", unread = true) => ({
  id: `t${n}`,
  repository: { full_name: "ada/demo", name: "demo", owner: { login: "ada" } },
  subject: {
    title: `Thing ${n}`,
    url: `${ORIGIN}/api/repos/ada/demo/${type === "Issue" ? "issues" : "pulls"}/${n}`,
    type,
  },
  reason: "mention",
  unread,
  updated_at: "2026-10-28T10:00:00Z",
});

describe("the inbox", () => {
  it("lists a tab's threads in one call, each linked to its page", async () => {
    const { context, calls } = api(() =>
      json({
        notifications: [thread(3, "PullRequest"), thread(4, "Issue", false)],
        next_cursor: "c2",
        delivery: "degraded",
      }),
    );
    const shown = await inboxLoader({
      request: get("/notifications?tab=participating"),
      context,
      params: {},
    } as never);
    expect(paths(calls)).toEqual(["GET /api/notifications?participating=true&per_page=50"]);
    expect(shown.tab).toBe("participating");
    expect(shown.degraded).toBe(true);
    expect(shown.threads.map((t) => t.page)).toEqual(["/ada/demo/pull/3", "/ada/demo/issues/4"]);
  });

  it("links no page for a subject URL it does not know", async () => {
    const odd = { ...thread(5, "Issue"), subject: { ...thread(5, "Issue").subject, url: "x" } };
    const { context } = api(() =>
      json({ notifications: [odd], next_cursor: null, delivery: "complete" }),
    );
    const shown = await inboxLoader({
      request: get("/notifications"),
      context,
      params: {},
    } as never);
    expect(shown.threads[0]?.page).toBeNull();
  });

  it.each([
    [{ intent: "read", id: "t/1" }, "PATCH /api/notifications/threads/t%2F1", 205],
    [{ intent: "done", id: "t1" }, "DELETE /api/notifications/threads/t1", 204],
    [{ intent: "read-all", before: "2026-10-28T10:00:00Z" }, "PUT /api/notifications", 202],
  ])("does %o with one call", async (fields, call, status) => {
    const { context, calls } = api(() => new Response(null, { status }));
    const result = await inboxAction({
      request: post("/notifications", fields),
      context,
      params: {},
    } as never);
    expect(result).toHaveProperty("done");
    expect(paths(calls)).toEqual([call]);
    if (fields.intent === "read-all")
      expect(await apiOnly(calls)[0]?.json()).toEqual({ last_read_at: "2026-10-28T10:00:00Z" });
  });

  it("says why the API refused", async () => {
    const { context } = api(() => json({ detail: "Not yours." }, 404));
    expect(
      await inboxAction({
        request: post("/notifications", { intent: "done", id: "t1" }),
        context,
        params: {},
      } as never),
    ).toEqual({ error: "Not yours." });
  });
});

describe("watching a repository", () => {
  const repo = { id: "rep_1", owner: "ada", name: "demo", description: null };

  it.each([
    [404, {}, "participating"],
    [200, { subscribed: true, ignored: false }, "watching"],
    [200, { subscribed: false, ignored: true }, "ignoring"],
  ])("shows the level the API keeps (%i %o)", async (status, body, level) => {
    const { context } = api((req) =>
      new URL(req.url).pathname.endsWith("/subscription") ? json(body, status) : json(repo),
    );
    const shown = await watchLoader({
      request: get("/ada/demo/watching"),
      context,
      params: { owner: "ada", repo: "demo" },
    } as never);
    expect(shown.level).toBe(level);
  });

  it.each([
    ["watching", "PUT /api/repos/ada/demo/subscription", { subscribed: true }],
    ["ignoring", "PUT /api/repos/ada/demo/subscription", { ignored: true }],
    ["participating", "DELETE /api/repos/ada/demo/subscription", null],
  ])("sets %s with one call", async (level, call, body) => {
    const { context, calls } = api(() => json({}));
    const result = await watchAction({
      request: post("/ada/demo/watching", { intent: "set", level }),
      context,
      params: { owner: "ada", repo: "demo" },
    } as never);
    expect(result).toEqual({ done: "Saved." });
    expect(paths(calls)).toEqual([call]);
    if (body) expect(await apiOnly(calls)[0]?.json()).toEqual(body);
  });

  it("says why the API refused, and sends nothing for no level", async () => {
    const { context, calls } = api(() => json({ detail: "Too many watchers." }, 409));
    const ask = (fields: Record<string, string>) =>
      watchAction({
        request: post("/ada/demo/watching", fields),
        context,
        params: { owner: "ada", repo: "demo" },
      } as never);
    expect(await ask({ intent: "set", level: "watching" })).toEqual({
      error: "Too many watchers.",
    });
    expect(await ask({ intent: "set" })).toEqual({ error: "Choose a level." });
    expect(apiOnly(calls)).toHaveLength(1);
  });
});

describe("a thread's notifications", () => {
  const params = { owner: "ada", repo: "demo", number: "7" };

  it("shows its level and links back to its page, an issue's or a pull request's", async () => {
    for (const [subject, back] of [
      [{ number: 7, title: "A bug" }, "/ada/demo/issues/7"],
      [{ number: 7, title: "A fix", pull_request: {} }, "/ada/demo/pull/7"],
    ] as const) {
      const { context } = api((req) =>
        new URL(req.url).pathname.endsWith("/subscription")
          ? json({ subscribed: false, ignored: true })
          : json(subject),
      );
      const shown = await threadLoader({
        request: get("/ada/demo/issues/7/subscription"),
        context,
        params,
      } as never);
      expect(shown).toMatchObject({ level: "unsubscribed", back });
    }
  });

  it.each([
    ["subscribed", "PUT", { subscribed: true }, 200],
    ["unsubscribed", "PUT", { ignored: true }, 200],
    ["default", "DELETE", null, 200],
  ])("sets %s with one call (%s)", async (level, method, body, status) => {
    const { context, calls } = api(() => json({}, status));
    const result = await threadAction({
      request: post("/ada/demo/issues/7/subscription", { intent: "set", level }),
      context,
      params,
    } as never);
    expect(result).toEqual({ done: "Saved." });
    expect(paths(calls)).toEqual([`${method} /api/repos/ada/demo/issues/7/subscription`]);
    if (body) expect(await apiOnly(calls)[0]?.json()).toEqual(body);
  });

  it("propagates a refusal of the subject, rather than showing a default", async () => {
    const { context } = api((req) =>
      new URL(req.url).pathname.endsWith("/subscription")
        ? json({ code: "issue_not_found", detail: "Not found." }, 404)
        : json({ id: 1, number: 7, title: "A bug" }),
    );
    const thrown = await threadLoader({
      request: get("/ada/demo/issues/7/subscription"),
      context,
      params,
    } as never).catch((e) => e);
    expect((thrown as { init?: { status?: number } }).init?.status).toBe(404);
  });
});

describe("a form drawn for another account", () => {
  it.each([
    ["/notifications", inboxAction, { intent: "done", id: "t1" }, {}],
    [
      "/ada/demo/watching",
      watchAction,
      { intent: "set", level: "watching" },
      { owner: "ada", repo: "demo" },
    ],
    [
      "/ada/demo/issues/7/subscription",
      threadAction,
      { intent: "set", level: "subscribed" },
      { owner: "ada", repo: "demo", number: "7" },
    ],
  ] as const)("is refused before any change (%s)", async (path, act, fields, params) => {
    const { context, calls } = api(() => json({}));
    const result = await (act as (args: unknown) => Promise<unknown>)({
      request: formPost(path, { viewer: "usr_someone_else", ...fields }),
      context,
      params,
    });
    expect(result).toEqual({ error: expect.stringMatching(/another account/) });
    expect(paths(calls)).toEqual([]);
  });
});
