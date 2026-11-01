// Notification email: the entry the repository marks queues a candidate in
// the recipient's feed when it would be sent now; its alarm sends it as the
// recipient would read it then, through the directory's fence, at most
// once whichever copy of the feed holds it, its retries and the day's
// attempts bounded, nothing past its life.

import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createMetrics } from "@fyrden/adapters-cloudflare/obs";
import type { FeedEntry } from "@fyrden/domain";
import { uniqueId } from "@fyrden/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reapEmails } from "../src/accounts/emails.js";
import type { RepoDO } from "../src/do/RepoDO.js";
import { feedHooks, type UserDO } from "../src/do/UserDO.js";
import { ALARM_LIMITS, ALARM_UNITS } from "../src/do/user/alarm-budget.js";
import { threadId } from "../src/do/user/inbox.js";
import {
  type Candidate,
  messageFor,
  publicOrigin,
  sendCandidate,
  sendHooks,
} from "../src/email/notifications.js";
import { type EmailMessage, type EmailProvider, emailHooks } from "../src/email/provider.js";
import { newId } from "../src/services.js";
import { api, json, user, type Who } from "./helpers/api.js";
import { entry } from "./helpers/feed.js";

let sent: EmailMessage[] = [];
const recording: EmailProvider = {
  name: "test",
  from: "Fyrden <n@fyrden.test>",
  async send(message) {
    sent.push(message);
    return { status: "accepted", id: `msg_${sent.length}` };
  },
};

let owner: Who;
let writer: Who;
let repo: { id: string; fullName: string };
let address: string;
let conversation: string;

beforeEach(async () => {
  sent = [];
  emailHooks.provider = recording;
  emailHooks.sending = true;
  await env.DIRECTORY.batch([
    env.DIRECTORY.prepare("DELETE FROM email_spend"),
    env.DIRECTORY.prepare("DELETE FROM email_attempts"),
  ]);
  [owner, writer] = [await user(), await user()];
  const made = await json<{ id: string; name: string }>(
    api("POST", "/user/repos", owner.token, { name: uniqueId("n") }),
  );
  repo = { id: made.body.id, fullName: `${owner.handle}/${made.body.name}` };
  expect(
    (
      await api("PUT", `/repos/${repo.fullName}/collaborators/${writer.handle}`, owner.token, {
        permission: "push",
      })
    ).status,
  ).toBeLessThan(300);
  expect(
    (await api("POST", `/repos/${repo.fullName}/issues`, owner.token, { title: "A bug" })).status,
  ).toBe(201);
  conversation = await runInDurableObject(env.REPO.getByName(repo.id), (_: RepoDO, state) =>
    String(
      state.storage.sql
        .exec<{ c: string }>("SELECT conversation_id AS c FROM issues WHERE number = 1")
        .one().c,
    ),
  );
  address = await verified(owner);
});

afterEach(() => {
  delete emailHooks.provider;
  delete emailHooks.sending;
  delete sendHooks.beforeFence;
  vi.restoreAllMocks();
});

/** A verified address of `who`'s (written as confirming one would); the address. */
async function verified(who: Who): Promise<string> {
  const id = newId("eml");
  const mailbox = `${id.toLowerCase()}@example.com`;
  await env.DIRECTORY.prepare(
    `INSERT INTO user_emails (id, principal_id, address, address_key, verified_at, created_at,
       removed_at) VALUES (?1, ?2, ?3, ?3, ?4, ?4, NULL)`,
  )
    .bind(id, who.principalId, mailbox, Date.now())
    .run();
  return mailbox;
}

/** `who`'s entry of issue 1, marked with an email as the repository marks one. */
function marked(
  who: Who,
  init: Partial<Parameters<typeof entry>[0]> & {
    email?: { category: "direct" | "participating"; reason: string };
  } = {},
): FeedEntry {
  const { email = { category: "direct", reason: "mention" }, ...rest } = init;
  const made = entry({
    version: 1,
    thread: 1,
    subject: "issue",
    repoId: repo.id,
    principal: who.principalId,
    conversation,
    kind: "mention",
    reasons: ["mentioned"],
    actor: writer.principalId,
    member: null,
    occurredAt: Date.now(),
    eventKey: `${repo.id}:${uniqueId("ev")}`,
    ...rest,
  });
  return { ...made, recipient: { ...made.recipient, email } };
}

