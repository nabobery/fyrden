// Labels, milestones and assignees of issues and pull requests: managed
// with write access, set with triage on either kind through the issue
// endpoints, each kind only by a token that may act on it; milestone
// counts kept whatever changes a state; new repositories start with their
// account's default labels.
import { env } from "cloudflare:workers";
import { type DomainEvent, type FeedBlock, GITHUB_DEFAULT_LABELS } from "@fyrden/domain";
import { uniqueId } from "@fyrden/testing";
import { beforeEach, describe, expect, inject, it } from "vitest";
import type { RepoDO } from "../src/do/RepoDO.js";
import { encodeCursor } from "../src/ops/cursor.js";
import { api, json, user, type Who } from "./helpers/api.js";
import { scopedToken } from "./helpers/principals.js";
import { type PushTarget, postPush } from "./helpers/push.js";
import { pushBody, ZERO } from "./helpers/push-fixtures.js";
import { inRepo } from "./helpers/repo-git.js";

const fx = inject("pushFixtures");

type Label = {
  id: number;
  name: string;
  color: string;
  description: string | null;
  default: boolean;
};
type Milestone = {
  number: number;
  title: string;
  state: "open" | "closed";
  open_issues: number;
  closed_issues: number;
  due_on: number | null;
  closed_at: number | null;
};
type Sorted = {
  number: number;
  labels: Label[];
  assignee: { id: string } | null;
  assignees: { id: string }[];
  milestone: Milestone | null;
  title: string;
  pull_request?: { merged_at: number | null };
  code?: string;
};

let owner: Who;
let repo: { id: string; name: string };
let path: string;

const stub = () => env.REPO.getByName(repo.id);

async function collaborator(permission: "pull" | "triage" | "push" | "admin"): Promise<Who> {
  const who = await user();
  expect(
    (await api("PUT", `${path}/collaborators/${who.handle}`, owner.token, { permission })).status,
  ).toBe(200);
  return who;
}

const scoped = async (who: Who, scopes: string[]): Promise<Who> => ({
  ...who,
  token: await scopedToken(who.principalId, scopes, "pat"),
});

const names = (labels: readonly Label[]) => labels.map((l) => l.name);
const label = (who: Who, name: string, color = "00ff00", description?: string) =>
  json<Label & { code?: string }>(
    api("POST", `${path}/labels`, who.token, { name, color, ...(description && { description }) }),
  );
const openIssue = (who: Who, input: Record<string, unknown> = {}) =>
  json<Sorted>(api("POST", `${path}/issues`, who.token, { title: "Broken", ...input }));
const getIssue = (who: Who, number: number) =>
  json<Sorted>(api("GET", `${path}/issues/${number}`, who.token));
const patchIssue = (who: Who, number: number, patch: Record<string, unknown>) =>
  json<Sorted>(api("PATCH", `${path}/issues/${number}`, who.token, patch));
const subjectLabels = (who: Who, number: number, method: string, body?: unknown, name = "") =>
  json<{ labels: Label[]; code?: string }>(
    api(
      method,
      `${path}/issues/${number}/labels${name && `/${encodeURIComponent(name)}`}`,
      who.token,
      body,
    ),
  );
const milestone = (who: Who, input: Record<string, unknown>) =>
  json<Milestone & { code?: string }>(api("POST", `${path}/milestones`, who.token, input));
const getMilestone = async (number: number) =>
  (await json<Milestone>(api("GET", `${path}/milestones/${number}`, owner.token))).body;

/** Opens a pull request from `feature` into `main` as the owner; its number. */
async function openPull(): Promise<number> {
  const res = await json<{ number: number }>(
    api("POST", `${path}/pulls`, owner.token, { title: "Change", head: "feature", base: "main" }),
  );
  expect(res.status).toBe(201);
  return res.body.number;
}

/** The outbox's events of `prefix`. */
const events = async (prefix: string) =>
  (
    await inRepo(stub(), (r: RepoDO) =>
      r.git.context.storage.sql
        .exec<{ event: string }>("SELECT event FROM outbox ORDER BY source_seq")
        .toArray()
        .map((row) => JSON.parse(row.event) as DomainEvent),
    )
  ).filter((e) => e.type.startsWith(prefix));

beforeEach(async () => {
  owner = await user();
  repo = (
    await json<{ id: string; name: string }>(
      api("POST", "/user/repos", owner.token, { name: uniqueId("r") }),
    )
  ).body;
  path = `/repos/${owner.handle}/${repo.name}`;
  const target: PushTarget = {
    repo: { id: repo.id, name: repo.name, stub: stub() },
    owner: {
      principalId: owner.principalId,
      token: await scopedToken(owner.principalId, [], "git"),
    },
    path: `/${owner.handle}/${repo.name}.git`,
  };
  const pushed = await postPush(
    target,
    pushBody(
      [
        { old: ZERO, new: fx.c1, ref: "refs/heads/main" },
        { old: ZERO, new: fx.c2, ref: "refs/heads/feature" },
      ],
      { pack: fx.packC2 },
    ),
  );
  expect(pushed.report).toContain("ok refs/heads/feature\n");
});

