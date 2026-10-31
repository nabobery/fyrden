// A ranked search's matches: of its candidates, only rows of its scope's
// repositories (filtered in its expression for a few, after it for more),
// of a kind the caller may read there, live, not older than their source's
// epoch and ownership, of a source shown; its qualifiers by live rows; the
// page asked for in rank order, with the count. Incomplete when search does
// not index or its scope holds a source not known whole.

import { env } from "cloudflare:workers";
import {
  createIdFactory,
  type IssueRow,
  type PullRequestRow,
  type RepoRow,
  secureRandomBytes,
} from "@fyrden/domain";
import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_ORG_SHARD, readModelFor } from "../src/events/read-model.js";
import { epochStatement, repoStatements, type Snapshot } from "../src/queues/events-consumer.js";
import type { RepoEntry } from "../src/repos/directory.js";
import type { ScopedRepo } from "../src/search/authorization.js";
import { reserveInteractive } from "../src/search/interactive.js";
import { parseSearchQuery } from "../src/search/parser.js";
import { matchDocuments, matchRepositories, type People, RESULTS } from "../src/search/query.js";
import { docStatements } from "../src/search/statements.js";

const newId = createIdFactory(Date.now, secureRandomBytes);
const db = readModelFor(env, DEFAULT_ORG_SHARD);

/** The recovery generation this file's sources are shown at (one below it, hidden). */
const SHOWN = 1;
beforeAll(async () => {
  await db.prepare("UPDATE search_index_state SET recovery_gen = ? WHERE id = 1").bind(SHOWN).run();
});

/** A term no other test's documents hold. */
const term = () => `q${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;

interface Doc {
  readonly number: number;
  readonly title: string;
  readonly pull?: Partial<PullRequestRow>;
  readonly issue?: Partial<IssueRow>;
}

const issueRow = (number: number, title: string, over: Partial<IssueRow> = {}): IssueRow => ({
  number,
  title,
  body: null,
  state: "open",
  stateReason: null,
  duplicateOf: null,
  locked: false,
  lockReason: null,
  authorId: "usr_author",
  authorRoot: "usr_author",
  closedAt: null,
  closedBy: null,
  createdAt: 1,
  updatedAt: 2,
  assignees: [],
  labels: [],
  milestone: null,
  ...over,
});

const pullRow = (number: number, title: string, over: Partial<PullRequestRow> = {}) =>
  ({
    number,
    title,
    body: null,
    state: "open",
    draft: false,
    authorId: "usr_author",
    authorRoot: "usr_author",
    baseRef: "main",
    headRef: "topic",
    headRepoId: null,
    maintainerCanModify: false,
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    headRefDeleted: false,
    locked: false,
    lockReason: null,
    generation: 1,
    closedAt: null,
    mergeCommitSha: null,
    mergedBy: null,
    mergedAt: null,
    createdAt: 1,
    updatedAt: 2,
    labels: [],
    assignees: [],
    milestone: null,
    ...over,
  }) satisfies PullRequestRow;

async function write(repoId: string, doc: Doc, version = 1, epochGen = 1) {
  await db.batch(
    docStatements(
      db,
      { repoId, epochGen, ownerGen: 1, sourceSeq: version },
      {
        type: doc.pull ? "pull_request" : "issue",
        id: `${repoId}#${doc.number}`,
        version,
        deleted: false,
        row: (doc.pull
          ? pullRow(doc.number, doc.title, doc.pull)
          : issueRow(doc.number, doc.title, doc.issue)) as unknown as Record<string, unknown>,
      },
    ),
  );
}

/** A source of `docs`, indexed, certified and covered, shown: its id. */
async function source(docs: readonly Doc[]): Promise<string> {
  const repoId = newId("rep");
  await epochStatement(db, repoId, 1, 0).run();
  for (const doc of docs) await write(repoId, doc);
  await db
    .prepare(
      `INSERT INTO search_sources (repo_id, cutoff_epoch, cutoff_seq, index_covered, visible_gen)
       VALUES (?, 1, 0, 1, ?)`,
    )
    .bind(repoId, SHOWN)
    .run();
  return repoId;
}

