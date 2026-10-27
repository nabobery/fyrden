// Digests, the repository's side: watchers past the pushed tier are told of
// a window's threads once, after it ends. The repository keeps each window's
// threads per kind as they happen, spending credit the deployment's daily
// allowance granted it in advance, per kind and per restore generation; seals
// a window a minute after it ends (its members as pages, one
// `repository.digest` event); lowers its counts as conversations are
// deleted; waits while it cannot emit; discards what the switch turned off;
// and cleans up after itself with no further events.

import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { DomainEvent, FeedSubjectKind } from "@fyrden/domain";
import { uniqueId } from "@fyrden/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RepoDO } from "../src/do/RepoDO.js";
import { DIGEST_POLICY, type DigestEntry, windowOf } from "../src/do/repo/digests.js";
import { WATCH_POLICY } from "../src/do/repo/watching.js";
import { api, json, user, type Who } from "./helpers/api.js";
import { countingExec } from "./helpers/feed.js";

const { windowMs, sealAfterMs } = DIGEST_POLICY;

type Repo = { id: string; fullName: string };

const stubOf = (repoId: string) => env.REPO.getByName(repoId);

/** A private repository of `owner`'s, which `readers` read (collaborators with `pull`). */
async function repoOf(owner: Who, readers: readonly Who[]): Promise<Repo> {
  const made = await json<{ id: string; name: string }>(
    api("POST", "/user/repos", owner.token, { name: uniqueId("d") }),
  );
  expect(made.status).toBe(201);
  const fullName = `${owner.handle}/${made.body.name}`;
  for (const reader of readers)
    expect(
      (
        await api("PUT", `/repos/${fullName}/collaborators/${reader.handle}`, owner.token, {
          permission: "pull",
        })
      ).status,
    ).toBeLessThan(300);
  return { id: made.body.id, fullName };
}

/** The pushed tier's watchers (written as the repository would, for speed): first in its order. */
const PUSHED = Array.from(
  { length: WATCH_POLICY.pushed },
  (_, i) => `usr_00${String(i).padStart(6, "0")}`,
);
/** A watcher past the pushed tier that does not read the repository (ordered after real users). */
const STRANGER = "usr_02stranger";

/**
 * A repository with watch audiences on: the pushed tier filled, then
 * `readers` (who read it) and a stranger watching past it.
 */
async function digestRepo(readerCount = 2) {
  const owner = await user();
  const readers: Who[] = [];
  for (let i = 0; i < readerCount; i++) readers.push(await user());
  const repo = await repoOf(owner, readers);
  await runInDurableObject(stubOf(repo.id), (instance: RepoDO, state) => {
    instance.watchAudiences = true;
    state.storage.transactionSync(() => {
      for (const id of PUSHED) instance.watching.set(id, id, "watching");
      instance.watching.set(STRANGER, STRANGER, "watching");
    });
  });
  for (const reader of readers)
    expect(
      (await api("PUT", `/repos/${repo.fullName}/subscription`, reader.token, { subscribed: true }))
        .status,
    ).toBe(200);
  return { owner, readers, repo };
}

const open = async (who: Who, repo: Repo, title = "One") =>
  (
    await json<{ number: number }>(
      api("POST", `/repos/${repo.fullName}/issues`, who.token, { title }),
    )
  ).body.number;
const comment = (who: Who, repo: Repo, number: number) =>
  api("POST", `/repos/${repo.fullName}/issues/${number}/comments`, who.token, { body: "more" });

const rows = <T extends Record<string, SqlStorageValue>>(repoId: string, query: string) =>
  runInDurableObject(stubOf(repoId), (_: RepoDO, state) =>
    state.storage.sql
      .exec<T>(query)
      .toArray()
      .map((r) => ({ ...r })),
  );

const threads = (repoId: string) =>
  rows<{ subject: string; number: number }>(
    repoId,
    "SELECT subject, number FROM digest_threads ORDER BY subject, number",
  );
const windows = (repoId: string) =>
  rows<{ subject: string; threads: number; live: number; sealed: number }>(
    repoId,
    "SELECT subject, threads, live, sealed FROM digest_windows ORDER BY win, subject",
  );
const credit = (repoId: string) =>
  rows<{ subject: string; units: number }>(
    repoId,
    "SELECT subject, units FROM digest_credit WHERE units > 0 ORDER BY subject",
  );