describe("repository labels", () => {
  it("start as GitHub's defaults, and are managed with write access", async () => {
    const listed = await json<{ labels: Label[] }>(api("GET", `${path}/labels`, owner.token));
    expect(names(listed.body.labels)).toEqual(GITHUB_DEFAULT_LABELS.map((l) => l.name));
    expect(listed.body.labels[0]).toMatchObject({
      name: "bug",
      color: "d73a4a",
      description: "Something isn't working",
      default: true,
    });
    const triage = await collaborator("triage");
    expect((await label(triage, "area/api")).status).toBe(403);
    const writer = await collaborator("push");
    const made = await label(writer, "area/api", "ABCDEF", "The API");
    expect(made).toMatchObject({
      status: 201,
      body: { name: "area/api", color: "abcdef", description: "The API", default: false },
    });
    // Names are unique ignoring case, and found ignoring case (a slash in a name is escaped).
    expect((await label(writer, "AREA/API")).body.code).toBe("label_exists");
    const got = await json<Label>(
      api("GET", `${path}/labels/${encodeURIComponent("Area/API")}`, triage.token),
    );
    expect(got.body.id).toBe(made.body.id);
    const renamed = await json<Label>(
      api("PATCH", `${path}/labels/${encodeURIComponent("area/api")}`, writer.token, {
        new_name: "API",
        description: null,
      }),
    );
    expect(renamed.body).toMatchObject({ id: made.body.id, name: "API", description: null });
    expect(
      (await json(api("PATCH", `${path}/labels/API`, writer.token, { new_name: "bug" }))).body.code,
    ).toBe("label_exists");
    expect((await api("DELETE", `${path}/labels/API`, triage.token)).status).toBe(403);
    expect((await api("DELETE", `${path}/labels/API`, writer.token)).status).toBe(200);
    expect((await api("GET", `${path}/labels/API`, writer.token)).status).toBe(404);
  });

  it("page by name, and serve a token that reads either kind, not one that reads neither", async () => {
    for (const name of ["a1", "B2", "c3"]) expect((await label(owner, name)).status).toBe(201);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: { status: number; body: { labels: Label[]; next_cursor: string | null } } =
        await json(
          api("GET", `${path}/labels?per_page=5${cursor ? `&cursor=${cursor}` : ""}`, owner.token),
        );
      expect(page.status).toBe(200);
      seen.push(...names(page.body.labels));
      cursor = page.body.next_cursor;
    } while (cursor);
    expect(seen).toEqual(
      [...GITHUB_DEFAULT_LABELS.map((l) => l.name), "a1", "B2", "c3"].sort((a, b) =>
        a.toLowerCase().localeCompare(b.toLowerCase()),
      ),
    );
    const pullsOnly = await scoped(owner, ["pull_requests:read"]);
    expect((await api("GET", `${path}/labels`, pullsOnly.token)).status).toBe(200);
    const neither = await scoped(owner, ["metadata:read"]);
    expect((await json(api("GET", `${path}/labels`, neither.token))).body.code).toBe(
      "missing_permission",
    );
    const issuesRead = await scoped(owner, ["issues:read"]);
    expect((await label(issuesRead, "x")).status).toBe(403);
  });
});

describe("label names", () => {
  it("compare ignoring the case of ASCII letters only, as storage does, and are never dot segments", async () => {
    expect((await label(owner, "Émoji")).status).toBe(201);
    // `é` and `É` are two names (only ASCII letters fold), so this is another label...
    expect((await label(owner, "émoji")).status).toBe(201);
    // ...and renaming one into the other is a collision, not a server error.
    const collision = await json<{ code: string }>(
      api("PATCH", `${path}/labels/${encodeURIComponent("Émoji")}`, owner.token, {
        new_name: "émoji",
      }),
    );
    expect(collision).toMatchObject({ status: 422, body: { code: "label_exists" } });
    // A rename that changes only ASCII case is the same label renamed.
    const renamed = await json<Label>(
      api("PATCH", `${path}/labels/BUG`, owner.token, { new_name: "Bug" }),
    );
    expect(renamed.body.name).toBe("Bug");
    for (const name of [".", ".."]) expect((await label(owner, name)).status).toBe(422);
  });
});

