// The digests of watched repositories: the list reads the feed's digest
// items in one call, paged forward by its cursor, and links each to its
// page; a digest's page reads its threads in one call and links each to
// its issue or pull request. Nothing is asked of the API for a path that
// cannot name a digest.

import { describe, expect, it } from "vitest";
import DigestPage, { loader as digestLoader } from "../app/routes/notifications.digest.js";
import Digests, { loader as digestsLoader } from "../app/routes/notifications.digests.js";
import { fakeApi, json, ORIGIN } from "./helpers/context.js";
import { ACTIVE_TAG, escaped, HOSTILE, renderPage } from "./helpers/render.js";

const get = (path: string) =>
  new Request(`${ORIGIN}${path}`, { headers: { Cookie: "fyrden_session=s" } });
/** The API calls made, the session checks left out. */
const paths = (calls: Request[]) =>
  calls
    .filter((c) => new URL(c.url).pathname !== "/auth/session")
    .map((c) => `${c.method} ${new URL(c.url).pathname}${new URL(c.url).search}`);

/** The API answering `answer`, and the session as ada's. */
const api = (answer: (req: Request) => Response) =>
  fakeApi((req) =>
    new URL(req.url).pathname === "/auth/session"
      ? json({ user: { id: "usr_ada", handle: "ada" } })
      : answer(req),
  );

const WINDOW = 1_992_491;
const MS = 15 * 60_000;

const item = (subject: "issue" | "pull", url: string) => ({
  item_key: `rep_1:${subject}-digest/${WINDOW}.2:digest`,
  repo: { id: "rep_1", full_name: "ada/demo" },
  thread_key: `${subject}-digest/${WINDOW}.2`,
  kind: "digest",
  subject: { kind: subject, title: "" },
  digest: { window: WINDOW, starts_at: WINDOW * MS, ends_at: (WINDOW + 1) * MS, url },
  epoch: 3,
  version: WINDOW,
  state: "open",
  priority: "P2",
  reasons: ["subscribed"],
  silent: false,
  action: "digest",
  actor: null,
  actor_trust: "none",
  excerpt: null,
  members: [],
  members_truncated: false,
  event_at: WINDOW * MS,
  acked_epoch: 0,
  acked_version: 0,
});

const feed = (items: unknown[], extra: Record<string, unknown> = {}) =>
  json({
    items,
    next_cursor: "c2",
    head_cursor: "c2",
    coverage: "full",
    delivery: "complete",
    poll_after_ms: 0,
    ...extra,
  });

describe("the digests list", () => {
  it("reads the feed's digests in one call, each linked to its page", async () => {
    const { context, calls } = api(() =>
      feed([
        item("issue", `${ORIGIN}/api/feed/digests/rep_1/issue/${WINDOW}/2`),
        item("pull", "elsewhere"),
        item("pull", `${ORIGIN}/api/feed/digests/rep_1/commit/${WINDOW}/2`),
      ]),
    );
    const shown = await digestsLoader({
      request: get("/notifications/digests?since=c1"),
      context,
      params: {},
    } as never);
    expect(paths(calls)).toEqual(["GET /api/feed?kind=digest&limit=50&since=c1"]);
    expect(shown.digests.map((d) => [d.repo, d.subject, d.page])).toEqual([
      ["ada/demo", "issue", `/notifications/digests/rep_1/issue/${WINDOW}/2`],
      ["ada/demo", "pull", null],
      ["ada/demo", "pull", null],
    ]);
    expect(shown.digests[0]?.window).toBe("2026-10-29 02:45–03:00 UTC");
    expect(shown.pages).toEqual({
      next: "/notifications/digests?since=c2",
      first: "/notifications/digests",
    });
  });

  it("says when watched activity may be missing, or other streams are left out", async () => {
    const { context } = api(() => feed([], { coverage: "partial", delivery: "degraded" }));
    const shown = await digestsLoader({
      request: get("/notifications/digests"),
      context,
      params: {},
    } as never);
    expect(shown).toMatchObject({ degraded: true, partial: true, expired: false });
  });

  it("shows the list, inert, with its notes and pages", async () => {
    const html = renderPage(Digests, "/notifications/digests?since=c1", {
      digests: [
        {
          key: "k1",
          repo: HOSTILE,
          subject: "pull",
          window: "2026-10-29 02:45–03:00 UTC",
          page: "/notifications/digests/rep_1/pull/1/2",
        },
        { key: "k2", repo: "ada/demo", subject: "issue", window: "w", page: null },
      ],
      degraded: true,
      partial: true,
      expired: true,
      pages: { next: "/notifications/digests?since=c2", first: "/notifications/digests" },
    });
    expect(html).toContain(escaped(`Pull request activity in ${HOSTILE}`));
    expect(html).not.toMatch(ACTIVE_TAG);
    expect(html).toContain('href="/notifications/digests/rep_1/pull/1/2"');
    expect(html).toContain("Issue activity in ada/demo</p>");
    for (const text of ["may be missing", "are left out", "starts from the beginning again"])
      expect(html).toContain(text);
    expect(html).toContain('href="/notifications/digests?since=c2"');
    expect(html).toMatch(/aria-current="page"[^>]*>Digests</);
  });

  it("starts over from the first page when its cursor expired", async () => {
    const { context } = api(() => json({ code: "cursor_expired", detail: "Expired." }, 410));
    const answer = await digestsLoader({
      request: get("/notifications/digests?since=old"),
      context,
      params: {},
    } as never).catch((thrown: unknown) => thrown);
    expect(answer).toBeInstanceOf(Response);
    expect((answer as Response).headers.get("Location")).toBe("/notifications/digests?expired=1");
    const { context: again } = api(() => feed([]));
    const shown = await digestsLoader({
      request: get("/notifications/digests?expired=1"),
      context: again,
      params: {},
    } as never);
    expect(shown.expired).toBe(true);
    // The note stays on that page, not on the ones it links to.
    expect(shown.pages).toEqual({ next: "/notifications/digests?since=c2", first: null });
  });

  it.each([
    [400, { code: "invalid_request", detail: "Too long." }],
    [422, { code: "invalid_cursor", detail: "Not a cursor." }],
  ])("starts over from a cursor the API cannot read (%i)", async (status, body) => {
    const { context } = api(() => json(body, status));
    const answer = await digestsLoader({
      request: get("/notifications/digests?since=eyJ2Ijoy"),
      context,
      params: {},
    } as never).catch((thrown: unknown) => thrown);
    expect((answer as Response).headers.get("Location")).toBe("/notifications/digests?expired=1");
  });

  it("does not loop when the first page itself is refused as expired", async () => {
    const { context } = api(() => json({ code: "cursor_expired", detail: "Expired." }, 410));
    const answer = await digestsLoader({
      request: get("/notifications/digests?expired=1"),
      context,
      params: {},
    } as never).catch((thrown: unknown) => thrown);
    expect(answer).toMatchObject({ init: { status: 410 } });
  });

  it("sends a signed-out visitor to sign in", async () => {
    const { context } = fakeApi((req) =>
      new URL(req.url).pathname === "/auth/session"
        ? json({ user: null }, 401)
        : json({ detail: "Sign in." }, 401),
    );
    const answer = await digestsLoader({
      request: get("/notifications/digests"),
      context,
      params: {},
    } as never).catch((thrown: unknown) => thrown);
    expect((answer as Response).headers.get("Location")).toMatch(/^\/auth\/sign-in\?/);
  });
});

