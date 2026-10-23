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
    const view = (who: Who) => stub().feedView(who.principalId, null, [member, "pull/1", "bogus"]);
    expect((await view(owner)).excerpts).toEqual({ [member]: "a secret revealed", "pull/1": null });
    await api("PATCH", `${path}/issues/comments/${made.body.id}`, writer.token, {
      body: "redacted",
    });
    expect((await view(owner)).excerpts[member]).toBe("redacted");
    const from = await seq();
    await api("DELETE", `${path}/issues/comments/${made.body.id}`, writer.token);
    expect(await blocks(from)).toEqual([]);
    expect((await view(owner)).excerpts[member]).toBeNull();
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
