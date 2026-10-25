// Search's projections of issues, pull requests, labels and milestones, written
// through the guarded statements every writer uses: a row moves only forward
// (epoch, ownership, version), only for a current, undeleted source past its
// cutoff, and a deletion leaves a row without its text that an older event
// cannot bring back. A deleted repository's rows go with its cleanups.
import { env } from "cloudflare:workers";
import {
  createIdFactory,
  type EntitySnapshot,
  type IssueRow,
  type LabelRow,
  type MilestoneRow,
  type PullRequestRow,
  secureRandomBytes,
} from "@fyrden/domain";
import { describe, expect, it } from "vitest";
import { epochStatement } from "../src/queues/events-consumer.js";
import { CLEANUP_POLICY, REPO_CLEANUPS } from "../src/repos/cleanups.js";
import {
  docStatement,
  labelStatement,
  milestoneStatement,
  type SearchPosition,
  searchStatement,
} from "../src/search/statements.js";

const newId = createIdFactory(Date.now, secureRandomBytes);
const db = env.ORG_READ;
const SHA = "a".repeat(40);

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
  createdAt: 10,
  updatedAt: 20,
  labels: [2, 5],
  assignees: ["usr_a", "usr_b"],
  milestone: 1,
  ...overrides,
});

const pull = (number: number, overrides: Partial<PullRequestRow> = {}): PullRequestRow => ({
  number,
  title: `Pull ${number}`,
  body: null,
  state: "open",
  draft: false,
  authorId: "usr_author",
  authorRoot: "usr_author",
  baseRef: "main",
  headRef: "topic",
  headRepoId: null,
  maintainerCanModify: false,
  baseSha: SHA,
  headSha: SHA,
  headRefDeleted: false,
  locked: false,
  lockReason: null,
  generation: 1,
  closedAt: null,
  mergeCommitSha: null,
  mergedBy: null,
  mergedAt: null,
  createdAt: 30,
  updatedAt: 40,
  labels: [],
  assignees: [],
  milestone: null,
  ...overrides,
});