describe("a digest's page", () => {
  const params = { repo: "rep_1", subject: "pull", window: String(WINDOW), epoch: "2" };

  it("reads its threads in one call, each linked to its page", async () => {
    const { context, calls } = api(() =>
      json({
        repo: { id: "rep_1", full_name: "ada/demo" },
        subject: "pull",
        window: WINDOW,
        starts_at: WINDOW * MS,
        ends_at: (WINDOW + 1) * MS,
        threads: [
          { number: 7, title: "Seven", last_activity_at: 0, actors: ["bo"], more_actors: true },
        ],
        complete: false,
      }),
    );
    const shown = await digestLoader({
      request: get(`/notifications/digests/rep_1/pull/${WINDOW}/2`),
      context,
      params,
    } as never);
    expect(paths(calls)).toEqual([`GET /api/feed/digests/rep_1/pull/${WINDOW}/2`]);
    expect(shown).toMatchObject({
      gone: false,
      repo: "ada/demo",
      subject: "pull",
      window: "2026-10-29 02:45–03:00 UTC",
      complete: false,
    });
    if (shown.gone) throw new Error("unreachable");
    expect(shown.threads).toEqual([
      { number: 7, title: "Seven", page: "/ada/demo/pull/7", actors: ["bo"], more: true },
    ]);
  });

  it("shows its threads, inert, and says when it may be incomplete", async () => {
    const html = renderPage(DigestPage, `/notifications/digests/rep_1/pull/${WINDOW}/2`, {
      gone: false,
      repo: "ada/demo",
      subject: "pull",
      window: "2026-10-29 02:45–03:00 UTC",
      threads: [
        { number: 7, title: HOSTILE, page: "/ada/demo/pull/7", actors: [HOSTILE], more: true },
      ],
      complete: false,
    });
    expect(html).toContain("Pull request activity in ada/demo");
    expect(html).toContain('href="/ada/demo/pull/7"');
    expect(html).toContain(escaped(HOSTILE));
    expect(html).toContain("and others");
    expect(html).not.toMatch(ACTIVE_TAG);
    expect(html).toContain("may be incomplete");
    const gone = renderPage(DigestPage, `/notifications/digests/rep_1/pull/${WINDOW}/2`, {
      gone: true,
    });
    expect(gone).toContain("This digest no longer shows");
    const empty = renderPage(DigestPage, `/notifications/digests/rep_1/pull/${WINDOW}/2`, {
      gone: false,
      repo: "ada/demo",
      subject: "issue",
      window: "w",
      threads: [],
      complete: true,
    });
    expect(empty).toContain("Nothing here you can see now.");
    expect(empty).not.toContain("may be incomplete");
  });

  it("sends a signed-out visitor to sign in", async () => {
    const { context } = fakeApi(() => json({ detail: "Sign in." }, 401));
    const answer = await digestLoader({
      request: get(`/notifications/digests/rep_1/pull/${WINDOW}/2`),
      context,
      params,
    } as never).catch((thrown: unknown) => thrown);
    expect((answer as Response).headers.get("Location")).toMatch(/^\/auth\/sign-in\?/);
  });

  it("says a digest no longer shows when the API does not find it", async () => {
    const { context } = api(() => json({ detail: "Not found." }, 404));
    const shown = await digestLoader({
      request: get(`/notifications/digests/rep_1/pull/${WINDOW}/2`),
      context,
      params,
    } as never);
    expect(shown.gone).toBe(true);
  });

  it.each([
    { ...params, subject: "commit" },
    { ...params, window: "0" },
    { ...params, epoch: "x" },
    { ...params, repo: "../users" },
  ])("asks the API nothing for a path naming no digest (%o)", async (bad) => {
    const { context, calls } = api(() => json({}));
    const answer = await digestLoader({
      request: get("/notifications/digests/x"),
      context,
      params: bad,
    } as never).catch((thrown: unknown) => thrown);
    expect(answer).toMatchObject({ init: { status: 404 } });
    expect(paths(calls)).toEqual([]);
  });
});
