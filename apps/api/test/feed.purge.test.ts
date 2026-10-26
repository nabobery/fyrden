// Activity feeds forget repositories their owner lost read access to: an
// account's access.revoked event reaches each principal's feed as a purge
// of those repositories up to then, and a mark keeps older entries arriving
// later out; a re-grant brings new items, and a late purge of an older
// access version changes nothing.

import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  createIdFactory,
  type DomainEvent,
  eventKey,
  type FeedEntry,
  secureRandomBytes,
} from "@fyrden/domain";
import { uniqueId } from "@fyrden/testing";
import { describe, expect, it } from "vitest";
import type { OrgDO } from "../src/do/OrgDO.js";
import type { UserDO } from "../src/do/UserDO.js";
import { Feed, type FeedPurge } from "../src/do/user/feed.js";
import { deliverEffects, invocationBudget, recoverEffects } from "../src/effects/dispatcher.js";
import {
  EFFECT_POLICY,
  type Effect,
  type EffectSink,
  effectStatements,
} from "../src/effects/journal.js";
import { feedSink } from "../src/feed/sink.js";
import { applyEnvelope } from "../src/queues/events-consumer.js";
import { api, json, user } from "./helpers/api.js";
import { recordingPublish } from "./helpers/effects.js";
import { FROM_START, shownCount } from "./helpers/feed.js";

const newId = createIdFactory(Date.now, secureRandomBytes);

/** An activity entry for `repoId`'s pull 1, at `occurredAt`. */
function entry(repoId: string, version: number, occurredAt: number): FeedEntry {
  return {
    eventKey: `${repoId}:1:${version}`,
    repoId,
    occurredAt,
    actor: "usr_actor",
    epochGen: 1,
    feed: {
      threadKey: "pull/1",
      subject: { kind: "pull", number: 1, title: "A pull request", version },
      action: "comment",
      actorRoot: "usr_actor",
      actorTrust: "write",
      member: `comment/${version}`,
      excerpt: null,
    },
    recipient: {
      principal: "usr_reader",
      kind: "activity",
      reasons: ["commenter"],
      priority: "P1",
      state: "open",
      silent: false,
    },
  };
}

async function shown(stub: DurableObjectStub<UserDO>) {
  const page = await stub.listStreams(FROM_START, 100, {});
  if (page.expired) throw new Error("expired");
  return page.items.map((item) => [item.repoId, item.members]);
}

function revokedEvent(
  sourceId: string,
  seq: number,
  data: Record<string, unknown>,
  at = Date.now(),
): DomainEvent {
  return {
    id: { sourceId, epochGen: 1, sourceSeq: seq },
    type: "access.revoked",
    at,
    actor: sourceId,
    actChain: [],
    ownerGen: 1,
    entity: null,
    data,
    stored: false,
  };
}

const ACCOUNT = "usr_01K742SG00NAWD8WB4RTMJF8H9";

/** A purge of `repoIds` by ACCOUNT (or `accountId`), in its first epoch unless told. */
const purgeOf = (
  repoIds: string[],
  until: number,
  aclVersion: number,
  scope: { accountId?: string; epochGen?: number } = {},
): FeedPurge => ({
  repoIds,
  until,
  accountId: scope.accountId ?? ACCOUNT,
  epochGen: scope.epochGen ?? 1,
  aclVersion,
});

