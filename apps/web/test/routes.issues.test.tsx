// Issues: the list (its state, filters and pages, a new issue opened), and
// an issue's page (its conversation a page at a time, edits from the
// version the form showed, closing and reopening): what each form sends
// the API, what a viewer without the role is offered, and hostile titles,
// bodies and comments shown as text, never markup.

import { describe, expect, it } from "vitest";
import {
  default as IssuePage,
  action as issueAction,
  loader as issueLoader,
} from "../app/routes/repo.issue.js";
import {
  default as Issues,
  action as issuesAction,
  loader as issuesLoader,
} from "../app/routes/repo.issues.js";
import { fakeApi, formPost, json, ORIGIN } from "./helpers/context.js";
import { api, pathOf, repo, VIEWER } from "./helpers/pulls.js";
import { ACTIVE_TAG, escaped, HOSTILE, renderPage } from "./helpers/render.js";

const params = { owner: "ada", repo: "demo", number: "7" };
const ALL = { admin: true, maintain: true, push: true, triage: true, pull: true };
const READ_ONLY = { admin: false, maintain: false, push: false, triage: false, pull: true };

function issue(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    number: 7,
    state: "open",
    state_reason: null,
    duplicate_of: null,
    title: "Crash on start",
    body: "Steps: run it.",
    user: { id: VIEWER },
    performed_via_agents: [],
    locked: false,
    active_lock_reason: null,
    closed_by: null,
    created_at: Date.parse("2026-10-01T10:00:00Z"),
    updated_at: Date.parse("2026-10-01T10:00:00Z"),
    closed_at: null,
    version: 3,
    labels: [],
    assignee: null,
    assignees: [],
    milestone: null,
    reactions: { total_count: 0 },
    ...overrides,
  };
}

function comment(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    issue_number: 7,
    user: { id: VIEWER },
    performed_via_agents: [],
    body: `comment ${id}`,
    created_at: 1,
    updated_at: 1,
    version: 1,
    reactions: { total_count: 0 },
    ...overrides,
  };
}

const pageData = (overrides: Record<string, unknown> = {}) => ({
  owner: "ada",
  repo: "demo",
  issue: issue(),
  comments: [comment(1)],
  pages: { next: null, first: null },
  permissions: ALL,
  viewer: VIEWER,
  viewerKnown: true,
  ...overrides,
});

