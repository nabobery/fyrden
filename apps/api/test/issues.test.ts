// Issues: opened by anyone who reads, numbered with pull requests, changed
// as the issue matrix allows, locked and deleted; the issue endpoints answer
// pull requests too (as GitHub's), each kind only to a caller that may read
// it; comments on either through the same endpoints.
import { env } from "cloudflare:workers";
import type { DomainEvent } from "@fyrden/domain";
import { uniqueId } from "@fyrden/testing";
import { beforeEach, describe, expect, inject, it } from "vitest";
import type { RepoDO } from "../src/do/RepoDO.js";
import { bodyOf } from "../src/webhooks/sink.js";
import { api, json, user, type Who } from "./helpers/api.js";
import { scopedToken } from "./helpers/principals.js";
import { type PushTarget, postPush } from "./helpers/push.js";
import { pushBody, ZERO } from "./helpers/push-fixtures.js";
import { inRepo } from "./helpers/repo-git.js";

const fx = inject("pushFixtures");

type Issue = {
  id: number;
  number: number;
  state: "open" | "closed";
  state_reason: string | null;
  duplicate_of: number | null;
  title: string;
  body: string | null;
  user: { id: string };
  locked: boolean;
  active_lock_reason: string | null;
  closed_by: { id: string } | null;
  closed_at: number | null;
  pull_request?: { merged_at: number | null };
  code?: string;
};
type Listing = { issues: Issue[]; next_cursor: string | null; code?: string };

let owner: Who;
let repo: { id: string; name: string };
let path: string;

async function collaborator(permission: "pull" | "triage" | "push" | "admin"): Promise<Who> {
  const who = await user();
  expect(
    (await api("PUT", `${path}/collaborators/${who.handle}`, owner.token, { permission })).status,
  ).toBe(200);
  return who;
}

/** `who` with a token limited to `scopes`. */
async function scoped(who: Who, scopes: string[]): Promise<Who> {
  return { ...who, token: await scopedToken(who.principalId, scopes, "pat") };
}

const open = (who: Who, title = "Broken", body?: string) =>
  json<Issue>(api("POST", `${path}/issues`, who.token, { title, ...(body && { body }) }));
const get = (who: Who, number: number) =>
  json<Issue>(api("GET", `${path}/issues/${number}`, who.token));
const update = (who: Who, number: number, patch: Record<string, unknown>) =>
  json<Issue>(api("PATCH", `${path}/issues/${number}`, who.token, patch));
const list = (who: Who, query = "") =>
  json<Listing>(api("GET", `${path}/issues${query}`, who.token));
const comment = (who: Who, number: number, body = "Thoughts") =>
  json<{ id: number; code?: string }>(
    api("POST", `${path}/issues/${number}/comments`, who.token, { body }),
  );
const lock = (who: Who, number: number, reason?: string) =>
  json<{ locked: boolean; active_lock_reason: string | null; code?: string }>(
    api("PUT", `${path}/issues/${number}/lock`, who.token, reason ? { lock_reason: reason } : {}),
  );

/** Opens a pull request from `feature` into `main` as the owner; its number. */
async function openPull(): Promise<number> {
  const res = await json<{ number: number }>(
    api("POST", `${path}/pulls`, owner.token, { title: "Change", head: "feature", base: "main" }),
  );
  expect(res.status).toBe(201);
  return res.body.number;
}

