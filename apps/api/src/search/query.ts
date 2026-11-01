import { SAME_DAY } from "./admission.js";
import type { ScopedRepo } from "./authorization.js";
import type { GeneratedFilters } from "./compiler.js";
import { type InteractiveReservation, readOnDay } from "./interactive.js";
import type { ParsedQuery } from "./parser.js";
import { RANKING, type RankingCharge, rankCandidates } from "./ranking.js";
import type { IndexingState } from "./repairs.js";
import { DOC_KIND, DOC_STATE } from "./statements.js";
import { SOURCE_VISIBLE } from "./visibility.js";

/*
 * A ranked search's matches: the index's best candidates (by its scope's
 * repositories, or their owner, and its kinds as generated filters when
 * they fit), then of those only what the caller may read now: rows of its
 * scope's repositories, of a kind it may read there, live, not older than
 * their source's epoch and ownership, of a source shown; then its
 * qualifiers, by live rows alike. Counted to `RESULTS.depth` at most, the
 * page asked for in rank order. Incomplete when search does not index, when
 * its scope holds a source not known whole (uncertified, not covered, a
 * repair pending, hidden since a recovery), when the candidates were all a
 * search takes (others may have been crowded out), or when the matches are
 * more than it counts.
 */

export const RESULTS = {
  /** Matches a search counts and pages through at most. */
  depth: 1_000,
  /** Scope repositories a search filters by in its expression at most, past which it filters after. */
  generatedRepos: 50,
  /** A listing's rows examined at most (from its first). */
  listing: 5_000,
} as const;

export interface PageRequest {
  readonly page: number;
  readonly perPage: number;
}

export interface Matches<T> {
  /** Why the query was refused, if it was (nothing matched). */
  readonly refused?: "prefix_too_broad" | "query_too_broad" | "sort_needs_scope";
  readonly totalCount: number;
  readonly incomplete: boolean;
  readonly items: readonly T[];
  /** Rows its statements read. */
  readonly reads: number;
  readonly charge?: RankingCharge;
}

export interface DocMatch {
  readonly docId: number;
  readonly repoId: string;
  readonly number: number;
  readonly kind: number;
}

export interface RepoMatch {
  readonly repoId: string;
}

/** The principals an issue search's `author:` and `assignee:` name (null: a handle naming no one). */
export interface People {
  readonly authors: readonly (string | null)[];
  readonly assignees: readonly (string | null)[];
}

/** SQL true while `row` is live and not older than its source's (`repo`) epoch and ownership. */
export const fenced = (row: string, repo: string) => `${row}.deleted = 0
  AND ${row}.epoch_gen >= coalesce((SELECT e.epoch_gen FROM consumer_epochs e
    WHERE e.source_id = ${repo}), 0)
  AND ${row}.owner_gen >= coalesce((SELECT o.owner_gen FROM source_owner o
    WHERE o.source_id = ${repo}), 0)`;

/**
 * SQL: 1 when every repository of the JSON array `ids` has a source known
 * whole, at the indexing generation `gen`, and shown.
 */
const WHOLE = (ids: string, gen: string) => `SELECT coalesce(min(s.repo_id IS NOT NULL
    AND s.index_covered = 1 AND s.indexing_gen = ${gen}
    AND ${SOURCE_VISIBLE("j.value")} AND NOT EXISTS (SELECT 1 FROM search_repairs r
      WHERE r.repo_id = j.value AND r.dirty > r.covered)), 1)
  FROM json_each(${ids}) j LEFT JOIN search_sources s ON s.repo_id = j.value`;

/** SQL: a repository (an expression) among the JSON array `ids`. */
const among = (repo: string, ids: string) => `${repo} IN (SELECT value FROM json_each(${ids}))`;

interface ScopeNumbers {
  /** Each scope repository's search number (those with one), and whether it is in the repository index. */
  readonly nums: ReadonlyMap<string, { readonly num: number; readonly indexed: boolean }>;
  /** The search number of `owner`, if asked for and it has one. */
  readonly owner: number | null;
  readonly reads: number;
}

/** The search numbers of the scope repositories `ids` (and of `owner`). */
async function scopeNumbers(
  db: D1Database,
  reservation: InteractiveReservation,
  ids: readonly string[],
  owner: string | null = null,
): Promise<ScopeNumbers> {
  const [repos, owners] = await readOnDay(db, reservation, [
    db
      .prepare(
        `SELECT n.repo_id, n.num, n.indexed FROM search_repo_nums n
         WHERE ${among("n.repo_id", "?1")}`,
      )
      .bind(JSON.stringify(ids)),
    db.prepare("SELECT num FROM search_owner_nums WHERE owner_id = ?1").bind(owner),
  ]);
  const rows = (repos?.results ?? []) as { repo_id: string; num: number; indexed: number }[];
  return {
    nums: new Map(rows.map((r) => [r.repo_id, { num: r.num, indexed: r.indexed === 1 }])),
    owner: (owners?.results[0] as { num: number } | undefined)?.num ?? null,
    reads: (repos?.meta.rows_read ?? 0) + (owners?.meta.rows_read ?? 0),
  };
}