describe("the issue list", () => {
  it("asks for issues only, in the state and with the filters the page names, a page at a time", async () => {
    const { context, calls } = api({
      "GET /api/repos/ada/demo": () => json({ ...repo, permissions: ALL }),
      "GET /api/repos/ada/demo/issues": () => json({ issues: [], next_cursor: "c2" }),
    });
    const data = await issuesLoader({
      request: new Request(
        `${ORIGIN}/ada/demo/issues?state=closed&labels=bug&assignee=none&cursor=c1&bogus=1`,
      ),
      context,
      params: { owner: "ada", repo: "demo" },
    } as never);
    const listed = calls.map(pathOf).find((p) => p.startsWith("GET /api/repos/ada/demo/issues"));
    expect(listed).toContain("state=closed");
    expect(listed).toContain("type=issues");
    expect(listed).toContain("labels=bug");
    expect(listed).toContain("assignee=none");
    expect(listed).toContain("cursor=c1");
    expect(listed).not.toContain("bogus");
    expect(data.pages.next).toContain("cursor=c2");
    expect(data.filters).toEqual({ labels: "bug", assignee: "none" });
  });

  it("lists pull requests too when asked for both kinds, each linked to its own page", async () => {
    const { context, calls } = api({
      "GET /api/repos/ada/demo": () => json({ ...repo, permissions: ALL }),
      "GET /api/repos/ada/demo/issues": () => json({ issues: [], next_cursor: null }),
    });
    const data = await issuesLoader({
      request: new Request(`${ORIGIN}/ada/demo/issues?kind=all&milestone=3&state=all`),
      context,
      params: { owner: "ada", repo: "demo" },
    } as never);
    const listed = calls.map(pathOf).find((p) => p.startsWith("GET /api/repos/ada/demo/issues"));
    expect(listed).not.toContain("type=");
    expect(listed).toContain("milestone=3");
    expect(data.kind).toBe("all");
    const html = renderPage(Issues, "/ada/demo/issues", {
      ...data,
      issues: [
        issue({ number: 7 }),
        issue({ number: 8, title: "A change", state: "closed", pull_request: { merged_at: 5 } }),
      ],
    });
    expect(html).toContain('href="/ada/demo/issues/7"');
    expect(html).toContain('href="/ada/demo/pull/8"');
    expect(html).toContain("Merged");
    // The state links keep both kinds and the filters.
    expect(html).toContain('href="/ada/demo/issues?kind=all&amp;milestone=3"');
  });

  it("shows hostile titles and label names as text", () => {
    const html = renderPage(Issues, "/ada/demo/issues", {
      repo,
      origin: ORIGIN,
      state: "open",
      filters: { labels: HOSTILE },
      issues: [issue({ title: HOSTILE, labels: [{ id: 1, name: HOSTILE, color: "ededed" }] })],
      pages: { next: null, first: null },
      viewer: VIEWER,
      viewerKnown: true,
      proposed: true,
    });
    expect(html).not.toMatch(ACTIVE_TAG);
    expect(html).toContain(escaped(HOSTILE));
    expect(html).toContain("Open issue");
  });

  it("opens an issue and goes to it; a refusal keeps what was written", async () => {
    const open = async (reply: () => Response) => {
      const { context, calls } = api({ "POST /api/repos/ada/demo/issues": reply });
      const outcome = await issuesAction({
        request: formPost("/ada/demo/issues", { viewer: VIEWER, title: "T", body: "  indented" }),
        context,
        params: { owner: "ada", repo: "demo" },
      } as never);
      const post = calls.find((c) => c.method === "POST");
      return { outcome, sent: post ? await post.json() : undefined };
    };
    const made = await open(() => json(issue({ number: 12 }), 201));
    expect(made.sent).toEqual({ title: "T", body: "  indented" });
    expect((made.outcome as Response).headers.get("Location")).toBe("/ada/demo/issues/12");
    const refused = await open(() => json({ code: "x", detail: "No." }, 422));
    expect(refused.outcome).toEqual({
      error: "No.",
      draft: { title: "T", body: "  indented", viewer: VIEWER },
    });
  });
});