describe("purging a feed", () => {
  it("forgets a repository up to the purge, keeps older entries out, and takes a re-grant's", async () => {
    const stub = env.USER.getByName(uniqueId("usr"));
    const t = Date.now();
    await stub.applyFeed([entry("rep_a", 1, t - 2_000), entry("rep_b", 1, t - 2_000)]);
    await stub.applyFeed([entry("rep_a", 2, t - 1_000)]);
    expect(await stub.purge(purgeOf(["rep_a"], t - 500, 5))).toEqual({ deleted: 1 });
    expect(await shown(stub)).toEqual([["rep_b", ["comment/1"]]]);
    // An entry from before the purge arriving late: dropped.
    await stub.applyFeed([entry("rep_a", 3, t - 600)]);
    expect(await shown(stub)).toEqual([["rep_b", ["comment/1"]]]);
    // Access given back: new entries apply, never the old ones.
    await stub.applyFeed([entry("rep_a", 4, t), entry("rep_a", 1, t - 2_000)]);
    expect(await shown(stub)).toEqual([
      ["rep_b", ["comment/1"]],
      ["rep_a", ["comment/4"]],
    ]);
    // A late purge of an older access version (or the same one again): nothing changes.
    for (const late of [purgeOf(["rep_a"], t + 1_000, 4), purgeOf(["rep_a"], t - 500, 5)])
      expect(await stub.purge(late)).toEqual({ deleted: 0 });
    expect(await shown(stub)).toHaveLength(2);
    expect(await runInDurableObject(stub, (_: UserDO, state) => shownCount(state.storage))).toBe(2);
    // A newer one applies, its mark kept for the repository.
    expect(await stub.purge(purgeOf(["rep_a"], t, 6))).toEqual({ deleted: 1 });
    expect(await marks(stub)).toEqual([
      { repo_id: "rep_a", until_at: t, account_id: ACCOUNT, epoch_gen: 1, acl_version: 6 },
    ]);
  });

  it("takes a late purge's members out of an item that survives it, as if the purge came first", async () => {
    const t = Date.now();
    const before = { ...entry("rep_a", 1, t - 2_000), actor: "usr_old" };
    const old = { ...before, feed: { ...before.feed, member: "review_comment/1" } };
    const fresh = { ...entry("rep_a", 2, t), actor: "usr_new" };
    const purge = purgeOf(["rep_a"], t - 500, 5);
    const late = env.USER.getByName(uniqueId("usr"));
    await late.applyFeed([old]);
    await late.applyFeed([fresh]);
    await late.purge(purge);
    const first = env.USER.getByName(uniqueId("usr"));
    await first.purge(purge);
    await first.applyFeed([old, fresh]);
    const item = async (stub: DurableObjectStub<UserDO>) => {
      const page = await stub.listStreams(FROM_START, 10, {});
      if (page.expired) throw new Error("expired");
      return page.items.map((i) => ({ members: i.members, member: i.member, actor: i.actor }));
    };
    expect(await item(late)).toEqual([
      { members: ["comment/2"], member: "comment/2", actor: "usr_new" },
    ]);
    expect(await item(first)).toEqual(await item(late));
  });

  it("keeps a restored comment that reuses an older one's id through a purge between them", async () => {
    const t = Date.now();
    const old = entry("rep_a", 1, t - 1_000);
    const restored = { ...entry("rep_a", 1, t), epochGen: 2, actor: "usr_new" };
    for (const order of [
      [old, restored],
      [restored, old],
    ]) {
      const stub = env.USER.getByName(uniqueId("usr"));
      for (const one of order) await stub.applyFeed([one]);
      await stub.purge(purgeOf(["rep_a"], t - 500, 5));
      const page = await stub.listStreams(FROM_START, 10, {});
      if (page.expired) throw new Error("expired");
      expect(page.items).toMatchObject([
        { epoch: 2, members: ["comment/1"], member: "comment/1", actor: "usr_new" },
      ]);
    }
  });

  it("forgets what a read found lost as that purge would: up to its check, never past newer access", async () => {
    const stub = env.USER.getByName(uniqueId("usr"));
    const t = Date.now();
    await stub.applyFeed([entry("rep_a", 1, t - 2_000), entry("rep_a", 2, t + 1_000)]);
    // Checked at t, by ACL version 5: what came after (access given back) stays.
    expect(await stub.forgetRepos([purgeOf(["rep_a"], t, 5)])).toEqual({ deleted: 0 });
    expect(await shown(stub)).toEqual([["rep_a", ["comment/2"]]]);
    // A check by an older version than a purge already applied changes nothing.
    expect(await stub.purge(purgeOf(["rep_a"], t + 2_000, 7))).toEqual({ deleted: 1 });
    await stub.applyFeed([entry("rep_a", 3, t + 3_000)]);
    expect(await stub.forgetRepos([purgeOf(["rep_a"], t + 4_000, 6)])).toEqual({ deleted: 0 });
    expect(await shown(stub)).toEqual([["rep_a", ["comment/3"]]]);
    // A repository found gone (no account) is judged by time, against any mark.
    const gone = { accountId: "", epochGen: 0 };
    expect(await stub.forgetRepos([purgeOf(["rep_a"], t + 4_000, 0, gone)])).toEqual({
      deleted: 1,
    });
    expect(await stub.forgetRepos([purgeOf(["rep_a"], t + 3_500, 0, gone)])).toEqual({
      deleted: 0,
    });
    expect(await marks(stub)).toMatchObject([
      { repo_id: "rep_a", account_id: "", until_at: t + 4_000 },
    ]);
  });

  it("takes a later cutoff of the same access version, whichever of its purges comes first", async () => {
    // A read's check pulled ACL version 5 when it started (t - 400), before activity it lets
    // in still (t - 300) and the revocation itself (t - 200), which version 5 is.
    const t = Date.now();
    const read = purgeOf(["rep_a"], t - 400, 5);
    const revoked = purgeOf(["rep_a"], t - 200, 5);
    for (const order of [
      [read, revoked],
      [revoked, read],
    ]) {
      const stub = env.USER.getByName(uniqueId("usr"));
      await stub.applyFeed([entry("rep_a", 1, t - 300)]);
      for (const purge of order) await stub.purge(purge);
      expect(await shown(stub)).toEqual([]);
      expect(await marks(stub)).toMatchObject([{ repo_id: "rep_a", until_at: t - 200 }]);
      // A later check by the same version forgets what came since; an earlier one, nothing.
      await stub.applyFeed([entry("rep_a", 2, t - 100)]);
      expect(await stub.forgetRepos([purgeOf(["rep_a"], t - 300, 5)])).toEqual({ deleted: 0 });
      expect(await stub.forgetRepos([purgeOf(["rep_a"], t, 5)])).toEqual({ deleted: 1 });
      expect(await marks(stub)).toMatchObject([{ repo_id: "rep_a", until_at: t }]);
    }
  });

  it("judges a purge by its account's epoch and version, and another account's by its time", async () => {
    const stub = env.USER.getByName(uniqueId("usr"));
    const t = Date.now();
    const item = (version: number, at: number) => stub.applyFeed([entry("rep_a", version, at)]);
    await item(1, t - 5_000);
    await stub.purge(purgeOf(["rep_a"], t - 4_000, 100));
    // The account was restored: its versions start again, in a newer epoch.
    await item(2, t - 3_000);
    expect(await stub.purge(purgeOf(["rep_a"], t - 2_500, 2, { epochGen: 2 }))).toEqual({
      deleted: 1,
    });
    // An older epoch's, however great its version, is behind it.
    await item(3, t - 2_000);
    expect(await stub.purge(purgeOf(["rep_a"], t - 1_500, 500))).toEqual({ deleted: 0 });
    // Transferred: another account's purge counts when it is later than the mark.
    const other = { accountId: "org_01K742SG00NAWD8WB4RTMJF8H9" };
    expect(await stub.purge(purgeOf(["rep_a"], t - 2_600, 1, other))).toEqual({ deleted: 0 });
    expect(await stub.purge(purgeOf(["rep_a"], t - 1_000, 1, other))).toEqual({ deleted: 1 });
    expect(await marks(stub)).toMatchObject([
      { repo_id: "rep_a", until_at: t - 1_000, account_id: other.accountId, acl_version: 1 },
    ]);
  });
});

