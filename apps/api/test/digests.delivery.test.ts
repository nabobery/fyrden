// Digests, delivered: a sealed window's event becomes one discretionary
// effect per page of its members; each member gets a digest item per kind
// it is told of, P2, in that kind's stream and never in its inbox, until
// the earlier of its admission window's end and the digest's deadline. A
// reader shows a digest only while its window still holds a conversation
// the repository has, and forgets it once not; a digest is acknowledged at
// its own version only.

import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  type DomainEvent,
  digestThreadKey,
  eventKey,
  type FeedEntry,
  type FeedSubjectKind,
} from "@fyrden/domain";
import { describe, expect, it, vi } from "vitest";
import type { RepoDO } from "../src/do/RepoDO.js";
import { DIGEST_POLICY, type DigestEntry, windowOf } from "../src/do/repo/digests.js";
import type { UserDO } from "../src/do/UserDO.js";
import { DISCRETIONARY_WINDOW_MS } from "../src/effects/discretionary.js";
import { deliverEffects, invocationBudget, recoverEffects } from "../src/effects/dispatcher.js";
import type { PlannedEffect } from "../src/effects/journal.js";
import { feedSink } from "../src/feed/sink.js";
import { applyEnvelope } from "../src/queues/events-consumer.js";
import { api, json, type Who } from "./helpers/api.js";
import {
  comment,
  digestEvents,
  digestRepo,
  drain,
  open,
  PUSHED,
  pastSeal,
  type Repo,
  STRANGER,
  startWindow,
  stubOf,
} from "./helpers/digests.js";
import { recordingPublish } from "./helpers/effects.js";
import { countingExec, entry, feedIn, inFeed } from "./helpers/feed.js";
import { scopedToken } from "./helpers/principals.js";
import { admitted } from "./helpers/read-model.js";

type Item = {
  item_key: string;
  thread_key: string;
  kind: string;
  subject: { kind: string; number?: number; title: string };
  digest?: { window: number; starts_at: number; ends_at: number; url: string };
  priority: string;
  epoch: number;
  version: number;
};

/** The digest items of `who`'s feed, as `GET /feed` shows them (with `token`, its own by default). */
const digestItems = async (who: Who, token = who.token) => {
  const read = await json<{ items: Item[] }>(api("GET", "/feed", token));
  expect(read.status).toBe(200);
  return read.body.items.filter((i) => i.kind === "digest");
};

/** A digest event's digest. */
function digestOf(event: DomainEvent) {
  const digest = event.data?.digest as
    | { key: string; epochGen: number; deadline: number }
    | undefined;
  if (!digest) throw new Error("not a digest event");
  return digest;
}

/** The digest items `who`'s feed shows (read in its object, whatever its tokens); `tombstones` too. */
const storedDigests = (who: Who, tombstones = false) =>
  runInDurableObject(
    env.USER.getByName(who.principalId),
    (_: UserDO, state) =>
      state.storage.sql
        .exec<{ n: number }>(
          `SELECT count(*) AS n FROM feed_items WHERE kind = 'digest'
           AND (feed_seq IS NOT NULL OR ?)`,
          tombstones ? 1 : 0,
        )
        .one().n,
  );

/** Journals the event's feed effects and delivers them as the feed queue would; the effects. */
async function deliver(repo: Repo, event: DomainEvent, deliverAt?: number) {
  const { publish, sent } = recordingPublish();
  const now = Date.now();
  await applyEnvelope(
    env,
    { sourceId: repo.id, events: [event] },
    { sinks: [feedSink], publish, inline: { batched: 0 }, now: () => now },
  );
  if (deliverAt !== undefined) vi.setSystemTime(deliverAt);
  for (let next = sent.shift(); next; next = sent.shift())
    await deliverEffects(
      { db: admitted(), env, sinks: [feedSink], now: () => Date.now(), publish },
      next.sink,
      next.ids,
      invocationBudget(Date.now()),
    );
  return await effectsOf(repo);
}

/** The repository's digest effects. */
const effectsOf = async (repo: Repo) =>
  (
    await admitted()
      .prepare(
        "SELECT target, state, last_error FROM effects WHERE effect_id LIKE ? ORDER BY target",
      )
      .bind(`${repo.id}:%`)
      .all<{ target: string; state: string; last_error: string | null }>()
  ).results.filter((e) => e.target.startsWith("digest:"));

/** An issue's activity in a window, sealed: its window and digest event. */
async function sealed(owner: Who, repo: Repo) {
  const window = startWindow();
  const number = await open(owner, repo);
  // The first event asks for credit; the next is kept.
  await drain(repo.id);
  expect((await comment(owner, repo, number)).status).toBe(201);
  pastSeal(window);
  await drain(repo.id);
  const [event] = await digestEvents(repo.id);
  if (!event) throw new Error("no digest was sealed");
  return { window, number, event };
}

