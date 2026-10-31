// What a repository's pull request events mean for activity feeds,
// decided with each change: review requests and their settling, review
// outcomes for the author, conflicts, mentions and thread activity; the
// actor never told of its own action, recipients only those who read the
// repository.
import { env } from "cloudflare:workers";
import type { DomainEvent, FeedBlock } from "@fyrden/domain";
import { uniqueId } from "@fyrden/testing";
import { beforeEach, describe, expect, inject, it } from "vitest";
import type { RepoDO } from "../src/do/RepoDO.js";
import { type FeedMember, memberKey } from "../src/do/repo/feed-view.js";
import { api, json, user, type Who } from "./helpers/api.js";
import { scopedToken } from "./helpers/principals.js";
import { type PushTarget, postPush } from "./helpers/push.js";
import { pushBody, ZERO } from "./helpers/push-fixtures.js";
import { inRepo } from "./helpers/repo-git.js";

const fx = inject("pushFixtures");

let owner: Who;
let writer: Who;
let reader: Who;
let repo: { id: string; name: string };
let path: string;
let head: string;

const stub = () => env.REPO.getByName(repo.id);
const commitOn = async (branch: string, content: string) => {
  const made = await json<{ commit: { sha: string } }>(
    api("POST", `${path}/file-commits`, owner.token, {
      branch,
      message: "change",
      changes: [{ path: "a.txt", content }],
    }),
  );
  expect(made.status).toBe(201);
  return made.body.commit.sha;
};
async function branchAt(name: string, sha: string) {
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
    pushBody([{ old: ZERO, new: sha, ref: `refs/heads/${name}` }], { pack: fx.packEmpty }),
  );
  expect(pushed.report).toContain(`ok refs/heads/${name}\n`);
}
async function collaborator(permission: "pull" | "push"): Promise<Who> {
  const who = await user();
  const set = await api("PUT", `${path}/collaborators/${who.handle}`, owner.token, {
    permission,
  });
  expect(set.status).toBe(200);
  return who;
}

/** The outbox's events since `from`. */
const events = (from = 0) =>
  inRepo(stub(), (r: RepoDO) =>
    r.git.context.storage.sql
      .exec<{ event: string }>(
        "SELECT event FROM outbox WHERE source_seq > ? ORDER BY source_seq",
        from,
      )
      .toArray()
      .map((row) => JSON.parse(row.event) as DomainEvent),
  );
/** The feed blocks of the outbox's events since `from`, with their event types. */
const blocks = async (from = 0) =>
  (await events(from))
    .filter((e) => e.feed)
    .map((e) => ({ type: e.type, ...(e.feed as FeedBlock) }));
const seq = () =>
  inRepo(
    stub(),
    (r: RepoDO) =>
      r.git.context.storage.sql
        .exec<{ s: number | null }>("SELECT max(source_seq) AS s FROM outbox")
        .one().s ?? 0,
  );
/** Who an event tells, as `principal:kind:state[:silent]`. */
const told = (block: FeedBlock | undefined) =>
  (block?.audience ?? [])
    .map((a) => `${a.principal}:${a.kind}:${a.state}${a.silent ? ":silent" : ""}`)
    .sort();

beforeEach(async () => {
  owner = await user();
  repo = (
    await json<{ id: string; name: string }>(
      api("POST", "/user/repos", owner.token, { name: uniqueId("r") }),
    )
  ).body;
  path = `/repos/${owner.handle}/${repo.name}`;
  writer = await collaborator("push");
  reader = await collaborator("pull");
  await branchAt("feature", await commitOn("main", "one\n"));
  head = await commitOn("feature", "one\ntwo\n");
  const opened = await api("POST", `${path}/pulls`, owner.token, {
    title: "A change",
    head: "feature",
    base: "main",
  });
  expect(opened.status).toBe(201);
});

