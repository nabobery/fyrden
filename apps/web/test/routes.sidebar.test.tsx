// An issue's or pull request's sidebar (labels, assignees, milestone, lock,
// deletion) and the pages that choose its labels and milestone: what each
// form sends, what each role is offered, and nothing sent from a form whose
// fields it may not send.

import { describe, expect, it } from "vitest";
import { metaCall } from "../app/lib/subject-meta.server.js";
import { default as IssuePage, action as issueAction } from "../app/routes/repo.issue.js";
import {
  default as Labels,
  action as labelsAction,
  loader as labelsLoader,
} from "../app/routes/repo.issue.labels.js";
import {
  default as Milestone,
  action as milestoneAction,
} from "../app/routes/repo.issue.milestone.js";
import { action as pullAction } from "../app/routes/repo.pull.js";
import { formPost, json, ORIGIN } from "./helpers/context.js";
import { api, pathOf, repo, VIEWER } from "./helpers/pulls.js";
import { ACTIVE_TAG, escaped, HOSTILE, renderPage } from "./helpers/render.js";

const API = "/api/repos/ada/demo/issues/7";
const params = { owner: "ada", repo: "demo", number: "7" };
const ALL = { admin: true, maintain: true, push: true, triage: true, pull: true };
const TRIAGE = { admin: false, maintain: false, push: false, triage: true, pull: true };
const READ_ONLY = { admin: false, maintain: false, push: false, triage: false, pull: true };

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
};

describe("a sidebar form's API call", () => {
  it("is GitHub's for each, labels held to the id the form showed", () => {
    expect(metaCall("label-add", form({ label: "bug", label_id: "3" }), API)).toEqual({
      method: "POST",
      path: `${API}/labels`,
      body: { labels: ["bug"], expected_ids: [3] },
    });
    expect(metaCall("label-remove", form({ label: "a b/c", label_id: "3" }), API)).toEqual({
      method: "DELETE",
      path: `${API}/labels/a%20b%2Fc`,
      body: { expected_id: 3 },
    });
    expect(metaCall("assign", form({ handle: " @bo " }), API)).toEqual({
      method: "POST",
      path: `${API}/assignees`,
      body: { assignees: ["bo"] },
    });
    expect(metaCall("unassign", form({ assignee_id: "usr_x" }), API)).toEqual({
      method: "DELETE",
      path: `${API}/assignees`,
      body: { assignee_ids: ["usr_x"] },
    });
    expect(metaCall("milestone-set", form({ milestone: "2" }), API)).toMatchObject({
      method: "PATCH",
      body: { milestone: 2 },
    });
    expect(metaCall("milestone-clear", form({}), API)).toMatchObject({ body: { milestone: null } });
    expect(metaCall("lock", form({ lock_reason: "too heated" }), API)).toEqual({
      method: "PUT",
      path: `${API}/lock`,
      body: { lock_reason: "too heated" },
    });
    expect(metaCall("lock", form({ lock_reason: "" }), API)).toMatchObject({ body: {} });
    expect(metaCall("unlock", form({}), API)).toMatchObject({
      method: "DELETE",
      path: `${API}/lock`,
    });
    expect(metaCall("delete-issue", form({}), API)).toMatchObject({ method: "DELETE", path: API });
  });

  it("is none for fields it may not send", () => {
    for (const [intent, fields] of [
      ["label-add", { label: "bug", label_id: "x" }],
      ["label-remove", { label: "", label_id: "3" }],
      ["assign", { handle: "not a handle" }],
      ["assign", { handle: "a".repeat(40) }],
      ["unassign", { assignee_id: "../x" }],
      ["milestone-set", { milestone: "0" }],
      ["lock", { lock_reason: "bored" }],
    ] as const)
      expect(
        metaCall(intent, form(fields), API),
        `${intent} ${JSON.stringify(fields)}`,
      ).toHaveProperty("refused");
  });
});

function issue(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    number: 7,
    state: "open",
    state_reason: null,
    duplicate_of: null,
    title: "Crash on start",
    body: null,
    user: { id: "usr_other" },
    performed_via_agents: [],
    locked: false,
    active_lock_reason: null,
    closed_by: null,
    created_at: 1,
    updated_at: 1,
    closed_at: null,
    version: 3,
    labels: [{ id: 3, name: "bug", color: "d73a4a", description: null, default: true, version: 1 }],
    assignee: { id: "usr_bo" },
    assignees: [{ id: "usr_bo" }],
    milestone: { number: 2, title: "v2", state: "closed" },
    reactions: { total_count: 0 },
    ...overrides,
  };
}

const pageData = (overrides: Record<string, unknown> = {}) => ({
  owner: "ada",
  repo: "demo",
  issue: issue(),
  comments: [],
  pages: { next: null, first: null },
  permissions: ALL,
  viewer: VIEWER,
  viewerKnown: true,
  ...overrides,
});

