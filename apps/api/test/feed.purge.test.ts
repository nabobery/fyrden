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
  type FeedEntry,
  secureRandomBytes,
} from "@fyrden/domain";
import { uniqueId } from "@fyrden/testing";
import { describe, expect, it } from "vitest";
import type { OrgDO } from "../src/do/OrgDO.js";
import type { UserDO } from "../src/do/UserDO.js";
import type { FeedPurge } from "../src/do/user/feed.js";
import { sweepEffects } from "../src/effects/dispatcher.js";
import { EFFECT_POLICY, type Effect, type EffectSink } from "../src/effects/journal.js";
import { feedSink } from "../src/feed/sink.js";
import { applyEnvelope } from "../src/queues/events-consumer.js";
import { api, json, user } from "./helpers/api.js";
import { settleOthersDue } from "./helpers/effects.js";

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
  const page = await stub.listFeed(null, 100, {});
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
    const items = await runInDurableObject(stub, (_: UserDO, state) =>
      state.storage.sql.exec("SELECT items FROM feed_meta").one(),
    );
    expect(items).toEqual({ items: 2 });
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
      const page = await stub.listFeed(null, 10, {});
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
      const page = await stub.listFeed(null, 10, {});
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
  it("plans a revocation as purges of at most 100 principals, and none for one it cannot read", () => {
    const sourceId = newId("org");
    const event = revokedEvent(sourceId, 1, {
      principals: ["usr_a"],
      repos: ["rep_x"],
      acl_version: 3,
    });
    expect(feedSink.plan(event)).toEqual([
      {
        target: "purge:0",
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
    expect(many.map((p) => p.target)).toEqual(Array.from({ length: 11 }, (_, i) => `purge:${i}`));
    expect(many.map((p) => feedSink.calls?.(p))).toEqual([...Array(10).fill(100), 50]);
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

  it("completes a revocation of 1,050 principals across sweeps, each within its calls", async () => {
    const orgId = newId("org");
    const { on, purges } = recordingPurges();
    // Its sweeps' bounds hold for its own effects: others' are settled first.
    await settleOthersDue(Date.now() + EFFECT_POLICY.sweepAfterMs + 60_000);
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
      // Nothing inline: the sweeper delivers it all.
      { sinks: [feedSink], inline: { left: 0, batched: 0 } },
    );
    expect(await effectsOf(orgId)).toHaveLength(11);
    const due = Date.now() + EFFECT_POLICY.sweepAfterMs;
    let sweeps = 0;
    while ((await effectsOf(orgId)).some((e) => e.state === "pending")) {
      const before = purges.length;
      await sweepEffects({ db: env.ORG_READ, env: on, sinks: [feedSink], now: () => due });
      expect(purges.length - before).toBeLessThanOrEqual(EFFECT_POLICY.sweepCalls);
      sweeps++;
      expect(sweeps).toBeLessThanOrEqual(3);
    }
    expect(new Set(purges.map((p) => p.principal)).size).toBe(1_050);
  });

  it("gives back, untried, the effects past a sweep's calls", async () => {
    const orgId = newId("org");
    const { on, purges } = recordingPurges();
    // Its sweeps' bounds hold for its own effects: others' are settled first.
    await settleOthersDue(Date.now() + EFFECT_POLICY.sweepAfterMs + 60_000);
    await applyEnvelope(
      on,
      {
        sourceId: orgId,
        events: [
          revokedEvent(orgId, 1, { principals: principals(400), repos: ["rep_x"], acl_version: 2 }),
        ],
      },
      { sinks: [feedSink], inline: { left: 0, batched: 0 } },
    );
    await sweepEffects({
      db: env.ORG_READ,
      env: on,
      sinks: [feedSink],
      now: () => Date.now() + EFFECT_POLICY.sweepAfterMs,
      policy: { ...EFFECT_POLICY, sweepCalls: 150 },
    });
    expect(purges).toHaveLength(100);
    const rows = await effectsOf(orgId);
    expect(rows.filter((e) => e.state === "done")).toHaveLength(1);
    expect(rows.filter((e) => e.state === "pending")).toEqual(
      expect.arrayContaining([expect.objectContaining({ attempts: 0, lease_token: null })]),
    );
    expect(rows.filter((e) => e.state === "pending" && (e.attempts > 0 || e.lease_token))).toEqual(
      [],
    );
  });
});