const feedOf = (who: Who) => env.USER.getByName(who.principalId);

/** Applies entries to `who`'s feed, then runs its alarm (what is due is sent). */
async function deliver(who: Who, ...entries: FeedEntry[]): Promise<void> {
  await feedOf(who).applyFeed(entries);
  await runDurableObjectAlarm(feedOf(who));
}

const queued = (who: Who) =>
  runInDurableObject(feedOf(who), (_: UserDO, state) =>
    state.storage.sql
      .exec<{ event_key: string; due_at: number; tries: number }>(
        "SELECT event_key, due_at, tries FROM email_queue ORDER BY arrival",
      )
      .toArray(),
  );

const delivery = (who: Who, event: string) =>
  env.DIRECTORY.prepare(
    "SELECT state, attempts, next_attempt_at FROM email_deliveries WHERE principal_id = ? AND event_key = ?",
  )
    .bind(who.principalId, event)
    .first<{ state: string; attempts: number; next_attempt_at: number | null }>();

describe("a notification email", () => {
  it("is sent once, as the recipient reads the thread now, with a one-click unsubscribe", async () => {
    const comment = await json<{ id: number }>(
      api("POST", `/repos/${repo.fullName}/issues/1/comments`, writer.token, {
        body: `@${owner.handle} please look at this`,
      }),
    );
    // Renamed since: the email says what the thread is called now.
    await api("PATCH", `/repos/${repo.fullName}/issues/1`, owner.token, { title: "A worse bug" });
    const told = marked(owner, { member: `comment/${comment.body.id}` });
    await deliver(owner, told);
    expect(sent).toHaveLength(1);
    const [message] = sent as [EmailMessage];
    expect(message.to).toBe(address);
    expect(message.subject).toBe(`[${repo.fullName}] A worse bug (#1)`);
    expect(message.text).toContain(`${writer.handle} mentioned you in issue ${repo.fullName}#1.`);
    expect(message.text).toContain("please look at this");
    expect(message.text).toContain(`https://fyrden.test/${repo.fullName}/issues/1`);
    expect(message.text).toContain("https://fyrden.test/settings/notifications");
    expect(message.headers?.["List-Unsubscribe"]).toMatch(
      /^<https:\/\/fyrden\.test\/unsubscribe\?t=v1\.eml_/,
    );
    expect(message.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(await delivery(owner, told.eventKey)).toMatchObject({ state: "sent" });
    // Redelivered, or queued again by a restored feed: not again.
    await deliver(owner, told);
    expect(sent).toHaveLength(1);
    expect(await queued(owner)).toEqual([]);
  });

  /** The deployment's email attempts and spending, and `who`'s queue: what a refused turn must leave. */
  const standing = async (who: Who) => ({
    queue: await queued(who),
    attempts: await env.DIRECTORY.prepare(
      "SELECT coalesce(sum(used), 0) AS n FROM email_attempts",
    ).first(),
    // Its rows (the result's metadata, timings among them, changes between any two reads).
    spend: (
      await env.DIRECTORY.prepare(
        "SELECT scope, period, used FROM email_spend ORDER BY scope, period",
      ).all()
    ).results,
  });

  it("waits, as it was, while the alarm's budget cannot admit it whole, and is sent at once after", async () => {
    const told = marked(owner);
    await feedOf(owner).applyFeed([told]);
    const before = await standing(owner);
    // Room for the mandatory steps only: the candidate is not started.
    feedHooks.alarmLimits = {
      ...ALARM_LIMITS,
      d1: ALARM_UNITS.mandatory.d1 + ALARM_UNITS.email.d1 - 1,
    };
    try {
      await runDurableObjectAlarm(feedOf(owner));
    } finally {
      delete feedHooks.alarmLimits;
    }
    expect(sent).toHaveLength(0);
    // No attempt, no spending, no try, no new due time: as it was.
    expect(await standing(owner)).toEqual(before);
    expect(await delivery(owner, told.eventKey)).toBeNull();
    // Its run is due at once.
    const alarm = await runInDurableObject(feedOf(owner), (_: UserDO, state) =>
      state.storage.getAlarm(),
    );
    expect(alarm).not.toBeNull();
    expect(alarm as number).toBeLessThanOrEqual(Date.now());
    await runDurableObjectAlarm(feedOf(owner));
    expect(sent).toHaveLength(1);
    expect(await delivery(owner, told.eventKey)).toMatchObject({ state: "sent" });
  });

  it("admits the next email by what the run has made so far, the rest left for the next run", async () => {
    const first = marked(owner);
    const second = marked(owner);
    await feedOf(owner).applyFeed([first, second]);
    // Room for one email's ceiling and the mandatory steps, not for another once the first's
    // statements are counted (it makes some: an empty count would let the second in).
    feedHooks.alarmLimits = {
      ...ALARM_LIMITS,
      d1: ALARM_UNITS.mandatory.d1 + ALARM_UNITS.email.d1 + 7,
    };
    try {
      await runDurableObjectAlarm(feedOf(owner));
    } finally {
      delete feedHooks.alarmLimits;
    }
    expect(sent).toHaveLength(1);
    expect(await queued(owner)).toMatchObject([{ event_key: second.eventKey, tries: 0 }]);
    await runDurableObjectAlarm(feedOf(owner));
    expect(sent).toHaveLength(2);
    expect(await queued(owner)).toEqual([]);
  });

  it("is not queued without a deliverable address or with its category off", async () => {
    const other = await user();
    await feedOf(other).applyFeed([marked(other)]);
    expect(await queued(other)).toEqual([]);
    // Participating is off unless set.
    await feedOf(owner).applyFeed([
      marked(owner, {
        kind: "activity",
        reasons: ["author"],
        email: { category: "participating", reason: "author" },
      }),
    ]);
    expect(await queued(owner)).toEqual([]);
    // A redelivered entry with no mark (made before marks): nothing either.
    const plain = marked(owner);
    await feedOf(owner).applyFeed([
      { ...plain, recipient: { ...plain.recipient, email: undefined } },
    ]);
    expect(await queued(owner)).toEqual([]);
  });

  it("is not sent once the recipient cannot read the thread, or the repository is ignored", async () => {
    const reader = await user();
    await api("PUT", `/repos/${repo.fullName}/collaborators/${reader.handle}`, owner.token, {
      permission: "pull",
    });
    await verified(reader);
    await feedOf(reader).applyFeed([marked(reader)]);
    expect(await queued(reader)).toHaveLength(1);
    await api("DELETE", `/repos/${repo.fullName}/collaborators/${reader.handle}`, owner.token);
    await runDurableObjectAlarm(feedOf(reader));
    expect(sent).toEqual([]);
    expect(await queued(reader)).toEqual([]);
    // Ignored after it was queued: held back at the fence.
    await feedOf(owner).applyFeed([marked(owner)]);
    await env.DIRECTORY.prepare(
      `INSERT INTO watch_preferences (principal_id, repo_id, root_id, level, revision, epoch_gen, at)
       VALUES (?1, ?2, ?1, 'ignoring', 1, 1, ?3)`,
    )
      .bind(owner.principalId, repo.id, Date.now())
      .run();
    await runDurableObjectAlarm(feedOf(owner));
    expect(sent).toEqual([]);
  });

  it("is held back by an unsubscribed thread, unless it asks something of the recipient", async () => {
    await env.DIRECTORY.prepare(
      `INSERT INTO email_preferences (principal_id, direct, participating, watching, updated_at)
       VALUES (?, 1, 1, 0, ?)`,
    )
      .bind(owner.principalId, Date.now())
      .run();
    await feedOf(owner).applyFeed([
      marked(owner, {
        kind: "activity",
        reasons: ["author"],
        email: { category: "participating", reason: "author" },
      }),
      marked(owner, {
        kind: "assigned",
        reasons: ["assignee"],
        email: { category: "direct", reason: "assign" },
      }),
    ]);
    await env.DIRECTORY.prepare(
      `INSERT INTO thread_preferences (principal_id, repo_id, conversation, number, kind, root_id,
         state, revision, epoch_gen, at) VALUES (?1, ?2, ?3, 1, 'issue', ?1, 'unsubscribed', 1, 1, ?4)`,
    )
      .bind(owner.principalId, repo.id, conversation, Date.now())
      .run();
    await runDurableObjectAlarm(feedOf(owner));
    expect(sent.map((m) => m.text.split("\n")[0])).toEqual([
      `${writer.handle} assigned you to issue ${repo.fullName}#1.`,
    ]);
  });

  it("is tried again after a refusal, at most four attempts, each its own key, the message given back", async () => {
    const keys: string[] = [];
    emailHooks.provider = {
      ...recording,
      async send(message) {
        keys.push(message.idempotencyKey);
        return { status: "refused", permanent: false, reason: "429", retryAfterMs: 0 };
      },
    };
    const told = marked(owner);
    await deliver(owner, told);
    expect(await delivery(owner, told.eventKey)).toMatchObject({ state: "retry", attempts: 1 });
    for (let i = 0; i < 5; i++) {
      // Not before its back-off, whatever the provider said.
      await runDurableObjectAlarm(feedOf(owner));
      vi.setSystemTime(Date.now() + 41 * 60_000);
      await runInDurableObject(feedOf(owner), (_: UserDO, state) =>
        state.storage.setAlarm(Date.now()),
      );
      await runDurableObjectAlarm(feedOf(owner));
    }
    expect(keys).toHaveLength(4);
    expect(new Set(keys).size).toBe(4);
    expect(await delivery(owner, told.eventKey)).toMatchObject({ state: "exhausted", attempts: 4 });
    expect(await queued(owner)).toEqual([]);
    const spent = await env.DIRECTORY.prepare("SELECT sum(used) AS n FROM email_spend").first<{
      n: number | null;
    }>();
    expect(spent?.n ?? 0).toBe(0);
  });

  it("is never sent again after an unknown outcome, even queued again", async () => {
    let calls = 0;
    emailHooks.provider = {
      ...recording,
      async send() {
        calls++;
        return { status: "unknown", reason: "lost" };
      },
    };
    const told = marked(owner);
    await deliver(owner, told);
    await deliver(owner, told);
    expect(calls).toBe(1);
    expect(await delivery(owner, told.eventKey)).toMatchObject({ state: "unknown" });
  });

  it("waits for the next day when the day's attempts are spent", async () => {
    await env.DIRECTORY.prepare("INSERT INTO email_attempts (day, used) VALUES (?, 200)")
      .bind(Math.floor(Date.now() / 86_400_000))
      .run();
    await deliver(owner, marked(owner));
    expect(sent).toEqual([]);
    const [waiting] = await queued(owner);
    expect(waiting?.due_at).toBe(Math.floor(Date.now() / 86_400_000 + 1) * 86_400_000);
  });

  it("is not sent past its life, even when it expires during its checks", async () => {
    await feedOf(owner).applyFeed([marked(owner, { occurredAt: Date.now() - 25 * 60 * 60_000 })]);
    expect(await queued(owner)).toEqual([]);
    const late = marked(owner, { occurredAt: Date.now() - (24 * 60 - 1) * 60_000 });
    sendHooks.beforeFence = async () => {
      vi.setSystemTime(Date.now() + 2 * 60_000);
    };
    await deliver(owner, late);
    expect(sent).toEqual([]);
    expect(await queued(owner)).toEqual([]);
    expect(await delivery(owner, late.eventKey)).toBeNull();
  });

  it("keeps the earlier candidates when the queue is full, and forgets a purged repository's", async () => {
    const entries = Array.from({ length: 201 }, (_, i) =>
      marked(owner, { eventKey: `${repo.id}:ev${String(i).padStart(3, "0")}` }),
    );
    // No sends meanwhile: the day's attempts are spent.
    await env.DIRECTORY.prepare("INSERT INTO email_attempts (day, used) VALUES (?, 200)")
      .bind(Math.floor(Date.now() / 86_400_000))
      .run();
    await feedOf(owner).applyFeed(entries);
    const kept = await queued(owner);
    expect(kept).toHaveLength(200);
    expect(kept.at(-1)?.event_key).toBe(`${repo.id}:ev199`);
    await feedOf(owner).purge({
      repoIds: [repo.id],
      until: Date.now(),
      accountId: owner.principalId,
      epochGen: 1,
      aclVersion: 1,
    });
    expect(await queued(owner)).toEqual([]);
  });

  it("goes with a gone thread, a replaced conversation, and the feed's retirement", async () => {
    const parked = () =>
      env.DIRECTORY.prepare("INSERT INTO email_attempts (day, used) VALUES (?, 200)")
        .bind(Math.floor(Date.now() / 86_400_000))
        .run();
    await parked();
    await feedOf(owner).applyFeed([marked(owner)]);
    await feedOf(owner).forgetGoneThreads([{ repoId: repo.id, threadKey: "issue/1", epoch: 1 }]);
    expect(await queued(owner)).toEqual([]);
    await feedOf(owner).applyFeed([marked(owner)]);
    await feedOf(owner).forgetInboxThreads([{ id: threadId(repo.id, conversation), epoch: 1 }]);
    expect(await queued(owner)).toEqual([]);
    await feedOf(owner).applyFeed([marked(owner)]);
    await feedOf(owner).retire();
    expect(await queued(owner)).toEqual([]);
  });

  it("leaves its outcome a month, then it is reaped", async () => {
    const told = marked(owner);
    await deliver(owner, told);
    expect(await delivery(owner, told.eventKey)).toMatchObject({ state: "sent" });
    await reapEmails(env, { now: Date.now() + 29 * 86_400_000 });
    expect(await delivery(owner, told.eventKey)).not.toBeNull();
    await reapEmails(env, { now: Date.now() + 31 * 86_400_000 });
    expect(await delivery(owner, told.eventKey)).toBeNull();
  });

  it("is not sent once forgotten during its checks", async () => {
    const told = marked(owner);
    const candidate = {
      event_key: told.eventKey,
      repo_id: repo.id,
      thread_key: "issue/1",
      conversation,
      epoch: 1,
      member: null,
      actor: writer.principalId,
      action: "mention",
      category: "direct",
      reason: "mention",
      occurred_at: Date.now(),
      arrival: 1,
      due_at: Date.now(),
      tries: 0,
    } satisfies Candidate;
    expect(
      await sendCandidate(
        env,
        owner.principalId,
        candidate,
        createMetrics(env.METRICS),
        () => false,
      ),
    ).toEqual({ done: true });
    expect(sent).toEqual([]);
    expect(await delivery(owner, told.eventKey)).toBeNull();
  });

  it("stays queued when an older purge is refused", async () => {
    await env.DIRECTORY.prepare("INSERT INTO email_attempts (day, used) VALUES (?, 200)")
      .bind(Math.floor(Date.now() / 86_400_000))
      .run();
    const at = Date.now();
    await feedOf(owner).applyFeed([marked(owner, { occurredAt: at })]);
    const purge = { repoIds: [repo.id], accountId: owner.principalId, epochGen: 1 };
    await feedOf(owner).purge({ ...purge, aclVersion: 2, until: at - 1000 });
    // Older by its access version, though later by its time: refused, the candidate kept.
    await feedOf(owner).purge({ ...purge, aclVersion: 1, until: at + 1000 });
    expect(await queued(owner)).toHaveLength(1);
  });

  it("counts a refusal's delay from the provider's answer", async () => {
    emailHooks.provider = {
      ...recording,
      async send() {
        vi.setSystemTime(Date.now() + 20 * 60_000);
        return { status: "refused", permanent: false, reason: "429", retryAfterMs: 10 * 60_000 };
      },
    };
    const told = marked(owner);
    await deliver(owner, told);
    const row = await delivery(owner, told.eventKey);
    expect(row?.next_attempt_at).toBeGreaterThanOrEqual(Date.now() + 10 * 60_000 - 1000);
  });

  it("drops a category turned off first when the queue is full", async () => {
    await env.DIRECTORY.prepare("INSERT INTO email_attempts (day, used) VALUES (?, 200)")
      .bind(Math.floor(Date.now() / 86_400_000))
      .run();
    await feedOf(owner).applyFeed(
      Array.from({ length: 200 }, (_, i) => marked(owner, { eventKey: `${repo.id}:d${i}` })),
    );
    await env.DIRECTORY.prepare(
      `INSERT INTO email_preferences (principal_id, direct, participating, watching, updated_at)
       VALUES (?, 0, 1, 0, ?)`,
    )
      .bind(owner.principalId, Date.now())
      .run();
    const participating = marked(owner, {
      kind: "activity",
      reasons: ["commenter"],
      email: { category: "participating", reason: "comment" },
    });
    await feedOf(owner).applyFeed([participating]);
    expect((await queued(owner)).map((q) => q.event_key)).toEqual([participating.eventKey]);
  });

  it("is dropped, not kept waiting, when it is not to be sent at all", async () => {
    // The day's allowance spent: an eligible candidate would wait for room.
    await env.DIRECTORY.prepare("INSERT INTO email_spend VALUES ('day', ?, 1000)")
      .bind(Math.floor(Date.now() / 86_400_000))
      .run();
    await feedOf(owner).applyFeed([marked(owner)]);
    await runDurableObjectAlarm(feedOf(owner));
    expect(await queued(owner)).toHaveLength(1);
    await env.DIRECTORY.prepare(
      `INSERT INTO watch_preferences (principal_id, repo_id, root_id, level, revision, epoch_gen, at)
       VALUES (?1, ?2, ?1, 'ignoring', 1, 1, ?3)`,
    )
      .bind(owner.principalId, repo.id, Date.now())
      .run();
    await runInDurableObject(feedOf(owner), (_: UserDO, state) => {
      state.storage.sql.exec("UPDATE email_queue SET due_at = 0");
      state.storage.sql.exec("UPDATE user_schedule SET due_at = 0 WHERE kind = 'email'");
      return state.storage.setAlarm(Date.now());
    });
    await runDurableObjectAlarm(feedOf(owner));
    expect(await queued(owner)).toEqual([]);
  });

  it("names a deleted actor as GitHub does", async () => {
    await env.DIRECTORY.prepare(
      "UPDATE principals SET lifecycle = 'deleted', disabled_at = coalesce(disabled_at, 1) WHERE id = ?",
    )
      .bind(writer.principalId)
      .run();
    await deliver(owner, marked(owner));
    expect(sent[0]?.text.split("\n")[0]).toBe(`ghost mentioned you in issue ${repo.fullName}#1.`);
  });
});

describe("a notification's text", () => {
  const view = { owner: "o", name: "r", title: "T", excerpt: null };
  const of = (action: string, reason: string, thread = "pull/3") =>
    messageFor(
      "https://f.test",
      { thread_key: thread, action, reason, category: "direct" } as Candidate,
      view,
      "w",
    ).text.split("\n")[0];

  it("says what the event did, whatever entry carried it", () => {
    expect(of("closed", "author")).toBe("w closed pull request o/r#3.");
    expect(of("merged", "author")).toBe("w merged pull request o/r#3.");
    expect(of("review_requested", "review_requested")).toBe(
      "w requested your review on pull request o/r#3.",
    );
    expect(of("comment", "mention", "issue/3")).toBe("w mentioned you in issue o/r#3.");
    expect(of("merge_conflict", "author")).toBe(
      "Your pull request o/r#3 now has a merge conflict.",
    );
    // Every action the repository emits, in words.
    expect(of("review", "author")).toBe("w reviewed pull request o/r#3.");
    expect(of("review_comment", "comment")).toBe("w commented on a change in pull request o/r#3.");
    expect(of("review_dismissed", "author")).toBe("w dismissed a review on pull request o/r#3.");
    expect(of("comment_edited", "comment")).toBe("w edited a comment on pull request o/r#3.");
  });

  it("links to a canonical public origin only", () => {
    expect(publicOrigin({ FYRDEN_PUBLIC_ORIGIN: "https://Git.Example:443" })).toBe(
      "https://git.example",
    );
    for (const bad of [
      "http://git.example",
      "https://git.example/x",
      "https://git.example?q",
      "nope",
    ])
      expect(publicOrigin({ FYRDEN_PUBLIC_ORIGIN: bad }), bad).toBeNull();
  });
});