describe("the issue page's sidebar", () => {
  it("shows labels, assignees and milestone to anyone, and offers each change as the role allows", () => {
    const reader = renderPage(
      IssuePage,
      "/ada/demo/issues/7",
      pageData({ permissions: READ_ONLY }),
    );
    expect(reader).toContain("bug");
    expect(reader).toContain("usr_bo");
    expect(reader).toMatch(/v2<span class="muted"> \(closed\)/);
    expect(reader).not.toMatch(
      /value="(label-remove|unassign|assign|milestone-clear|lock|delete-issue)"/,
    );
    expect(reader).not.toContain("Add labels");
    const triage = renderPage(IssuePage, "/ada/demo/issues/7", pageData({ permissions: TRIAGE }));
    for (const intent of ["label-remove", "unassign", "assign", "milestone-clear"])
      expect(triage, intent).toContain(`value="${intent}"`);
    expect(triage).toContain('href="/ada/demo/issues/7/labels"');
    expect(triage).toContain('href="/ada/demo/issues/7/milestone"');
    expect(triage).not.toMatch(/value="(lock|delete-issue)"/);
    const admin = renderPage(IssuePage, "/ada/demo/issues/7", pageData());
    expect(admin).toContain('value="lock"');
    expect(admin).toContain("Delete issue #7");
    const locked = renderPage(
      IssuePage,
      "/ada/demo/issues/7",
      pageData({ issue: issue({ locked: true, active_lock_reason: "too heated" }) }),
    );
    expect(locked).toContain("Locked as Too heated");
    expect(locked).toContain('value="unlock"');
  });

  it("sends each change, and goes to the list once the issue is deleted", async () => {
    const { context, calls } = api({
      [`DELETE ${API}/labels/bug`]: () => json({ labels: [] }),
      [`DELETE ${API}`]: () => json({ number: 7, state: "deleted" }),
      [`PUT ${API}/lock`]: () => json({ locked: true }),
    });
    const send = (fields: Record<string, string>) =>
      issueAction({
        request: formPost("/ada/demo/issues/7", { viewer: VIEWER, ...fields }),
        context,
        params,
      } as never);
    expect(await send({ intent: "label-remove", label: "bug", label_id: "3" })).toMatchObject({
      ok: "label-remove",
    });
    expect(await send({ intent: "lock", lock_reason: "spam" })).toMatchObject({ ok: "lock" });
    const deleted = (await send({ intent: "delete-issue" })) as Response;
    expect(deleted.status).toBe(302);
    expect(deleted.headers.get("Location")).toBe("/ada/demo/issues");
    expect(await send({ intent: "assign", handle: "no way" })).toMatchObject({
      error: "Name someone by their handle.",
    });
    expect(calls.filter((c) => c.method !== "GET").map(pathOf)).toEqual([
      `DELETE ${API}/labels/bug`,
      `PUT ${API}/lock`,
      `DELETE ${API}`,
    ]);
  });
});

describe("the pull request page's sidebar", () => {
  it("changes a pull request through its number, never deleting it", async () => {
    const { context, calls } = api({
      [`POST ${API}/assignees`]: () => json(issue()),
    });
    const send = (fields: Record<string, string>) =>
      pullAction({
        request: formPost("/ada/demo/pull/7", { viewer: VIEWER, ...fields }),
        context,
        params,
      } as never);
    expect(await send({ intent: "assign", handle: "bo" })).toMatchObject({ ok: "assign" });
    expect(await send({ intent: "delete-issue" })).toMatchObject({ error: "Unknown action." });
    expect(calls.filter((c) => c.method !== "GET").map(pathOf)).toEqual([`POST ${API}/assignees`]);
  });

  it("sends nothing from any of its forms made for another viewer", async () => {
    const { context, calls } = api({});
    for (const fields of [
      { intent: "assign", handle: "bo" },
      { intent: "lock", lock_reason: "" },
      { intent: "react", target: "issue", content: "rocket" },
      { intent: "comment", body: "hi" },
      { intent: "edit", title: "t", body: "b" },
      { intent: "close" },
      { intent: "merge", sha: "a".repeat(40), merge_method: "merge" },
    ]) {
      const outcome = await pullAction({
        request: formPost("/ada/demo/pull/7", { viewer: "usr_other", ...fields }),
        context,
        params,
      } as never);
      expect(outcome).toMatchObject({ error: expect.stringContaining("someone else") });
    }
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  });
});

