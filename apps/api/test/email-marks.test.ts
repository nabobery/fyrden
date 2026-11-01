// Which email an event makes for each recipient, decided by the repository
// from all of that recipient's contributions and carried on exactly one of
// its entries: so a recipient's settled requests, a later page, or an
// unread thread never hide the email the event makes.

import { env } from "cloudflare:workers";
import type { DomainEvent, FeedBlock, FeedRecipient } from "@fyrden/domain";
import { uniqueId } from "@fyrden/testing";
import { beforeEach, describe, expect, it } from "vitest";
import type { RepoDO } from "../src/do/RepoDO.js";
import { markEmail } from "../src/do/repo/feed.js";
import { api, json, user, type Who } from "./helpers/api.js";
import { inRepo } from "./helpers/repo-git.js";

let owner: Who;
let writer: Who;
let reader: Who;
let path: string;
let repoId: string;

const sourceSeq = () =>
  inRepo(
    env.REPO.getByName(repoId),
    (r: RepoDO) =>
      r.git.context.storage.sql
        .exec<{ s: number | null }>("SELECT max(source_seq) AS s FROM outbox")
        .one().s ?? 0,
  );

/** The feed blocks of the outbox's events since `from`. */
const blocks = async (from: number) =>
  (
    await inRepo(env.REPO.getByName(repoId), (r: RepoDO) =>
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

/** Each recipient's marks in a block, as `principal:category:reason`. */
const marks = (block: FeedBlock | undefined) =>
  (block?.audience ?? [])
    .filter((a) => a.email)
    .map((a) => `${a.principal}:${a.email?.category}:${a.email?.reason}`)
    .sort();

beforeEach(async () => {
  owner = await user();
  const repo = (
    await json<{ id: string; name: string }>(
      api("POST", "/user/repos", owner.token, { name: uniqueId("r"), auto_init: true }),
    )
  ).body;
  repoId = repo.id;
  path = `/repos/${owner.handle}/${repo.name}`;
  [writer, reader] = [await user(), await user()];
  for (const [who, permission] of [
    [writer, "push"],
    [reader, "pull"],
  ] as const)
    expect(
      (await api("PUT", `${path}/collaborators/${who.handle}`, owner.token, { permission })).status,
    ).toBe(200);
  expect((await api("POST", `${path}/issues`, owner.token, { title: "A bug" })).status).toBe(201);
});

describe("an event's email for each recipient", () => {
  it("is direct for a mention, participating for a comment on a thread taken part in", async () => {
    const from = await sourceSeq();
    await api("POST", `${path}/issues/1/comments`, writer.token, {
      body: `@${reader.handle} have a look`,
    });
    expect(marks((await blocks(from))[0])).toEqual(
      [`${reader.principalId}:direct:mention`, `${owner.principalId}:participating:author`].sort(),
    );
  });

  it("is direct for an author whose issue another closed, and none for the actor", async () => {
    const from = await sourceSeq();
    await api("PATCH", `${path}/issues/1`, writer.token, { state: "closed" });
    const [closed] = await blocks(from);
    expect(marks(closed)).toEqual([`${owner.principalId}:direct:author`]);
    // The actor's own entries (silent) carry none.
    expect(closed?.audience.filter((a) => a.principal === writer.principalId && a.email)).toEqual(
      [],
    );
  });

  it("is direct for an assignment, carried once whatever else the event tells the recipient", async () => {
    await api("POST", `${path}/issues/1/comments`, reader.token, { body: "me too" });
    const from = await sourceSeq();
    await api("POST", `${path}/issues/1/assignees`, owner.token, { assignees: [reader.handle] });
    const [assigned] = await blocks(from);
    const readers = assigned?.audience.filter((a) => a.principal === reader.principalId) ?? [];
    expect(readers.filter((a) => a.email)).toEqual([
      expect.objectContaining({ email: { category: "direct", reason: "assign" } }),
    ]);
  });
});

describe("the mark", () => {
  const entry = (
    principal: string,
    kind: FeedRecipient["kind"],
    reasons: string[],
    state: "open" | "resolved" = "open",
    silent = false,
  ): FeedRecipient => ({ principal, kind, reasons, priority: "P1", state, silent });

  it("goes on a recipient's first entry, folded from all of them, before any is paged", () => {
    const audience = [
      entry("a", "approved", ["author"], "resolved"),
      ...Array.from({ length: 99 }, (_, i) => entry(`p${i}`, "activity", ["commenter"])),
      // The 101st: paged, yet folded into the first entry's mark.
      entry("a", "activity", ["author"]),
    ];
    markEmail(audience, "closed");
    expect(audience[0]?.email).toEqual({ category: "direct", reason: "author" });
    expect(audience[100]?.email).toBeUndefined();
    expect(audience[1]?.email).toEqual({ category: "participating", reason: "comment" });
  });

  it("is none for what only settles, the recipient's own action, or watching", () => {
    const audience = [
      entry("settled", "review_requested", ["requested_reviewer"], "resolved"),
      entry("self", "activity", ["author"], "open", true),
      entry("watcher", "activity", ["watching"]),
    ];
    markEmail(audience, "comment");
    expect(audience.filter((a) => a.email)).toEqual([]);
  });

  it("names the strongest reason among the contributions that make email", () => {
    const audience = [
      entry("a", "activity", ["commenter"]),
      entry("a", "review_requested", ["requested_team"]),
    ];
    markEmail(audience, "review_requested");
    expect(audience[0]?.email).toEqual({ category: "direct", reason: "review_requested" });
  });
});