describe("default labels", () => {
  it("are an organization's to set, copied into its new repositories and on request", async () => {
    const admin = await user(true);
    const org = uniqueId("org").slice(0, 39);
    expect(
      (await api("POST", "/admin/organizations", admin.token, { login: org, admin: owner.handle }))
        .status,
    ).toBe(201);
    const member = await user();
    expect(
      (
        await api("PUT", `/orgs/${org}/memberships/${member.handle}`, owner.token, {
          role: "member",
        })
      ).status,
    ).toBe(200);
    const defaults = await json<{ labels: { name: string }[] }>(
      api("GET", `/orgs/${org}/default-labels`, member.token),
    );
    expect(defaults.body.labels).toHaveLength(GITHUB_DEFAULT_LABELS.length);
    const set = {
      labels: [
        { name: "triage", color: "EEEEEE" },
        { name: "Bug", color: "ff0000", description: "Broken" },
      ],
    };
    expect((await api("PUT", `/orgs/${org}/default-labels`, member.token, set)).status).toBe(403);
    expect(
      (
        await json(
          api("PUT", `/orgs/${org}/default-labels`, owner.token, {
            labels: [
              { name: "x", color: "000000" },
              { name: "X", color: "000000" },
            ],
          }),
        )
      ).status,
    ).toBe(422);
    const replaced = await json<{ labels: unknown[] }>(
      api("PUT", `/orgs/${org}/default-labels`, owner.token, set),
    );
    expect(replaced.body.labels).toEqual([
      { name: "triage", color: "eeeeee", description: null },
      { name: "Bug", color: "ff0000", description: "Broken" },
    ]);
    const made = await json<{ name: string }>(
      api("POST", `/orgs/${org}/repos`, owner.token, { name: uniqueId("r") }),
    );
    expect(made.status).toBe(201);
    const orgPath = `/repos/${org}/${made.body.name}`;
    const got = await json<{ labels: Label[] }>(api("GET", `${orgPath}/labels`, owner.token));
    expect(names(got.body.labels)).toEqual(["Bug", "triage"]);
    // Copying the defaults in again adds only what is missing.
    expect((await api("DELETE", `${orgPath}/labels/triage`, owner.token)).status).toBe(200);
    const copied = await json<{ labels: Label[] }>(
      api("POST", `${orgPath}/labels/defaults`, owner.token),
    );
    expect(names(copied.body.labels)).toEqual(["triage"]);
    // The organization's object checks the caller is an owner as it writes: one whose ownership
    // went after the Worker checked it is refused there.
    const orgId = (
      await env.DIRECTORY.prepare("SELECT id FROM principals WHERE handle = ?")
        .bind(org)
        .first<{ id: string }>()
    )?.id as string;
    expect(
      await env.ORG.getByName(orgId).setDefaultLabels([], {
        accountId: orgId,
        actor: { principalId: member.principalId },
      }),
    ).toMatchObject({ ok: false, code: "forbidden" });
    // A fork starts with its owner's defaults (a user's: GitHub's) like any new repository.
    const fork = await json<{ name: string; code?: string }>(
      api("POST", `${path}/forks`, owner.token, { name: uniqueId("f") }),
    );
    expect(fork.status).toBe(201);
    const forked = await json<{ labels: Label[] }>(
      api("GET", `/repos/${owner.handle}/${fork.body.name}/labels`, owner.token),
    );
    expect(names(forked.body.labels)).toEqual(GITHUB_DEFAULT_LABELS.map((l) => l.name));
    // A user's handle is no organization.
    expect((await api("GET", `/orgs/${owner.handle}/default-labels`, owner.token)).status).toBe(
      404,
    );
  });
});

describe("labels on issues and pull requests", () => {
  it("are added, set, removed and cleared with triage, the author too", async () => {
    const reader = await collaborator("pull");
    const { number } = (await openIssue(reader)).body;
    expect((await subjectLabels(reader, number, "POST", { labels: ["bug"] })).status).toBe(403);
    const triage = await collaborator("triage");
    const added = await subjectLabels(triage, number, "POST", { labels: ["BUG", "question"] });
    expect(names(added.body.labels)).toEqual(["bug", "question"]);
    expect(
      names((await subjectLabels(triage, number, "POST", { labels: ["bug"] })).body.labels),
    ).toEqual(["bug", "question"]);
    expect((await subjectLabels(triage, number, "POST", { labels: ["nope"] })).body.code).toBe(
      "label_not_found",
    );
    const set = await subjectLabels(triage, number, "PUT", { labels: ["wontfix"] });
    expect(names(set.body.labels)).toEqual(["wontfix"]);
    // Taking off one it does not have changes nothing; one the repository lacks is not found.
    expect(
      names((await subjectLabels(triage, number, "DELETE", undefined, "bug")).body.labels),
    ).toEqual(["wontfix"]);
    expect((await subjectLabels(triage, number, "DELETE", undefined, "nope")).status).toBe(404);
    expect((await subjectLabels(triage, number, "DELETE")).body.labels).toEqual([]);
    expect((await subjectLabels(reader, number, "GET")).body.labels).toEqual([]);
  });

  it("go on pull requests through the same endpoints, each kind only with its permission", async () => {
    const { number: issue } = (await openIssue(owner)).body;
    const pr = await openPull();
    const issuesOnly = await scoped(owner, ["issues:write"]);
    const pullsOnly = await scoped(owner, ["pull_requests:write"]);
    expect((await subjectLabels(issuesOnly, pr, "POST", { labels: ["bug"] })).status).toBe(404);
    expect((await subjectLabels(pullsOnly, issue, "POST", { labels: ["bug"] })).status).toBe(404);
    expect(
      names((await subjectLabels(pullsOnly, pr, "POST", { labels: ["bug"] })).body.labels),
    ).toEqual(["bug"]);
    const pull = await json<Sorted>(api("GET", `${path}/pulls/${pr}`, owner.token));
    expect(names(pull.body.labels)).toEqual(["bug"]);
    expect(names((await getIssue(owner, pr)).body.labels)).toEqual(["bug"]);
    const listed = await json<{ issues: Sorted[] }>(api("GET", `${path}/issues`, owner.token));
    expect(listed.body.issues.map((i) => [i.number, names(i.labels)])).toEqual([
      [pr, ["bug"]],
      [issue, []],
    ]);
  });

  it("drop a label deleted from the repository, and hold at most 100", async () => {
    const { number } = (await openIssue(owner)).body;
    await subjectLabels(owner, number, "POST", { labels: ["bug", "question"] });
    expect((await api("DELETE", `${path}/labels/bug`, owner.token)).status).toBe(200);
    expect(names((await getIssue(owner, number)).body.labels)).toEqual(["question"]);
    // A new label of the same name is another label: the issue does not have it.
    expect((await label(owner, "bug")).status).toBe(201);
    expect(names((await getIssue(owner, number)).body.labels)).toEqual(["question"]);
    const many = Array.from({ length: 100 }, (_, i) => `l${i}`);
    for (const name of many) expect((await label(owner, name)).status).toBe(201);
    expect((await subjectLabels(owner, number, "POST", { labels: many })).body.code).toBe(
      "too_many_labels",
    );
    expect((await subjectLabels(owner, number, "PUT", { labels: many })).body.labels).toHaveLength(
      100,
    );
  });
});