/** What the account's outbox would send. */
const outboxOf = (accountId: string) =>
  runInDurableObject(env.ORG.getByName(accountId), (_: OrgDO, state) =>
    state.storage.sql
      .exec<{ event: string }>("SELECT event FROM outbox ORDER BY source_seq")
      .toArray()
      .map((row) => JSON.parse(row.event) as DomainEvent),
  );

/** Two accounts in the directory, and how a test puts private repositories there. */
async function accounts() {
  const [orgId, elsewhere] = [newId("org"), newId("org")];
  await env.DIRECTORY.batch(
    [orgId, elsewhere].map((id) =>
      env.DIRECTORY.prepare(
        "INSERT INTO principals (id, type, handle, created_at) VALUES (?, 'org', ?, 0)",
      ).bind(id, uniqueId("org").slice(0, 39)),
    ),
  );
  const repo = async (ownerId: string) => {
    const id = newId("rep");
    await env.DIRECTORY.prepare(
      `INSERT INTO repos (id, owner_id, name, network_id, org_shard, visibility, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'default', 'private', 0, 0)`,
    )
      .bind(id, ownerId, id.toLowerCase(), newId("net"))
      .run();
    return id;
  };
  return { orgId, elsewhere, repo };
}

const marks = (stub: DurableObjectStub<UserDO>) =>
  runInDurableObject(stub, (_: UserDO, state) =>
    state.storage.sql
      .exec("SELECT repo_id, until_at, account_id, epoch_gen, acl_version FROM purge_marks")
      .toArray(),
  );