/** Records threads of both kinds by hand, the pull request's floor at `pullFloor`, then seals. */
async function sealedBothKinds(repo: Repo, pullFloor: string) {
  const window = startWindow();
  await runInDurableObject(stubOf(repo.id), (instance: RepoDO, state) => {
    state.storage.transactionSync(() => {
      for (const subject of ["issue", "pull"] as const)
        state.storage.sql.exec(
          `INSERT INTO digest_credit (subject, epoch_gen, units, expires_at, wanted, pending,
             retry_at, refusals)
           VALUES (?, ?, 100, ?, 0, NULL, 0, 0)`,
          subject,
          instance.events.epochGen(),
          Date.now() + 3_600_000,
        );
      const entry = (subject: FeedSubjectKind, floor: string): DigestEntry => ({
        subject,
        conversation: `c-${subject}`,
        number: 1,
        at: Date.now(),
        actorRoot: null,
        floor: { revision: 1, principal: floor },
      });
      expect(instance.digests.record(entry("issue", PUSHED.at(-1) ?? ""))).toBe(true);
      expect(instance.digests.record(entry("pull", pullFloor))).toBe(true);
      instance.git.jobs.ensure("digest_seal", "digest_seal");
    });
  });
  pastSeal(window);
  await drain(repo.id);
  const [event] = await digestEvents(repo.id);
  if (!event) throw new Error("no digest was sealed");
  return { window, event };
}