describe("assignees", () => {
  it("are users who can read the repository, at most 10, assigned with triage", async () => {
    const reader = await collaborator("pull");
    const { number } = (await openIssue(reader)).body;
    const assign = (who: Who, assignees: string[]) =>
      json<Sorted>(api("POST", `${path}/issues/${number}/assignees`, who.token, { assignees }));
    expect((await assign(reader, [reader.handle])).status).toBe(403);
    const triage = await collaborator("triage");
    const assigned = await assign(triage, [reader.handle, owner.handle]);
    expect(assigned.status).toBe(200);
    expect(assigned.body.assignees.map((a) => a.id).sort()).toEqual(
      [reader.principalId, owner.principalId].sort(),
    );
    expect(assigned.body.assignee).toEqual(assigned.body.assignees[0]);
    const stranger = await user();
    expect((await assign(triage, [stranger.handle])).body.code).toBe("assignee_no_access");
    expect((await assign(triage, ["no-such-user"])).body.code).toBe("assignee_no_access");
    const more = await Promise.all(Array.from({ length: 9 }, () => collaborator("pull")));
    expect(
      (
        await assign(
          triage,
          more.map((m) => m.handle),
        )
      ).body.code,
    ).toBe("too_many_assignees");
    const removed = await json<Sorted>(
      api("DELETE", `${path}/issues/${number}/assignees`, triage.token, {
        assignees: [owner.handle, stranger.handle],
      }),
    );
    expect(removed.body.assignees).toEqual([{ id: reader.principalId }]);
  });

  it("answer the issue as the caller reads it (a duplicate target of a kind it reads only)", async () => {
    const pr = await openPull();
    const { number } = (await openIssue(owner)).body;
    await patchIssue(owner, number, {
      state: "closed",
      state_reason: "duplicate",
      duplicate_of: pr,
    });
    const mixed = await scoped(owner, ["issues:write", "pull_requests:read"]);
    const added = await json<Sorted & { duplicate_of: number | null }>(
      api("POST", `${path}/issues/${number}/assignees`, mixed.token, { assignees: [owner.handle] }),
    );
    expect(added.body.duplicate_of).toBe(pr);
    const removed = await json<Sorted & { duplicate_of: number | null }>(
      api("DELETE", `${path}/issues/${number}/assignees`, mixed.token, {
        assignees: [owner.handle],
      }),
    );
    expect(removed.body.duplicate_of).toBe(pr);
  });

  it("are told in their feeds, until unassigned or the issue closes, again when it reopens", async () => {
    const reader = await collaborator("pull");
    const { number } = (await openIssue(owner, { assignees: [reader.handle] })).body;
    await patchIssue(owner, number, { state: "closed" });
    await patchIssue(owner, number, { state: "open" });
    await api("DELETE", `${path}/issues/${number}/assignees`, owner.token, {
      assignees: [reader.handle],
    });
    const told = (await events("issue."))
      .filter((e) => e.feed)
      .map((e) => [
        e.type,
        (e.feed as FeedBlock).audience
          .filter((a) => a.principal === reader.principalId)
          .map((a) => [a.kind, a.state]),
      ]);
    expect(told).toEqual([
      ["issue.opened", [["assigned", "open"]]],
      [
        "issue.closed",
        [
          ["assigned", "resolved"],
          ["activity", "open"],
        ],
      ],
      [
        "issue.reopened",
        [
          ["assigned", "open"],
          ["activity", "open"],
        ],
      ],
      ["issue.unassigned", [["assigned", "resolved"]]],
    ]);
  });
});