const entry = (id: string, ownerId = "usr_owner"): RepoEntry =>
  ({ id, ownerId, ownerHandle: "owner", name: id }) as unknown as RepoEntry;

const scoped = (id: string, may: Partial<Omit<ScopedRepo, "entry">> = {}): ScopedRepo => ({
  entry: entry(id),
  metadata: true,
  issues: true,
  pulls: true,
  ...may,
});

const NOBODY: People = { authors: [], assignees: [] };

async function docs(
  q: string,
  scope: readonly ScopedRepo[],
  options: { people?: People; page?: number; perPage?: number; indexing?: boolean } = {},
) {
  const found = await matchDocuments(
    db,
    await reserveInteractive(db, 0),
    parseSearchQuery(q, "issues"),
    scope,
    options.people ?? NOBODY,
    { page: options.page ?? 1, perPage: options.perPage ?? 30 },
    options.indexing ?? true,
  );
  if (!found) throw new Error("no free text");
  return { ...found, numbers: found.items.map((i) => i.number) };
}

describe("an issue search's matches", () => {
  it("are of its scope's repositories alone, of the kinds the caller may read there", async () => {
    const t = term();
    const a = await source([
      { number: 1, title: t },
      { number: 2, title: t, pull: {} },
    ]);
    const b = await source([{ number: 3, title: t }]);
    expect((await docs(t, [scoped(a)])).numbers.sort()).toEqual([1, 2]);
    expect((await docs(t, [scoped(a), scoped(b)])).numbers.sort()).toEqual([1, 2, 3]);
    expect((await docs(t, [scoped(a, { issues: false })])).numbers).toEqual([2]);
    expect((await docs(`${t} is:issue`, [scoped(a)])).numbers).toEqual([1]);
    expect((await docs(`${t} is:issue`, [scoped(a, { issues: false })])).numbers).toEqual([]);
    // Each repository's own: issues of one, pull requests of the other.
    const mixed = await docs(t, [scoped(a, { pulls: false }), scoped(b, { issues: false })]);
    expect(mixed.numbers).toEqual([1]);
  });

  it("are filtered after ranking past the repositories its expression filters by", async () => {
    const t = term();
    const a = await source([{ number: 1, title: t }]);
    const b = await source([{ number: 2, title: t }]);
    const others = await Promise.all(
      // Each with a document indexed, so with a number: past the expression's.
      Array.from({ length: RESULTS.generatedRepos }, () => source([{ number: 1, title: "plain" }])),
    );
    const found = await docs(t, [scoped(a), ...others.map((id) => scoped(id))]);
    expect(found.numbers).toEqual([1]);
    expect(found.incomplete).toBe(false);
    // The one outside its scope ranked too, and left out.
    expect((await docs(t, [scoped(b)])).numbers).toEqual([2]);
  });

  it("are live, not older than their source's epoch and ownership, of a source shown", async () => {
    const t = term();
    const live = await source([{ number: 1, title: t }]);
    const stale = await source([{ number: 1, title: t }]);
    await epochStatement(db, stale, 2, 0).run();
    const moved = await source([{ number: 1, title: t }]);
    await db
      .prepare("INSERT INTO source_owner (source_id, owner_gen) VALUES (?, 2)")
      .bind(moved)
      .run();
    const hidden = await source([{ number: 1, title: t }]);
    await db
      .prepare("UPDATE search_sources SET visible_gen = ? WHERE repo_id = ?")
      .bind(SHOWN - 1, hidden)
      .run();
    const found = await docs(
      t,
      [live, stale, moved, hidden].map((id) => scoped(id)),
    );
    expect(found.items.map((i) => i.repoId)).toEqual([live]);
    // The hidden source is not known whole.
    expect(found.incomplete).toBe(true);
    expect((await docs(t, [scoped(live)])).incomplete).toBe(false);
  });

  it("hold their qualifiers by live rows", async () => {
    const t = term();
    const repo = await source([
      { number: 1, title: t, issue: { labels: [7], milestone: 3, assignees: ["usr_ann"] } },
      { number: 2, title: t, issue: { state: "closed", authorId: "usr_bo", labels: [8] } },
      { number: 3, title: t, pull: { state: "merged", mergedAt: 5 } },
      { number: 4, title: t, pull: { state: "closed" } },
    ]);
    const meta = (sql: string, ...values: unknown[]) =>
      db
        .prepare(sql)
        .bind(repo, ...values)
        .run();
    await meta(
      `INSERT INTO search_labels (repo_id, label_id, name, color, epoch_gen, owner_gen, version,
         updated_seq) VALUES (?, 7, 'Bug', 'ffffff', 1, 1, 1, 1)`,
    );
    await meta(
      `INSERT INTO search_labels (repo_id, label_id, deleted, epoch_gen, owner_gen, version,
         updated_seq) VALUES (?, 8, 1, 1, 1, 1, 1)`,
    );
    await meta(
      `INSERT INTO search_milestones (repo_id, number, title, state, epoch_gen, owner_gen,
         version, updated_seq) VALUES (?, 3, 'v1.0', 1, 1, 1, 1, 1)`,
    );
    const scope = [scoped(repo)];
    const numbers = async (q: string, people: People = NOBODY) =>
      (await docs(`${t} ${q}`, scope, { people })).numbers.sort();
    expect(await numbers("is:open")).toEqual([1]);
    expect(await numbers("is:closed")).toEqual([2, 3, 4]);
    expect(await numbers("is:merged")).toEqual([3]);
    expect(await numbers("is:open is:closed")).toEqual([]);
    expect(await numbers("label:bug")).toEqual([1]);
    expect(await numbers("label:#7")).toEqual([1]);
    // A deleted label matches no one, by id either.
    expect(await numbers("label:#8")).toEqual([]);
    expect(await numbers("milestone:V1.0")).toEqual([1]);
    expect(await numbers("milestone:3")).toEqual([1]);
    expect(await numbers("author:bo", { authors: ["usr_bo"], assignees: [] })).toEqual([2]);
    expect(await numbers("assignee:ann", { authors: [], assignees: ["usr_ann"] })).toEqual([1]);
    expect(await numbers("author:nobody", { authors: [null], assignees: [] })).toEqual([]);
  });

  it("are paged in rank order, counted whole", async () => {
    const t = term();
    const repo = await source(
      Array.from({ length: 5 }, (_, i) => ({
        number: i + 1,
        // Fewer occurrences of the term in a longer title rank lower.
        title: `${`${t} `.repeat(5 - i)}${"filler ".repeat(i * 3)}`,
      })),
    );
    const all = await docs(t, [scoped(repo)]);
    expect(all.numbers).toEqual([1, 2, 3, 4, 5]);
    expect(all.totalCount).toBe(5);
    const second = await docs(t, [scoped(repo)], { page: 2, perPage: 2 });
    expect(second).toMatchObject({ totalCount: 5, numbers: [3, 4] });
    const past = await docs(t, [scoped(repo)], { page: 4, perPage: 2 });
    expect(past).toMatchObject({ totalCount: 5, numbers: [] });
  });

  it("are counted to the depth at most, the pages within it", async () => {
    const t = term();
    const repoId = newId("rep");
    await epochStatement(db, repoId, 1, 0).run();
    // Written a hundred to a batch.
    const many = async (from: number, to: number) => {
      for (let start = from; start <= to; start += 100) {
        const group: D1PreparedStatement[] = [];
        for (let n = start; n <= Math.min(to, start + 99); n++)
          group.push(
            ...docStatements(
              db,
              { repoId, epochGen: 1, ownerGen: 1, sourceSeq: n },
              {
                type: "issue",
                id: `${repoId}#${n}`,
                version: 1,
                deleted: false,
                row: issueRow(n, t) as unknown as Record<string, unknown>,
              },
            ),
          );
        await db.batch(group);
      }
    };
    await many(1, RESULTS.depth);
    await db
      .prepare(
        `INSERT INTO search_sources (repo_id, cutoff_epoch, cutoff_seq, index_covered, visible_gen)
         VALUES (?, 1, 0, 1, ?)`,
      )
      .bind(repoId, SHOWN)
      .run();
    const at = (page: number, perPage = 100) => docs(t, [scoped(repoId)], { page, perPage });
    expect(await at(10)).toMatchObject({ totalCount: RESULTS.depth, incomplete: false });
    expect((await at(10)).items).toHaveLength(100);
    await many(RESULTS.depth + 1, RESULTS.depth + 1);
    const last = await at(10);
    expect(last).toMatchObject({ totalCount: RESULTS.depth, incomplete: true });
    expect(last.items).toHaveLength(100);
    // Past the depth, nothing: the one more is only counted.
    expect((await at(11)).items).toEqual([]);
    expect((await at(34, 30)).items).toHaveLength(10);
  });

  it("are known whole or not as the statement that takes them finds their sources", async () => {
    const t = term();
    const repo = await source([{ number: 1, title: t }]);
    // A write just before the last batch (the scope's numbers, the ranking, then it).
    const before = (write: () => Promise<unknown>) => {
      let calls = 0;
      return new Proxy(db, {
        get(target, prop) {
          const value = Reflect.get(target, prop);
          if (prop !== "batch") return typeof value === "function" ? value.bind(target) : value;
          return async (statements: D1PreparedStatement[]) => {
            if (++calls === 3) await write();
            return target.batch(statements);
          };
        },
      });
    };
    const run = async (using: D1Database) => {
      const found = await matchDocuments(
        using,
        await reserveInteractive(db, 0),
        parseSearchQuery(t, "issues"),
        [scoped(repo)],
        NOBODY,
        { page: 1, perPage: 30 },
        true,
      );
      return { incomplete: found?.incomplete, numbers: found?.items.map((i) => i.number) };
    };
    expect(await run(db)).toEqual({ incomplete: false, numbers: [1] });
    expect(
      await run(
        before(() =>
          db
            .prepare(
              `INSERT INTO search_repairs (repo_id, dirty, covered, reason, since, next_at)
               VALUES (?, 2, 1, 'test', 0, 0)`,
            )
            .bind(repo)
            .run(),
        ),
      ),
    ).toEqual({ incomplete: true, numbers: [1] });
    expect(
      await run(
        before(() =>
          db
            .prepare("UPDATE search_sources SET visible_gen = ? WHERE repo_id = ?")
            .bind(SHOWN - 1, repo)
            .run(),
        ),
      ),
    ).toEqual({ incomplete: true, numbers: [] });
  });

  it("read a bounded amount however large the scope", async () => {
    const t = term();
    const repos = await Promise.all(
      Array.from({ length: 20 }, (_, i) => source([{ number: 1, title: `${t} ${i}` }])),
    );
    // The most a scope holds, its other repositories never projected.
    const scope = [
      ...repos.map((id) => scoped(id)),
      ...Array.from({ length: 1_000 - repos.length }, () => scoped(newId("rep"))),
    ];
    const found = await docs(t, scope);
    expect(found.numbers).toHaveLength(repos.length);
    // About five reads a scope repository (its number, source, repair, visibility) and a few a
    // candidate, with the ranking's (measured: 5,335).
    expect(found.reads).toBeLessThanOrEqual(6 * scope.length + 100 * repos.length);
  });

  it("are incomplete when search does not index or a source is not known whole", async () => {
    const t = term();
    const repo = await source([{ number: 1, title: t }]);
    expect((await docs(t, [scoped(repo)], { indexing: false })).incomplete).toBe(true);
    await db
      .prepare(
        `INSERT INTO search_repairs (repo_id, dirty, covered, reason, since, next_at)
         VALUES (?, 2, 1, 'test', 0, 0)`,
      )
      .bind(repo)
      .run();
    const pending = await docs(t, [scoped(repo)]);
    expect(pending).toMatchObject({ incomplete: true, numbers: [1] });
    // One never certified.
    const uncertified = newId("rep");
    expect((await docs(t, [scoped(uncertified)])).incomplete).toBe(true);
  });

  it("are none, the refusal said, for a query too broad", async () => {
    const stem = term();
    const repo = await source([
      {
        number: 1,
        title: "plain",
        issue: { body: Array.from({ length: 1_001 }, (_, i) => `${stem}${i}`).join(" ") },
      },
    ]);
    const refused = await docs(`${stem}*`, [scoped(repo)]);
    expect(refused).toMatchObject({ refused: "prefix_too_broad", numbers: [], totalCount: 0 });
  });
});

