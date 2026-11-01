// Milestones: the page lists a repository's open or closed milestones a
// page at a time, each with its due date, progress and a link to its
// issues and pull requests; write access creates, edits (from the version
// the form showed), closes, reopens and deletes them. Hostile titles and
// descriptions are text, never markup.

import { describe, expect, it } from "vitest";
import { dateOf, dueOf, excerpt, milestoneItems } from "../app/lib/milestones.js";
import { action, loader, default as Milestones } from "../app/routes/repo.milestones.js";
import { formPost, json, ORIGIN } from "./helpers/context.js";
import { api, pathOf, repo, VIEWER } from "./helpers/pulls.js";
import { ACTIVE_TAG, escaped, HOSTILE, renderPage } from "./helpers/render.js";

const params = { owner: "ada", repo: "demo" };
const ALL = { admin: true, maintain: true, push: true, triage: true, pull: true };
const READ_ONLY = { admin: false, maintain: false, push: false, triage: false, pull: true };

function milestone(number: number, overrides: Record<string, unknown> = {}) {
  return {
    id: number,
    number,
    title: `v${number}`,
    description: null,
    state: "open",
    open_issues: 1,
    closed_issues: 3,
    creator: { id: VIEWER },
    due_on: Date.UTC(2026, 11, 31),
    created_at: 1,
    updated_at: 1,
    closed_at: null,
    version: 2,
    ...overrides,
  };
}

const pageData = (overrides: Record<string, unknown> = {}) => ({
  repo: { ...repo, permissions: ALL },
  at: { owner: "ada", repo: "demo" },
  origin: ORIGIN,
  state: "open",
  milestones: [milestone(1)],
  pages: { next: null, first: null },
  viewer: VIEWER,
  viewerKnown: true,
  ...overrides,
});

describe("a milestone's due date and description", () => {
  it("is a UTC day, both ways; an empty field is none, a date that is none refused", () => {
    expect(dueOf("2026-12-31")).toBe(Date.UTC(2026, 11, 31));
    expect(dueOf("")).toBeNull();
    for (const bad of ["2026-02-30", "31/12/2026", "2026-13-01", "x"])
      expect(dueOf(bad), bad).toBeUndefined();
    expect(dateOf(Date.UTC(2026, 11, 31))).toBe("2026-12-31");
    expect(dateOf(null)).toBe("");
    // Past year 9999 and up to the API's latest, both ways; past it or before 1970, refused.
    expect(dateOf(Date.UTC(10000, 0, 1))).toBe("10000-01-01");
    expect(dueOf("10000-01-01")).toBe(Date.UTC(10000, 0, 1));
    expect(dueOf(dateOf(8_640_000_000_000_000))).toBe(8_640_000_000_000_000);
    expect(dateOf(8_640_000_000_000_000)).toBe("275760-09-13");
    expect(dueOf("275760-09-14")).toBeUndefined();
    expect(dueOf("1969-12-31")).toBeUndefined();
  });

  it("shows up to 500 characters of a description, and links its items of both kinds", () => {
    expect(excerpt("short")).toBe("short");
    expect([...excerpt("€".repeat(600))]).toHaveLength(501);
    expect(excerpt("x".repeat(500))).toBe("x".repeat(500));
    // Characters, never halves of one.
    expect(excerpt("😀".repeat(501))).toBe(`${"😀".repeat(500)}…`);
    expect(milestoneItems("ada", "demo", 3)).toBe(
      "/ada/demo/issues?state=all&kind=all&milestone=3",
    );
  });
});

describe("the milestones page", () => {
  it("asks for the repository, a page of milestones in the state it names, and the viewer", async () => {
    const { context, calls } = api({
      "GET /api/repos/ada/demo": () => json({ ...repo, permissions: ALL }),
      "GET /api/repos/ada/demo/milestones": () =>
        json({ milestones: [milestone(1)], next_cursor: "N" }),
    });
    const data = await loader({
      request: new Request(`${ORIGIN}/ada/demo/milestones?state=closed&cursor=C`, {
        headers: { Cookie: "fyrden_session=s" },
      }),
      context,
      params,
    } as never);
    expect(calls.map(pathOf)).toContain(
      "GET /api/repos/ada/demo/milestones?state=closed&per_page=30&cursor=C",
    );
    expect(data).toMatchObject({
      state: "closed",
      at: { owner: "ada", repo: "demo" },
      pages: { next: "/ada/demo/milestones?state=closed&cursor=N" },
      viewer: VIEWER,
    });
  });

  it("shows each milestone's due date, progress and items; hostile text as text", () => {
    const html = renderPage(
      Milestones,
      "/ada/demo/milestones",
      pageData({ milestones: [milestone(1, { title: HOSTILE, description: HOSTILE })] }),
    );
    expect(html).toContain(escaped(HOSTILE));
    expect(html).not.toMatch(ACTIVE_TAG);
    expect(html).toContain("Due 2026-12-31");
    expect(html).toContain("75% complete");
    expect(html).toContain('href="/ada/demo/issues?state=all&amp;kind=all&amp;milestone=1"');
  });

  it("offers write access every change, a reader none", () => {
    const writer = renderPage(Milestones, "/ada/demo/milestones", pageData());
    for (const text of ["New milestone", "Edit", "Close milestone", "Delete milestone v1"])
      expect(writer, text).toContain(text);
    expect(writer).toMatch(
      /name="intent" value="edit"\/><input type="hidden" name="number" value="1"\/><input type="hidden" name="version" value="2"/,
    );
    const closed = renderPage(
      Milestones,
      "/ada/demo/milestones",
      pageData({ state: "closed", milestones: [milestone(1, { state: "closed" })] }),
    );
    expect(closed).toContain("Reopen milestone");
    const reader = renderPage(
      Milestones,
      "/ada/demo/milestones",
      pageData({ repo: { ...repo, permissions: READ_ONLY } }),
    );
    expect(reader).not.toMatch(/name="intent"/);
  });

  it("keeps a refused edit's draft and version, and one for a milestone not on the page to copy", () => {
    const scope = { viewer: VIEWER, owner: "ada", repo: "demo", page: "milestones" };
    const html = renderPage(
      Milestones,
      "/ada/demo/milestones",
      pageData({ milestones: [milestone(1, { version: 5 })] }),
      {
        error: "Someone changed it",
        scope,
        draft: {
          fields: { title: "v1, mine", due_on: "2027-01-02", description: "d" },
          version: 2,
          target: 1,
        },
      },
    );
    expect(html).toContain('value="v1, mine"');
    expect(html).toContain('value="2027-01-02"');
    expect(html).toMatch(/name="number" value="1"\/><input type="hidden" name="version" value="2"/);
    const away = renderPage(Milestones, "/ada/demo/milestones", pageData({ milestones: [] }), {
      error: "x",
      scope,
      draft: { fields: { title: "elsewhere", due_on: "", description: "" }, version: 2, target: 9 },
    });
    expect(away).toContain("Your unsent text");
    expect(away).toContain("elsewhere");
  });
});