describe("feed blocks", () => {
  it("ask a review of the reviewer, settle it when given, and tell the author the outcome", async () => {
    const from = await seq();
    await api("POST", `${path}/pulls/1/requested_reviewers`, owner.token, {
      reviewers: [writer.handle],
    });
    const [requested] = await blocks(from);
    expect(requested).toMatchObject({
      type: "pull_request.review_requested",
      threadKey: "pull/1",
      subject: { kind: "pull", number: 1, title: "A change" },
      action: "review_requested",
      actorRoot: owner.principalId,
      actorTrust: "write",
    });
    expect(told(requested)).toEqual([`${writer.principalId}:review_requested:open`]);
    expect(requested?.audience[0]).toMatchObject({
      priority: "P0",
      reasons: ["requested_reviewer"],
    });

    const after = await seq();
    const reviewed = await api("POST", `${path}/pulls/1/reviews`, writer.token, {
      event: "APPROVE",
      commit_id: head,
    });
    expect(reviewed.status).toBe(200);
    const [review] = await blocks(after);
    expect(review?.action).toBe("review");
    // The author hears of the approval; the reviewer's own request settles silently, in entries
    // the event carries (standing across a transfer).
    expect(told(review)).toEqual(
      [
        `${owner.principalId}:approved:open`,
        `${owner.principalId}:changes_requested:resolved`,
        `${owner.principalId}:activity:open`,
      ].sort(),
    );
    expect(review?.subject.version).toBeGreaterThan(requested?.subject.version as number);
    const [settling] = (await events(after)).filter(
      (e) => e.type === "pull_request_review.submitted",
    );
    const settled = (settling?.data?.resolutions ?? []) as FeedBlock[];
    expect(settled.map(told)).toEqual([[`${writer.principalId}:review_requested:resolved:silent`]]);
    expect(settled[0]?.subject.version).toBeGreaterThan(requested?.subject.version as number);
    // A settlement names the conversation as the event's own block does.
    expect(settled[0]?.subject.conversation).toBe(review?.subject.conversation);
    expect(review?.subject.conversation).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("keep changes requested open until that reviewer's latest review is not one", async () => {
    const from = await seq();
    await api("POST", `${path}/pulls/1/reviews`, writer.token, {
      event: "REQUEST_CHANGES",
      body: "Not yet.",
      commit_id: head,
    });
    const [changes] = await blocks(from);
    expect(told(changes)).toContain(`${owner.principalId}:changes_requested:open`);
    expect(told(changes)).toContain(`${owner.principalId}:approved:resolved`);
    expect(changes?.member).toMatch(/^review\/\d+$/);
    const again = await seq();
    await api("POST", `${path}/pulls/1/reviews`, writer.token, {
      event: "APPROVE",
      commit_id: head,
    });
    const [approval] = await blocks(again);
    expect(told(approval)).toContain(`${owner.principalId}:changes_requested:resolved`);
    expect(told(approval)).toContain(`${owner.principalId}:approved:open`);
  });

  it("tell participants of comments, never their own, naming the comment (not its text)", async () => {
    const from = await seq();
    const made = await json<{ id: number }>(
      api("POST", `${path}/issues/1/comments`, writer.token, { body: "Looks\n  right." }),
    );
    const [comment] = await blocks(from);
    expect(comment).toMatchObject({
      action: "comment",
      member: `comment/${made.body.id}`,
      excerpt: null,
    });
    expect(told(comment)).toEqual([`${owner.principalId}:activity:open`]);
    // The writer now takes part: the owner's comment tells it, not the owner.
    const after = await seq();
    await api("POST", `${path}/issues/1/comments`, owner.token, { body: "Thanks." });
    expect(told((await blocks(after))[0])).toEqual([`${writer.principalId}:activity:open`]);
  });

  it("mention those who read the repository, urgently from a writer, less from a reader", async () => {
    const outsider = await user();
    const from = await seq();
    await api("POST", `${path}/issues/1/comments`, writer.token, {
      body: `@${reader.handle} please look; not \`@${owner.handle}\`, and @${outsider.handle}`,
    });
    const [byWriter] = await blocks(from);
    const mention = byWriter?.audience.find((a) => a.kind === "mention");
    expect(mention).toMatchObject({ principal: reader.principalId, priority: "P0" });
    // The outsider cannot read the private repository: left out. The owner's handle is code.
    expect(byWriter?.audience.filter((a) => a.kind === "mention")).toHaveLength(1);
    const after = await seq();
    await api("POST", `${path}/issues/1/comments`, reader.token, {
      body: `@${writer.handle} what about this?`,
    });
    const [byReader] = await blocks(after);
    expect(byReader?.actorTrust).toBe("read");
    expect(byReader?.audience.find((a) => a.kind === "mention")).toMatchObject({
      principal: writer.principalId,
      priority: "P1",
    });
  });

  it("tell only new mentions of an edit", async () => {
    const made = await json<{ id: number }>(
      api("POST", `${path}/issues/1/comments`, owner.token, { body: `hi @${writer.handle}` }),
    );
    const from = await seq();
    await api("PATCH", `${path}/issues/comments/${made.body.id}`, owner.token, {
      body: `hi @${writer.handle} and @${reader.handle}`,
    });
    const [edit] = await blocks(from);
    expect(edit).toMatchObject({ action: "comment_edited", member: `comment/${made.body.id}` });
    // Only the new mention is told (feeds read the comment's text when shown).
    expect(told(edit)).toEqual([`${reader.principalId}:mention:open`]);
  });

  it("tell no one of a deleted comment; its text is read live and shows gone", async () => {
    const made = await json<{ id: number }>(
      api("POST", `${path}/issues/1/comments`, writer.token, { body: "a   secret\n\nrevealed" }),
    );
    const member = `comment/${made.body.id}`;
    const EPOCH = await inRepo(stub(), (r: RepoDO) => r.events.epochGen());
    const view = (who: Who) =>
      stub().feedView(who.principalId, null, [
        { epoch: EPOCH, thread: "pull/1", member },
        { epoch: EPOCH, thread: "pull/1", member: "pull/1" },
        { epoch: EPOCH, thread: "pull/1", member: "bogus" },
      ]);
    expect((await view(owner)).excerpts).toEqual({
      [`${EPOCH} pull/1 ${member}`]: "a secret revealed",
      [`${EPOCH} pull/1 pull/1`]: null,
    });
    await api("PATCH", `${path}/issues/comments/${made.body.id}`, writer.token, {
      body: "redacted",
    });
    expect((await view(owner)).excerpts[`${EPOCH} pull/1 ${member}`]).toBe("redacted");
    const from = await seq();
    await api("DELETE", `${path}/issues/comments/${made.body.id}`, writer.token);
    expect(await blocks(from)).toEqual([]);
    expect((await view(owner)).excerpts[`${EPOCH} pull/1 ${member}`]).toBeNull();
    // One who cannot read the repository gets nothing, and is told so by the ACL decided with.
    expect(await view(await user())).toMatchObject({
      readable: false,
      role: null,
      excerpts: {},
      denial: {
        kind: "lost",
        loss: { accountId: owner.principalId, aclVersion: expect.any(Number) },
      },
    });
  });

  it("show a member only on its own thread and restore generation, whatever its id or number names now", async () => {
    // As after a restore of the repository, which sets its id and number counters back: an item's
    // member names a comment, review or review comment now on another subject, or a number now
    // another kind's; or the item was told before the restore.
    await api("PATCH", `${path}/pulls/1`, owner.token, { body: "pull text" });
    const issue = await json<{ number: number }>(
      api("POST", `${path}/issues`, owner.token, { title: "An issue", body: "issue text" }),
    );
    const onPull = await json<{ id: number }>(
      api("POST", `${path}/issues/1/comments`, owner.token, { body: "pull request text" }),
    );
    const onIssue = await json<{ id: number }>(
      api("POST", `${path}/issues/${issue.body.number}/comments`, owner.token, {
        body: "issue comment",
      }),
    );
    const epoch = await inRepo(stub(), (r: RepoDO) => {
      const sql = r.git.context.storage.sql;
      sql.exec(
        `INSERT INTO reviews (review_id, pr_number, reviewer_id, reviewer_root, by_agent, state,
           commit_sha, body, submitted_at) VALUES (900, 1, 'usr_r', 'usr_r', 0, 'COMMENTED', ?, 'review text', 1)`,
        "0".repeat(40),
      );
      // Another pull request, as one opened after the restore would be.
      sql.exec(
        `INSERT INTO pull_requests (number, title, state, draft, author_id, author_root, base_ref,
           base_sha, head_ref, head_sha, created_at, updated_at)
         VALUES (50, 'another', 'open', 0, 'usr_r', 'usr_r', 'main', ?1, 'other', ?1, 1, 1)`,
        "0".repeat(40),
      );
      sql.exec(
        `INSERT INTO review_threads (thread_id, pr_number, commit_sha, path, side, line)
         VALUES (902, 1, ?, 'a.txt', 'RIGHT', 1)`,
        "0".repeat(40),
      );
      sql.exec(
        `INSERT INTO review_comments (comment_id, pr_number, thread_id, author_id, author_root, body,
           created_at, updated_at) VALUES (901, 1, 902, 'usr_r', 'usr_r', 'line text', 1, 1)`,
      );
      return r.events.epochGen();
    });
    const n = issue.body.number;
    const cases: [FeedMember, string | null][] = [
      [{ epoch, thread: `issue/${n}`, member: `comment/${onPull.body.id}` }, null],
      [{ epoch, thread: `issue/${n}`, member: `comment/${onIssue.body.id}` }, "issue comment"],
      [{ epoch, thread: "pull/1", member: `comment/${onPull.body.id}` }, "pull request text"],
      [{ epoch, thread: "issue/1", member: "issue/1" }, null],
      [{ epoch, thread: "issue/1", member: `comment/${onPull.body.id}` }, null],
      [{ epoch, thread: "pull/1", member: `comment/${onIssue.body.id}` }, null],
      [{ epoch, thread: `pull/${n}`, member: `pull/${n}` }, null],
      [{ epoch, thread: `issue/${n}`, member: `issue/${n}` }, "issue text"],
      [{ epoch, thread: "pull/1", member: "pull/1" }, "pull text"],
      [{ epoch, thread: "pull/1", member: "review/900" }, "review text"],
      [{ epoch, thread: `issue/${n}`, member: "review/900" }, null],
      [{ epoch, thread: "pull/1", member: "review_comment/901" }, "line text"],
      [{ epoch, thread: `issue/${n}`, member: "review_comment/901" }, null],
      [{ epoch, thread: "pull/50", member: "review/900" }, null],
      [{ epoch, thread: "pull/50", member: "review_comment/901" }, null],
      [{ epoch, thread: "pull/50", member: `comment/${onPull.body.id}` }, null],
      [{ epoch, thread: "pull/99", member: "review/900" }, null],
      // Told in another restore generation: nothing, even on its own thread.
      [{ epoch: epoch + 1, thread: "pull/1", member: `comment/${onPull.body.id}` }, null],
      [{ epoch: epoch - 1, thread: "pull/1", member: "review/900" }, null],
    ];
    const { excerpts } = await stub().feedView(
      owner.principalId,
      null,
      cases.map(([m]) => m),
    );
    expect(cases.map(([m]) => excerpts[memberKey(m)])).toEqual(cases.map(([, said]) => said));
  });

  it("keep out of a thread those mentioned who cannot read the repository", async () => {
    const outsider = await user();
    await api("POST", `${path}/issues/1/comments`, writer.token, { body: `@${outsider.handle}` });
    const participants = await inRepo(stub(), (r: RepoDO) =>
      r.git.context.storage.sql
        .exec<{ principal: string }>("SELECT principal FROM feed_participants WHERE number = 1")
        .toArray()
        .map((p) => p.principal),
    );
    expect(participants).not.toContain(outsider.principalId);
    expect(participants).toContain(writer.principalId);
  });

  it("put back what stood when a pull request is reopened", async () => {
    await api("POST", `${path}/pulls/1/requested_reviewers`, owner.token, {
      reviewers: [reader.handle],
    });
    await api("POST", `${path}/pulls/1/reviews`, writer.token, {
      event: "APPROVE",
      commit_id: head,
    });
    await api("PATCH", `${path}/pulls/1`, owner.token, { state: "closed" });
    const from = await seq();
    await api("PATCH", `${path}/pulls/1`, owner.token, { state: "open" });
    const [reopened] = await blocks(from);
    expect(reopened?.action).toBe("reopened");
    expect(told(reopened)).toEqual(
      expect.arrayContaining([
        `${reader.principalId}:review_requested:open`,
        `${owner.principalId}:approved:open:silent`,
        `${owner.principalId}:changes_requested:resolved:silent`,
        `${writer.principalId}:activity:open`,
      ]),
    );
  });

  it("change the actor's own items silently, opening them too", async () => {
    const other = await collaborator("push");
    await api("POST", `${path}/pulls/1/reviews`, writer.token, {
      event: "APPROVE",
      commit_id: head,
    });
    const changes = await json<{ id: number }>(
      api("POST", `${path}/pulls/1/reviews`, other.token, {
        event: "REQUEST_CHANGES",
        body: "No.",
        commit_id: head,
      }),
    );
    const from = await seq();
    await api("PUT", `${path}/pulls/1/reviews/${changes.body.id}/dismissals`, owner.token, {
      message: "Addressed.",
    });
    const [dismissed] = await blocks(from);
    expect(told(dismissed)).toEqual(
      [
        `${owner.principalId}:approved:open:silent`,
        `${owner.principalId}:changes_requested:resolved:silent`,
      ].sort(),
    );
  });

  it("settle what was to act on when the pull request closes, and tell participants", async () => {
    await api("POST", `${path}/pulls/1/requested_reviewers`, owner.token, {
      reviewers: [reader.handle],
    });
    await api("POST", `${path}/issues/1/comments`, writer.token, { body: "Hmm." });
    const from = await seq();
    await api("PATCH", `${path}/pulls/1`, writer.token, { state: "closed" });
    const [closed] = await blocks(from);
    expect(closed?.action).toBe("closed");
    expect(told(closed)).toEqual(
      [
        `${reader.principalId}:review_requested:resolved`,
        `${reader.principalId}:activity:open`,
        `${owner.principalId}:approved:resolved`,
        `${owner.principalId}:changes_requested:resolved`,
        `${owner.principalId}:merge_conflict:resolved`,
        `${owner.principalId}:activity:open`,
      ].sort(),
    );
  });

  it("tell the author of a conflict and of its end", async () => {
    // As the mergeability job emits them: each with the state before it.
    let previous: string | null = null;
    const emit = (state: string) =>
      inRepo(stub(), (r: RepoDO) =>
        r.git.context.storage.transactionSync(() => {
          r.events.emitActivity("pull_request.mergeability", null, {
            number: 1,
            state,
            previous_state: previous,
          });
          previous = state;
        }),
      );
    const from = await seq();
    await emit("conflicts");
    // Still conflicting, in another way: no news.
    await emit("manual");
    // Not known for a while, then clean: the conflict is over all the same.
    await emit("unknown");
    await emit("clean");
    await emit("unknown");
    const made = await blocks(from);
    expect(made.map((b) => [b.action, told(b)])).toEqual([
      ["merge_conflict", [`${owner.principalId}:merge_conflict:open`]],
      ["merge_clean", [`${owner.principalId}:merge_conflict:resolved`]],
    ]);
  });

  it("are left out when an event tells no one", async () => {
    const from = await seq();
    // The author's own comment on its own thread, nobody else taking part.
    await api("POST", `${path}/issues/1/comments`, owner.token, { body: "Note to self." });
    expect(await blocks(from)).toEqual([]);
  });
});