const job = async (repoId: string, kind: string) =>
  (
    await rows<{ state: string; attempts: number; next_run_at: number }>(
      repoId,
      `SELECT state, attempts, next_run_at FROM jobs WHERE job_id = '${kind}'`,
    )
  )[0];

/** The repository's digest events since `from`. */
const digestEvents = (repoId: string, from = 0) =>
  rows<{ event: string }>(
    repoId,
    `SELECT event FROM outbox WHERE source_seq > ${from} ORDER BY source_seq`,
  ).then((all) =>
    all
      .map((r) => JSON.parse(r.event) as DomainEvent)
      .filter((e) => e.type === "repository.digest"),
  );

/** Runs the repository's alarms until none is due now, at most `max`. */
async function drain(repoId: string, max = 10) {
  for (let i = 0; i < max; i++) if (!(await runDurableObjectAlarm(stubOf(repoId)))) return;
}

/** Holds the clock a minute into the next window; the window. */
function startWindow(): number {
  const window = windowOf(Date.now()) + 1;
  vi.setSystemTime(window * windowMs + 60_000);
  return window;
}

/** Moves the clock past the window's seal. */
const pastSeal = (window: number) => vi.setSystemTime((window + 1) * windowMs + sealAfterMs + 1);

afterEach(() => {
  // Back to the suite's clock (held a day ahead).
  vi.setSystemTime(Date.now());
});

/** Credit granted in the repository by its own job (the ledger admitting it). */
async function funded(repo: Repo, opener: Who): Promise<number> {
  const number = await open(opener, repo);
  // Nothing was written without credit; the event asked for it.
  expect(await threads(repo.id)).toEqual([]);
  expect(await job(repo.id, "digest_credit")).toMatchObject({ state: "queued" });
  await drain(repo.id);
  expect(await credit(repo.id)).toEqual([{ subject: "issue", units: DIGEST_POLICY.creditBlock }]);
  return number;
}