/**
 * The statement counting `matched` (candidates' rows, by `ord`, at most
 * `RESULTS.depth` and one more to tell there are more) and taking the page
 * asked for of the first `RESULTS.depth`, with whether the scope's sources
 * (the JSON array `?4`) are known whole at the indexing generation `?9`, in
 * the same snapshot. Binds: candidates `?1`, the day `?5`, the depth `?6`,
 * the page `?7` and `?8`.
 */
const paged = (matched: string) => `WITH matched AS MATERIALIZED (${matched}
    ORDER BY c.ord LIMIT ?6 + 1)
  SELECT (SELECT count(*) FROM matched) AS total, (${WHOLE("?4", "?9")}) AS whole, m.*
  FROM (SELECT 1) LEFT JOIN (SELECT * FROM (SELECT * FROM matched ORDER BY ord LIMIT ?6)
    ORDER BY ord LIMIT ?7 OFFSET ?8) m
  ORDER BY m.ord`;

/** The candidates of `paged` (`c`: their rank order, `ord`, and their rowid, `id`), read on the day. */
const CANDIDATES = `(SELECT CAST(key AS INTEGER) AS ord, value AS id FROM json_each(?1)
  WHERE ${SAME_DAY(5)}) c`;

const pageBinds = (
  candidates: readonly number[],
  scopes: readonly [unknown, unknown, unknown],
  request: PageRequest,
  reservation: InteractiveReservation,
  indexing: IndexingState,
): unknown[] => [
  JSON.stringify(candidates),
  ...scopes.map((ids) => JSON.stringify(ids)),
  reservation.day,
  RESULTS.depth,
  request.perPage,
  (request.page - 1) * request.perPage,
  indexing.gen,
];

/** A page's matches from its statement's rows (`total`, `whole`, then a match's columns, or none). */
function pageOf<T>(
  rows: readonly Record<string, unknown>[],
  item: (row: Record<string, unknown>) => T | null,
  incomplete: boolean,
  reads: number,
): Matches<T> {
  const total = Number(rows[0]?.total ?? 0);
  return {
    totalCount: Math.min(total, RESULTS.depth),
    incomplete: incomplete || rows[0]?.whole !== 1 || total > RESULTS.depth,
    items: rows.flatMap((r) => item(r) ?? []),
    reads,
  };
}

/** No matches (nothing read past the scope's numbers, or a refusal). */
const none = <T>(incomplete: boolean, reads: number): Matches<T> => ({
  totalCount: 0,
  incomplete,
  items: [],
  reads,
});

const QUERY_KINDS = { issue: DOC_KIND.issue, pr: DOC_KIND.pull } as const;

/** A listing's order: by when its items were made or last updated. */
export interface ListingOrder {
  readonly sort: "created" | "updated";
  readonly direction: "asc" | "desc";
}

/** Each listing's index, by the state it lists and its order (each holds the repository first). */
const LISTING_INDEX = {
  open: {
    column: "open_state",
    value: 1,
    created: "search_docs_open_created",
    updated: "search_docs_open_updated",
  },
  closed: {
    column: "open_state",
    value: 2,
    created: "search_docs_open_created",
    updated: "search_docs_open_updated",
  },
  merged: {
    column: "state",
    value: DOC_STATE.merged,
    created: "search_docs_state_created",
    updated: "search_docs_state_updated",
  },
} as const;

/**
 * The first rows of one repository's listing of one state, in `order` (the
 * newest first, or the oldest), at most `RESULTS.listing` and one more to
 * tell there are more: their documents' ids.
 */
async function listed(
  db: D1Database,
  reservation: InteractiveReservation,
  repoId: string,
  state: keyof typeof LISTING_INDEX,
  order: ListingOrder,
): Promise<{ ids: number[]; more: boolean; reads: number }> {
  const index = LISTING_INDEX[state];
  const column = order.sort === "created" ? "created_at" : "updated_at";
  const direction = order.direction === "asc" ? "ASC" : "DESC";
  const [result] = await readOnDay(db, reservation, [
    db
      .prepare(
        `SELECT d.doc_id FROM search_docs d INDEXED BY ${index[order.sort]}
         WHERE d.repo_id = ?1 AND d.${index.column} = ?2 AND d.deleted = 0 AND ${SAME_DAY(3)}
         ORDER BY d.${column} ${direction}, d.doc_id ${direction} LIMIT ?4 + 1`,
      )
      .bind(repoId, index.value, reservation.day, RESULTS.listing),
  ]);
  const ids = ((result?.results ?? []) as { doc_id: number }[]).map((r) => r.doc_id);
  return {
    ids: ids.slice(0, RESULTS.listing),
    more: ids.length > RESULTS.listing,
    reads: result?.meta.rows_read ?? 0,
  };
}