describe("an issue's page", () => {
  it("reads the issue, a page of its comments after an id, the repository and the viewer", async () => {
    const { context, calls } = api({
      "GET /api/repos/ada/demo/issues/7": () => json(issue()),
      "GET /api/repos/ada/demo/issues/7/comments": () =>
        json({ comments: [comment(5), comment(6)], next_cursor: "n" }),
      "GET /api/repos/ada/demo": () => json({ ...repo, permissions: READ_ONLY }),
    });
    const data = await issueLoader({
      request: new Request(`${ORIGIN}/ada/demo/issues/7?after=4`),
      context,
      params,
    } as never);
    expect(calls.map(pathOf)).toContain(
      "GET /api/repos/ada/demo/issues/7/comments?per_page=25&after=4",
    );
    // The next page starts after the last comment shown.
    expect(data.pages).toEqual({ next: "/ada/demo/issues/7?after=6", first: "/ada/demo/issues/7" });
    expect(data.permissions).toEqual(READ_ONLY);
  });

  it("sends a pull request's number to its own page", async () => {
    const { context } = api({
      "GET /api/repos/ada/demo/issues/7": () => json(issue({ pull_request: { merged_at: null } })),
      "GET /api/repos/ada/demo/issues/7/comments": () => json({ comments: [], next_cursor: null }),
      "GET /api/repos/ada/demo": () => json(repo),
    });
    const thrown = await issueLoader({
      request: new Request(`${ORIGIN}/ada/demo/issues/7`),
      context,
      params,
    } as never).catch((e: unknown) => e);
    expect((thrown as Response).headers.get("Location")).toBe("/ada/demo/pull/7");
  });

  async function act(fields: Record<string, string>, reply = () => json(issue())) {
    const { context, calls } = api({
      "PATCH /api/repos/ada/demo/issues/7": reply,
      "POST /api/repos/ada/demo/issues/7/comments": () => json(comment(9), 201),
      "PATCH /api/repos/ada/demo/issues/comments/5": reply,
      "DELETE /api/repos/ada/demo/issues/comments/5": () => new Response(null, { status: 204 }),
    });
    const outcome = await issueAction({
      request: formPost("/ada/demo/issues/7", { viewer: VIEWER, ...fields }),
      context,
      params,
    } as never);
    const sent = calls.find((c) => c.method !== "GET" && !c.url.includes("/auth/"));
    return {
      outcome,
      sent: sent && {
        path: pathOf(sent),
        body: sent.method === "DELETE" ? undefined : await sent.json(),
      },
    };
  }

  it("edits from the version the form showed, and keeps the text when someone changed it since", async () => {
    const saved = await act({ intent: "edit", title: "New", body: "b", version: "3" });
    expect(saved.sent?.body).toEqual({ title: "New", body: "b", expected_version: 3 });
    // The answer names its scope and the version the change made (the API's answer).
    expect(saved.outcome).toEqual({
      ok: "edit",
      target: undefined,
      version: 3,
      scope: { viewer: VIEWER, owner: "ada", repo: "demo", number: 7 },
    });
    const stale = await act({ intent: "edit", title: "New", body: "b", version: "3" }, () =>
      json({ code: "stale", detail: "d", current_version: 4 }, 409),
    );
    // The draft keeps the version it was written from.
    expect(stale.outcome).toMatchObject({
      draft: { fields: { title: "New", body: "b" }, version: 3 },
    });
    expect((stale.outcome as { error: string }).error).toContain("Someone changed it");
    // Never sent without the version it was opened at (it would overwrite a newer one).
    for (const fields of [
      { intent: "edit", title: "New", body: "b" },
      { intent: "edit-comment", comment_id: "5", body: "c", version: "0" },
    ]) {
      const { sent, outcome } = await act(fields);
      expect(sent, fields.intent).toBeUndefined();
      expect(outcome).toMatchObject({ draft: { fields: expect.any(Object) } });
    }
    const commentEdit = await act({
      intent: "edit-comment",
      comment_id: "5",
      body: "c",
      version: "2",
    });
    expect(commentEdit.sent).toEqual({
      path: "PATCH /api/repos/ada/demo/issues/comments/5",
      body: { body: "c", expected_version: 2 },
    });
  });

  it("closes for a reason, a duplicate naming what it duplicates; reopens; comments", async () => {
    expect((await act({ intent: "close", state_reason: "not_planned" })).sent?.body).toEqual({
      state: "closed",
      state_reason: "not_planned",
    });
    expect(
      (await act({ intent: "close", state_reason: "duplicate", duplicate_of: "3" })).sent?.body,
    ).toEqual({ state: "closed", state_reason: "duplicate", duplicate_of: 3 });
    expect((await act({ intent: "close", state_reason: "duplicate" })).outcome).toMatchObject({
      error: "Name the issue or pull request it duplicates.",
    });
    expect((await act({ intent: "reopen" })).sent?.body).toEqual({ state: "open" });
    expect((await act({ intent: "comment", body: "hi" })).sent).toEqual({
      path: "POST /api/repos/ada/demo/issues/7/comments",
      body: { body: "hi" },
    });
    const deleted = await act({ intent: "delete-comment", comment_id: "5" });
    expect(deleted.sent?.path).toBe("DELETE /api/repos/ada/demo/issues/comments/5");
    // The answer names the comment, so the page drops what was kept for it.
    expect(deleted.outcome).toMatchObject({ ok: "delete-comment", target: 5 });
  });

  it("sends nothing from a form made for another viewer", async () => {
    const { context, calls } = api({});
    const outcome = await issueAction({
      request: formPost("/ada/demo/issues/7", {
        viewer: "usr_other",
        intent: "comment",
        body: "hi",
      }),
      context,
      params,
    } as never);
    expect(outcome).toEqual({ error: "You are signed in as someone else now: reload the page." });
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("shows hostile titles, bodies and comments as text", () => {
    const html = renderPage(
      IssuePage,
      "/ada/demo/issues/7",
      pageData({
        issue: issue({
          title: HOSTILE,
          body: HOSTILE,
          labels: [{ id: 1, name: HOSTILE, color: "ededed" }],
        }),
        comments: [comment(1, { body: HOSTILE })],
      }),
    );
    expect(html).not.toMatch(ACTIVE_TAG);
    expect(html).toContain(escaped(HOSTILE));
  });

  it("offers a reader of another's issue no edits or state change; a locked one no comment", () => {
    const reader = renderPage(
      IssuePage,
      "/ada/demo/issues/7",
      pageData({
        issue: issue({ user: { id: "usr_other" } }),
        comments: [comment(1, { user: { id: "usr_other" } })],
        permissions: READ_ONLY,
      }),
    );
    expect(reader).not.toContain("Edit title and description");
    expect(reader).not.toContain("Close issue");
    expect(reader).not.toContain("Edit or delete");
    expect(reader).toContain("Add a comment");
    const locked = renderPage(
      IssuePage,
      "/ada/demo/issues/7",
      pageData({ issue: issue({ locked: true }), permissions: READ_ONLY }),
    );
    expect(locked).not.toContain("Add a comment");
    expect(locked).toContain("This conversation is locked.");
    // Write access still talks in a locked conversation.
    const writer = renderPage(
      IssuePage,
      "/ada/demo/issues/7",
      pageData({ issue: issue({ locked: true }) }),
    );
    expect(writer).toContain("Add a comment");
  });
});

describe("the issue pages' forms and viewers", () => {
  it("opens nothing from a new-issue form made for another viewer", async () => {
    const { context, calls } = api({});
    const outcome = await issuesAction({
      request: formPost("/ada/demo/issues", { viewer: "usr_other", title: "T" }),
      context,
      params: { owner: "ada", repo: "demo" },
    } as never);
    expect((outcome as { error: string }).error).toContain("someone else");
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
  });

  it("says when the session could not be checked, rather than sign the viewer out", async () => {
    const { context } = fakeApi((request) => {
      const url = new URL(request.url);
      if (url.pathname === "/auth/session") return new Response("down", { status: 503 });
      if (url.pathname.endsWith("/comments")) return json({ comments: [], next_cursor: null });
      if (url.pathname === "/api/repos/ada/demo") return json({ ...repo, permissions: ALL });
      return json(issue());
    });
    const data = await issueLoader({
      request: new Request(`${ORIGIN}/ada/demo/issues/7`, {
        headers: { Cookie: "fyrden_session=s" },
      }),
      context,
      params,
    } as never);
    expect(data).toMatchObject({ viewer: null, viewerKnown: false });
  });

  it("lets the author edit a locked issue, and offers a duplicate only to triage", () => {
    const authorReader = renderPage(
      IssuePage,
      "/ada/demo/issues/7",
      pageData({ issue: issue({ locked: true }), permissions: READ_ONLY, viewerKnown: true }),
    );
    expect(authorReader).toContain("Edit title and description");
    expect(authorReader).toContain("Close issue");
    expect(authorReader).not.toContain("Duplicate of");
    const triager = renderPage(IssuePage, "/ada/demo/issues/7", pageData({ viewerKnown: true }));
    expect(triager).toContain("Duplicate of");
  });

  it("clears filters to the state alone", () => {
    const html = renderPage(Issues, "/ada/demo/issues?state=closed&labels=bug", {
      repo,
      origin: ORIGIN,
      state: "closed",
      filters: { labels: "bug" },
      issues: [],
      pages: { next: null, first: null },
      viewer: VIEWER,
      viewerKnown: true,
      proposed: false,
    });
    expect(html).toMatch(/href="\/ada\/demo\/issues\?state=closed"[^>]*>Clear filters/);
  });
});

describe("an action's answer, in its scope only", () => {
  const scope = { viewer: VIEWER, owner: "ada", repo: "demo", number: 7 };
  const stale = (over: Record<string, unknown> = {}) => ({
    error: "Someone changed it",
    scope,
    draft: { fields: { title: "Mine", body: "my draft text" }, version: 3 },
    ...over,
  });

  it("sends a refused draft again from the version it was written from, without JavaScript too", () => {
    // The page read again shows version 4; the refused draft was written from 3.
    const html = renderPage(
      IssuePage,
      "/ada/demo/issues/7",
      pageData({ issue: issue({ version: 4 }) }),
      stale(),
    );
    expect(html).toContain("my draft text");
    expect(html).toMatch(
      /name="intent" value="edit"\/><input type="hidden" name="version" value="3"/,
    );
  });

  it("never shows one viewer's or issue's draft on another's page", () => {
    for (const other of [
      { ...scope, viewer: "usr_other" },
      { ...scope, number: 8 },
      { ...scope, repo: "elsewhere" },
    ]) {
      const html = renderPage(IssuePage, "/ada/demo/issues/7", pageData(), stale({ scope: other }));
      expect(html, JSON.stringify(other)).not.toContain("my draft text");
      expect(html).not.toContain("Someone changed it");
    }
  });

  it("keeps a comment's draft and version to that comment", () => {
    const html = renderPage(
      IssuePage,
      "/ada/demo/issues/7",
      pageData({ comments: [comment(1, { version: 5 }), comment(2, { version: 6 })] }),
      { error: "x", scope, draft: { fields: { body: "draft for 2" }, version: 4, target: 2 } },
    );
    expect(html).toContain(
      'name="comment_id" value="1"/><input type="hidden" name="version" value="5"',
    );
    expect(html).toContain(
      'name="comment_id" value="2"/><input type="hidden" name="version" value="4"',
    );
    expect(html.match(/draft for 2/g)).toHaveLength(1);
    expect(html).not.toContain("Your unsent text");
  });

  it("keeps a draft to copy when its comment is on another page now", () => {
    // The comment grew past the page's budget while the edit was refused: it is not shown here.
    const html = renderPage(
      IssuePage,
      "/ada/demo/issues/7",
      pageData({
        comments: [comment(1)],
        pages: { next: "/ada/demo/issues/7?after=1", first: null },
      }),
      {
        error: "x",
        scope,
        draft: { fields: { body: `draft for 9 ${HOSTILE}` }, version: 4, target: 9 },
      },
    );
    expect(html).toContain("Your unsent text");
    expect(html).toContain(`draft for 9 ${escaped(HOSTILE)}`);
    expect(html).not.toMatch(ACTIVE_TAG);
    expect(html).toMatch(/<textarea id="unsent-comment-9-body" class="short" readOnly="">/);
  });

  it("keeps a comment's and a new comment's drafts to copy once the conversation is locked", () => {
    const locked = issue({ locked: true, user: { id: "usr_other" } });
    for (const [text, draft] of [
      ["my new comment", { fields: { comment: "my new comment" }, version: undefined }],
      ["my comment edit", { fields: { body: "my comment edit" }, version: 1, target: 1 }],
    ] as const) {
      const html = renderPage(
        IssuePage,
        "/ada/demo/issues/7",
        pageData({ issue: locked, permissions: READ_ONLY }),
        { error: "Locked.", scope, draft },
      );
      expect(html, text).toContain("Your unsent text");
      expect(html.match(new RegExp(text, "g")), text).toHaveLength(1);
      // Nothing to send it with: no comment, edit or delete form.
      expect(html).not.toMatch(/value="(comment|edit-comment|delete-comment)"/);
    }
  });

  it("shows the new issue form's draft only to who wrote it", () => {
    const list = (viewer: string) =>
      renderPage(
        Issues,
        "/ada/demo/issues",
        {
          repo,
          origin: ORIGIN,
          state: "open",
          filters: {},
          issues: [],
          pages: { next: null, first: null },
          viewer,
          viewerKnown: true,
          proposed: false,
        },
        { error: "No.", draft: { title: "Alice's draft", body: "", viewer: VIEWER } },
      );
    expect(list(VIEWER)).toContain("Alice&#x27;s draft");
    expect(list("usr_other")).not.toContain("Alice");
  });
});

describe("the conversation's source budget", () => {
  it("shows comments up to 256 KiB of Markdown, going on after the last one shown", async () => {
    // 65,536 three-byte characters: 192 KiB each, so one a page past the first.
    const big = (id: number) => comment(id, { body: "€".repeat(65_536) });
    const { context } = api({
      "GET /api/repos/ada/demo/issues/7": () => json(issue()),
      "GET /api/repos/ada/demo/issues/7/comments": () =>
        json({ comments: [big(1), big(2), big(3)], next_cursor: null }),
      "GET /api/repos/ada/demo": () => json({ ...repo, permissions: ALL }),
    });
    const data = await issueLoader({
      request: new Request(`${ORIGIN}/ada/demo/issues/7`),
      context,
      params,
    } as never);
    expect(data.comments.map((c) => c.id)).toEqual([1]);
    // The API had no more, but the page was cut: it goes on after the one shown.
    expect(data.pages.next).toBe("/ada/demo/issues/7?after=1");
  });
});

describe("an action that cannot finish", () => {
  const edit = { viewer: VIEWER, intent: "edit", title: "T", body: "my text", version: "3" };

  it("sends nothing when the session cannot be checked, and keeps what was written", async () => {
    const { context, calls } = fakeApi((request) =>
      new URL(request.url).pathname === "/auth/session"
        ? new Response("down", { status: 503 })
        : json({}),
    );
    const outcome = await issueAction({
      request: formPost("/ada/demo/issues/7", edit),
      context,
      params,
    } as never);
    expect(outcome).toMatchObject({
      scope: { viewer: VIEWER, owner: "ada", repo: "demo", number: 7 },
      draft: { fields: { title: "T", body: "my text" }, version: 3 },
    });
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
    const listed = await issuesAction({
      request: formPost("/ada/demo/issues", { viewer: VIEWER, title: "New", body: "b" }),
      context,
      params: { owner: "ada", repo: "demo" },
    } as never);
    expect(listed).toMatchObject({ draft: { title: "New", body: "b", viewer: VIEWER } });
  });

  it("keeps what was written when the API cannot be reached or answers unreadably", async () => {
    for (const fail of [
      () => {
        throw new TypeError("binding failed");
      },
      () => new Response("<html>bad gateway</html>", { status: 503 }),
    ]) {
      const { context } = fakeApi((request) =>
        new URL(request.url).pathname === "/auth/session"
          ? json({ user: { id: VIEWER, handle: "ada" } })
          : fail(),
      );
      const outcome = await issueAction({
        request: formPost("/ada/demo/issues/7", edit),
        context,
        params,
      } as never);
      expect(outcome).toMatchObject({ draft: { fields: { body: "my text" }, version: 3 } });
      expect((outcome as { error: string }).error).toContain("may or may not have been done");
      const listed = await issuesAction({
        request: formPost("/ada/demo/issues", { viewer: VIEWER, title: "New", body: "b" }),
        context,
        params: { owner: "ada", repo: "demo" },
      } as never);
      expect(listed).toMatchObject({ draft: { title: "New", body: "b", viewer: VIEWER } });
    }
  });
});

describe("reactions", () => {
  const rollup = (over: Record<string, unknown> = {}) => ({
    total_count: 0,
    "+1": 0,
    "-1": 0,
    laugh: 0,
    confused: 0,
    heart: 0,
    hooray: 0,
    rocket: 0,
    eyes: 0,
    ...over,
  });

  it("toggles the viewer's own off by its id, and adds the others", () => {
    const html = renderPage(
      IssuePage,
      "/ada/demo/issues/7",
      pageData({
        issue: issue({
          reactions: rollup({
            total_count: 3,
            heart: 2,
            "+1": 1,
            viewer: [{ id: 9, content: "heart" }],
          }),
        }),
        comments: [comment(1, { reactions: rollup({ total_count: 1, eyes: 1, viewer: [] }) })],
      }),
    );
    // The heart is the viewer's: taken back by its id.
    expect(html).toMatch(
      /value="unreact"\/><input type="hidden" name="target" value="issue"\/><input type="hidden" name="content" value="heart"\/><input type="hidden" name="reaction_id" value="9"\/>/,
    );
    expect(html).toMatch(
      /aria-pressed="true"[^>]*><span aria-hidden="true">❤️<\/span><span class="visually-hidden">Heart<\/span> <!-- -->2/,
    );
    // Another's +1: one more is added.
    expect(html).toMatch(
      /value="react"\/><input type="hidden" name="target" value="issue"\/><input type="hidden" name="content" value="\+1"/,
    );
    // A comment's: by its id, with the viewer's form field.
    expect(html).toMatch(
      /value="react"\/><input type="hidden" name="target" value="1"\/><input type="hidden" name="content" value="eyes"\/><input type="hidden" name="viewer" value="usr_viewer"/,
    );
    // The rest, to add.
    expect(html.match(/Add a reaction/g)).toHaveLength(2);
  });

  it("shows counts only to whoever may not react", () => {
    const reacted = issue({ reactions: rollup({ total_count: 1, rocket: 1 }) });
    for (const data of [
      pageData({ issue: reacted, viewer: null }),
      pageData({ issue: { ...reacted, locked: true }, permissions: READ_ONLY }),
    ]) {
      const html = renderPage(IssuePage, "/ada/demo/issues/7", data);
      expect(html).toContain('<span class="visually-hidden">Rocket</span> <!-- -->1');
      expect(html).not.toMatch(/value="(un)?react"/);
      expect(html).not.toContain("Add a reaction");
    }
  });

  async function react(fields: Record<string, string>) {
    const { context, calls } = api({
      "POST /api/repos/ada/demo/issues/7/reactions": () => json({ id: 3 }, 201),
      "DELETE /api/repos/ada/demo/issues/7/reactions/9": () => json({ id: 9, state: "deleted" }),
      "POST /api/repos/ada/demo/issues/comments/5/reactions": () => json({ id: 4 }, 201),
    });
    const outcome = await issueAction({
      request: formPost("/ada/demo/issues/7", { viewer: VIEWER, ...fields }),
      context,
      params,
    } as never);
    const sent = calls.find((c) => c.method !== "GET" && !c.url.includes("/auth/"));
    return {
      outcome,
      sent: sent && {
        path: pathOf(sent),
        body: sent.method === "DELETE" ? undefined : await sent.json(),
      },
    };
  }

  it("adds and takes back on the issue or a comment, and sends nothing malformed", async () => {
    const added = await react({ intent: "react", target: "issue", content: "heart" });
    expect(added.sent).toEqual({
      path: "POST /api/repos/ada/demo/issues/7/reactions",
      body: { content: "heart" },
    });
    expect(added.outcome).toMatchObject({ ok: "react" });
    expect(
      (await react({ intent: "unreact", target: "issue", content: "heart", reaction_id: "9" }))
        .sent,
    ).toEqual({ path: "DELETE /api/repos/ada/demo/issues/7/reactions/9", body: undefined });
    expect((await react({ intent: "react", target: "5", content: "+1" })).sent).toEqual({
      path: "POST /api/repos/ada/demo/issues/comments/5/reactions",
      body: { content: "+1" },
    });
    for (const bad of [
      { intent: "react", target: "issue", content: "thumbsup" },
      { intent: "react", target: "../7", content: "heart" },
      { intent: "unreact", target: "issue", reaction_id: "x" },
    ]) {
      const { sent, outcome } = await react(bad);
      expect(sent, JSON.stringify(bad)).toBeUndefined();
      expect(outcome).toMatchObject({ error: expect.any(String) });
    }
  });
});