describe("milestones", () => {
  it("are managed with write access, titles unique, listed by due date with none last", async () => {
    const triage = await collaborator("triage");
    expect((await milestone(triage, { title: "v1" })).status).toBe(403);
    const v2 = await milestone(owner, { title: "v2", due_on: 2_000 });
    const v1 = await milestone(owner, { title: "v1", due_on: 1_000, description: "First" });
    const later = await milestone(owner, { title: "Later" });
    const shipped = await milestone(owner, { title: "v0", state: "closed", due_on: 500 });
    expect(v1).toMatchObject({ status: 201, body: { number: 2, state: "open", open_issues: 0 } });
    expect(shipped.body.closed_at).not.toBeNull();
    expect((await milestone(owner, { title: "v1" })).body.code).toBe("milestone_exists");
    const page = async (query: string) => {
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const res: { body: { milestones: Milestone[]; next_cursor: string | null } } = await json(
          api(
            "GET",
            `${path}/milestones?per_page=1${query}${cursor ? `&cursor=${cursor}` : ""}`,
            triage.token,
          ),
        );
        seen.push(...res.body.milestones.map((m) => m.title));
        cursor = res.body.next_cursor;
      } while (cursor);
      return seen;
    };
    expect(await page("")).toEqual(["v1", "v2", "Later"]);
    expect(await page("&state=all&direction=desc")).toEqual(["Later", "v2", "v1", "v0"]);
    expect(await page("&state=closed")).toEqual(["v0"]);
    const closed = await json<Milestone>(
      api("PATCH", `${path}/milestones/${v2.body.number}`, owner.token, {
        state: "closed",
        due_on: null,
      }),
    );
    expect(closed.body).toMatchObject({ state: "closed", due_on: null });
    expect(closed.body.closed_at).not.toBeNull();
    expect(
      (await api("DELETE", `${path}/milestones/${later.body.number}`, owner.token)).status,
    ).toBe(200);
    expect((await api("GET", `${path}/milestones/${later.body.number}`, owner.token)).status).toBe(
      404,
    );
  });

  it("count their issues and pull requests as they stand, whatever changes a state", async () => {
    const { number: m } = (await milestone(owner, { title: "v1" })).body;
    const { number: other } = (await milestone(owner, { title: "v2" })).body;
    const a = (await openIssue(owner, { milestone: m })).body.number;
    const b = (await openIssue(owner)).body.number;
    const pr = await openPull();
    expect((await patchIssue(owner, b, { milestone: m })).status).toBe(200);
    expect((await patchIssue(owner, pr, { milestone: m })).status).toBe(200);
    expect(await getMilestone(m)).toMatchObject({ open_issues: 3, closed_issues: 0 });
    await patchIssue(owner, a, { state: "closed" });
    expect(await getMilestone(m)).toMatchObject({ open_issues: 2, closed_issues: 1 });
    // A pull request merged counts as closed.
    expect(
      (await api("PUT", `${path}/pulls/${pr}/merge`, owner.token, { merge_method: "merge" }))
        .status,
    ).toBe(200);
    expect(await getMilestone(m)).toMatchObject({ open_issues: 1, closed_issues: 2 });
    await patchIssue(owner, b, { milestone: other });
    expect(await getMilestone(m)).toMatchObject({ open_issues: 0, closed_issues: 2 });
    expect(await getMilestone(other)).toMatchObject({ open_issues: 1, closed_issues: 0 });
    expect((await api("DELETE", `${path}/issues/${a}`, owner.token)).status).toBe(200);
    expect(await getMilestone(m)).toMatchObject({ open_issues: 0, closed_issues: 1 });
    await patchIssue(owner, pr, { milestone: null });
    expect(await getMilestone(m)).toMatchObject({ open_issues: 0, closed_issues: 0 });
    // A milestone deleted is none for its issues from then on.
    await api("DELETE", `${path}/milestones/${other}`, owner.token);
    expect((await getIssue(owner, b)).body.milestone).toBeNull();
    expect((await patchIssue(owner, b, { milestone: other })).body.code).toBe(
      "milestone_not_found",
    );
  });
});