describe("a digest", () => {
  it("gives each member an item per kind it is told of, P2, in that kind's stream, never its inbox", async () => {
    const { readers, repo } = await digestRepo(2);
    // The first reader (in the watchers' order) was pushed when the pull request's event happened.
    const [first, second] = [...readers].sort((a, b) =>
      a.principalId < b.principalId ? -1 : 1,
    ) as [Who, Who];
    const { window, event } = await sealedBothKinds(repo, first.principalId);
    expect(event.data?.digest).toMatchObject({ subjects: ["issue", "pull"], pages: [{ n: 1 }] });
    expect(await deliver(repo, event)).toEqual([
      { target: "digest:1", state: "done", last_error: null },
    ]);
    const epoch = digestOf(event).epochGen;
    expect((await digestItems(first)).map((i) => i.thread_key)).toEqual([
      `issue-digest/${window}.${epoch}`,
    ]);
    const items = await digestItems(second);
    expect(items.map((i) => i.thread_key).sort()).toEqual([
      `issue-digest/${window}.${epoch}`,
      `pull-digest/${window}.${epoch}`,
    ]);
    expect(items.find((i) => i.subject.kind === "issue")).toMatchObject({
      subject: { kind: "issue", title: "" },
      digest: {
        window,
        starts_at: window * DIGEST_POLICY.windowMs,
        ends_at: (window + 1) * DIGEST_POLICY.windowMs,
        url: expect.stringMatching(
          new RegExp(`/api/feed/digests/${repo.id}/issue/${window}/${epoch}$`),
        ),
      },
      priority: "P2",
      epoch,
      version: window,
    });
    expect(items[0]?.subject.number).toBeUndefined();
    // A token reading issues only sees the issue digest.
    const issuesOnly = await scopedToken(second.principalId, ["issues:read", "metadata:read"]);
    expect((await digestItems(second, issuesOnly)).map((i) => i.subject.kind)).toEqual(["issue"]);
    // Nothing in the inbox.
    const inbox = await json<{ notifications: unknown[] }>(
      api("GET", "/notifications?all=true", second.token),
    );
    expect(inbox.body.notifications).toEqual([]);
  });

  it("is admitted at its page's whole price: each member's call and the page's read", async () => {
    const { owner, repo } = await digestRepo(2);
    const { event } = await sealed(owner, repo);
    const [planned, ...more] = feedSink.plan(event);
    expect(more).toEqual([]);
    expect(planned).toMatchObject({
      target: "digest:1",
      admission: { price: { do_requests: 3 }, maxAttempts: 1 },
    });
    expect(feedSink.calls?.(planned as PlannedEffect)).toBe(3);
  });

  it("tells no one who does not read the repository", async () => {
    const { owner, repo } = await digestRepo(1);
    const { event } = await sealed(owner, repo);
    const [page] = await runInDurableObject(stubOf(repo.id), (_: RepoDO, state) =>
      state.storage.sql
        .exec<{ recipients: string }>(
          "SELECT recipients FROM feed_audience_pages WHERE event_key = ?",
          digestOf(event).key,
        )
        .toArray(),
    );
    const members = JSON.parse(page?.recipients ?? "[]") as { principal: string }[];
    expect(members.map((m) => m.principal)).not.toContain(STRANGER);
  });

  it("is hidden, and forgotten, once its window's conversations are all deleted", async () => {
    const { owner, readers, repo } = await digestRepo(1);
    const reader = readers[0] as Who;
    const { window, number, event } = await sealed(owner, repo);
    await deliver(repo, event);
    expect(await digestItems(reader)).toHaveLength(1);
    expect(
      (await api("DELETE", `/repos/${repo.fullName}/issues/${number}`, owner.token)).status,
    ).toBe(200);
    expect(await digestItems(reader)).toEqual([]);
    expect(await storedDigests(reader)).toBe(0);
    // Kept as a tombstone, which nothing opens again: its entry again (a redelivery within its
    // window) is dropped, never back.
    expect(await storedDigests(reader, true)).toBe(1);
    // Its stream full of newer tombstones and fences, then one more tombstone: the cap evicts the
    // oldest, but not a digest's while its entries may still arrive.
    await runInDurableObject(env.USER.getByName(reader.principalId), (_: UserDO, state) => {
      const later = Date.now() + 1;
      for (let i = 0; i < 500; i++)
        state.storage.sql.exec(
          `INSERT INTO feed_items (repo_id, thread_key, kind, subject, number, title, thread_epoch,
             version, state, priority, reasons, silent, action, actor, actor_trust, display_member,
             members, truncated, last_event_key, last_event_at, acked_epoch, acked_version,
             feed_seq, seq_at, order_at)
           VALUES (?, ?, 'assigned', 'issue', ?, '', 1, 1, 'resolved', 'P0', '[]', 0, 'unassigned',
             NULL, 'none', NULL, '[]', 0, 'e', ?, 0, 0, NULL, ?, ?)`,
          repo.id,
          `issue/${2000 + i}`,
          2000 + i,
          later,
          later + i,
          later + i,
        );
      for (let i = 0; i < 100; i++)
        state.storage.sql.exec(
          `INSERT INTO feed_evictions (repo_id, thread_key, kind, subject, thread_epoch, version,
             event_at, event_key)
           VALUES (?, ?, 'activity', 'issue', 1, 1, ?, 'e')`,
          repo.id,
          `issue/${3000 + i}`,
          later + i,
        );
      state.storage.sql.exec(
        "UPDATE feed_streams SET tombstones = tombstones + 500 WHERE repo_id = ? AND subject = 'issue'",
        repo.id,
      );
    });
    const resolved: FeedEntry = {
      eventKey: `${repo.id}:1:999`,
      repoId: repo.id,
      occurredAt: Date.now(),
      actor: null,
      epochGen: 1,
      feed: {
        threadKey: "issue/9999",
        subject: { kind: "issue", number: 9999, title: "", version: 1 },
        action: "unassigned",
        actorRoot: null,
        actorTrust: "write",
        member: null,
        excerpt: null,
      },
      recipient: {
        principal: reader.principalId,
        kind: "assigned",
        reasons: ["assignee"],
        priority: "P0",
        state: "resolved",
        silent: false,
      },
    };
    await env.USER.getByName(reader.principalId).applyFeed([resolved]);
    expect(await storedDigests(reader, true)).toBe(1);
    const digest = digestOf(event);
    const entry: FeedEntry = {
      eventKey: eventKey(event.id),
      repoId: repo.id,
      occurredAt: (window + 1) * DIGEST_POLICY.windowMs,
      actor: null,
      epochGen: digest.epochGen,
      feed: {
        threadKey: digestThreadKey("issue", window, digest.epochGen),
        subject: { kind: "issue", number: 0, title: "", version: window },
        action: "digest",
        actorRoot: null,
        actorTrust: "none",
        member: null,
        excerpt: null,
      },
      recipient: {
        principal: reader.principalId,
        kind: "digest",
        reasons: ["watching"],
        priority: "P2",
        state: "open",
        silent: false,
      },
      until: Date.now() + 60_000,
    };
    expect(await env.USER.getByName(reader.principalId).applyFeed([entry])).toMatchObject({
      changed: 0,
    });
    expect(await storedDigests(reader)).toBe(0);
  });

  it("is acknowledged at its own version only, its clock moving once", async () => {
    const { owner, readers, repo } = await digestRepo(1);
    const reader = readers[0] as Who;
    const { window, event } = await sealed(owner, repo);
    await deliver(repo, event);
    const [item] = await digestItems(reader);
    if (!item) throw new Error("no digest item");
    const ack = (epoch: number, version: number) =>
      json<{ code?: string; acked_version?: number }>(
        api("POST", "/feed/ack", reader.token, { item_key: item.item_key, epoch, version }),
      );
    expect(await ack(item.epoch, window - 1)).toMatchObject({
      status: 422,
      body: { code: "digest_version_inexact" },
    });
    expect(await ack(item.epoch, window)).toMatchObject({
      status: 200,
      body: { acked_version: window },
    });
    expect((await ack(item.epoch, window)).status).toBe(200);
  });

  it("is never claimed past its admission window, its effect ended by recovery", async () => {
    const { owner, readers, repo } = await digestRepo(1);
    const { event } = await sealed(owner, repo);
    expect(await deliver(repo, event, Date.now() + DISCRETIONARY_WINDOW_MS + 1)).toEqual([
      { target: "digest:1", state: "pending", last_error: null },
    ]);
    const { publish } = recordingPublish();
    await recoverEffects({
      db: admitted(),
      env,
      sinks: [feedSink],
      now: () => Date.now(),
      publish,
    });
    expect(await effectsOf(repo)).toEqual([
      { target: "digest:1", state: "failed", last_error: "past its delivery horizon" },
    ]);
    expect(await storedDigests(readers[0] as Who)).toBe(0);
  });

  it("is ended unread when its page is read past the digest's deadline", async () => {
    const { owner, readers, repo } = await digestRepo(1);
    const { event } = await sealed(owner, repo);
    const { deadline } = digestOf(event);
    // Journaled late (within its admission window still when claimed), read after the deadline.
    vi.setSystemTime(deadline - 10 * 60_000);
    expect(await deliver(repo, event, deadline + 1)).toEqual([
      {
        target: "digest:1",
        state: "failed",
        last_error: "expired: past the digest's delivery deadline",
      },
    ]);
    expect(await storedDigests(readers[0] as Who)).toBe(0);
  });
});