const label = (id: number, overrides: Partial<LabelRow> = {}): LabelRow => ({
  id,
  name: "bug",
  color: "d73a4a",
  description: "Something isn't working",
  isDefault: true,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

const milestone = (number: number, overrides: Partial<MilestoneRow> = {}): MilestoneRow => ({
  number,
  title: "v1",
  description: "The first release",
  state: "open",
  dueOn: 1_000,
  closedAt: null,
  openIssues: 3,
  closedIssues: 1,
  openPulls: 0,
  closedPulls: 0,
  creator: "usr_author",
  createdAt: 1,
  updatedAt: 2,
  ...overrides,
});

/** A source with its epoch recorded, as the consumer records it before projecting. */
async function source(epochGen = 1): Promise<string> {
  const repoId = newId("rep");
  await epochStatement(db, repoId, epochGen, 0).run();
  return repoId;
}

const at = (repoId: string, over: Partial<SearchPosition> = {}): SearchPosition => ({
  repoId,
  epochGen: 1,
  ownerGen: 1,
  sourceSeq: 1,
  ...over,
});

function entity(
  type: string,
  id: string,
  version: number,
  row: object | null,
  deleted = false,
): EntitySnapshot {
  return { type, id, version, deleted, row: row as Record<string, unknown> | null };
}

const issueEntity = (repoId: string, row: IssueRow, version: number) =>
  entity("issue", `${repoId}#${row.number}`, version, row);
const pullEntity = (repoId: string, row: PullRequestRow, version: number) =>
  entity("pull_request", `${repoId}#${row.number}`, version, row);

async function doc(repoId: string, number: number) {
  return db
    .prepare("SELECT * FROM search_docs WHERE repo_id = ? AND number = ?")
    .bind(repoId, number)
    .first<Record<string, unknown>>();
}

async function project(position: SearchPosition, snapshot: EntitySnapshot): Promise<number> {
  const statement = searchStatement(db, position, snapshot);
  if (!statement) throw new Error("not projected");
  return (await statement.run()).meta.changes;
}

describe("search projections", () => {
  it("projects an issue's and a pull request's fields, metadata and state", async () => {
    const repo = await source();
    await project(at(repo), issueEntity(repo, issue(1), 1));
    await project(
      at(repo, { sourceSeq: 2 }),
      pullEntity(repo, pull(2, { state: "merged", mergedAt: 50, closedAt: 50, draft: true }), 1),
    );

    expect(await doc(repo, 1)).toMatchObject({
      kind: 1,
      state: 1,
      open_state: 1,
      state_reason: null,
      draft: 0,
      title: "Issue 1",
      body: "Something is broken.",
      author_id: "agt_author",
      author_root: "usr_author",
      labels: "[2,5]",
      assignees: '["usr_a","usr_b"]',
      milestone: 1,
      created_at: 10,
      updated_at: 20,
      deleted: 0,
      epoch_gen: 1,
      owner_gen: 1,
      version: 1,
      updated_seq: 1,
    });
    // Merged: its own state, and closed for listings of open or closed ones.
    expect(await doc(repo, 2)).toMatchObject({
      kind: 2,
      state: 3,
      open_state: 2,
      draft: 1,
      merged_at: 50,
      closed_at: 50,
      updated_seq: 2,
    });
  });

  it("moves a row only forward: by epoch, then ownership, then version", async () => {
    const repo = await source();
    await project(at(repo, { sourceSeq: 5 }), issueEntity(repo, issue(1, { title: "v3" }), 3));
    // An older or equal version (a delayed or replayed event) changes nothing.
    expect(
      await project(at(repo, { sourceSeq: 3 }), issueEntity(repo, issue(1, { title: "v2" }), 2)),
    ).toBe(0);
    expect(
      await project(at(repo, { sourceSeq: 6 }), issueEntity(repo, issue(1, { title: "again" }), 3)),
    ).toBe(0);
    expect((await doc(repo, 1))?.title).toBe("v3");
    // A later ownership (a transfer) or epoch (a restore) replaces it whatever its version.
    await db
      .prepare("INSERT INTO source_owner (source_id, owner_gen) VALUES (?, 2)")
      .bind(repo)
      .run();
    expect(
      await project(
        at(repo, { ownerGen: 2, sourceSeq: 7 }),
        issueEntity(repo, issue(1, { title: "moved" }), 1),
      ),
    ).toBe(1);
    await epochStatement(db, repo, 2, 0).run();
    expect(
      await project(
        at(repo, { epochGen: 2, ownerGen: 2, sourceSeq: 1 }),
        issueEntity(repo, issue(1, { title: "restored" }), 1),
      ),
    ).toBe(1);
    expect(await doc(repo, 1)).toMatchObject({
      title: "restored",
      epoch_gen: 2,
      owner_gen: 2,
      version: 1,
    });
  });

  it("refuses an older epoch, an older ownership, a deleted repository and what the cutoff covers", async () => {
    const stale = await source(2);
    expect(await project(at(stale), issueEntity(stale, issue(1), 1))).toBe(0);

    const moved = await source();
    await db
      .prepare("INSERT INTO source_owner (source_id, owner_gen) VALUES (?, 3)")
      .bind(moved)
      .run();
    expect(await project(at(moved, { ownerGen: 2 }), issueEntity(moved, issue(1), 1))).toBe(0);

    const gone = await source();
    await db
      .prepare(
        `INSERT INTO repos (repo_id, deleted, epoch_gen, version, owner_gen, updated_seq, updated_at)
         VALUES (?, 1, 1, 9, 1, 9, 0)`,
      )
      .bind(gone)
      .run();
    expect(await project(at(gone), issueEntity(gone, issue(1), 1))).toBe(0);
    expect(await project(at(gone), entity("label", `${gone}#labels/1`, 1, label(1)))).toBe(0);
    expect(
      await project(at(gone), entity("milestone", `${gone}#milestones/1`, 1, milestone(1))),
    ).toBe(0);

    const cut = await source(2);
    await db
      .prepare("INSERT INTO search_sources (repo_id, cutoff_epoch, cutoff_seq) VALUES (?, 2, 10)")
      .bind(cut)
      .run();
    // At or before the cutoff (an earlier epoch whatever its sequence): refused; after it: written.
    expect(
      await project(at(cut, { epochGen: 2, sourceSeq: 10 }), issueEntity(cut, issue(1), 1)),
    ).toBe(0);
    expect(
      await project(at(cut, { epochGen: 2, sourceSeq: 11 }), issueEntity(cut, issue(1), 1)),
    ).toBe(1);
    expect(
      await project(
        at(cut, { epochGen: 2, sourceSeq: 12 }),
        entity("label", `${cut}#labels/1`, 1, label(1)),
      ),
    ).toBe(1);
  });

  it("keeps a deletion without its text, and an older event does not bring it back", async () => {
    const repo = await source();
    await project(at(repo), issueEntity(repo, issue(1), 1));
    await project(at(repo, { sourceSeq: 3 }), entity("issue", `${repo}#1`, 3, null, true));
    expect(await doc(repo, 1)).toMatchObject({
      deleted: 1,
      kind: 1,
      title: null,
      body: null,
      state: null,
      open_state: null,
      labels: "[]",
      assignees: "[]",
      milestone: null,
      author_id: null,
      version: 3,
    });
    expect(await project(at(repo, { sourceSeq: 2 }), issueEntity(repo, issue(1), 2))).toBe(0);
    // A deletion that arrives before anything else of it stays, too.
    await project(at(repo, { sourceSeq: 9 }), entity("issue", `${repo}#4`, 5, null, true));
    expect(await project(at(repo, { sourceSeq: 8 }), issueEntity(repo, issue(4), 4))).toBe(0);
    expect((await doc(repo, 4))?.deleted).toBe(1);
  });

  it("projects labels and milestones, deletions kept the same way", async () => {
    const repo = await source();
    await project(at(repo), entity("label", `${repo}#labels/7`, 1, label(7)));
    await project(
      at(repo),
      entity(
        "milestone",
        `${repo}#milestones/2`,
        1,
        milestone(2, { state: "closed", closedAt: 5 }),
      ),
    );
    expect(
      await db.prepare("SELECT * FROM search_labels WHERE repo_id = ?").bind(repo).first(),
    ).toMatchObject({
      label_id: 7,
      name: "bug",
      color: "d73a4a",
      description: "Something isn't working",
      deleted: 0,
    });
    expect(
      await db.prepare("SELECT * FROM search_milestones WHERE repo_id = ?").bind(repo).first(),
    ).toMatchObject({
      number: 2,
      title: "v1",
      state: 2,
      description: "The first release",
      due_on: 1_000,
      closed_at: 5,
    });

    await project(at(repo, { sourceSeq: 2 }), entity("label", `${repo}#labels/7`, 2, null, true));
    await project(
      at(repo, { sourceSeq: 2 }),
      entity("milestone", `${repo}#milestones/2`, 2, null, true),
    );
    expect(
      await project(at(repo, { sourceSeq: 3 }), entity("label", `${repo}#labels/7`, 1, label(7))),
    ).toBe(0);
    expect(
      await db
        .prepare("SELECT deleted, name, color FROM search_labels WHERE repo_id = ?")
        .bind(repo)
        .first(),
    ).toEqual({ deleted: 1, name: null, color: null });
    expect(
      await db
        .prepare("SELECT deleted, title, state FROM search_milestones WHERE repo_id = ?")
        .bind(repo)
        .first(),
    ).toEqual({ deleted: 1, title: null, state: null });
  });

  it("refuses another repository's entity, a malformed row and a stored event's missing row", () => {
    const position = at("rep_one");
    expect(() => docStatement(db, position, entity("issue", "rep_two#1", 1, issue(1)))).toThrow(
      /another repository/,
    );
    expect(() => docStatement(db, position, entity("issue", "rep_one#2", 1, issue(1)))).toThrow(
      /malformed/,
    );
    expect(() =>
      docStatement(db, position, entity("issue", "rep_one#1", 1, { title: "x" })),
    ).toThrow(/malformed/);
    expect(() => docStatement(db, position, entity("issue", "rep_one#1", 1, null))).toThrow(
      /malformed/,
    );
    expect(() =>
      labelStatement(db, position, entity("label", "rep_one#labels/x", 1, label(1))),
    ).toThrow(/malformed/);
    expect(() =>
      milestoneStatement(db, position, entity("milestone", "rep_one#milestones/1", 1, label(1))),
    ).toThrow(/malformed/);
    expect(searchStatement(db, position, entity("repo", "rep_one", 1, {}))).toBeUndefined();
  });
});

describe("a deleted repository's search projections", () => {
  const cleanup = REPO_CLEANUPS.find((c) => c.name === "search");

  it("go a page of each table at a time, and no other repository's", async () => {
    if (!cleanup) throw new Error("no search cleanup");
    const doomed = await source();
    const kept = await source();
    for (const repo of [doomed, kept]) {
      await db
        .prepare(
          `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?2)
           INSERT INTO search_docs (repo_id, number, kind, deleted, epoch_gen, owner_gen, version,
             updated_seq)
           SELECT ?1, i, 1, 1, 1, 1, 1, 1 FROM n`,
        )
        .bind(repo, CLEANUP_POLICY.searchPage + 1)
        .run();
      await project(at(repo), entity("label", `${repo}#labels/1`, 1, label(1)));
      await project(at(repo), entity("milestone", `${repo}#milestones/1`, 1, milestone(1)));
      await db
        .prepare("INSERT INTO search_sources (repo_id, cutoff_epoch, cutoff_seq) VALUES (?, 1, 1)")
        .bind(repo)
        .run();
    }
    const target = { repoId: doomed, shard: "default", gen: 1 };
    expect(await cleanup.page(env, target)).toBe("more");
    expect(await rows(doomed)).toEqual([1, 0, 0, 0]);
    expect(await cleanup.page(env, target)).toBe("done");
    expect(await rows(doomed)).toEqual([0, 0, 0, 0]);
    expect(await rows(kept)).toEqual([CLEANUP_POLICY.searchPage + 1, 1, 1, 1]);
  });
});

async function rows(repoId: string): Promise<number[]> {
  const counts = await db.batch<{ n: number }>(
    ["search_docs", "search_labels", "search_milestones", "search_sources"].map((table) =>
      db.prepare(`SELECT count(*) AS n FROM ${table} WHERE repo_id = ?`).bind(repoId),
    ),
  );
  return counts.map((c) => c.results[0]?.n ?? -1);
}

describe("search projections' write costs", () => {
  // Rows written, as D1 counts them (the row and each index entry it changes): an issue
  // first projected writes its row, its unique key and its four listing indexes; a change
  // rewrites the row and the listing indexes; a deletion takes it out of them.
  it("are pinned", async () => {
    const repo = await source();
    const written = async (position: SearchPosition, snapshot: EntitySnapshot) => {
      const statement = searchStatement(db, position, snapshot);
      if (!statement) throw new Error("not projected");
      return (await statement.run()).meta.rows_written;
    };
    const edited = issue(1, { title: "Renamed", updatedAt: 21 });
    expect({
      insert: await written(at(repo), issueEntity(repo, issue(1), 1)),
      text: await written(at(repo, { sourceSeq: 2 }), issueEntity(repo, edited, 2)),
      metadata: await written(
        at(repo, { sourceSeq: 3 }),
        issueEntity(repo, { ...edited, labels: [3] }, 3),
      ),
      duplicate: await written(at(repo, { sourceSeq: 4 }), issueEntity(repo, edited, 3)),
      deletion: await written(
        at(repo, { sourceSeq: 5 }),
        entity("issue", `${repo}#1`, 4, null, true),
      ),
      label: await written(at(repo), entity("label", `${repo}#labels/1`, 1, label(1))),
      milestone: await written(
        at(repo),
        entity("milestone", `${repo}#milestones/1`, 1, milestone(1)),
      ),
    }).toEqual({
      insert: 6,
      text: 5,
      metadata: 5,
      duplicate: 0,
      deletion: 1,
      label: 2,
      milestone: 2,
    });
  });
});