/**
 * Feeds that record the purges they get (and apply nothing), for a sink
 * test that needs no feed at all.
 */
function recordingPurges() {
  const purges: { principal: string; purge: FeedPurge }[] = [];
  const on = {
    ...env,
    USER: {
      getByName: (principal: string) => ({
        purge: async (purge: FeedPurge) => {
          purges.push({ principal, purge });
          return { deleted: 0 };
        },
      }),
    },
  } as unknown as Env;
  return { on, purges };
}

const principals = (n: number) =>
  Array.from({ length: n }, (_, i) => `usr_${String(i).padStart(4, "0")}`);

/** The account's effects: `[effect id, state, attempts]`. */
async function effectsOf(accountId: string) {
  const { results } = await env.ORG_READ.prepare(
    "SELECT effect_id, state, attempts, lease_token FROM effects WHERE effect_id LIKE ? ORDER BY effect_id",
  )
    .bind(`${accountId}:%`)
    .all<{ effect_id: string; state: string; attempts: number; lease_token: string | null }>();
  return results;
}

describe("the feed sink and access revocations", () => {
  it("plans a revocation as purges of at most 100 principals and 2 repositories, and none for one it cannot read", () => {
    const sourceId = newId("org");
    const event = revokedEvent(sourceId, 1, {
      principals: ["usr_a"],
      repos: ["rep_x"],
      acl_version: 3,
    });
    expect(feedSink.plan(event)).toEqual([
      {
        target: "purge:0:r0",
        payload: {
          purge: {
            accountId: sourceId,
            principals: ["usr_a"],
            repos: ["rep_x"],
            until: event.at,
            epochGen: 1,
            aclVersion: 3,
          },
        },
      },
    ]);
    const many = feedSink.plan({
      ...event,
      data: { principals: principals(1_050), repos: ["rep_x"], acl_version: 3 },
    });
    expect(many.map((p) => p.target)).toEqual(
      Array.from({ length: 11 }, (_, i) => `purge:${i}:r0`),
    );
    expect(many.map((p) => feedSink.calls?.(p))).toEqual([...Array(10).fill(100), 50]);
    // Five repositories: three effects for each part, of at most two repositories.
    const wide = feedSink.plan({
      ...event,
      data: { principals: principals(150), repos: ["r1", "r2", "r3", "r4", "r5"], acl_version: 3 },
    });
    expect(wide.map((p) => p.target)).toEqual([
      "purge:0:r0",
      "purge:0:r1",
      "purge:0:r2",
      "purge:1:r0",
      "purge:1:r1",
      "purge:1:r2",
    ]);
    expect(wide.map((p) => (p.payload as { purge: { repos: string[] } }).purge.repos)).toEqual([
      ["r1", "r2"],
      ["r3", "r4"],
      ["r5"],
      ["r1", "r2"],
      ["r3", "r4"],
      ["r5"],
    ]);
    expect(feedSink.plan({ ...event, data: null, stored: true })).toEqual([]);
    expect(feedSink.plan({ ...event, data: { principals: [] } })).toEqual([]);
  });

  it("takes an account's events for the feed sink only, and leaves public repositories out of its purges", async () => {
    const orgId = newId("org");
    await env.DIRECTORY.prepare(
      "INSERT INTO principals (id, type, handle, created_at) VALUES (?, 'org', ?, 0)",
    )
      .bind(orgId, uniqueId("org").slice(0, 39))
      .run();
    const repo = async (visibility: "private" | "internal" | "public") => {
      const id = newId("rep");
      await env.DIRECTORY.prepare(
        `INSERT INTO repos (id, owner_id, name, network_id, org_shard, visibility, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'default', ?, 0, 0)`,
      )
        .bind(id, orgId, id.toLowerCase(), newId("net"), visibility)
        .run();
      return id;
    };
    const [kept, internal, open] = [
      await repo("private"),
      await repo("internal"),
      await repo("public"),
    ];
    const other: string[] = [];
    const oneByOne: EffectSink = {
      name: "test_hook",
      plan: () => [{ target: "hook_1", payload: {} }],
      deliver: async (effect: Effect) => {
        other.push(effect.id);
      },
    };
    const { on, purges } = recordingPurges();
    const at = Date.now();
    const outcome = await applyEnvelope(
      on,
      {
        sourceId: orgId,
        events: [
          revokedEvent(
            orgId,
            1,
            { principals: ["usr_dev"], repos: [kept, internal, open], acl_version: 9 },
            at,
          ),
        ],
      },
      { sinks: [oneByOne, feedSink] },
    );
    expect(outcome).toBe("applied");
    expect(other).toEqual([]);
    expect(purges).toHaveLength(1);
    expect(purges[0]?.principal).toBe("usr_dev");
    expect([...(purges[0]?.purge.repoIds ?? [])].sort()).toEqual([kept, internal].sort());
    expect(purges[0]?.purge).toMatchObject({
      until: at,
      accountId: orgId,
      epochGen: 1,
      aclVersion: 9,
    });
    const epoch = await env.ORG_READ.prepare(
      "SELECT epoch_gen FROM consumer_epochs WHERE source_id = ?",
    )
      .bind(orgId)
      .first();
    expect(epoch).toEqual({ epoch_gen: 1 });
  });

  it("purges a removed collaborator's feed of the repository, from the account's own event", async () => {
    const owner = await user();
    const reader = await user();
    const made = await api("POST", "/user/repos", owner.token, { name: uniqueId("r") });
    const repo = await made.json<{ id: string; full_name: string }>();
    const path = `/repos/${repo.full_name}/collaborators/${reader.handle}`;
    await api("PUT", path, owner.token, { permission: "pull" });
    const feed = env.USER.getByName(reader.principalId);
    await feed.applyFeed([{ ...entry(repo.id, 1, Date.now()), repoId: repo.id }]);
    await feed.applyFeed([{ ...entry("rep_elsewhere", 1, Date.now()) }]);
    expect(await shown(feed)).toHaveLength(2);
    expect((await api("DELETE", path, owner.token)).status).toBe(200);
    // What the account's outbox would send.
    const events = await runInDurableObject(
      env.ORG.getByName(owner.principalId),
      (_: OrgDO, state) =>
        state.storage.sql
          .exec<{ event: string }>("SELECT event FROM outbox ORDER BY source_seq")
          .toArray()
          .map((row) => JSON.parse(row.event) as DomainEvent),
    );
    expect(await applyEnvelope(env, { sourceId: owner.principalId, events })).toBe("applied");
    expect(await shown(feed)).toEqual([["rep_elsewhere", ["comment/1"]]]);
  });

  it("purges a removed member's feed of a repository the organization transferred before the purge arrived", async () => {
    const admin = await user(true);
    const owner = await user();
    const dev = await user();
    const org = async () => {
      const login = uniqueId("org").slice(0, 39);
      const made = await json<{ id: string }>(
        api("POST", "/admin/organizations", admin.token, { login, admin: owner.handle }),
      );
      expect(made.status).toBe(201);
      return { login, id: made.body.id };
    };
    const [from, to] = [await org(), await org()];
    await api("PUT", `/orgs/${from.login}/memberships/${dev.handle}`, owner.token, {});
    const repo = (
      await json<{ id: string; name: string }>(
        api("POST", `/orgs/${from.login}/repos`, owner.token, { name: uniqueId("r") }),
      )
    ).body;
    const feed = env.USER.getByName(dev.principalId);
    const t = Date.now();
    await feed.applyFeed([entry(repo.id, 1, t - 1_000)]);
    // The member leaves; the account's event waits in its outbox while the repository moves.
    expect(
      (await api("DELETE", `/orgs/${from.login}/memberships/${dev.handle}`, owner.token)).status,
    ).toBe(200);
    const moved = await json<{ state: string }>(
      api("POST", `/repos/${from.login}/${repo.name}/transfer`, owner.token, {
        new_owner: to.login,
      }),
    );
    expect(moved.body.state).toBe("transferred");
    expect(await applyEnvelope(env, { sourceId: from.id, events: await outboxOf(from.id) })).toBe(
      "applied",
    );
    expect(await shown(feed)).toEqual([]);
    // Access given back where the repository is now: its old activity stays gone, late or not.
    await api("PUT", `/orgs/${to.login}/memberships/${dev.handle}`, owner.token, {});
    await feed.applyFeed([entry(repo.id, 1, t - 1_000), entry(repo.id, 2, Date.now())]);
    expect(await shown(feed)).toEqual([[repo.id, ["comment/2"]]]);
  });

  it("purges the repositories a removal named, wherever they went since", async () => {
    const { orgId, elsewhere, repo } = await accounts();
    const [leaving, staying] = [await repo(orgId), await repo(orgId)];
    const event = revokedEvent(orgId, 1, {
      principals: ["usr_dev"],
      repos: [leaving, staying],
      acl_version: 3,
    });
    // Before the delivery, one repository leaves, comes back and leaves again.
    for (const owner of [elsewhere, orgId, elsewhere])
      await env.DIRECTORY.prepare("UPDATE repos SET owner_id = ? WHERE id = ?")
        .bind(owner, leaving)
        .run();
    const { on, purges } = recordingPurges();
    await applyEnvelope(on, { sourceId: orgId, events: [event] }, { sinks: [feedSink] });
    expect(purges.map((p) => p.purge.repoIds)).toEqual([[leaving, staying]]);
  });

  it("completes a revocation of 1,050 principals across queue messages, each invocation within its calls", async () => {
    const orgId = newId("org");
    const { on, purges } = recordingPurges();
    const { publish, sent } = recordingPublish();
    await applyEnvelope(
      on,
      {
        sourceId: orgId,
        events: [
          revokedEvent(orgId, 1, {
            principals: principals(1_050),
            repos: ["rep_x"],
            acl_version: 2,
          }),
        ],
      },
      // Nothing inline: the feed's queue delivers it all.
      { sinks: [feedSink], publish, inline: { batched: 0 } },
    );
    expect(await effectsOf(orgId)).toHaveLength(11);
    // The queue: one message an invocation, what each sends back taken by a later one.
    let invocations = 0;
    for (let next = sent.shift(); next; next = sent.shift()) {
      const before = purges.length;
      const now = Date.now();
      await deliverEffects(
        { db: env.ORG_READ, env: on, sinks: [feedSink], now: () => now, publish },
        next.sink,
        next.ids,
        invocationBudget(now),
      );
      expect(purges.length - before).toBeLessThanOrEqual(EFFECT_POLICY.invocation.calls);
      invocations++;
      expect(invocations).toBeLessThanOrEqual(3);
    }
    expect((await effectsOf(orgId)).every((e) => e.state === "done")).toBe(true);
    expect(new Set(purges.map((p) => p.principal)).size).toBe(1_050);
  });

  it("gives back, untried, the effects past an invocation's calls, and sends them back", async () => {
    const orgId = newId("org");
    const { on, purges } = recordingPurges();
    const { publish, sent } = recordingPublish();
    await applyEnvelope(
      on,
      {
        sourceId: orgId,
        events: [
          revokedEvent(orgId, 1, { principals: principals(400), repos: ["rep_x"], acl_version: 2 }),
        ],
      },
      { sinks: [feedSink], publish, inline: { batched: 0 } },
    );
    const [message] = sent.splice(0);
    const policy = {
      ...EFFECT_POLICY,
      invocation: { ...EFFECT_POLICY.invocation, calls: 150 },
    };
    const now = Date.now();
    await deliverEffects(
      { db: env.ORG_READ, env: on, sinks: [feedSink], now: () => now, publish, policy },
      "feed",
      message?.ids ?? [],
      invocationBudget(now, policy),
    );
    expect(purges).toHaveLength(100);
    const rows = await effectsOf(orgId);
    expect(rows.filter((e) => e.state === "done")).toHaveLength(1);
    const pending = rows.filter((e) => e.state === "pending");
    expect(pending).toHaveLength(3);
    expect(pending.every((e) => e.attempts === 0 && e.lease_token === null)).toBe(true);
    expect(sent).toHaveLength(1);
    expect([...(sent[0]?.ids ?? [])].sort()).toEqual(pending.map((e) => e.effect_id).sort());
  });
});

