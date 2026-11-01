// A ranked search's admission, decided with its ranking in one statement:
// each clause charged what its index's vocabulary says its terms cover
// (`cnt`, as often as each is written; a prefix's every term, refused past
// a thousand; a generated filter's every token), bounded a clause and the
// whole; a query refused ranks nothing, and a write before the statement is
// what it decides on. Its candidates are the index's best by rank, at most
// the most a search takes, read only on its reservation's day.

import { env } from "cloudflare:workers";
import { createIdFactory, type IssueRow, secureRandomBytes } from "@fyrden/domain";
import { describe, expect, it } from "vitest";
import { DEFAULT_ORG_SHARD, readModelFor } from "../src/events/read-model.js";
import { epochStatement } from "../src/queues/events-consumer.js";
import { InteractiveDayEnded, reserveInteractive } from "../src/search/interactive.js";
import { parseSearchQuery } from "../src/search/parser.js";
import { RANKING, type RankingLimits, rankCandidates } from "../src/search/ranking.js";
import { docStatements } from "../src/search/statements.js";

const newId = createIdFactory(Date.now, secureRandomBytes);
const db = readModelFor(env, DEFAULT_ORG_SHARD);

/** A term no other test's documents hold. */
const term = () => `q${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;

const issue = (number: number, title: string, body: string): IssueRow => ({
  number,
  title,
  body,
  state: "open",
  stateReason: null,
  duplicateOf: null,
  locked: false,
  lockReason: null,
  authorId: "agt_author",
  authorRoot: "usr_author",
  closedAt: null,
  closedBy: null,
  createdAt: 1,
  updatedAt: 2,
  assignees: [],
  labels: [],
  milestone: null,
});

/** A source with issues of these titles and bodies, indexed: its repository's number. */
async function source(texts: readonly [string, string][]): Promise<number> {
  const repoId = newId("rep");
  await epochStatement(db, repoId, 1, 0).run();
  for (const [i, [title, body]] of texts.entries()) await add(repoId, i + 1, title, body);
  const row = await db
    .prepare("SELECT num FROM search_repo_nums WHERE repo_id = ?")
    .bind(repoId)
    .first<{ num: number }>();
  return row?.num as number;
}

async function add(repoId: string, number: number, title: string, body: string) {
  await db.batch(
    docStatements(
      db,
      { repoId, epochGen: 1, ownerGen: 1, sourceSeq: number },
      {
        type: "issue",
        id: `${repoId}#${number}`,
        version: number,
        deleted: false,
        row: issue(number, title, body) as unknown as Record<string, unknown>,
      },
    ),
  );
}

/** A term's occurrences in the documents' index, as its vocabulary counts them. */
const cnt = (t: string) =>
  db
    .prepare("SELECT cnt FROM search_vocab WHERE term = ?")
    .bind(t)
    .first<{ cnt: number }>()
    .then((r) => r?.cnt ?? 0);

const rank = async (
  q: string,
  generated: { repos?: number[]; kinds?: number[] } = {},
  limits?: RankingLimits,
) =>
  rankCandidates(
    db,
    await reserveInteractive(db, 0),
    "issues",
    parseSearchQuery(q, "issues"),
    generated,
    limits,
  );