describe("changing milestones", () => {
  async function act(fields: Record<string, string>, reply = () => json(milestone(1))) {
    const { context, calls } = api({
      "POST /api/repos/ada/demo/milestones": () => json(milestone(2), 201),
      "PATCH /api/repos/ada/demo/milestones/1": reply,
      "DELETE /api/repos/ada/demo/milestones/1": () => json({ number: 1, state: "deleted" }),
    });
    const outcome = await action({
      request: formPost("/ada/demo/milestones", { viewer: VIEWER, ...fields }),
      context,
      params,
    } as never);
    const sent = calls.find((c) => c.method !== "GET" && !c.url.includes("/auth/"));
    return {
      outcome,
      sent: sent && {
        path: pathOf(sent),
        body: await sent.text().then((t) => (t ? JSON.parse(t) : undefined)),
      },
    };
  }

  it("creates, edits from the version shown, closes, reopens and deletes", async () => {
    expect(
      (await act({ intent: "create", title: " v2 ", due_on: "2027-01-02", description: "" })).sent,
    ).toEqual({
      path: "POST /api/repos/ada/demo/milestones",
      body: { title: "v2", due_on: Date.UTC(2027, 0, 2) },
    });
    const edited = await act({
      intent: "edit",
      number: "1",
      title: "v1",
      due_on: "",
      description: "",
      version: "2",
    });
    expect(edited.sent).toEqual({
      path: "PATCH /api/repos/ada/demo/milestones/1",
      body: { title: "v1", due_on: null, description: null, expected_version: 2 },
    });
    expect(edited.outcome).toMatchObject({ ok: "edit", target: 1 });
    expect((await act({ intent: "close", number: "1" })).sent).toEqual({
      path: "PATCH /api/repos/ada/demo/milestones/1",
      body: { state: "closed" },
    });
    expect((await act({ intent: "reopen", number: "1" })).sent?.body).toEqual({ state: "open" });
    expect((await act({ intent: "delete", number: "1" })).sent?.path).toBe(
      "DELETE /api/repos/ada/demo/milestones/1",
    );
  });

  it("sends nothing malformed, keeping the version of a draft refused here or there", async () => {
    for (const bad of [
      { intent: "create", title: "", due_on: "" },
      { intent: "create", title: "v3", due_on: "2026-02-30" },
      { intent: "edit", number: "x", title: "v1", due_on: "" },
    ]) {
      const { sent, outcome } = await act(bad);
      expect(sent, JSON.stringify(bad)).toBeUndefined();
      expect(outcome).toMatchObject({ error: expect.any(String) });
    }
    // An edit is never sent without the version it was opened at (it would overwrite).
    for (const version of [undefined, "garbage", "0"]) {
      const { sent, outcome } = await act({
        intent: "edit",
        number: "1",
        title: "v1",
        due_on: "",
        ...(version !== undefined && { version }),
      });
      expect(sent, version).toBeUndefined();
      expect(outcome).toMatchObject({ draft: { fields: { title: "v1" }, target: 1 } });
    }
    const local = await act({ intent: "edit", number: "1", title: " ", due_on: "", version: "2" });
    expect(local.outcome).toMatchObject({ draft: { version: 2, target: 1 } });
    const stale = await act(
      {
        intent: "edit",
        number: "1",
        title: "mine",
        due_on: "2027-01-02",
        description: "d",
        version: "2",
      },
      () => json({ code: "stale", detail: "d", current_version: 3 }, 409),
    );
    expect(stale.outcome).toMatchObject({
      error: expect.stringContaining("Someone changed it"),
      draft: {
        fields: { title: "mine", due_on: "2027-01-02", description: "d" },
        version: 2,
        target: 1,
      },
    });
  });
});