describe("a forgotten digest's tombstone", () => {
  it("is kept from the stream's cap until its delivery ends, and no longer, costing no reads past it", async () => {
    await inFeed((storage) => {
      const window = windowOf(Date.now());
      const { feed, apply } = feedIn(storage, Date.now);
      const told = (w: number): FeedEntry => ({
        eventKey: `rep_test:1:${w}`,
        repoId: "rep_test",
        occurredAt: (w + 1) * DIGEST_POLICY.windowMs,
        actor: null,
        epochGen: 1,
        feed: {
          threadKey: digestThreadKey("issue", w, 1),
          subject: { kind: "issue", number: 0, title: "", version: w },
          action: "digest",
          actorRoot: null,
          actorTrust: "none",
          member: null,
          excerpt: null,
        },
        recipient: {
          principal: "usr_reader",
          kind: "digest",
          reasons: ["watching"],
          priority: "P2",
          state: "open",
          silent: false,
        },
      });
      // 400 digests whose delivery ended (two to six days old), and one whose has not.
      const ended = Array.from({ length: 400 }, (_, i) => window - 2 * 96 - i);
      const windows = [...ended, window - 1];
      apply(windows.map(told));
      storage.transactionSync(() =>
        feed.forgetThreads(
          windows.map((w) => ({
            repoId: "rep_test",
            threadKey: digestThreadKey("issue", w, 1),
            epoch: 1,
          })),
        ),
      );
      // A hundred more tombstones (assignments resolved before they showed), the last over the cap.
      const resolved = (n: number) =>
        entry({
          repoId: "rep_test",
          subject: "issue",
          thread: 5000 + n,
          kind: "assigned",
          version: 1,
          state: "resolved",
          priority: "P0",
        });
      apply(Array.from({ length: 99 }, (_, n) => resolved(n)));
      const counting = countingExec(storage.sql);
      apply([resolved(99)]);
      const { read } = counting.stop();
      const left = storage.sql
        .exec<{ thread_key: string }>(
          "SELECT thread_key FROM feed_items WHERE kind = 'digest' AND feed_seq IS NULL",
        )
        .toArray()
        .map((r) => r.thread_key);
      // The oldest ended digest went; the one still deliverable stayed, read past no other.
      expect(left).toHaveLength(400);
      expect(left).toContain(digestThreadKey("issue", window - 1, 1));
      expect(left).not.toContain(digestThreadKey("issue", Math.min(...ended), 1));
      expect(read).toBeLessThan(60);
      // Its entry again: dropped.
      expect(apply([told(window - 1)])).toMatchObject({ changed: 0 });
      // A digest of a window ahead of the feed's clock (past a window's skew): dropped too, and
      // answered as expired (its effect ends so).
      expect(apply([told(window + 2)])).toEqual({
        changed: 0,
        notified: 0,
        expired: [`rep_test:1:${window + 2}`],
      });
      expect(apply([told(window)])).toMatchObject({ changed: 1 });
    });
  });
});
