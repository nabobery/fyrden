// Search's full-text indexes kept with its projections, each write's group
// in one batch: an issue's or pull request's title and body (with tokens of
// its repository and kind), a repository's name and description (with its
// owner's token). Every write that moves a row moves its indexed tuple;
// nothing else does. The index agrees with its content throughout
// (`integrity-check` against it).

import { env } from "cloudflare:workers";
import {
  createIdFactory,
  type EntitySnapshot,
  type IssueRow,
  type RepoRow,
  secureRandomBytes,
} from "@fyrden/domain";
import { describe, expect, it } from "vitest";
import { DEFAULT_ORG_SHARD, readModelFor } from "../src/events/read-model.js";
import { epochStatement, repoStatements, type Snapshot } from "../src/queues/events-consumer.js";
import { REPO_CLEANUPS } from "../src/repos/cleanups.js";
import { docStatements, type SearchPosition } from "../src/search/statements.js";

const newId = createIdFactory(Date.now, secureRandomBytes);
// Written as production writes it: through the read model's executor.
const db = readModelFor(env, DEFAULT_ORG_SHARD);

const issue = (number: number, overrides: Partial<IssueRow> = {}): IssueRow => ({
  number,
  title: `Issue ${number}`,
  body: "Something is broken.",
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
  ...overrides,
});

async function source(): Promise<string> {
  const repoId = newId("rep");
  await epochStatement(db, repoId, 1, 0).run();
  return repoId;
}

const at = (repoId: string, over: Partial<SearchPosition> = {}): SearchPosition => ({
  repoId,
  epochGen: 1,
  ownerGen: 1,
  sourceSeq: 1,
  ...over,
});

const issueEntity = (repoId: string, row: IssueRow | null, version: number): EntitySnapshot => ({
  type: "issue",
  id: `${repoId}#${row?.number ?? 1}`,
  version,
  deleted: row === null,
  row: row as unknown as Record<string, unknown> | null,
});

const project = (position: SearchPosition, entity: EntitySnapshot) =>
  db.batch(docStatements(db, position, entity));

/** Documents of `repoId` whose index matches `query` (its numbers). */
async function matching(repoId: string, query: string): Promise<number[]> {
  const { results } = await db
    .prepare(
      `SELECT d.number FROM search_fts f JOIN search_docs d ON d.doc_id = f.rowid
       WHERE search_fts MATCH ?1 AND d.repo_id = ?2 ORDER BY d.number`,
    )
    .bind(query, repoId)
    .all<{ number: number }>();
  return results.map((r) => r.number);
}

const state = () =>
  db
    .prepare(
      "SELECT next_repo_num, next_owner_num, live_docs, indexed_repos FROM search_index_state WHERE id = 1",
    )
    .first<{
      next_repo_num: number;
      next_owner_num: number;
      live_docs: number;
      indexed_repos: number;
    }>();

const docRow = (repoId: string, number: number) =>
  db
    .prepare(
      "SELECT doc_id, fts_token, deleted, title FROM search_docs WHERE repo_id = ? AND number = ?",
    )
    .bind(repoId, number)
    .first<{ doc_id: number; fts_token: string | null; deleted: number; title: string | null }>();

/** Both indexes agree with their content (each a statement the executor admits). */
async function consistent(): Promise<void> {
  await db.batch([
    db.prepare("INSERT INTO search_fts (search_fts, rank) VALUES ('integrity-check', 1)"),
    db.prepare(
      "INSERT INTO search_repos_fts (search_repos_fts, rank) VALUES ('integrity-check', 1)",
    ),
  ]);
}