describe("a ranked search's admission", () => {
  it("charges each clause its terms' occurrences, as often as written, a prefix's every term", async () => {
    const [a, b] = [term(), term()];
    await source([
      [`${a} ${a}`, b],
      [a, `${b} ${a}`],
    ]);
    expect([await cnt(a), await cnt(b)]).toEqual([4, 2]);
    // Two clauses, and a phrase repeating a term: charged twice.
    expect((await rank(`${a} ${b}`))?.charge).toEqual({
      expansions: 0,
      clause: 4,
      total: 6,
      narrowest: 2,
    });
    expect((await rank(`"${a} ${a}"`))?.charge).toEqual({
      expansions: 0,
      clause: 8,
      total: 8,
      narrowest: 8,
    });
    // In either order alike.
    expect((await rank(`${b} ${a}`))?.charge).toEqual((await rank(`${a} ${b}`))?.charge);
    // A clause an `in:` column each.
    expect((await rank(`${a} in:title in:body`))?.charge).toEqual({
      expansions: 0,
      clause: 4,
      total: 8,
      narrowest: 4,
    });
    // A prefix: every term it stands for.
    expect((await rank(`${b} ${a.slice(0, 8)}*`))?.charge).toEqual({
      expansions: 1,
      clause: 4,
      total: 6,
      narrowest: 2,
    });
  });

  it("charges every token of its generated filters", async () => {
    const a = term();
    const num = await source([
      [a, ""],
      ["plain", a],
      ["plain", ""],
    ]);
    const k1 = await cnt("k1");
    const ranked = await rank(a, { repos: [num], kinds: [1] });
    expect(await cnt(`r${num}`)).toBe(3);
    expect(ranked?.charge).toEqual({
      expansions: 0,
      clause: k1,
      total: 2 + 3 + k1,
      narrowest: 2,
    });
    expect(ranked?.candidates).toHaveLength(2);
  });

  it("refuses a prefix standing for more than a thousand terms, and ranks nothing", async () => {
    const stem = term();
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => `${stem}${i.toString().padStart(4, "0")}`).join(" ");
    // All in one document.
    const repoId = newId("rep");
    await epochStatement(db, repoId, 1, 0).run();
    await add(repoId, 1, "plain", many(RANKING.expansions));
    const admitted = await rank(`${stem}*`);
    expect(admitted?.refused).toBeUndefined();
    expect(admitted?.charge.expansions).toBe(RANKING.expansions);
    expect(admitted?.candidates).toHaveLength(1);
    await add(repoId, 2, `${stem}x`, "");
    const refused = await rank(`${stem}*`);
    expect(refused?.refused).toBe("prefix_too_broad");
    expect(refused?.charge.expansions).toBe(RANKING.expansions + 1);
    expect(refused?.candidates).toEqual([]);
  });

  it("refuses a clause or a whole past its bound, deciding on what was written before it", async () => {
    const [a, b] = [term(), term()];
    const repoId = newId("rep");
    await epochStatement(db, repoId, 1, 0).run();
    await add(repoId, 1, a, b);
    await add(repoId, 2, a, "");
    const limits = { ...RANKING, clauseOccurrences: 2, queryOccurrences: 3 };
    expect((await rank(`${a} ${b}`, {}, limits))?.candidates).toHaveLength(1);
    // A write before the statement: its admission sees it.
    await add(repoId, 3, b, "");
    const whole = await rank(`${a} ${b}`, {}, limits);
    expect(whole?.refused).toBe("query_too_broad");
    expect(whole?.candidates).toEqual([]);
    await add(repoId, 4, a, "");
    expect((await rank(a, {}, { ...limits, queryOccurrences: 10 }))?.refused).toBe(
      "query_too_broad",
    );
    // Its narrowest clause past the documents it may score: a 3, b 2.
    const wide = { ...RANKING, matches: 1 };
    expect((await rank(`${a} ${b}`, {}, wide))?.refused).toBe("query_too_broad");
    expect((await rank(`${a} ${b}`, {}, { ...wide, matches: 2 }))?.refused).toBeUndefined();
  });

  it("takes no candidates when it refuses", async () => {
    const a = term();
    // Its refusal's tokens in their text too: not walked.
    await source(Array.from({ length: 50 }, () => ["r0 o0", `${a} r0 o0`] as [string, string]));
    // Every document of the kind: the ranking's work, which a refusal does not do.
    const admitted = await rank(a, { kinds: [1] });
    const refused = await rank(a, { kinds: [1] }, { ...RANKING, queryOccurrences: 1 });
    expect(admitted?.candidates).toHaveLength(50);
    expect(refused?.refused).toBe("query_too_broad");
    expect(refused?.reads).toBeLessThan((admitted?.reads ?? 0) / 2);
  });

  it("ranks the index's best candidates, at most the most a search takes, and none without free text", async () => {
    const a = term();
    await source([
      [`${a} ${a} ${a}`, ""],
      ["other", a],
      [a, `${a} words`],
    ]);
    const ranked = await rank(a);
    expect(ranked?.candidates).toHaveLength(3);
    const ranks = ranked?.candidates.map((c) => c.rank) ?? [];
    expect(ranks).toEqual([...ranks].sort((x, y) => x - y));
    // The same index, the same order; the best of them alone past the most a search takes.
    expect((await rank(a))?.candidates).toEqual(ranked?.candidates);
    expect((await rank(a, {}, { ...RANKING, candidates: 2 }))?.candidates).toEqual(
      ranked?.candidates.slice(0, 2),
    );
    expect(await rank("is:open")).toBeNull();
  });

  it("reads only on its reservation's day", async () => {
    const a = term();
    await source([[a, ""]]);
    const today = await reserveInteractive(db, 0);
    const yesterday = { day: today.day - 1, reads: today.reads };
    await expect(
      rankCandidates(db, yesterday, "issues", parseSearchQuery(a, "issues"), {}),
    ).rejects.toBeInstanceOf(InteractiveDayEnded);
  });
});