beforeEach(async () => {
  owner = await user();
  repo = (
    await json<{ id: string; name: string }>(
      api("POST", "/user/repos", owner.token, { name: uniqueId("r") }),
    )
  ).body;
  path = `/repos/${owner.handle}/${repo.name}`;
  const target: PushTarget = {
    repo: { id: repo.id, name: repo.name, stub: env.REPO.getByName(repo.id) },
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

describe("issues", () => {
  it("are opened by anyone who reads, numbered in one sequence with pull requests", async () => {
    const reader = await collaborator("pull");
    const first = await open(reader, "Crash on start", "Steps: run it.");
    expect(first).toMatchObject({
      status: 201,
      body: {
        id: 1,
        number: 1,
        state: "open",
        state_reason: null,
        duplicate_of: null,
        title: "Crash on start",
        body: "Steps: run it.",
        user: { id: reader.principalId },
        locked: false,
        closed_by: null,
      },
    });
    expect(first.body.pull_request).toBeUndefined();
    expect(await openPull()).toBe(2);
    expect((await open(owner)).body.number).toBe(3);
    expect((await get(reader, 1)).body).toEqual(first.body);
    // A stranger reads nothing of a private repository.
    expect((await open(await user())).status).toBe(404);
  });

  it("never give two subjects one number, however issues and pull requests interleave", async () => {
    const opened = await Promise.all([
      open(owner, "a"),
      open(owner, "b"),
      json<{ number: number }>(
        api("POST", `${path}/pulls`, owner.token, { title: "c", head: "feature", base: "main" }),
      ),
      open(owner, "d"),
    ]);
    const numbers = opened.map((o) => o.body.number).sort((a, b) => a - b);
    expect(numbers).toEqual([1, 2, 3, 4]);
  });

  it("answer a pull request by its number, marked, in the listing and on its own", async () => {
    await open(owner, "Bug");
    const pr = await openPull();
    const answer = await get(owner, pr);
    expect(answer.body).toMatchObject({
      number: pr,
      state: "open",
      title: "Change",
      pull_request: { merged_at: null },
    });
    const listed = await list(owner, "?state=all");
    expect(listed.body.issues.map((i) => [i.number, i.pull_request !== undefined])).toEqual([
      [2, true],
      [1, false],
    ]);
    expect((await list(owner, "?type=issues")).body.issues.map((i) => i.number)).toEqual([1]);
    expect((await list(owner, "?type=pulls")).body.issues.map((i) => i.number)).toEqual([2]);
    expect((await get(owner, 99)).body.code).toBe("issue_not_found");
  });

  it("show each kind only to a token that may read it, and reveal nothing of the other", async () => {
    await open(owner, "Bug");
    const pr = await openPull();
    await open(owner, "Another");
    const issuesOnly = await scoped(owner, ["issues:read"]);
    const pullsOnly = await scoped(owner, ["pull_requests:read"]);
    const neither = await scoped(owner, ["contents:read"]);
    expect((await list(issuesOnly)).body.issues.map((i) => i.number)).toEqual([3, 1]);
    expect((await list(pullsOnly)).body.issues.map((i) => i.number)).toEqual([pr]);
    // Asking for the kind it may not read lists nothing rather than failing on a hint.
    expect((await list(issuesOnly, "?type=pulls")).body.issues).toEqual([]);
    expect((await get(issuesOnly, pr)).body.code).toBe("issue_not_found");
    expect((await get(pullsOnly, 1)).body.code).toBe("issue_not_found");
    expect((await get(issuesOnly, 1)).status).toBe(200);
    expect((await list(neither)).status).toBe(403);
    // Pages of one kind: a cursor carries nothing about the other.
    const page = await list(issuesOnly, "?per_page=1");
    expect(page.body.issues.map((i) => i.number)).toEqual([3]);
    const next = await list(
      issuesOnly,
      `?per_page=1&cursor=${encodeURIComponent(page.body.next_cursor ?? "")}`,
    );
    expect(next.body.issues.map((i) => i.number)).toEqual([1]);
    expect(next.body.next_cursor).toBeNull();
  });

  it("list by state, oldest or newest first, by creation or update, a page at a time", async () => {
    for (const title of ["one", "two", "three", "four"]) await open(owner, title);
    await update(owner, 2, { state: "closed" });
    // When each was last changed, set outright (requests may share a millisecond): 1 last.
    const changedAt = (times: Record<number, number>) =>
      inRepo(env.REPO.getByName(repo.id), (r) => {
        for (const [n, at] of Object.entries(times))
          r.git.context.storage.sql.exec(
            "UPDATE issues SET updated_at = ? WHERE number = ?",
            at,
            n,
          );
      });
    await changedAt({ 1: 4_000, 2: 3_000, 3: 1_000, 4: 2_000 });
    const titles = (l: Listing) => l.issues.map((i) => i.number);
    expect(titles((await list(owner)).body)).toEqual([4, 3, 1]);
    expect(titles((await list(owner, "?state=closed")).body)).toEqual([2]);
    expect(titles((await list(owner, "?state=all&direction=asc")).body)).toEqual([1, 2, 3, 4]);
    expect(titles((await list(owner, "?state=all&sort=updated")).body)).toEqual([1, 2, 4, 3]);
    // Every page of a listing sorted by update, its cursor bound to its filters.
    const seen: number[] = [];
    let cursor: string | null = "";
    while (cursor !== null) {
      const q: string = `?state=all&sort=updated&direction=asc&per_page=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const page = await list(owner, q);
      expect(page.status).toBe(200);
      seen.push(...titles(page.body));
      cursor = page.body.next_cursor;
    }
    expect(seen).toEqual([3, 4, 2, 1]);
    // Changed at the same time: by number.
    await changedAt({ 1: 5_000, 2: 5_000, 3: 5_000, 4: 5_000 });
    expect(titles((await list(owner, "?state=all&sort=updated")).body)).toEqual([4, 3, 2, 1]);
    const first = await list(owner, "?per_page=1");
    const other = await list(
      owner,
      `?per_page=1&state=closed&cursor=${encodeURIComponent(first.body.next_cursor ?? "")}`,
    );
    expect(other.body.code).toBe("invalid_cursor");
  });

  it("change as the matrix says: authors their own, triage closes, write edits", async () => {
    const reader = await collaborator("pull");
    const triager = await collaborator("triage");
    const writer = await collaborator("push");
    const { number } = (await open(reader, "Mine")).body;
    expect((await update(reader, number, { title: "Mine, clearer" })).body.title).toBe(
      "Mine, clearer",
    );
    expect((await update(triager, number, { title: "Theirs" })).status).toBe(403);
    expect((await update(writer, number, { body: "Context" })).body.body).toBe("Context");
    const closed = await update(triager, number, { state: "closed", state_reason: "not_planned" });
    expect(closed.body).toMatchObject({
      state: "closed",
      state_reason: "not_planned",
      closed_by: { id: triager.principalId },
    });
    expect(closed.body.closed_at).not.toBeNull();
    const reopened = await update(reader, number, { state: "open" });
    expect(reopened.body).toMatchObject({
      state: "open",
      state_reason: "reopened",
      closed_by: null,
      closed_at: null,
    });
    // Another reader may not close someone else's issue.
    expect((await update(await collaborator("pull"), number, { state: "closed" })).status).toBe(
      403,
    );
    // A null reason is as leaving it out (GitHub's accepts it).
    expect(
      (await update(reader, number, { title: "Mine, again", state_reason: null })).status,
    ).toBe(200);
    // A patch is authorized whole: nothing of it applies when a part is refused.
    expect(
      (await update(reader, number, { title: "x", state_reason: "duplicate", duplicate_of: 9 }))
        .status,
    ).toBe(422);
    expect((await get(owner, number)).body.title).toBe("Mine, again");
  });

  it("are marked duplicates by triage, of a subject the caller reads, never of themselves", async () => {
    const reader = await collaborator("pull");
    const triager = await collaborator("triage");
    const { number: original } = (await open(owner, "Original")).body;
    const { number: copy } = (await open(reader, "Copy")).body;
    const asDuplicate = { state: "closed", state_reason: "duplicate", duplicate_of: original };
    // The author alone may not.
    expect((await update(reader, copy, asDuplicate)).status).toBe(403);
    expect((await update(triager, copy, { ...asDuplicate, duplicate_of: copy })).body.code).toBe(
      "duplicate_of_itself",
    );
    expect((await update(triager, copy, { ...asDuplicate, duplicate_of: 99 })).body.code).toBe(
      "duplicate_target_not_found",
    );
    expect(
      (await update(triager, copy, { state: "closed", state_reason: "duplicate" })).body.code,
    ).toBe("duplicate_target_required");
    // A target the caller may not name answers as one that does not exist.
    expect((await update(reader, copy, { ...asDuplicate, duplicate_of: 99 })).body.code).toBe(
      "duplicate_target_not_found",
    );
    const marked = await update(triager, copy, asDuplicate);
    expect(marked.body).toMatchObject({
      state: "closed",
      state_reason: "duplicate",
      duplicate_of: original,
    });
    // Another reason drops the target; reopening drops it too.
    expect((await update(triager, copy, { state_reason: "not_planned" })).body).toMatchObject({
      state_reason: "not_planned",
      duplicate_of: null,
    });
    await update(triager, copy, { state_reason: "duplicate", duplicate_of: original });
    expect((await update(reader, copy, { state: "open" })).body.duplicate_of).toBeNull();
  });

  it("show a duplicate's target only to a reader of its kind, and not once it is deleted", async () => {
    const pr = await openPull();
    const { number: issue } = (await open(owner, "Same as the change")).body;
    await update(owner, issue, { state: "closed", state_reason: "duplicate", duplicate_of: pr });
    expect((await get(owner, issue)).body.duplicate_of).toBe(pr);
    const issuesOnly = await scoped(owner, ["issues:read"]);
    expect((await get(issuesOnly, issue)).body.duplicate_of).toBeNull();
    // Naming the hidden target again (the one it already has) tells nothing: it answers as a
    // number that does not exist, for a triager and for a reader alike.
    const asDuplicateOf = (target: number) => ({
      state: "closed",
      state_reason: "duplicate",
      duplicate_of: target,
    });
    for (const who of [
      await scoped(owner, ["issues:write"]),
      await scoped(await collaborator("pull"), ["issues:write"]),
    ])
      for (const target of [pr, 999])
        expect((await update(who, issue, asDuplicateOf(target))).body.code).toBe(
          "duplicate_target_not_found",
        );
    // An issues-only token cannot point at a pull request either.
    const { number: other } = (await open(owner, "Another")).body;
    const writer = await scoped(owner, ["issues:write"]);
    expect(
      (
        await update(writer, other, {
          state: "closed",
          state_reason: "duplicate",
          duplicate_of: pr,
        })
      ).body.code,
    ).toBe("duplicate_target_not_found");
    const { number: target } = (await open(owner, "Target")).body;
    await update(owner, other, {
      state: "closed",
      state_reason: "duplicate",
      duplicate_of: target,
    });
    expect((await api("DELETE", `${path}/issues/${target}`, owner.token)).status).toBe(200);
    expect((await get(owner, other)).body.duplicate_of).toBeNull();
  });

  it("lock conversations of issues and pull requests: then only write and above comment", async () => {
    const reader = await collaborator("pull");
    const triager = await collaborator("triage");
    const writer = await collaborator("push");
    const { number } = (await open(reader, "Heated")).body;
    const before = await comment(reader, number, "Before");
    expect((await lock(triager, number)).status).toBe(403);
    expect((await lock(writer, number, "too heated")).body).toEqual({
      locked: true,
      active_lock_reason: "too heated",
    });
    expect((await get(reader, number)).body).toMatchObject({
      locked: true,
      active_lock_reason: "too heated",
    });
    expect((await comment(reader, number)).body.code).toBe("conversation_locked");
    expect(
      (
        await api("PATCH", `${path}/issues/comments/${before.body.id}`, reader.token, {
          body: "Edited",
        })
      ).status,
    ).toBe(403);
    expect((await comment(writer, number, "Moderated")).status).toBe(201);
    const unlocked = await json(api("DELETE", `${path}/issues/${number}/lock`, writer.token));
    expect(unlocked.body).toEqual({ locked: false, active_lock_reason: null });
    expect((await comment(reader, number)).status).toBe(201);

    const pr = await openPull();
    expect((await lock(writer, pr, "resolved")).status).toBe(200);
    const pull = await json<{ locked: boolean; active_lock_reason: string }>(
      api("GET", `${path}/pulls/${pr}`, reader.token),
    );
    expect(pull.body).toMatchObject({ locked: true, active_lock_reason: "resolved" });
    expect((await comment(reader, pr)).body.code).toBe("conversation_locked");
    // Locking a pull request takes its own kind's permission.
    const issuesOnly = await scoped(writer, ["issues:write"]);
    expect((await lock(issuesOnly, pr)).body.code).toBe("issue_not_found");
  });

  it("are deleted by admins only, with their comments; the number is never used again", async () => {
    const maintainer = await collaborator("push");
    const { number } = (await open(maintainer, "Spam")).body;
    const written = await comment(maintainer, number, "More spam");
    expect((await api("DELETE", `${path}/issues/${number}`, maintainer.token)).status).toBe(403);
    expect((await json(api("DELETE", `${path}/issues/${number}`, owner.token))).body).toEqual({
      number,
      state: "deleted",
    });
    expect((await get(owner, number)).body.code).toBe("issue_not_found");
    expect(
      (
        await json<{ code: string }>(
          api("GET", `${path}/issues/comments/${written.body.id}`, owner.token),
        )
      ).body.code,
    ).toBe("comment_not_found");
    expect((await comment(owner, number)).body.code).toBe("issue_not_found");
    expect((await open(owner, "Next")).body.number).toBe(number + 1);
    expect((await json(api("DELETE", `${path}/issues/${number}`, owner.token))).body.code).toBe(
      "issue_not_found",
    );
    // Its tombstone stays, without its text.
    const tombstone = await inRepo(env.REPO.getByName(repo.id), (r) =>
      r.git.context.storage.sql
        .exec("SELECT * FROM issue_tombstones WHERE number = ?", number)
        .toArray(),
    );
    expect(tombstone).toEqual([expect.objectContaining({ number, deleted_by: owner.principalId })]);
  });
});

describe("comments on issues and pull requests", () => {
  it("take the permission of their subject's kind", async () => {
    const { number: issue } = (await open(owner, "Bug")).body;
    const pr = await openPull();
    const issuesOnly = await scoped(owner, ["issues:write"]);
    const pullsOnly = await scoped(owner, ["pull_requests:write"]);
    const onIssue = await comment(issuesOnly, issue, "On the issue");
    expect(onIssue.status).toBe(201);
    expect((await comment(issuesOnly, pr)).body.code).toBe("issue_not_found");
    const onPull = await comment(pullsOnly, pr, "On the change");
    expect(onPull.status).toBe(201);
    expect((await comment(pullsOnly, issue)).body.code).toBe("issue_not_found");
    // Reading one comment, listing them, editing one: the same rule.
    const read = (who: Who, id: number) =>
      json<{ code?: string }>(api("GET", `${path}/issues/comments/${id}`, who.token));
    expect((await read(pullsOnly, onIssue.body.id)).body.code).toBe("comment_not_found");
    expect((await read(issuesOnly, onIssue.body.id)).status).toBe(200);
    expect(
      (await json<{ code?: string }>(api("GET", `${path}/issues/${pr}/comments`, issuesOnly.token)))
        .body.code,
    ).toBe("issue_not_found");
    expect(
      (
        await api("PATCH", `${path}/issues/comments/${onPull.body.id}`, issuesOnly.token, {
          body: "Mine now",
        })
      ).status,
    ).toBe(404);
    // A read-only token writes nothing, whichever kind.
    const readsBoth = await scoped(owner, ["issues:read", "pull_requests:read"]);
    expect((await comment(readsBoth, issue)).status).toBe(403);
  });
});

describe("comment webhooks", () => {
  it("carry what the comment is on as it was then, an issue or a pull request", async () => {
    const { number: issue } = (await open(owner, "Bug")).body;
    const pr = await openPull();
    const onIssue = await comment(owner, issue, "On the issue");
    await comment(owner, pr, "On the change");
    await update(owner, issue, { title: "Bug, renamed" });
    await api("DELETE", `${path}/issues/comments/${onIssue.body.id}`, owner.token);
    const events = await inRepo(env.REPO.getByName(repo.id), (r) =>
      r.git.context.storage.sql
        .exec<{ event: string }>("SELECT event FROM outbox ORDER BY source_seq")
        .toArray()
        .map((row) => JSON.parse(row.event) as DomainEvent)
        .filter((e) => e.type.startsWith("issue_comment.")),
    );
    const bodies = events.map((e) => {
      const body = bodyOf({
        ...e,
        webhooks: {
          hooks: [],
          repo: { name: repo.name, ownerId: owner.principalId, private: true },
        },
      } as DomainEvent);
      return [body?.action, body?.issue];
    });
    expect(bodies).toEqual([
      ["created", { number: issue, title: "Bug", state: "open" }],
      ["created", { number: pr, title: "Change", state: "open", pull_request: {} }],
      // Deleted after the rename: the issue as it was when the comment went.
      ["deleted", { number: issue, title: "Bug, renamed", state: "open" }],
    ]);
  });
});

describe("comments racing a lock or a deletion", () => {
  /** Runs `meanwhile` inside the repository object when the next comment is about to be written. */
  async function beforeNextComment(meanwhile: (r: RepoDO) => void) {
    await inRepo(env.REPO.getByName(repo.id), (r) => {
      r.changeHooks.beforeChange = async (method) => {
        if (method !== "createComment") return;
        r.changeHooks = {};
        meanwhile(r);
      };
    });
  }
  const caller = (who: Who, role: "admin" | "write") => ({
    actor: { principal: who.principalId, via: "api" as const },
    root: who.principalId,
    role,
  });

  it("refuses a comment whose conversation was locked after it was prepared", async () => {
    const reader = await collaborator("pull");
    const { number } = (await open(reader, "Heated")).body;
    await beforeNextComment((r) => {
      const locked = r.issues.setLock(
        number,
        { locked: true, reason: null },
        caller(owner, "admin"),
        ["issue"],
      );
      expect(locked.ok).toBe(true);
    });
    expect((await comment(reader, number, `@${owner.handle} see this`)).body.code).toBe(
      "conversation_locked",
    );
    const listed = await json<{ comments: unknown[] }>(
      api("GET", `${path}/issues/${number}/comments`, owner.token),
    );
    expect(listed.body.comments).toEqual([]);
  });

  it("leaves no comment, event or participant of an issue deleted while the comment was prepared", async () => {
    const reader = await collaborator("pull");
    const { number } = (await open(reader, "Gone soon")).body;
    await beforeNextComment((r) => {
      expect(r.issues.delete(number, caller(owner, "admin")).ok).toBe(true);
    });
    expect((await comment(reader, number, "Late")).body.code).toBe("issue_not_found");
    const left = await inRepo(env.REPO.getByName(repo.id), (r) => {
      const sql = r.git.context.storage.sql;
      return {
        comments: sql.exec("SELECT count(*) AS n FROM comments WHERE number = ?", number).one().n,
        participants: sql
          .exec("SELECT count(*) AS n FROM feed_participants WHERE number = ?", number)
          .one().n,
        events: sql
          .exec("SELECT count(*) AS n FROM outbox WHERE event LIKE '%issue_comment.created%'")
          .one().n,
      };
    });
    expect(left).toEqual({ comments: 0, participants: 0, events: 0 });
  });
});

describe("issue events", () => {
  it("carry the issue's snapshot at a rising version, and its deletion none; each change audited", async () => {
    const { number } = (await open(owner, "Bug", "Body")).body;
    await update(owner, number, { title: "Bug!", state: "closed" });
    await lock(owner, number, "resolved");
    await api("DELETE", `${path}/issues/${number}`, owner.token);
    const recorded = await inRepo(env.REPO.getByName(repo.id), (r) => {
      const sql = r.git.context.storage.sql;
      return {
        events: sql
          .exec<{ event: string }>("SELECT event FROM outbox ORDER BY source_seq")
          .toArray()
          .map((row) => JSON.parse(row.event) as DomainEvent)
          .filter((e) => e.type.startsWith("issue.")),
        audit: sql
          .exec<{ action: string }>(
            "SELECT action FROM audit_log WHERE action LIKE 'issue.%' ORDER BY seq",
          )
          .toArray()
          .map((row) => row.action),
      };
    });
    expect(
      recorded.events.map((e) => [
        e.type,
        e.entity?.type,
        e.entity?.id,
        e.entity?.version,
        e.entity?.deleted,
        (e.entity?.row as { title?: string } | null)?.title ?? null,
      ]),
    ).toEqual([
      ["issue.opened", "issue", `${repo.id}#${number}`, 1, false, "Bug"],
      ["issue.edited", "issue", `${repo.id}#${number}`, 2, false, "Bug!"],
      ["issue.closed", "issue", `${repo.id}#${number}`, 3, false, "Bug!"],
      ["issue.locked", "issue", `${repo.id}#${number}`, 4, false, "Bug!"],
      ["issue.deleted", "issue", `${repo.id}#${number}`, 5, true, null],
    ]);
    expect(recorded.audit).toEqual([
      "issue.open",
      "issue.edit",
      "issue.close",
      "issue.lock",
      "issue.delete",
    ]);
  });
});