describe("milestone counts", () => {
  it("count only the kinds the caller reads, embedded or not", async () => {
    const { number: m } = (await milestone(owner, { title: "v1" })).body;
    const { number: issue } = (await openIssue(owner, { milestone: m })).body;
    const pr = await openPull();
    await patchIssue(owner, pr, { milestone: m });
    const counts = async (who: Who) => {
      const got = await json<Milestone>(api("GET", `${path}/milestones/${m}`, who.token));
      return [got.body.open_issues, got.body.closed_issues];
    };
    expect(await counts(owner)).toEqual([2, 0]);
    const issuesOnly = await scoped(owner, ["issues:read"]);
    const pullsOnly = await scoped(owner, ["pull_requests:read"]);
    expect(await counts(issuesOnly)).toEqual([1, 0]);
    expect(await counts(pullsOnly)).toEqual([1, 0]);
    // The pull request merged is nothing an issues-only token sees change.
    await api("PUT", `${path}/pulls/${pr}/merge`, owner.token, { merge_method: "merge" });
    expect(await counts(issuesOnly)).toEqual([1, 0]);
    expect(await counts(pullsOnly)).toEqual([0, 1]);
    expect((await getIssue(issuesOnly, issue)).body.milestone).toMatchObject({
      open_issues: 1,
      closed_issues: 0,
    });
    const pull = await json<Sorted>(api("GET", `${path}/pulls/${pr}`, pullsOnly.token));
    expect(pull.body.milestone).toMatchObject({ open_issues: 0, closed_issues: 1 });
  });
});

describe("issues sorted on creation and update", () => {
  it("take labels, assignees and a milestone with triage, refused without it, all or nothing", async () => {
    const reader = await collaborator("pull");
    const { number: m } = (await milestone(owner, { title: "v1" })).body;
    expect((await openIssue(reader, { labels: ["bug"] })).status).toBe(403);
    const made = await openIssue(owner, {
      labels: ["bug", "question"],
      assignees: [reader.handle],
      milestone: m,
    });
    expect(made.status).toBe(201);
    expect(names(made.body.labels)).toEqual(["bug", "question"]);
    expect(made.body.assignees).toEqual([{ id: reader.principalId }]);
    expect(made.body.milestone).toMatchObject({ number: m, open_issues: 1 });
    // A refused part refuses all of it.
    const refused = await patchIssue(owner, made.body.number, {
      title: "Renamed",
      labels: ["nope"],
    });
    expect(refused.body.code).toBe("label_not_found");
    expect((await getIssue(owner, made.body.number)).body.title).toBe("Broken");
    const both = await patchIssue(owner, made.body.number, {
      title: "Renamed",
      labels: [],
      milestone: null,
    });
    expect(both.body).toMatchObject({ title: "Renamed", labels: [], milestone: null });
    // The author edits its title, but needs triage for the rest.
    const own = (await openIssue(reader)).body.number;
    expect((await patchIssue(reader, own, { title: "Mine" })).status).toBe(200);
    expect((await patchIssue(reader, own, { milestone: m })).status).toBe(403);
  });

  it("take only labels, assignees and milestone for a pull request's number", async () => {
    const pr = await openPull();
    expect((await patchIssue(owner, pr, { title: "Renamed" })).body.code).toBe(
      "pull_request_fields",
    );
    const sorted = await patchIssue(owner, pr, { labels: ["bug"], assignees: [owner.handle] });
    expect(sorted.status).toBe(200);
    expect(sorted.body.pull_request).toBeDefined();
    expect(names(sorted.body.labels)).toEqual(["bug"]);
    const issuesOnly = await scoped(owner, ["issues:write", "pull_requests:read"]);
    expect((await patchIssue(issuesOnly, pr, { labels: [] })).status).toBe(404);
  });

  it("emit each change with the subject's snapshot carrying its labels, assignees and milestone", async () => {
    const { number: m } = (await milestone(owner, { title: "v1" })).body;
    const { number } = (await openIssue(owner, { labels: ["bug"] })).body;
    await patchIssue(owner, number, {
      labels: ["question"],
      assignees: [owner.handle],
      milestone: m,
    });
    const bug = (await json<Label>(api("GET", `${path}/labels/bug`, owner.token))).body.id;
    const question = (await json<Label>(api("GET", `${path}/labels/question`, owner.token))).body
      .id;
    expect(
      (await events("issue.")).map((e) => {
        const row = e.entity?.row as {
          labels: number[];
          assignees: string[];
          milestone: number | null;
        };
        return [e.type, e.entity?.version, row.labels, row.assignees, row.milestone, e.data];
      }),
    ).toEqual([
      ["issue.opened", 1, [bug], [], null, null],
      [
        "issue.labeled",
        2,
        [question],
        [owner.principalId],
        m,
        { label: { id: question, name: "question", color: "d876e3" } },
      ],
      [
        "issue.unlabeled",
        2,
        [question],
        [owner.principalId],
        m,
        { label: { id: bug, name: "bug", color: "d73a4a" } },
      ],
      [
        "issue.assigned",
        2,
        [question],
        [owner.principalId],
        m,
        { assignee: owner.principalId, assignee_root: owner.principalId },
      ],
      [
        "issue.milestoned",
        2,
        [question],
        [owner.principalId],
        m,
        { milestone: { number: m, title: "v1" } },
      ],
    ]);
    expect((await events("milestone.")).map((e) => e.type)).toEqual(["milestone.created"]);
    expect((await events("label.")).map((e) => e.type)).toEqual(
      GITHUB_DEFAULT_LABELS.map(() => "label.created"),
    );
  });
});

