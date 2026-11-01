// A thread's participants for activity feeds: up to a cap a thread, joins
// past it counted rather than silently ignored, those named directly told
// whatever the cap, and the participants read in the order they joined.
import { env } from "cloudflare:workers";
import type { DomainEvent, FeedBlock } from "@fyrden/domain";
import { uniqueId } from "@fyrden/testing";
import { beforeEach, describe, expect, it } from "vitest";
import type { RepoDO } from "../src/do/RepoDO.js";
import { MAX_PARTICIPANTS, PARTICIPANTS_PAGE } from "../src/do/repo/feed.js";
import { api, json, user, type Who } from "./helpers/api.js";
import { inRepo } from "./helpers/repo-git.js";

let owner: Who;
let repo: { id: string; name: string };
let path: string;

const stub = () => env.REPO.getByName(repo.id);
const fake = (i: number) => `usr_fake${String(i).padStart(4, "0")}`;

/** The feed blocks of the outbox's events since `from`. */
const blocks = async (from: number) =>
  (
    await inRepo(stub(), (r: RepoDO) =>
      r.git.context.storage.sql
        .exec<{ event: string }>(
          "SELECT event FROM outbox WHERE source_seq > ? ORDER BY source_seq",
          from,
        )
        .toArray()
        .map((row) => JSON.parse(row.event) as DomainEvent),
    )
  )
    .filter((e) => e.feed)
    .map((e) => e.feed as FeedBlock);
const seq = () =>
  inRepo(
    stub(),
    (r: RepoDO) =>
      r.git.context.storage.sql
        .exec<{ s: number | null }>("SELECT max(source_seq) AS s FROM outbox")
        .one().s ?? 0,
  );
const participation = () =>
  inRepo(stub(), (r: RepoDO) =>
    r.git.context.storage.sql
      .exec<{ participants: number; overflow: number }>(
        "SELECT participants, overflow FROM feed_participation WHERE number = 1",
      )
      .one(),
  );
const isParticipant = (principal: string) =>
  inRepo(
    stub(),
    (r: RepoDO) =>
      r.git.context.storage.sql
        .exec("SELECT 1 FROM feed_participants WHERE number = 1 AND principal = ?", principal)
        .toArray().length > 0,
  );

/**
 * Fills issue 1's participants up to the cap with principals made up here,
 * who read the repository: its object holds it public (repositories are
 * made private, and these principals hold no grant).
 */
async function fillParticipants(visibility: "public" | "private" = "public") {
  await inRepo(stub(), (r: RepoDO) => {
    const sql = r.git.context.storage.sql;
    sql.exec("UPDATE repo_meta SET visibility = ?", visibility);
    const { participants, next_seq } = sql
      .exec<{ participants: number; next_seq: number }>(
        "SELECT participants, next_seq FROM feed_participation WHERE number = 1",
      )
      .one();
    for (let i = 0; i < MAX_PARTICIPANTS - participants; i++)
      sql.exec(
        `INSERT INTO feed_participants (number, principal, root, reason, joined_seq)
         VALUES (1, ?1, ?1, 'commenter', ?2)`,
        fake(i),
        next_seq + i,
      );
    sql.exec(
      "UPDATE feed_participation SET participants = ?1, next_seq = ?2 WHERE number = 1",
      MAX_PARTICIPANTS,
      next_seq + MAX_PARTICIPANTS - participants,
    );
  });
}

const comment = (who: Who, body: string) =>
  api("POST", `${path}/issues/1/comments`, who.token, { body });

/** A user who reads the repository (and so may comment on its issues). */
async function reader(): Promise<Who> {
  const who = await user();
  const set = await api("PUT", `${path}/collaborators/${who.handle}`, owner.token, {
    permission: "pull",
  });
  expect(set.status).toBe(200);
  return who;
}

beforeEach(async () => {
  owner = await user();
  repo = (
    await json<{ id: string; name: string }>(
      api("POST", "/user/repos", owner.token, { name: uniqueId("r") }),
    )
  ).body;
  path = `/repos/${owner.handle}/${repo.name}`;
  expect((await api("POST", `${path}/issues`, owner.token, { title: "Busy" })).status).toBe(201);
});

describe("thread participants", () => {
  it("are kept up to the cap, joins past it counted, not repeats of those already in", async () => {
    expect(MAX_PARTICIPANTS).toBe(1_000);
    await fillParticipants();
    const late = await reader();
    expect((await comment(late, "Me too")).status).toBe(201);
    expect(await isParticipant(late.principalId)).toBe(false);
    expect(await participation()).toEqual({ participants: MAX_PARTICIPANTS, overflow: 1 });
    // Each join refused counts; one already in counts nothing.
    expect((await comment(late, "Still me")).status).toBe(201);
    expect((await comment(owner, "Noted")).status).toBe(201);
    expect(await participation()).toEqual({ participants: MAX_PARTICIPANTS, overflow: 2 });
  });

  it("tell one mentioned past the cap, though it does not join", async () => {
    await fillParticipants();
    const named = await reader();
    const from = await seq();
    expect((await comment(owner, `Over to @${named.handle}`)).status).toBe(201);
    const [block] = await blocks(from);
    const mentions = (block?.audience ?? []).filter((a) => a.kind === "mention");
    expect(mentions.map((a) => a.principal)).toEqual([named.principalId]);
    // Things to act on first, then participants in the order they joined.
    expect(block?.audience[0]?.principal).toBe(named.principalId);
    expect(block?.audience.slice(1, 4).map((a) => a.principal)).toEqual([
      fake(0),
      fake(1),
      fake(2),
    ]);
    expect(await isParticipant(named.principalId)).toBe(false);
  });

  it("are read in the order they joined through an index", async () => {
    const plan = await inRepo(stub(), (r: RepoDO) =>
      r.git.context.storage.sql
        .exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${PARTICIPANTS_PAGE}`, 1, 0, 200)
        .toArray()
        .map((row) => row.detail),
    );
    expect(plan).toEqual([expect.stringMatching(/USING INDEX feed_participants_joined /)]);
  });

  it("give the places of those who no longer read the repository to those who do", async () => {
    // Made up, these principals hold no grant on the private repository.
    await fillParticipants("private");
    const late = await reader();
    expect((await comment(late, "Me too")).status).toBe(201);
    expect(await isParticipant(late.principalId)).toBe(true);
    expect(await isParticipant(fake(0))).toBe(false);
    // The owner (the issue's author) and the newcomer.
    expect(await participation()).toEqual({ participants: 2, overflow: 0 });
  });

  it("decide an audience of the cap's participants from one read of who reads the repository", async () => {
    await fillParticipants();
    const counted = { n: 0 };
    await inRepo(stub(), (r: RepoDO) => {
      const sql = r.git.context.storage.sql;
      const exec = sql.exec.bind(sql);
      (sql as { exec: typeof sql.exec }).exec = ((...args: Parameters<typeof sql.exec>) => {
        counted.n++;
        return exec(...args);
      }) as typeof sql.exec;
    });
    expect((await comment(owner, "Thanks, all")).status).toBe(201);
    // Every statement of the comment's change, its 1,000-participant audience included.
    expect(counted.n).toBeGreaterThan(0);
    expect(counted.n).toBeLessThan(150);
  });

  it("are forgotten, with their count, when their issue is deleted", async () => {
    expect((await api("DELETE", `${path}/issues/1`, owner.token)).status).toBe(200);
    const left = await inRepo(stub(), (r: RepoDO) =>
      r.git.context.storage.sql
        .exec("SELECT number FROM feed_participation WHERE number = 1")
        .toArray(),
    );
    expect(left).toEqual([]);
  });
});