describe("an issue's full-text entry", () => {
  it("is made with its row, its repository's and kind's tokens with it, and counted once", async () => {
    const repo = await source();
    const before = await state();
    await project(at(repo), issueEntity(repo, issue(1, { title: "Crashing renderer" }), 1));
    expect(await matching(repo, "crashing")).toEqual([1]);
    expect(await matching(repo, "kind:k1 AND broken")).toEqual([1]);
    const { num } = (await db
      .prepare("SELECT num FROM search_repo_nums WHERE repo_id = ?")
      .bind(repo)
      .first<{ num: number }>()) as { num: number };
    expect(await matching(repo, `repo:r${num}`)).toEqual([1]);
    expect(await state()).toMatchObject({
      next_repo_num: (before?.next_repo_num ?? 0) + 1,
      live_docs: (before?.live_docs ?? 0) + 1,
    });
    await consistent();
  });

  it("follows its text, keeps its place, and stays as it is when only its metadata changes", async () => {
    const repo = await source();
    await project(at(repo), issueEntity(repo, issue(1, { title: "Old words" }), 1));
    const first = await docRow(repo, 1);
    const counted = (await state())?.live_docs;
    await project(
      at(repo, { sourceSeq: 2 }),
      issueEntity(repo, issue(1, { title: "New words" }), 2),
    );
    expect([await matching(repo, "old"), await matching(repo, "new")]).toEqual([[], [1]]);
    const edited = await docRow(repo, 1);
    expect(edited?.doc_id).toBe(first?.doc_id);
    expect(edited?.fts_token).not.toBe(first?.fts_token);
    // Metadata only: the index untouched (its mark kept), the row moved on.
    await project(
      at(repo, { sourceSeq: 3 }),
      issueEntity(repo, issue(1, { title: "New words", labels: [3], updatedAt: 9 }), 3),
    );
    expect((await docRow(repo, 1))?.fts_token).toBe(edited?.fts_token);
    expect((await state())?.live_docs).toBe(counted);
    await consistent();
  });

  it("goes with a deletion, before its text, and is counted out", async () => {
    const repo = await source();
    await project(at(repo), issueEntity(repo, issue(1, { title: "Doomed" }), 1));
    const counted = (await state())?.live_docs ?? 0;
    await project(at(repo, { sourceSeq: 2 }), issueEntity(repo, null, 2));
    expect(await matching(repo, "doomed")).toEqual([]);
    expect(await docRow(repo, 1)).toMatchObject({ deleted: 1, title: null, fts_token: null });
    expect((await state())?.live_docs).toBe(counted - 1);
    await consistent();
  });

  it("is left as it is by a duplicate, a stale write and one its cutoff covers", async () => {
    const repo = await source();
    await project(at(repo, { sourceSeq: 5 }), issueEntity(repo, issue(1, { title: "Kept" }), 3));
    const row = await docRow(repo, 1);
    const counters = await state();
    await project(at(repo, { sourceSeq: 5 }), issueEntity(repo, issue(1, { title: "Kept" }), 3));
    await project(at(repo, { sourceSeq: 3 }), issueEntity(repo, issue(1, { title: "Stale" }), 2));
    await db
      .prepare("INSERT INTO search_sources (repo_id, cutoff_epoch, cutoff_seq) VALUES (?, 1, 10)")
      .bind(repo)
      .run();
    await project(at(repo, { sourceSeq: 9 }), issueEntity(repo, issue(1, { title: "Covered" }), 9));
    expect(await docRow(repo, 1)).toEqual(row);
    expect(await state()).toEqual(counters);
    expect([await matching(repo, "kept"), await matching(repo, "stale OR covered")]).toEqual([
      [1],
      [],
    ]);
    await consistent();
  });

  it("moves with nothing of its group when the batch fails after the old entry went", async () => {
    const repo = await source();
    await project(at(repo), issueEntity(repo, issue(1, { title: "Before" }), 1));
    const row = await docRow(repo, 1);
    const counters = await state();
    await expect(
      db.batch([
        ...docStatements(
          db,
          at(repo, { sourceSeq: 2 }),
          issueEntity(repo, issue(1, { title: "After" }), 2),
        ),
        db
          .prepare(
            "INSERT INTO consumer_epochs (source_id, epoch_gen, updated_at) VALUES (?, 0, 0)",
          )
          .bind(repo),
      ]),
    ).rejects.toThrow();
    expect(await docRow(repo, 1)).toEqual(row);
    expect(await state()).toEqual(counters);
    expect(await matching(repo, "before")).toEqual([1]);
    await consistent();
  });
});

