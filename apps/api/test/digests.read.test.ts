// Digests, read: what a digest item tells of is resolved when it is read,
// for its reader, as the repository is then. Newest first, at most 50
// threads the reader may see: a conversation the repository still has,
// that the reader did not unsubscribe from, and that someone besides the
// reader took part in; nothing it may not see decides what or how much is
// answered. Decided as the item is (404 when not readable or not shown).

import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { RepoDO } from "../src/do/RepoDO.js";
import { DIGEST_POLICY } from "../src/do/repo/digests.js";
import { api, json, user, type Who } from "./helpers/api.js";
import {
  digestRepo,
  drain,
  open,
  PUSHED,
  pastSeal,
  type Repo,
  startWindow,
  stubOf,
} from "./helpers/digests.js";
import { scopedToken } from "./helpers/principals.js";

type Answer = {
  repo: { id: string; full_name: string };
  subject: string;
  window: number;
  threads: {
    number: number;
    title: string;
    last_activity_at: number;
    actors: string[];
    more_actors: boolean;
  }[];
  complete: boolean;
  code?: string;
};

/** A thread of the window: an issue's number and who acted on it, in order, `at` ms in. */
type Told = { number: number; actors: (string | null)[]; at: number };

/**
 * Records `told` in a window by hand (credit given), as the repository's
 * events would, and seals it: its window and generation.
 */
async function sealedWith(repo: Repo, told: readonly Told[], prepare?: (r: RepoDO) => void) {
  const window = startWindow();
  const epoch = await runInDurableObject(stubOf(repo.id), (instance: RepoDO, state) => {
    state.storage.transactionSync(() => {
      state.storage.sql.exec(
        `INSERT INTO digest_credit (subject, epoch_gen, units, expires_at, wanted, pending,
           retry_at, refusals)
         VALUES ('issue', ?1, 10000, ?2, 0, NULL, 0, 0)
         ON CONFLICT (subject) DO UPDATE SET epoch_gen = ?1, units = 10000, expires_at = ?2,
           wanted = 0, pending = NULL`,
        instance.events.epochGen(),
        Date.now() + 3_600_000,
      );
      for (const t of told)
        for (const actorRoot of t.actors) {
          const subject = instance.threads.subjectOf(t.number);
          if (!subject) throw new Error(`no conversation ${t.number}`);
          instance.digests.record({
            subject: "issue",
            conversation: subject.conversation,
            number: t.number,
            at: window * DIGEST_POLICY.windowMs + t.at,
            actorRoot,
            floor: { revision: 1, principal: PUSHED.at(-1) ?? "" },
          });
        }
      prepare?.(instance);
      instance.git.jobs.ensure("digest_seal", "digest_seal");
    });
    return instance.events.epochGen();
  });
  pastSeal(window);
  await drain(repo.id);
  return { window, epoch };
}

const read = (who: Who, repoId: string, window: number, epoch: number, token = who.token) =>
  json<Answer>(api("GET", `/feed/digests/${repoId}/issue/${window}/${epoch}`, token));

/** Opens issues titled `T<i>` as `who`; their numbers. */
async function issues(who: Who, repo: Repo, n: number) {
  const numbers: number[] = [];
  for (let i = 0; i < n; i++) numbers.push(await open(who, repo, `T${i}`));
  return numbers;
}