describe("the issue listing's filters", () => {
  const listed = (query: string, who: Who = owner) =>
    json<{ issues: Sorted[]; next_cursor: string | null; code?: string }>(
      api("GET", `${path}/issues?state=all&${query}`, who.token),
    );
  const numbers = (body: { issues: Sorted[] }) =>
    body.issues.map((i) => i.number).sort((a, b) => a - b);

  it("take labels by name or id, an assignee, a milestone and a creator, each a handle or none or any", async () => {
    const other = await collaborator("triage");
    await label(owner, "Bug");
    const comma = (await label(owner, "needs,discussion")).body;
    await label(owner, "needs");
    await label(owner, "discussion");
    const due = (await milestone(owner, { title: "v1" })).body;
    const a = (await openIssue(owner, { labels: ["bug"], assignees: [other.handle] })).body;
    const b = (await openIssue(owner, { labels: ["needs,discussion"], milestone: due.number }))
      .body;
    const c = (await openIssue(owner, { labels: ["needs", "discussion"] })).body;
    const d = (await openIssue(other, {})).body;
    const cases: [string, number[]][] = [
      ["labels=BUG", [a.number]],
      [`label_ids=${comma.id}`, [b.number]],
      ["labels=needs,discussion", [c.number]],
      ["labels=needs,missing", []],
      [`assignee=${other.handle.toUpperCase()}`, [a.number]],
      ["assignee=none", [b.number, c.number, d.number]],
      ["assignee=*", [a.number]],
      [`milestone=${due.number}`, [b.number]],
      ["milestone=none", [a.number, c.number, d.number]],
      ["milestone=*", [b.number]],
      [`creator=${other.handle}`, [d.number]],
      [`creator=${owner.handle}&labels=bug`, [a.number]],
      ["assignee=nobody-here", []],
      ["creator=nobody-here", []],
    ];
    for (const [query, expected] of cases) {
      const res = await listed(query);
      expect(res.status, query).toBe(200);
      expect(numbers(res.body), query).toEqual(expected.sort((x, y) => x - y));
    }
  });

  it("refuse labels with label_ids, too many names, and a cursor made with other filters", async () => {
    await label(owner, "bug");
    for (let i = 0; i < 3; i++) await openIssue(owner, { labels: ["bug"] });
    expect((await listed("labels=bug&label_ids=1")).status).toBe(422);
    const many = Array.from({ length: 21 }, (_, i) => `l${i}`).join(",");
    expect((await listed(`labels=${many}`)).body.code).toBe("invalid_filter");
    const first = await listed("labels=bug&per_page=1");
    expect(first.body.next_cursor).not.toBeNull();
    const cursor = encodeURIComponent(first.body.next_cursor as string);
    expect((await listed(`labels=bug&per_page=1&cursor=${cursor}`)).status).toBe(200);
    for (const other of ["", "labels=Bug,x", "milestone=none", "assignee=*"])
      expect((await listed(`${other}&per_page=1&cursor=${cursor}`)).body.code, other).toBe(
        "invalid_cursor",
      );
  });
});

describe("the issue listing's filters, at their edges", () => {
  const listed = (query: string) =>
    json<{ issues: Sorted[]; next_cursor: string | null; code?: string }>(
      api("GET", `${path}/issues?state=all&${query}`, owner.token),
    );

  it("match nothing for a deleted label or milestone, and treat what they left as none", async () => {
    const gone = (await label(owner, "gone")).body;
    const due = (await milestone(owner, { title: "gone" })).body;
    const issue = (await openIssue(owner, { labels: ["gone"], milestone: due.number })).body;
    expect((await api("DELETE", `${path}/labels/gone`, owner.token)).ok).toBe(true);
    expect((await api("DELETE", `${path}/milestones/${due.number}`, owner.token)).ok).toBe(true);
    for (const query of [
      `label_ids=${gone.id}`,
      "labels=gone",
      `milestone=${due.number}`,
      "milestone=*",
    ])
      expect((await listed(query)).body.issues, query).toEqual([]);
    expect((await listed("milestone=none")).body.issues.map((i) => i.number)).toEqual([
      issue.number,
    ]);
  });

  it("take none as a creator's handle, the assignee's words aside", async () => {
    const none = await user();
    await env.DIRECTORY.prepare("UPDATE principals SET handle = 'none' WHERE id = ?")
      .bind(none.principalId)
      .run();
    expect(
      (await api("PUT", `${path}/collaborators/none`, owner.token, { permission: "pull" })).status,
    ).toBe(200);
    const theirs = (await openIssue(none)).body;
    await openIssue(owner);
    expect((await listed("creator=none")).body.issues.map((i) => i.number)).toEqual([
      theirs.number,
    ]);
  });

  it("follow a cursor made with the most labels a filter names", async () => {
    const longNames = Array.from(
      { length: 20 },
      (_, i) => `${String(i).padStart(2, "0")}${"x".repeat(48)}`,
    );
    for (const name of longNames) expect((await label(owner, name)).status).toBe(201);
    for (let i = 0; i < 2; i++) await openIssue(owner, { labels: longNames });
    const query = `labels=${encodeURIComponent(longNames.join(","))}&per_page=1`;
    const first = await listed(query);
    expect(first.body.issues).toHaveLength(1);
    const next = await listed(
      `${query}&cursor=${encodeURIComponent(first.body.next_cursor as string)}`,
    );
    expect(next.status).toBe(200);
    expect(next.body.issues).toHaveLength(1);
  });
});