describe("choosing labels", () => {
  const label = (id: number, name: string) => ({
    id,
    name,
    color: "0e8a16",
    description: null,
    default: false,
    version: 1,
  });

  it("searches the repository's labels by name, a page at a time", async () => {
    const { context, calls } = api({
      [`GET ${API}`]: () => json(issue()),
      "GET /api/repos/ada/demo": () => json({ ...repo, permissions: TRIAGE }),
      "GET /api/repos/ada/demo/labels": () => json({ labels: [], next_cursor: null }),
    });
    const data = await labelsLoader({
      request: new Request(`${ORIGIN}/ada/demo/issues/7/labels?q=bu&cursor=C`),
      context,
      params,
    } as never);
    expect(calls.map(pathOf)).toContain("GET /api/repos/ada/demo/labels?q=bu&per_page=30&cursor=C");
    expect(data).toMatchObject({ q: "bu", triage: true });
  });

  it("offers each label's add or removal, by name and id; hostile names as text", () => {
    const html = renderPage(Labels, "/ada/demo/issues/7/labels", {
      at: { owner: "ada", repo: "demo", number: 7 },
      subject: issue({ title: HOSTILE }),
      q: "",
      labels: [label(3, "bug"), label(4, HOSTILE)],
      pages: { next: null, first: null },
      triage: true,
      viewer: VIEWER,
      viewerKnown: true,
    });
    expect(html).not.toMatch(ACTIVE_TAG);
    expect(html).toContain(escaped(HOSTILE));
    expect(html).toMatch(
      /value="label-remove"\/><input type="hidden" name="label" value="bug"\/><input type="hidden" name="label_id" value="3"/,
    );
    expect(html).toContain('value="label-add"');
    expect(html).toContain('href="/ada/demo/issues/7"');
  });

  it("adds one, held to its id", async () => {
    const { context, calls } = api({ [`POST ${API}/labels`]: () => json({ labels: [] }) });
    const outcome = await labelsAction({
      request: formPost("/ada/demo/issues/7/labels", {
        viewer: VIEWER,
        intent: "label-add",
        label: "docs",
        label_id: "5",
      }),
      context,
      params,
    } as never);
    expect(outcome).toMatchObject({ ok: "label-add" });
    const sent = calls.find((c) => c.method === "POST");
    expect(await sent?.json()).toEqual({ labels: ["docs"], expected_ids: [5] });
  });
});

describe("choosing a milestone", () => {
  const picker = (subject: ReturnType<typeof issue>, milestones: unknown[]) =>
    renderPage(Milestone, "/ada/demo/issues/7/milestone", {
      at: { owner: "ada", repo: "demo", number: 7 },
      subject,
      milestones,
      pages: { next: null, first: null },
      triage: true,
      viewer: VIEWER,
      viewerKnown: true,
    });

  it("shows a closed current milestone, which the open ones do not list, to clear", () => {
    const html = picker(issue({ milestone: { number: 9, title: "v0", state: "closed" } }), [
      { number: 3, title: "v3", state: "open", due_on: null },
    ]);
    expect(html).toMatch(/In v0<span class="muted"> \(closed\)/);
    expect(html).toContain("Clear the milestone");
    expect(html).not.toContain("(its milestone)");
  });

  it("links a pull request's back to its own page", () => {
    const html = picker(issue({ pull_request: { merged_at: null } }), []);
    expect(html).toContain('href="/ada/demo/pull/7"');
    expect(html).toContain("Back to the pull request");
  });

  it("sends nothing from a form made for another viewer", async () => {
    const { context, calls } = api({});
    const outcome = await milestoneAction({
      request: formPost("/ada/demo/issues/7/milestone", {
        viewer: "usr_other",
        intent: "milestone-clear",
      }),
      context,
      params,
    } as never);
    expect(outcome).toMatchObject({ error: expect.stringContaining("someone else") });
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("offers the open ones and clearing the current one, and sets one", async () => {
    const html = renderPage(Milestone, "/ada/demo/issues/7/milestone", {
      at: { owner: "ada", repo: "demo", number: 7 },
      subject: issue({ milestone: { number: 2, title: "v2", state: "open" } }),
      milestones: [
        { number: 2, title: "v2", state: "open", due_on: null },
        { number: 3, title: "v3", state: "open", due_on: Date.UTC(2027, 0, 2) },
      ],
      pages: { next: null, first: null },
      triage: true,
      viewer: VIEWER,
      viewerKnown: true,
    });
    expect(html).toContain("Clear the milestone");
    expect(html).toContain("(its milestone)");
    expect(html).toMatch(/value="milestone-set"\/><input type="hidden" name="milestone" value="3"/);
    const { context, calls } = api({ [`PATCH ${API}`]: () => json(issue()) });
    const outcome = await milestoneAction({
      request: formPost("/ada/demo/issues/7/milestone", {
        viewer: VIEWER,
        intent: "milestone-set",
        milestone: "3",
      }),
      context,
      params,
    } as never);
    expect(outcome).toMatchObject({ ok: "milestone-set" });
    expect(await calls.find((c) => c.method === "PATCH")?.json()).toEqual({ milestone: 3 });
  });
});