/**
 * An issue search's matches in `scoped` (what the caller may read of
 * each), `people` its handles' principals, the page asked for: by rank,
 * or, with no free text or an `order` asked for, one repository's listing
 * of one state in that order (the newest updated first by default), its
 * first `RESULTS.listing` rows examined (and the free text held within
 * them). A listing needs its scope to be one named repository, and one
 * state (`sort_needs_scope`).
 */
export async function matchDocuments(
  db: D1Database,
  reservation: InteractiveReservation,
  parsed: ParsedQuery,
  scoped: readonly ScopedRepo[],
  people: People,
  request: PageRequest,
  indexing: IndexingState,
  order?: ListingOrder,
): Promise<Matches<DocMatch>> {
  const listing =
    order ?? (parsed.text.length === 0 ? { sort: "updated", direction: "desc" } : undefined);
  const [state] = parsed.states;
  // One repository named (however written), one state; what the scope leaves of it may be none.
  const named = new Set(parsed.repos.map((r) => `${r.owner}/${r.name}`.toLowerCase()));
  if (listing && (named.size !== 1 || parsed.states.length !== 1))
    return { ...none(false, 0), refused: "sort_needs_scope" };
  // The kinds asked for (repeated, each of them), of those each repository's the caller may read.
  const asked = [DOC_KIND.issue, DOC_KIND.pull].filter((k) =>
    parsed.kinds.every((q) => QUERY_KINDS[q] === k),
  );
  const readable = scoped.flatMap((r) => {
    const kinds = asked.filter((k) => (k === DOC_KIND.issue ? r.issues : r.pulls));
    return kinds.length > 0 ? [{ id: r.entry.id, kinds, everyKind: r.issues && r.pulls }] : [];
  });
  if (readable.length === 0) return none(!indexing.on, 0);
  const ids = readable.map((r) => r.id);
  const scope = await scopeNumbers(db, reservation, ids);
  let reads = scope.reads;
  let incomplete = !indexing.on;
  let candidates: readonly number[] = [];
  const nums = readable.flatMap((r) => scope.nums.get(r.id)?.num ?? []);
  // Something of theirs indexed, and every handle naming someone: else nothing matches.
  if (nums.length > 0 && ![...people.authors, ...people.assignees].includes(null)) {
    const [first] = readable;
    const kinds = first?.kinds ?? [];
    const generated: GeneratedFilters = {
      ...(nums.length <= RESULTS.generatedRepos && { repos: nums }),
      ...(kinds.length === 1 &&
        readable.every((r) => r.kinds.length === 1 && r.kinds[0] === kinds[0]) && { kinds }),
    };
    let within: readonly number[] | undefined;
    if (listing && first && state) {
      const examined = await listed(db, reservation, first.id, state, listing);
      reads += examined.reads;
      // Rows of a kind the caller may not read count against what is examined (whatever kinds it
      // asks for): whether they passed it would tell of them, so it is never said complete then.
      if (examined.more || !first.everyKind) incomplete = true;
      within = examined.ids;
    }
    const ranked =
      within !== undefined && parsed.text.length === 0
        ? null
        : await rankCandidates(db, reservation, "issues", parsed, generated, RANKING, within);
    if (ranked) {
      reads += ranked.reads;
      if (ranked.refused)
        return { ...none(incomplete, reads), refused: ranked.refused, charge: ranked.charge };
      if (within === undefined && ranked.candidates.length >= RANKING.candidates) incomplete = true;
      candidates = ranked.candidates.map((c) => c.rowid);
    } else candidates = within ?? [];
  }
  const binds = pageBinds(
    candidates,
    [
      readable.filter((r) => r.kinds.includes(DOC_KIND.issue)).map((r) => r.id),
      readable.filter((r) => r.kinds.includes(DOC_KIND.pull)).map((r) => r.id),
      ids,
    ],
    request,
    reservation,
    indexing,
  );
  const bind = (value: unknown) => `?${binds.push(value)}`;
  const where = [
    `((d.kind = ${DOC_KIND.issue} AND ${among("d.repo_id", "?2")})
      OR (d.kind = ${DOC_KIND.pull} AND ${among("d.repo_id", "?3")}))`,
    fenced("d", "d.repo_id"),
    SOURCE_VISIBLE("d.repo_id"),
  ];
  for (const state of parsed.states)
    where.push(
      state === "merged"
        ? `d.state = ${DOC_STATE.merged}`
        : `d.open_state = ${state === "open" ? 1 : 2}`,
    );
  // A label by id: held, and live (its row by key); by name: one of the labels so named in the
  // scope's repositories (resolved once, through their index of names), held.
  for (const label of parsed.labels)
    where.push(
      "id" in label
        ? `EXISTS (SELECT 1 FROM json_each(d.labels) l WHERE l.value = ${bind(label.id)})
           AND EXISTS (SELECT 1 FROM search_labels sl WHERE sl.repo_id = d.repo_id
             AND sl.label_id = ${bind(label.id)} AND ${fenced("sl", "d.repo_id")})`
        : `EXISTS (SELECT 1 FROM json_each(d.labels) l WHERE (d.repo_id, l.value) IN (
             SELECT sl.repo_id, sl.label_id FROM search_labels sl INDEXED BY search_labels_name
             WHERE ${among("sl.repo_id", "?4")} AND sl.name = ${bind(label.name)} COLLATE NOCASE
               AND ${fenced("sl", "sl.repo_id")}))`,
    );
  for (const milestone of parsed.milestones)
    where.push(`EXISTS (SELECT 1 FROM search_milestones m
      WHERE m.repo_id = d.repo_id AND m.number = d.milestone AND ${fenced("m", "d.repo_id")} AND ${
        "number" in milestone
          ? `m.number = ${bind(milestone.number)}`
          : `m.title = ${bind(milestone.title)} COLLATE NOCASE`
      })`);
  for (const author of people.authors) where.push(`d.author_id = ${bind(author)}`);
  for (const assignee of people.assignees)
    where.push(`EXISTS (SELECT 1 FROM json_each(d.assignees) a WHERE a.value = ${bind(assignee)})`);
  const [result] = await readOnDay(db, reservation, [
    db
      .prepare(
        paged(`SELECT c.ord, d.doc_id, d.repo_id, d.number, d.kind
          FROM ${CANDIDATES} JOIN search_docs d ON d.doc_id = c.id
          WHERE ${where.join(" AND ")}`),
      )
      .bind(...binds),
  ]);
  reads += result?.meta.rows_read ?? 0;
  return pageOf(
    result?.results ?? [],
    (r) =>
      r.doc_id === null
        ? null
        : {
            docId: r.doc_id as number,
            repoId: r.repo_id as string,
            number: r.number as number,
            kind: r.kind as number,
          },
    incomplete,
    reads,
  );
}