describe("a repository's digests", () => {
  it("keep a window's threads past the pushed tier, spending credit granted in advance", async () => {
    const { owner, repo } = await digestRepo();
    startWindow();
    const first = await funded(repo, owner);
    await comment(owner, repo, first);
    const second = await open(owner, repo, "Two");
    await comment(owner, repo, second);
    expect(await threads(repo.id)).toEqual([
      { subject: "issue", number: first },
      { subject: "issue", number: second },
    ]);
    expect(await windows(repo.id)).toEqual([{ subject: "issue", threads: 2, live: 2, sealed: 0 }]);
    // A new bucket spends its units, each new thread one, a known thread one more.
    const spent = DIGEST_POLICY.bucketUnits + DIGEST_POLICY.threadUnits * 2;
    expect(await credit(repo.id)).toEqual([
      { subject: "issue", units: DIGEST_POLICY.creditBlock - spent },
    ]);
  });

  it("keep nothing while every watcher is in the pushed tier", async () => {
    const owner = await user();
    const repo = await repoOf(owner, []);
    await runInDurableObject(stubOf(repo.id), (instance: RepoDO, state) => {
      instance.watchAudiences = true;
      state.storage.transactionSync(() => {
        for (const id of PUSHED) instance.watching.set(id, id, "watching");
      });
    });
    await open(owner, repo);
    expect(await threads(repo.id)).toEqual([]);
    expect(await job(repo.id, "digest_credit")).toBeUndefined();
  });

  it("seal a window a minute after it ends: its readers as pages, one event", async () => {
    const { owner, readers, repo } = await digestRepo();
    const window = startWindow();
    const number = await funded(repo, owner);
    await comment(owner, repo, number);
    // Not before the minute after the window.
    vi.setSystemTime((window + 1) * windowMs + sealAfterMs - 1_000);
    await drain(repo.id);
    expect(await digestEvents(repo.id)).toEqual([]);
    pastSeal(window);
    await drain(repo.id);
    const [event, ...more] = await digestEvents(repo.id);
    expect(more).toEqual([]);
    const digest = event?.data?.digest as {
      key: string;
      window: number;
      subjects: string[];
      pages: { n: number; count: number }[];
      deadline: number;
    };
    expect(digest).toMatchObject({
      window,
      subjects: ["issue"],
      pages: [{ n: 1, count: 2 }],
      deadline: (window + 1) * windowMs + DIGEST_POLICY.deliveryMs,
    });
    // The members: its readers past the pushed tier, not the stranger nor the pushed.
    const [page] = await rows<{ recipients: string }>(
      repo.id,
      `SELECT recipients FROM feed_audience_pages WHERE event_key = '${digest.key}'`,
    );
    const members = JSON.parse(page?.recipients ?? "[]") as {
      principal: string;
      kinds: string[];
    }[];
    expect(members.map((m) => m.principal).sort()).toEqual(
      readers.map((r) => r.principalId).sort(),
    );
    expect(members.every((m) => m.kinds.join() === "issue")).toBe(true);
    expect(await windows(repo.id)).toEqual([{ subject: "issue", threads: 1, live: 1, sealed: 1 }]);
    // Sealed: a late event of the window keeps nothing more.
    await runInDurableObject(stubOf(repo.id), (instance: RepoDO) => {
      expect(
        instance.digests.record({
          subject: "issue",
          conversation: "late",
          number: 99,
          at: window * windowMs,
          actorRoot: null,
          floor: { revision: 1, principal: PUSHED.at(-1) ?? "" },
        }),
      ).toBe(false);
    });
  });

  it("lower a window's live count as its conversations are deleted, sealing nothing for none", async () => {
    const { owner, repo } = await digestRepo();
    const window = startWindow();
    const number = await funded(repo, owner);
    await comment(owner, repo, number);
    expect(await windows(repo.id)).toMatchObject([{ live: 1 }]);
    expect(
      (await api("DELETE", `/repos/${repo.fullName}/issues/${number}`, owner.token)).status,
    ).toBe(200);
    expect(await threads(repo.id)).toEqual([]);
    expect(await windows(repo.id)).toEqual([{ subject: "issue", threads: 1, live: 0, sealed: 0 }]);
    pastSeal(window);
    await drain(repo.id);
    expect(await digestEvents(repo.id)).toEqual([]);
    expect(await windows(repo.id)).toMatchObject([{ sealed: 1 }]);
  });

  it("wait while the repository cannot emit, spending no attempt, then seal", async () => {
    const { owner, repo } = await digestRepo();
    const window = startWindow();
    const number = await funded(repo, owner);
    await comment(owner, repo, number);
    // As a transfer freezes it.
    await runInDurableObject(stubOf(repo.id), (_: RepoDO, state) =>
      state.storage.sql.exec(
        "UPDATE repo_meta SET transfer_id = 'held', write_frozen = 1 WHERE id = 1",
      ),
    );
    pastSeal(window);
    // More waits than the job's attempts, each past the last one's wait.
    for (let i = 0; i < 12; i++) {
      await drain(repo.id, 3);
      const held = await job(repo.id, "digest_seal");
      expect(held).toMatchObject({ state: "queued", attempts: 0 });
      vi.setSystemTime((held?.next_run_at ?? Date.now()) + 1);
    }
    expect(await digestEvents(repo.id)).toEqual([]);
    await runInDurableObject(stubOf(repo.id), (_: RepoDO, state) =>
      state.storage.sql.exec(
        "UPDATE repo_meta SET transfer_id = NULL, write_frozen = 0 WHERE id = 1",
      ),
    );
    await drain(repo.id);
    expect(await digestEvents(repo.id)).toHaveLength(1);
  });

  it("discard what the switch turned off before its seal, and drop unused credit", async () => {
    const { owner, repo } = await digestRepo();
    const window = startWindow();
    const number = await funded(repo, owner);
    await comment(owner, repo, number);
    await runInDurableObject(stubOf(repo.id), (instance: RepoDO) => {
      instance.watchAudiences = false;
    });
    pastSeal(window);
    await drain(repo.id);
    expect(await digestEvents(repo.id)).toEqual([]);
    expect(await threads(repo.id)).toEqual([]);
    expect(await windows(repo.id)).toEqual([]);
    expect(await rows(repo.id, "SELECT * FROM digest_credit")).toEqual([]);
  });

  it("never seal a window of the generation before a restore, and clean it up", async () => {
    const { owner, repo } = await digestRepo();
    const window = startWindow();
    const number = await funded(repo, owner);
    await comment(owner, repo, number);
    // Restored as the runbook does: the directory takes the next generation, and the object
    // learns of it when it next starts.
    await env.DIRECTORY.prepare(
      "UPDATE source_epochs SET epoch_gen = epoch_gen + 1 WHERE source_id = ?",
    )
      .bind(repo.id)
      .run();
    await evictDurableObject(stubOf(repo.id));
    await runInDurableObject(stubOf(repo.id), (instance: RepoDO) => instance.checkEpoch());
    pastSeal(window);
    await drain(repo.id, 20);
    expect(await digestEvents(repo.id)).toEqual([]);
    expect(await threads(repo.id)).toEqual([]);
    expect(await windows(repo.id)).toEqual([]);
  });

  it("clean up an expired window with no further events, then rest", async () => {
    const { owner, repo } = await digestRepo();
    const window = startWindow();
    const number = await funded(repo, owner);
    await comment(owner, repo, number);
    pastSeal(window);
    await drain(repo.id);
    expect(await digestEvents(repo.id)).toHaveLength(1);
    // Kept until every item it made has expired: the job wakes for it alone.
    const kept = await job(repo.id, "digest_seal");
    expect(kept).toMatchObject({ state: "queued" });
    expect(kept?.next_run_at).toBe((window + 1) * windowMs + DIGEST_POLICY.keepMs);
    vi.setSystemTime((kept?.next_run_at ?? 0) + windowMs);
    await drain(repo.id);
    expect(await threads(repo.id)).toEqual([]);
    expect(await windows(repo.id)).toEqual([]);
    expect(await job(repo.id, "digest_seal")).toMatchObject({ state: "done" });
  });
});