const OWNER = "usr_01K742SG00NAWD8WB4RTMJF8H9";

const repoRow = (name: string, ownerId = OWNER): RepoRow => ({
  ownerId,
  name,
  visibility: "private",
  defaultBranch: "refs/heads/main",
  pushedAt: null,
  createdAt: 1,
  description: null,
});

/** A repository of `name`, in the repository index, certified and shown: its id. */
async function repository(name: string, ownerId = OWNER): Promise<string> {
  const repoId = newId("rep");
  await epochStatement(db, repoId, 1, 0).run();
  const snapshot: Snapshot = {
    id: { sourceId: repoId, epochGen: 1, sourceSeq: 1 },
    type: "repo.updated",
    at: 0,
    actor: null,
    actChain: [],
    ownerGen: 1,
    entity: {
      type: "repo",
      id: repoId,
      version: 1,
      deleted: false,
      row: repoRow(name, ownerId) as unknown as Record<string, unknown>,
    },
    data: null,
    stored: false,
  };
  await db.batch(repoStatements(db, repoId, snapshot, 0, true));
  await db
    .prepare(
      `INSERT INTO search_sources (repo_id, cutoff_epoch, cutoff_seq, index_covered, visible_gen)
       VALUES (?, 1, 0, 1, ?)`,
    )
    .bind(repoId, SHOWN)
    .run();
  return repoId;
}

describe("a repository search's matches", () => {
  it("are its scope's repositories whose metadata the caller may read", async () => {
    const t = term();
    const [a, b] = [await repository(`${t}-a`), await repository(`${t}-b`)];
    const other = await repository(`${t}-c`, "org_01K742SG00NAWD8WB4RTMJF8HA");
    const repos = async (scope: ScopedRepo[]) => {
      const found = await matchRepositories(
        db,
        await reserveInteractive(db, 0),
        parseSearchQuery(t, "repositories"),
        scope,
        { page: 1, perPage: 30 },
        true,
      );
      return found?.items.map((i) => i.repoId).sort();
    };
    const of = (id: string, ownerId = OWNER, metadata = true): ScopedRepo => ({
      entry: entry(id, ownerId),
      metadata,
      issues: metadata,
      pulls: metadata,
    });
    // One owner's (its token generated): the others' never.
    expect(await repos([of(a)])).toEqual([a]);
    expect(await repos([of(a), of(b)])).toEqual([a, b].sort());
    expect(await repos([of(a), of(other, "org_01K742SG00NAWD8WB4RTMJF8HA")])).toEqual(
      [a, other].sort(),
    );
    expect(await repos([of(a), of(b, OWNER, false)])).toEqual([a]);
  });
});