const OWNER = "usr_01K742SG00NAWD8WB4RTMJF8H9";
const OTHER = "org_01K742SG00NAWD8WB4RTMJF8HA";

const repoRow = (overrides: Partial<RepoRow> = {}): RepoRow => ({
  ownerId: OWNER,
  name: "widgets",
  visibility: "private",
  defaultBranch: "refs/heads/main",
  pushedAt: null,
  createdAt: 1,
  description: "Makes widgets",
  ...overrides,
});

function repoSnapshot(
  repoId: string,
  version: number,
  r: RepoRow | null,
  over: { ownerGen?: number; seq?: number } = {},
): Snapshot {
  return {
    id: { sourceId: repoId, epochGen: 1, sourceSeq: over.seq ?? version },
    type: r ? "repo.updated" : "repo.deleted",
    at: 0,
    actor: null,
    actChain: [],
    ownerGen: over.ownerGen ?? 1,
    entity: {
      type: "repo",
      id: repoId,
      version,
      deleted: r === null,
      row: r as unknown as Record<string, unknown> | null,
    },
    data: null,
    stored: false,
  };
}

const writeRepo = (snapshot: Snapshot, indexing = true) =>
  db.batch(repoStatements(db, snapshot.entity.id, snapshot, 0, indexing));

async function repoMatching(query: string): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT n.repo_id FROM search_repos_fts f JOIN search_repo_nums n ON n.num = f.rowid
       WHERE search_repos_fts MATCH ? ORDER BY n.repo_id`,
    )
    .bind(query)
    .all<{ repo_id: string }>();
  return results.map((r) => r.repo_id);
}

const membership = (repoId: string) =>
  db
    .prepare("SELECT indexed, fts_token, indexed_version FROM search_repo_nums WHERE repo_id = ?")
    .bind(repoId)
    .first<{ indexed: number; fts_token: string | null; indexed_version: number | null }>();

const ownerToken = async (owner: string) =>
  `o${(await db.prepare("SELECT num FROM search_owner_nums WHERE owner_id = ?").bind(owner).first<{ num: number }>())?.num}`;

describe("a repository's full-text entry", () => {
  it("follows its name and description, and stays as it is when only other fields change", async () => {
    const repo = await source();
    const counted = (await state())?.indexed_repos ?? 0;
    await writeRepo(repoSnapshot(repo, 1, repoRow({ name: `gadgets-${repo}` })));
    expect(await repoMatching(`"gadgets-${repo}"`)).toEqual([repo]);
    expect((await state())?.indexed_repos).toBe(counted + 1);
    const first = await membership(repo);
    await writeRepo(
      repoSnapshot(repo, 2, repoRow({ name: `gadgets-${repo}`, description: "Sprockets" })),
    );
    expect([
      await repoMatching(`"gadgets-${repo}" AND widgets`),
      await repoMatching(`"gadgets-${repo}" AND sprockets`),
    ]).toEqual([[], [repo]]);
    const described = await membership(repo);
    expect(described?.fts_token).not.toBe(first?.fts_token);
    // Visibility only: the index untouched, its place moved on.
    await writeRepo(
      repoSnapshot(
        repo,
        3,
        repoRow({ name: `gadgets-${repo}`, description: "Sprockets", visibility: "public" }),
      ),
    );
    expect(await membership(repo)).toMatchObject({
      fts_token: described?.fts_token,
      indexed_version: 3,
    });
    await consistent();
  });

  it("takes its new owner's token on a transfer at the same version, and refuses the old owner's late event", async () => {
    const repo = await source();
    await writeRepo(repoSnapshot(repo, 4, repoRow({ name: `moving-${repo}` })));
    const before = await ownerToken(OWNER);
    await db
      .prepare("INSERT INTO source_owner (source_id, owner_gen) VALUES (?, 2)")
      .bind(repo)
      .run();
    await writeRepo(
      repoSnapshot(repo, 4, repoRow({ name: `moving-${repo}`, ownerId: OTHER }), {
        ownerGen: 2,
        seq: 5,
      }),
    );
    const after = await ownerToken(OTHER);
    expect([
      await repoMatching(`"moving-${repo}" AND owner:${before}`),
      await repoMatching(`"moving-${repo}" AND owner:${after}`),
    ]).toEqual([[], [repo]]);
    // The old owner's event, later in its sequence: its ownership is over.
    await writeRepo(
      repoSnapshot(repo, 5, repoRow({ name: `moving-${repo}` }), { ownerGen: 1, seq: 6 }),
    );
    expect(await repoMatching(`"moving-${repo}" AND owner:${after}`)).toEqual([repo]);
    await consistent();
  });

  it("is taken out when its tuple changes while search does not index, the row still written", async () => {
    const repo = await source();
    await writeRepo(repoSnapshot(repo, 1, repoRow({ name: `quiet-${repo}` })));
    const counted = (await state())?.indexed_repos ?? 0;
    await writeRepo(repoSnapshot(repo, 2, repoRow({ name: `renamed-${repo}` })), false);
    expect([
      await repoMatching(`"quiet-${repo}"`),
      await repoMatching(`"renamed-${repo}"`),
    ]).toEqual([[], []]);
    expect(await membership(repo)).toMatchObject({ indexed: 0, fts_token: null });
    expect((await state())?.indexed_repos).toBe(counted - 1);
    expect(await db.prepare("SELECT name FROM repos WHERE repo_id = ?").bind(repo).first()).toEqual(
      { name: `renamed-${repo}` },
    );
    await consistent();
  });

  it("goes with its deletion, and is not made again by a replay of it", async () => {
    const repo = await source();
    await writeRepo(repoSnapshot(repo, 1, repoRow({ name: `gone-${repo}` })));
    await writeRepo(repoSnapshot(repo, 2, null));
    await writeRepo(repoSnapshot(repo, 2, null));
    expect(await repoMatching(`"gone-${repo}"`)).toEqual([]);
    expect(await membership(repo)).toMatchObject({ indexed: 0 });
    await consistent();
  });
});

describe("a deleted repository's cleanup", () => {
  it("takes its documents' entries out before their rows, a page at a time, and its number last", async () => {
    const search = REPO_CLEANUPS.find((c) => c.name === "search");
    if (!search) throw new Error("no search cleanup");
    const repo = await source();
    const sibling = await source();
    for (const number of [1, 2, 3])
      await project(
        at(repo, { sourceSeq: number }),
        issueEntity(repo, issue(number, { title: `Leaf ${number}` }), number),
      );
    await project(at(sibling), issueEntity(sibling, issue(1, { title: "Leaf sibling" }), 1));
    await writeRepo(repoSnapshot(repo, 1, repoRow({ name: `cleaned-${repo}` })));
    const counted = (await state())?.live_docs ?? 0;
    const { CLEANUP_POLICY } = await import("../src/repos/cleanups.js");
    const page = CLEANUP_POLICY.searchPage;
    CLEANUP_POLICY.searchPage = 2;
    try {
      expect(await search.page(env, { repoId: repo, shard: DEFAULT_ORG_SHARD, gen: 1 })).toBe(
        "more",
      );
      expect(await matching(repo, "leaf")).toEqual([3]);
      expect((await state())?.live_docs).toBe(counted - 2);
      // Its number stays while a document of it does: the rest needs its token.
      expect(await membership(repo)).not.toBeNull();
      expect(await search.page(env, { repoId: repo, shard: DEFAULT_ORG_SHARD, gen: 1 })).toBe(
        "done",
      );
    } finally {
      CLEANUP_POLICY.searchPage = page;
    }
    expect([await matching(repo, "leaf"), await matching(sibling, "leaf")]).toEqual([[], [1]]);
    expect(await membership(repo)).toBeNull();
    expect(await repoMatching(`"cleaned-${repo}"`)).toEqual([]);
    await consistent();
  });
});