describe("digest accumulation", () => {
  const FLOOR = { revision: 1, principal: PUSHED.at(-1) ?? "" };
  const entry = (over: Partial<DigestEntry> = {}): DigestEntry => ({
    subject: "issue",
    conversation: "c-1",
    number: 1,
    at: Date.now(),
    actorRoot: "usr_actor",
    floor: FLOOR,
    ...over,
  });

  /** Grants `units` of each kind's credit, for an hour, as the credit job would. */
  const fund = (
    instance: RepoDO,
    units: number,
    kinds: readonly FeedSubjectKind[] = ["issue", "pull"],
  ) =>
    instance.git.context.storage.transactionSync(() => {
      for (const kind of kinds)
        instance.git.context.storage.sql.exec(
          `INSERT INTO digest_credit (subject, epoch_gen, units, expires_at, wanted, pending,
             retry_at, refusals)
           VALUES (?, 0, 0, 0, 1, NULL, 0, 0)
           ON CONFLICT (subject) DO UPDATE SET wanted = 1, pending = NULL, retry_at = 0`,
          kind,
        );
      for (const ask of instance.digests.creditAsks())
        if (kinds.includes(ask.subject))
          expect(instance.digests.grant(ask, units, Date.now() + 3_600_000)).toBe(true);
    });

  it("spend each kind's own credit: one kind's activity leaves the other's untouched", async () => {
    const { repo } = await digestRepo(0);
    startWindow();
    await runInDurableObject(stubOf(repo.id), (instance: RepoDO) => {
      fund(instance, 10, ["issue"]);
      instance.git.context.storage.transactionSync(() => {
        // Pull requests have no credit: nothing kept, the issues' balance as it was.
        expect(instance.digests.record(entry({ subject: "pull", conversation: "p-1" }))).toBe(
          false,
        );
        expect(instance.digests.record(entry())).toBe(true);
      });
    });
    expect(await credit(repo.id)).toEqual([
      { subject: "issue", units: 10 - DIGEST_POLICY.bucketUnits },
    ]);
    expect(await windows(repo.id)).toEqual([{ subject: "issue", threads: 1, live: 1, sealed: 0 }]);
  });

  it("ask again after a refusal or a lost answer, installing only the kind's request of its generation", async () => {
    const { repo } = await digestRepo(0);
    startWindow();
    await runInDurableObject(stubOf(repo.id), (instance: RepoDO) => {
      const { digests } = instance;
      const tx = <T>(fn: () => T) => instance.git.context.storage.transactionSync(fn);
      const far = Date.now() + 3_600_000;
      // An event with no credit: nothing kept, the kind's credit wanted.
      expect(tx(() => digests.record(entry()))).toBe(false);
      const now = Date.now();
      const [first] = tx(() => digests.creditAsks());
      if (!first) throw new Error("no request");
      expect(first.subject).toBe("issue");
      // Asked: not again until its wait is over.
      expect(tx(() => digests.creditAsks())).toEqual([]);
      expect(digests.nextCreditDue()).toBe(now + 60_000);
      // Its answer lost: asked again by its own id once the wait is over, the wait doubling.
      tx(() => digests.unanswered(first));
      expect(digests.nextCreditDue()).toBe(now + 60_000);
      vi.setSystemTime(now + 60_000);
      const [again] = tx(() => digests.creditAsks());
      expect(again?.request).toBe(first.request);
      expect(digests.nextCreditDue()).toBe(now + 60_000 + 120_000);
      // Refused: a new request after the next wait.
      if (!again) throw new Error("no request");
      tx(() => digests.refused(again));
      expect(digests.nextCreditDue()).toBe(now + 60_000 + 120_000);
      vi.setSystemTime(now + 60_000 + 120_000);
      const [second] = tx(() => digests.creditAsks());
      if (!second) throw new Error("no request");
      expect(second.request).not.toBe(first.request);
      // The first request's late grant installs nothing; the second's does, and nothing is wanted.
      expect(tx(() => digests.grant(first, 200, far))).toBe(false);
      expect(tx(() => digests.grant(second, 200, far))).toBe(true);
      expect(digests.nextCreditDue()).toBeNull();
      // A request of an older generation installs nothing.
      const [third] = tx(() => {
        digests.dropCredit();
        digests.record(entry());
        return digests.creditAsks();
      });
      if (!third) throw new Error("no request");
      expect(tx(() => digests.grant({ ...third, epoch: third.epoch - 1 }, 200, far))).toBe(false);
      // Nor is credit spent past its end.
      expect(tx(() => digests.grant(third, 200, Date.now()))).toBe(true);
      expect(tx(() => digests.record(entry()))).toBe(false);
    });
  });

  it("ask the ledger again after it refuses, then spend what it grants", async () => {
    const { owner, repo } = await digestRepo();
    startWindow();
    // As the day's first refusal leaves the ledger (by the database's clock).
    const before = await env.ORG_READ.prepare(
      "SELECT refused_day, warn_until FROM discretionary_state WHERE id = 1",
    ).first<{ refused_day: number; warn_until: number }>();
    await env.ORG_READ.prepare(
      `INSERT INTO discretionary_state (id, refused_day, warn_until)
       VALUES (1, CAST(unixepoch() / 86400 AS INTEGER), 0)
       ON CONFLICT (id) DO UPDATE SET refused_day = excluded.refused_day`,
    ).run();
    try {
      await open(owner, repo);
      await drain(repo.id);
      expect(
        await rows(repo.id, "SELECT wanted, pending, refusals, units FROM digest_credit"),
      ).toEqual([{ wanted: 1, pending: null, refusals: 1, units: 0 }]);
      expect(await job(repo.id, "digest_credit")).toMatchObject({ state: "queued" });
    } finally {
      await (before
        ? env.ORG_READ.prepare(
            "UPDATE discretionary_state SET refused_day = ?, warn_until = ? WHERE id = 1",
          ).bind(before.refused_day, before.warn_until)
        : env.ORG_READ.prepare("DELETE FROM discretionary_state WHERE id = 1")
      ).run();
    }
    const retry = await job(repo.id, "digest_credit");
    vi.setSystemTime((retry?.next_run_at ?? 0) + 1);
    await drain(repo.id);
    expect(await credit(repo.id)).toEqual([{ subject: "issue", units: DIGEST_POLICY.creditBlock }]);
    expect(await job(repo.id, "digest_credit")).toMatchObject({ state: "done" });
  });

  it("spend no credit of an older generation (a restored balance)", async () => {
    const { repo } = await digestRepo(0);
    startWindow();
    await runInDurableObject(stubOf(repo.id), (instance: RepoDO, state) => {
      fund(instance, 200, ["issue"]);
      // As a restore leaves it: the balance of the generation before.
      state.storage.sql.exec("UPDATE digest_credit SET epoch_gen = epoch_gen - 1");
      expect(state.storage.transactionSync(() => instance.digests.record(entry()))).toBe(false);
    });
    expect(await threads(repo.id)).toEqual([]);
  });

  it("mark a bucket incomplete when its credit runs out, truncated past its threads", async () => {
    const { repo } = await digestRepo(0);
    startWindow();
    await runInDurableObject(stubOf(repo.id), (instance: RepoDO, state) => {
      const tx = <T>(fn: () => T) => state.storage.transactionSync(fn);
      fund(instance, DIGEST_POLICY.bucketUnits + 1, ["issue"]);
      expect(tx(() => instance.digests.record(entry({ conversation: "a" })))).toBe(true);
      expect(tx(() => instance.digests.record(entry({ conversation: "b" })))).toBe(true);
      expect(tx(() => instance.digests.record(entry({ conversation: "c" })))).toBe(false);
      fund(instance, DIGEST_POLICY.maxThreads + 10, ["pull"]);
      tx(() => {
        for (let i = 0; i < DIGEST_POLICY.maxThreads; i++)
          instance.digests.record(entry({ subject: "pull", conversation: `p-${i}`, number: i }));
        expect(instance.digests.record(entry({ subject: "pull", conversation: "past" }))).toBe(
          false,
        );
        // A thread it has is still kept.
        expect(instance.digests.record(entry({ subject: "pull", conversation: "p-0" }))).toBe(true);
      });
    });
    expect(
      await rows(
        repo.id,
        "SELECT subject, threads, truncated, incomplete FROM digest_windows ORDER BY subject",
      ),
    ).toEqual([
      { subject: "issue", threads: 2, truncated: 0, incomplete: 1 },
      { subject: "pull", threads: DIGEST_POLICY.maxThreads, truncated: 1, incomplete: 0 },
    ]);
  });

  it("tell each kind's members past its own lowest floor", async () => {
    const { readers, repo } = await digestRepo(1);
    startWindow();
    await runInDurableObject(stubOf(repo.id), (instance: RepoDO, state) => {
      fund(instance, 100);
      const window = windowOf(Date.now());
      // Pull requests' floor was lower (the 50th pushed watcher) when one of them happened.
      const lower = { revision: 1, principal: PUSHED[49] ?? "" };
      state.storage.transactionSync(() => {
        instance.digests.record(entry());
        instance.digests.record(entry({ subject: "pull", conversation: "p", floor: FLOOR }));
        instance.digests.record(entry({ subject: "pull", conversation: "q", floor: lower }));
      });
      const members = instance.digests.members(
        instance.digests.liveBuckets(window),
        (floor, limit) => instance.watching.after(floor, limit),
        (principal) => principal !== STRANGER,
      );
      const kinds = Object.fromEntries(members.map((m) => [m.principal, m.kinds.join()]));
      expect(kinds[PUSHED[50] ?? ""]).toBe("pull");
      expect(kinds[PUSHED[99] ?? ""]).toBe("pull");
      expect(kinds[PUSHED[49] ?? ""]).toBeUndefined();
      expect(kinds[readers[0]?.principalId ?? ""]).toBe("issue,pull");
      expect(kinds[STRANGER]).toBeUndefined();
      // The 50 pushed past the lower floor, and the reader.
      expect(members).toHaveLength(51);
    });
  });

  it("tell no one because of a deleted conversation's events (the floor of what is left)", async () => {
    const { readers, repo } = await digestRepo(1);
    startWindow();
    await runInDurableObject(stubOf(repo.id), (instance: RepoDO, state) => {
      fund(instance, 100, ["issue"]);
      const window = windowOf(Date.now());
      // The deleted conversation's event happened while the 50th watcher was the last pushed.
      const lower = { revision: 1, principal: PUSHED[49] ?? "" };
      state.storage.transactionSync(() => {
        instance.digests.record(entry({ conversation: "gone", floor: lower }));
        instance.digests.record(entry({ conversation: "kept" }));
      });
      const told = () =>
        instance.digests
          .members(
            instance.digests.liveBuckets(window),
            (floor, limit) => instance.watching.after(floor, limit),
            () => true,
          )
          .map((m) => m.principal);
      expect(told()).toContain(PUSHED[50]);
      state.storage.transactionSync(() => instance.digests.forgetConversation("gone", "issue"));
      expect(told().sort()).toEqual([readers[0]?.principalId, STRANGER].sort());
    });
  });

  it("decide each kind's members on its own, whatever the other's floor (past the cap, after a restore)", async () => {
    const { repo } = await digestRepo(0);
    startWindow();
    // More watchers than a kind's members (a restore can bring back more than the cap).
    const ids = Array.from(
      { length: DIGEST_POLICY.maxMembers + 200 },
      (_, i) => `w${String(i).padStart(5, "0")}`,
    );
    const after = (floor: { principal: string }, limit: number) =>
      ids
        .filter((id) => id > floor.principal)
        .slice(0, limit)
        .map((principal) => ({ principal, root: principal }));
    await runInDurableObject(stubOf(repo.id), (instance: RepoDO, state) => {
      fund(instance, 100);
      state.storage.transactionSync(() => {
        instance.digests.record(entry({ floor: { revision: 1, principal: "w00100" } }));
        instance.digests.record(
          entry({
            subject: "pull",
            conversation: "p",
            floor: { revision: 1, principal: "w00050" },
          }),
        );
      });
      const members = instance.digests.members(
        instance.digests.liveBuckets(windowOf(Date.now())),
        after,
        () => true,
      );
      const kinds = new Map(members.map((m) => [m.principal, m.kinds.join()]));
      const of = (kind: string) => members.filter((m) => m.kinds.includes(kind as "issue"));
      expect(of("issue")).toHaveLength(DIGEST_POLICY.maxMembers);
      expect(of("pull")).toHaveLength(DIGEST_POLICY.maxMembers);
      expect(kinds.get("w00060")).toBe("pull");
      expect(kinds.get("w00200")).toBe("issue,pull");
      expect(kinds.get(`w${String(DIGEST_POLICY.maxMembers + 100).padStart(5, "0")}`)).toBe(
        "issue",
      );
    });
  });

  it("seal at most a run's windows an invocation, the rest in the next", async () => {
    const { repo } = await digestRepo(1);
    const now = startWindow();
    await runInDurableObject(stubOf(repo.id), (instance: RepoDO, state) => {
      fund(instance, 100, ["issue"]);
      state.storage.transactionSync(() => {
        for (let w = now - 6; w < now - 1; w++)
          instance.digests.record(entry({ at: w * windowMs + 1, conversation: `c-${w}` }));
        instance.git.jobs.ensure("digest_seal", "digest_seal");
      });
    });
    await runDurableObjectAlarm(stubOf(repo.id));
    expect(await digestEvents(repo.id)).toHaveLength(DIGEST_POLICY.sealsPerRun);
    await runDurableObjectAlarm(stubOf(repo.id));
    expect(await digestEvents(repo.id)).toHaveLength(5);
  });

  it("delete a discarded window's threads a slice an invocation", async () => {
    const { repo } = await digestRepo(0);
    const window = startWindow();
    await runInDurableObject(stubOf(repo.id), (instance: RepoDO, state) => {
      fund(instance, 1_000, ["issue"]);
      state.storage.transactionSync(() => {
        for (let i = 0; i < DIGEST_POLICY.sliceRows + 100; i++)
          instance.digests.record(entry({ conversation: `c-${i}`, number: i + 1 }));
        instance.git.jobs.ensure("digest_seal", "digest_seal");
      });
      instance.watchAudiences = false;
    });
    pastSeal(window);
    await runDurableObjectAlarm(stubOf(repo.id));
    expect(await threads(repo.id)).toHaveLength(100);
    expect(await windows(repo.id)).toMatchObject([{ sealed: 2 }]);
    await drain(repo.id);
    expect(await threads(repo.id)).toEqual([]);
    expect(await windows(repo.id)).toEqual([]);
  });

  it("count nothing of a deleted conversation whose rows are still being deleted", async () => {
    const { readers, repo } = await digestRepo(1);
    const now = startWindow();
    // One conversation active in more windows than its deletion deletes at once: its two newest
    // windows' rows are left, one of them shared with a conversation that survives it.
    const windowsBack = DIGEST_POLICY.forgetInTransaction + 2;
    const [alone, shared] = [now - 3, now - 2];
    const lower = { revision: 1, principal: PUSHED[49] ?? "" };
    await runInDurableObject(stubOf(repo.id), (instance: RepoDO, state) => {
      fund(instance, 5 * windowsBack + 10, ["issue"]);
      state.storage.transactionSync(() => {
        for (let w = now - windowsBack - 1; w < now - 1; w++)
          instance.digests.record(
            entry({ at: w * windowMs + 1, conversation: "gone", floor: lower }),
          );
        instance.digests.record(entry({ at: shared * windowMs + 2, conversation: "kept" }));
        expect(instance.digests.forgetConversation("gone", "issue")).toBe(true);
      });
      const told = (window: number) =>
        instance.digests
          .members(
            instance.digests.liveBuckets(window),
            (floor, limit) => instance.watching.after(floor, limit),
            () => true,
          )
          .map((m) => m.principal)
          .sort();
      expect(instance.digests.liveBuckets(alone)).toEqual([]);
      expect(told(shared)).toEqual([readers[0]?.principalId, STRANGER].sort());
      // The windows before them sealed already: what is due is sealed while the rows are left.
      state.storage.transactionSync(() => {
        state.storage.sql.exec("UPDATE digest_windows SET sealed = 1 WHERE win < ?", alone);
        instance.git.jobs.ensure("digest_seal", "digest_seal");
      });
    });
    await runDurableObjectAlarm(stubOf(repo.id));
    expect(await digestEvents(repo.id)).toHaveLength(1);
    await drain(repo.id);
    expect(await rows(repo.id, "SELECT * FROM digest_forgets")).toEqual([]);
    expect(await threads(repo.id)).toEqual([{ subject: "issue", number: 1 }]);
  });

  it("clean up a bucket an invocation however small", async () => {
    const { repo } = await digestRepo(0);
    const now = startWindow();
    await runInDurableObject(stubOf(repo.id), (instance: RepoDO, state) => {
      fund(instance, 100, ["issue"]);
      state.storage.transactionSync(() => {
        for (let w = now - 4; w < now - 1; w++)
          for (let i = 0; i < 5; i++)
            instance.digests.record(entry({ at: w * windowMs + 1, conversation: `c-${w}-${i}` }));
        instance.git.jobs.ensure("digest_seal", "digest_seal");
      });
      instance.watchAudiences = false;
    });
    await runDurableObjectAlarm(stubOf(repo.id));
    expect(await windows(repo.id)).toHaveLength(2);
    await runDurableObjectAlarm(stubOf(repo.id));
    expect(await windows(repo.id)).toHaveLength(1);
    await drain(repo.id);
    expect(await windows(repo.id)).toEqual([]);
    expect(await job(repo.id, "digest_seal")).toMatchObject({ state: "done" });
  });

  it("cost no more than its credit's price: rows written and read a unit", async () => {
    const { repo } = await digestRepo(0);
    startWindow();
    await runInDurableObject(stubOf(repo.id), (instance: RepoDO, state) => {
      fund(instance, 200, ["issue"]);
      const measure = (e: DigestEntry) => {
        const counting = countingExec(state.storage.sql);
        state.storage.transactionSync(() => instance.digests.record(e));
        return counting.stop();
      };
      const bucket = measure(entry({ conversation: "a" }));
      const thread = measure(entry({ conversation: "b" }));
      const again = measure(entry({ conversation: "b", actorRoot: "usr_other" }));
      for (let i = 0; i < 48; i++) measure(entry({ conversation: `c-${i}` }));
      // Whether the bucket is live reads a thread or so, not all of them.
      const looking = countingExec(state.storage.sql);
      expect(instance.digests.liveBuckets(windowOf(Date.now()))).toHaveLength(1);
      expect(looking.stop().read).toBeLessThanOrEqual(5);
      // Their later deletion: 50 threads and their bucket, by cleanup.
      state.storage.transactionSync(() => instance.digests.discard(windowOf(Date.now())));
      const counting = countingExec(state.storage.sql);
      expect(state.storage.transactionSync(() => instance.digests.cleanupStep())).toBe(true);
      expect(instance.digests.nextDue()).not.toBe(Date.now());
      const deletion = counting.stop();
      // Each unit priced at 8 rows written and 12 read, its share of the deletion included
      // (measured: a new thread 5 read and 6 written; its deletion's share 6 and 2).
      const share = {
        read: Math.ceil(deletion.read / 50),
        written: Math.ceil(deletion.written / 50),
      };
      expect(bucket.written + share.written).toBeLessThanOrEqual(8 * DIGEST_POLICY.bucketUnits);
      expect(Math.max(thread.written, again.written) + share.written).toBeLessThanOrEqual(
        8 * DIGEST_POLICY.threadUnits,
      );
      expect(bucket.read + share.read).toBeLessThanOrEqual(12 * DIGEST_POLICY.bucketUnits);
      expect(Math.max(thread.read, again.read) + share.read).toBeLessThanOrEqual(
        12 * DIGEST_POLICY.threadUnits,
      );
    });
  });
});