describe("a digest's threads", () => {
  it("are read newest first, with titles as they are now and actors as logins", async () => {
    const { owner, readers, repo } = await digestRepo(1);
    const reader = readers[0] as Who;
    const [a, b] = (await issues(owner, repo, 2)) as [number, number];
    const { window, epoch } = await sealedWith(repo, [
      { number: a, actors: [owner.principalId, reader.principalId], at: 1_000 },
      { number: b, actors: [owner.principalId], at: 2_000 },
    ]);
    await api("PATCH", `/repos/${repo.fullName}/issues/${a}`, owner.token, { title: "Renamed" });
    const answer = await read(reader, repo.id, window, epoch);
    expect(answer).toMatchObject({
      status: 200,
      body: {
        repo: { id: repo.id, full_name: repo.fullName },
        subject: "issue",
        window,
        complete: true,
      },
    });
    expect(answer.body.threads).toEqual([
      {
        number: b,
        title: "T1",
        last_activity_at: window * DIGEST_POLICY.windowMs + 2_000,
        actors: [owner.handle],
        more_actors: false,
      },
      {
        number: a,
        title: "Renamed",
        last_activity_at: window * DIGEST_POLICY.windowMs + 1_000,
        actors: [owner.handle, reader.handle],
        more_actors: false,
      },
    ]);
  });

  it("leave out what the reader may not see, answering as if it never was", async () => {
    // One history: two threads others took part in, under more than a page of threads the reader
    // may not see, newer (its own only, unsubscribed, deleted, being deleted).
    const { owner, readers, repo } = await digestRepo(1);
    const reader = readers[0] as Who;
    const kept = [await open(owner, repo, "K0"), await open(owner, repo, "K1")];
    const own = await issues(owner, repo, 50);
    const [unsubscribed, deleted, forgetting] = (await issues(owner, repo, 3)) as [
      number,
      number,
      number,
    ];
    expect(
      (
        await api(
          "PUT",
          `/repos/${repo.fullName}/issues/${unsubscribed}/subscription`,
          reader.token,
          {
            ignored: true,
          },
        )
      ).status,
    ).toBe(200);
    const { window, epoch } = await sealedWith(repo, [
      { number: kept[0] as number, actors: [owner.principalId], at: 1_000 },
      { number: kept[1] as number, actors: [owner.principalId, null], at: 2_000 },
      ...own.map((number, i) => ({ number, actors: [reader.principalId], at: 3_000 + i })),
      { number: unsubscribed, actors: [owner.principalId], at: 4_000 },
      { number: deleted, actors: [owner.principalId], at: 4_001 },
      { number: forgetting, actors: [owner.principalId], at: 4_002 },
    ]);
    // A deletion whose rows are still being deleted (once sealed: cleanup would finish it).
    await runInDurableObject(stubOf(repo.id), (r: RepoDO, state) =>
      state.storage.sql.exec(
        "INSERT INTO digest_forgets (conversation, subject) VALUES (?, 'issue')",
        r.threads.subjectOf(forgetting)?.conversation,
      ),
    );
    expect(
      (await api("DELETE", `/repos/${repo.fullName}/issues/${deleted}`, owner.token)).status,
    ).toBe(200);
    // The other history: the two threads alone.
    const alone = await digestRepo(1);
    const aloneKept = [
      await open(alone.owner, alone.repo, "K0"),
      await open(alone.owner, alone.repo, "K1"),
    ];
    const single = await sealedWith(alone.repo, [
      { number: aloneKept[0] as number, actors: [alone.owner.principalId], at: 1_000 },
      { number: aloneKept[1] as number, actors: [alone.owner.principalId, null], at: 2_000 },
    ]);
    const normalized = (answer: Answer, ownerLogin: string) => ({
      complete: answer.complete,
      threads: answer.threads.map(({ number: _, actors, ...rest }) => ({
        ...rest,
        last_activity_at: rest.last_activity_at % DIGEST_POLICY.windowMs,
        actors: actors.map((a) => (a === ownerLogin ? "owner" : a)),
      })),
    });
    const answer = (await read(reader, repo.id, window, epoch)).body;
    const answerAlone = (
      await read(alone.readers[0] as Who, alone.repo.id, single.window, single.epoch)
    ).body;
    expect(answer.threads.map((t) => t.title)).toEqual(["K1", "K0"]);
    expect(normalized(answer, owner.handle)).toEqual(normalized(answerAlone, alone.owner.handle));
  });

  it("are at most 50, and say when more are left or the window was cut short", async () => {
    const { owner, readers, repo } = await digestRepo(1);
    const reader = readers[0] as Who;
    const numbers = await issues(owner, repo, 51);
    const told = numbers.map((number, i) => ({ number, actors: [owner.principalId], at: i + 1 }));
    const all = await sealedWith(repo, told);
    const answer = await read(reader, repo.id, all.window, all.epoch);
    expect(answer.body.threads).toHaveLength(50);
    expect(answer.body.threads[0]?.number).toBe(numbers.at(-1));
    expect(answer.body.complete).toBe(false);
    // Fifty and a window truncated: not complete either.
    const cut = await sealedWith(repo, told.slice(1), (r) =>
      r.git.context.storage.sql.exec("UPDATE digest_windows SET truncated = 1 WHERE sealed = 0"),
    );
    expect((await read(reader, repo.id, cut.window, cut.epoch)).body).toMatchObject({
      complete: false,
    });
    expect((await read(reader, repo.id, cut.window, cut.epoch)).body.threads).toHaveLength(50);
  });

  it("are not found for one who cannot read them, nor once the digest no longer shows", async () => {
    const { owner, readers, repo } = await digestRepo(1);
    const reader = readers[0] as Who;
    const [number] = (await issues(owner, repo, 1)) as [number];
    const { window, epoch } = await sealedWith(repo, [
      { number, actors: [owner.principalId], at: 1_000 },
    ]);
    expect((await read(reader, repo.id, window, epoch)).status).toBe(200);
    const stranger = await user();
    expect(await read(stranger, repo.id, window, epoch)).toMatchObject({
      status: 404,
      body: { code: "feed_digest_not_found" },
    });
    // A token that reads pull requests only.
    const pullsOnly = await scopedToken(reader.principalId, [
      "pull_requests:read",
      "metadata:read",
    ]);
    expect((await read(reader, repo.id, window, epoch, pullsOnly)).status).toBe(404);
    // Another generation's, or a window never sealed.
    expect((await read(reader, repo.id, window, epoch + 1)).status).toBe(404);
    expect((await read(reader, repo.id, window + 1, epoch)).status).toBe(404);
    // Judged again by the repository: another ownership than the one decided, nothing.
    const asked = { subject: "issue" as const, window, epoch };
    expect(
      await stubOf(repo.id).feedDigest(
        reader.principalId,
        null,
        { accountId: "acc_other", ownerGen: 0 },
        asked,
        50,
      ),
    ).toEqual({ status: "gone" });
    // While the repository takes its issue preferences back after a restore: try again.
    await runInDurableObject(stubOf(repo.id), (_: RepoDO, state) =>
      state.storage.sql.exec(
        "INSERT INTO preference_recovery (grp, target_epoch, phase, cursor) VALUES ('issues', 1, 'clear', NULL)",
      ),
    );
    expect(await read(reader, repo.id, window, epoch)).toMatchObject({
      status: 503,
      body: { code: "preferences_recovering" },
    });
    await runInDurableObject(stubOf(repo.id), (_: RepoDO, state) =>
      state.storage.sql.exec("DELETE FROM preference_recovery"),
    );
    // Its last conversation deleted.
    expect(
      (await api("DELETE", `/repos/${repo.fullName}/issues/${number}`, owner.token)).status,
    ).toBe(200);
    expect((await read(reader, repo.id, window, epoch)).status).toBe(404);
  });
});