/**
 * A repository search's ranked matches in `scoped` (those whose metadata
 * the caller may read), the page asked for; null when it has no free text.
 */
export async function matchRepositories(
  db: D1Database,
  reservation: InteractiveReservation,
  parsed: ParsedQuery,
  scoped: readonly ScopedRepo[],
  request: PageRequest,
  indexing: IndexingState,
): Promise<Matches<RepoMatch> | null> {
  if (parsed.text.length === 0) return null;
  const readable = scoped.filter((r) => r.metadata).map((r) => r.entry);
  if (readable.length === 0) return none(!indexing.on, 0);
  const ids = readable.map((r) => r.id);
  const owners = new Set(readable.map((r) => r.ownerId));
  const scope = await scopeNumbers(
    db,
    reservation,
    ids,
    owners.size === 1 ? ([...owners][0] as string) : null,
  );
  let reads = scope.reads;
  let incomplete = !indexing.on;
  let candidates: readonly number[] = [];
  // Something of theirs in the repository index: else nothing matches.
  if ([...scope.nums.values()].some((n) => n.indexed)) {
    const ranked = await rankCandidates(
      db,
      reservation,
      "repositories",
      parsed,
      scope.owner === null ? {} : { owner: scope.owner },
    );
    if (ranked) {
      reads += ranked.reads;
      if (ranked.refused)
        return { ...none(incomplete, reads), refused: ranked.refused, charge: ranked.charge };
      if (ranked.candidates.length >= RANKING.candidates) incomplete = true;
      candidates = ranked.candidates.map((c) => c.rowid);
    }
  }
  const [result] = await readOnDay(db, reservation, [
    db
      .prepare(
        paged(`SELECT c.ord, r.repo_id
          FROM ${CANDIDATES} JOIN search_repo_nums n ON n.num = c.id AND n.indexed = 1
          JOIN repos r ON r.repo_id = n.repo_id
          WHERE ${among("r.repo_id", "?2")} AND ${fenced("r", "r.repo_id")}
            AND ${SOURCE_VISIBLE("r.repo_id")}`),
      )
      .bind(...pageBinds(candidates, [ids, [], ids], request, reservation, indexing)),
  ]);
  reads += result?.meta.rows_read ?? 0;
  return pageOf(
    result?.results ?? [],
    (r) => (r.repo_id === null ? null : { repoId: r.repo_id as string }),
    incomplete,
    reads,
  );
}