describe("label search", () => {
  it("finds names starting with q, ignoring ASCII case, a page at a time, the cursor bound to q", async () => {
    for (const name of ["zz-a", "ZZ-b", "zz-c", "zza", "zy"]) await label(owner, name);
    const page = (query: string) =>
      json<{ labels: Label[]; next_cursor: string | null; code?: string }>(
        api("GET", `${path}/labels?${query}`, owner.token),
      );
    const first = await page("q=zz-&per_page=2");
    expect(names(first.body.labels)).toEqual(["zz-a", "ZZ-b"]);
    const cursor = encodeURIComponent(first.body.next_cursor as string);
    const last = await page(`q=zz-&per_page=2&cursor=${cursor}`);
    expect(names(last.body.labels)).toEqual(["zz-c"]);
    expect(last.body.next_cursor).toBeNull();
    expect(names((await page("q=ZZ")).body.labels)).toEqual(["zz-a", "ZZ-b", "zz-c", "zza"]);
    expect((await page("q=nothing")).body.labels).toEqual([]);
    // A cursor holds its q: another q, or none, refuses it; a plain cursor is refused with q.
    expect((await page(`q=zz&per_page=2&cursor=${cursor}`)).body.code).toBe("invalid_cursor");
    expect((await page(`per_page=2&cursor=${cursor}`)).body.code).toBe("invalid_cursor");
    const plain = await page("per_page=2");
    const plainCursor = encodeURIComponent(plain.body.next_cursor as string);
    expect((await page(`q=zz&cursor=${plainCursor}`)).body.code).toBe("invalid_cursor");
    // A cursor made up to start before the prefix still lists only names starting with it.
    const forged = encodeURIComponent(encodeCursor("\u0001zz\u0000aa"));
    expect(names((await page(`q=zz&cursor=${forged}`)).body.labels)).toEqual([
      "zz-a",
      "ZZ-b",
      "zz-c",
      "zza",
    ]);
  });

  it("finds names that go on past the last code point", async () => {
    for (const name of ["x", "x\u{10FFFF}a", "x\u{10FFFF}\u{10FFFF}", "xa", "y"])
      expect((await label(owner, name)).status, name).toBe(201);
    const found = await json<{ labels: Label[] }>(
      api("GET", `${path}/labels?q=x&per_page=100`, owner.token),
    );
    expect(names(found.body.labels).sort()).toEqual(
      ["x", "x\u{10FFFF}a", "x\u{10FFFF}\u{10FFFF}", "xa"].sort(),
    );
  });
});

describe("assignees removed by id", () => {
  it("removes exactly the ids named, deleted users' included", async () => {
    const [a, b, c] = [
      await collaborator("triage"),
      await collaborator("triage"),
      await collaborator("triage"),
    ];
    const issue = (await openIssue(owner, { assignees: [a.handle, b.handle, c.handle] })).body;
    // a and b deleted: their handles become their ids, the old ones name no one.
    for (const who of [a, b])
      await env.DIRECTORY.prepare("UPDATE principals SET handle = id WHERE id = ?")
        .bind(who.principalId)
        .run();
    const removed = await json<Sorted>(
      api("DELETE", `${path}/issues/${issue.number}/assignees`, owner.token, {
        assignee_ids: [a.principalId],
      }),
    );
    expect(removed.status).toBe(200);
    expect(removed.body.assignees.map((x) => x.id).sort()).toEqual(
      [b.principalId, c.principalId].sort(),
    );
    expect(
      (await api("DELETE", `${path}/issues/${issue.number}/assignees`, owner.token, {})).status,
    ).toBe(422);
  });
});

describe("a repository's permissions for its caller", () => {
  it("say what the caller's role allows, as GitHub's", async () => {
    const perms = async (who: Who) =>
      (await json<{ permissions: Record<string, boolean> }>(api("GET", path, who.token))).body
        .permissions;
    expect(await perms(owner)).toEqual({
      admin: true,
      maintain: true,
      push: true,
      triage: true,
      pull: true,
    });
    expect(await perms(await collaborator("triage"))).toEqual({
      admin: false,
      maintain: false,
      push: false,
      triage: true,
      pull: true,
    });
    expect(await perms(await collaborator("push"))).toMatchObject({ push: true, maintain: false });
  });
});