describe("a purge effect planned before purges named at most 2 repositories", () => {
  it("is delivered as its children, journaled from it and kept with its origin, once", async () => {
    const accountId = newId("org");
    const event = revokedEvent(accountId, 3, {
      principals: ["usr_a", "usr_b"],
      repos: ["rep_1", "rep_2", "rep_3", "rep_4", "rep_5"],
      acl_version: 7,
    });
    // As an earlier planner journaled it: one effect naming every repository.
    const parentId = `${eventKey(event.id)}:feed:purge:0`;
    const payload = {
      purge: {
        accountId,
        principals: ["usr_a", "usr_b"],
        repos: ["rep_1", "rep_2", "rep_3", "rep_4", "rep_5"],
        until: event.at,
        epochGen: 3,
        aclVersion: 7,
      },
    };
    await env.ORG_READ.prepare(
      `INSERT INTO effects (effect_id, sink, target, payload, next_attempt_at, created_at, source_id,
         epoch_gen, owner_gen, any_owner, recover_at, deliver_until)
       VALUES (?, 'feed', 'purge:0', ?, 0, 1000, ?, 3, 2, 1, 0, 9999999999999)`,
    )
      .bind(parentId, JSON.stringify(payload), accountId)
      .run();
    const { on, purges } = recordingPurges();
    const parent = { id: parentId, sink: "feed", target: "purge:0", payload, attempts: 1 };
    const delivered = await feedSink.deliverBatch?.([parent as Effect], on, env.ORG_READ);
    // No feed was called: the children were journaled, and the parent is done.
    expect(delivered?.delivered).toEqual([parentId]);
    expect(purges).toEqual([]);
    const children = async () =>
      (
        await env.ORG_READ.prepare(
          `SELECT effect_id, target, payload, state, created_at, source_id, epoch_gen, owner_gen,
             any_owner, deliver_until FROM effects WHERE effect_id LIKE ? ORDER BY effect_id`,
        )
          .bind(`${parentId}:%`)
          .all<Record<string, unknown>>()
      ).results;
    const made = await children();
    // Their ids are those the planner now gives the same event: delivered again, it adds none.
    expect(made.map((c) => c.effect_id)).toEqual(
      feedSink.plan(event).map((p) => `${eventKey(event.id)}:feed:${p.target}`),
    );
    for (const child of made)
      expect(child).toMatchObject({
        state: "pending",
        created_at: 1000,
        source_id: accountId,
        epoch_gen: 3,
        owner_gen: 2,
        any_owner: 1,
        deliver_until: 9999999999999,
      });
    expect(made.map((c) => JSON.parse(String(c.payload)).purge.repos)).toEqual([
      ["rep_1", "rep_2"],
      ["rep_3", "rep_4"],
      ["rep_5"],
    ]);
    // Delivered again (a retry after the journal write): nothing journaled twice.
    await feedSink.deliverBatch?.([parent as Effect], on, env.ORG_READ);
    expect(await children()).toHaveLength(3);
  });

  it("is done through the dispatcher; its children are sent by the cron, delivered, and ended by a restore", async () => {
    const accountId = newId("org");
    const repos = ["rep_1", "rep_2", "rep_3", "rep_4", "rep_5"];
    const event = revokedEvent(accountId, 3, {
      principals: ["usr_a", "usr_b"],
      repos,
      acl_version: 7,
    });
    const parentId = `${eventKey(event.id)}:feed:purge:0`;
    const payload = {
      purge: {
        accountId,
        principals: ["usr_a", "usr_b"],
        repos,
        until: event.at,
        epochGen: 1,
        aclVersion: 7,
      },
    };
    await env.ORG_READ.batch([
      env.ORG_READ.prepare(
        "INSERT INTO consumer_epochs (source_id, epoch_gen, updated_at) VALUES (?, 1, 0) ON CONFLICT DO NOTHING",
      ).bind(accountId),
      env.ORG_READ.prepare(
        `INSERT INTO effects (effect_id, sink, target, payload, next_attempt_at, created_at,
           source_id, epoch_gen, owner_gen, any_owner, recover_at)
         VALUES (?, 'feed', 'purge:0', ?, 0, 0, ?, 1, 0, 1, 0)`,
      ).bind(parentId, JSON.stringify(payload), accountId),
    ]);
    const { on, purges } = recordingPurges();
    const { publish, sent } = recordingPublish();
    const now = Date.now();
    const deps = { db: env.ORG_READ, env: on, sinks: [feedSink], now: () => now, publish };
    await deliverEffects(deps, "feed", [parentId], invocationBudget(now));
    const state = async (id: string) =>
      env.ORG_READ.prepare("SELECT state, last_error FROM effects WHERE effect_id = ?")
        .bind(id)
        .first<{ state: string; last_error: string | null }>();
    expect(await state(parentId)).toMatchObject({ state: "done" });
    expect(purges).toEqual([]);
    const children = feedSink.plan(event).map((p) => `${eventKey(event.id)}:feed:${p.target}`);
    // The event delivered again under the new planner (of the read model's epoch, so eligible):
    // the same ids, nothing journaled twice, the children as the parent made them.
    const again = await env.ORG_READ.batch(
      effectStatements(env.ORG_READ, [feedSink], accountId, [event], now),
    );
    expect(again.flatMap((r) => r.results)).toEqual([]);
    const kept = await env.ORG_READ.prepare(
      "SELECT DISTINCT created_at, epoch_gen, owner_gen FROM effects WHERE effect_id LIKE ?",
    )
      .bind(`${parentId}:%`)
      .all();
    expect(kept.results).toEqual([{ created_at: 0, epoch_gen: 1, owner_gen: 0 }]);
    const count = await env.ORG_READ.prepare(
      "SELECT count(*) AS n FROM effects WHERE effect_id LIKE ?",
    )
      .bind(`${parentId}:%`)
      .first<{ n: number }>();
    expect(count).toEqual({ n: 3 });
    // The effects cron sends the children (overdue as journaled).
    await recoverEffects({ ...deps, policy: { ...EFFECT_POLICY, recoverPage: 100_000 } });
    expect(sent.flatMap((m) => m.ids)).toEqual(expect.arrayContaining(children));
    await deliverEffects(deps, "feed", [children[0] ?? ""], invocationBudget(now));
    expect(await state(children[0] ?? "")).toMatchObject({ state: "done" });
    expect(purges.map((p) => [p.principal, p.purge.repoIds])).toEqual([
      ["usr_a", ["rep_1", "rep_2"]],
      ["usr_b", ["rep_1", "rep_2"]],
    ]);
    // The account restored to an earlier state since: a child not delivered yet is ended, as its
    // parent would have been.
    await env.ORG_READ.prepare("UPDATE consumer_epochs SET epoch_gen = 2 WHERE source_id = ?")
      .bind(accountId)
      .run();
    await deliverEffects(deps, "feed", [children[1] ?? ""], invocationBudget(now));
    expect(await state(children[1] ?? "")).toMatchObject({
      state: "failed",
      last_error: expect.stringMatching(/^invalidated:/),
    });
    expect(purges).toHaveLength(2);
  });

  it("keeps a repository's purge, scheduling its retention, when the next repository's fails", async () => {
    const stub = env.USER.getByName(uniqueId("usr"));
    const purge = {
      repoIds: ["rep_ok", "rep_bad"],
      until: Date.now(),
      accountId: "org_x",
      epochGen: 1,
      aclVersion: 1,
    };
    const original = Feed.prototype.purge;
    Feed.prototype.purge = function (this: Feed, p: FeedPurge) {
      if (p.repoIds.includes("rep_bad")) throw new Error("the second repository failed");
      return original.call(this, p);
    };
    try {
      await runInDurableObject(stub, async (instance: UserDO) => {
        await expect(instance.purge(purge)).rejects.toThrow(/second repository/);
      });
    } finally {
      Feed.prototype.purge = original;
    }
    const after = await runInDurableObject(stub, async (_: UserDO, state) => ({
      marks: state.storage.sql.exec("SELECT repo_id FROM purge_marks").toArray(),
      schedule: state.storage.sql.exec("SELECT kind FROM user_schedule").toArray(),
      alarm: (await state.storage.getAlarm()) !== null,
    }));
    expect(after).toEqual({
      marks: [{ repo_id: "rep_ok" }],
      schedule: [{ kind: "retain" }],
      alarm: true,
    });
    // Retried: the first is a mark already, the second purged now.
    expect(await stub.purge(purge)).toEqual({ deleted: 0 });
  });

  it("is refused by a feed when it names more than 2 repositories", async () => {
    const stub = env.USER.getByName(uniqueId("usr"));
    const purge = (repoIds: string[]) => ({
      repoIds,
      until: Date.now(),
      accountId: "org_x",
      epochGen: 1,
      aclVersion: 1,
    });
    // Asked inside the object: a refusal across RPC is also reported as unhandled there.
    await runInDurableObject(stub, async (instance: UserDO) => {
      await expect(instance.purge(purge(["rep_1", "rep_2", "rep_3"]))).rejects.toThrow(/at most 2/);
      await expect(
        instance.forgetRepos([purge(["rep_1"]), purge(["rep_2"]), purge(["rep_3"])]),
      ).rejects.toThrow(/at most 2/);
      expect(await instance.purge(purge(["rep_1", "rep_2"]))).toEqual({ deleted: 0 });
    });
  });
});
