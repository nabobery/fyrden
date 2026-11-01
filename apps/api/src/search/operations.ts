import {
  type Input,
  MAX_PAGE_BYTES,
  type Output,
  type searchIssues,
  type searchRepositories,
} from "@fyrden/api-contract";
import { DEFAULT_ORG_SHARD, readModelFor } from "../events/read-model.js";
import { type OpContext, OperationError } from "../ops/execute.js";
import { findReposById, type RepoEntry } from "../repos/directory.js";
import { principalsByLogin } from "../repos/reviews.js";
import { authorizeScope } from "./authorization.js";
import { hydrateIssues, hydrateRepositories } from "./hydrate.js";
import {
  InteractiveDayEnded,
  type InteractiveReservation,
  reserveInteractive,
  settleInteractive,
} from "./interactive.js";
import {
  type ParsedQuery,
  parseSearchQuery,
  SearchQueryError,
  type SearchTarget,
} from "./parser.js";
import { type Matches, matchDocuments, matchRepositories } from "./query.js";
import { type IndexingState, searchIndexingState } from "./repairs.js";

/*
 * The search operations: a principal's searches rate limited
 * (`RATE_LIMIT_SEARCH`, its tokens and agents' delegations alike), its
 * query parsed, its scope authorized afresh, then within a reservation of
 * the day's searches' reads (the most a search reads, Proposed; settled at
 * what it read): its matches and their hydration, a page past
 * `MAX_PAGE_BYTES` as JSON refused whole (`page_too_large`). A search whose
 * reservation's day ends while it reads is run once more on the new day.
 */

/**
 * The reads a search reserves (Proposed): its scope's (about 6 a
 * repository), its ranking's or listing's (about 4 a document scored, at
 * most `RANKING.matches`, and a listing's 5,001 rows), its candidates' (about
 * 4 each) and its page's, at most.
 */
export const SEARCH_RESERVE: Record<SearchTarget, number> = {
  issues: 100_000,
  repositories: 100_000,
};

const SEARCH_RATE_RETRY = 60;

/** The `search.issues` operation. */
export async function searchIssuesOperation(
  ctx: OpContext,
  input: Input<typeof searchIssues>,
): Promise<Output<typeof searchIssues>> {
  const parsed = await admitted(ctx, input.q, "issues");
  const order = input.sort && { sort: input.sort, direction: input.order };
  const scoped = await authorizeScope(ctx, parsed);
  const repos = new Map(scoped.map((r) => [r.entry.id, r.entry]));
  const handles = [...parsed.authors, ...parsed.assignees];
  const found = handles.length > 0 ? await principalsByLogin(ctx, handles, true) : new Map();
  const id = (handle: string): string | null => found.get(handle.toLowerCase()) ?? null;
  const people = { authors: parsed.authors.map(id), assignees: parsed.assignees.map(id) };
  return reading(ctx, "issues", async (db, reservation, indexing) => {
    const matches = await matchDocuments(
      db,
      reservation,
      parsed,
      scoped,
      people,
      { page: input.page, perPage: input.per_page },
      indexing,
      order || (parsed.text.length === 0 ? { sort: "updated", direction: input.order } : undefined),
    );
    return pageOf(ctx, repos, matches, (items) =>
      hydrateIssues(ctx, db, reservation, items, repos),
    );
  });
}

/** The `search.repositories` operation. */
export async function searchRepositoriesOperation(
  ctx: OpContext,
  input: Input<typeof searchRepositories>,
): Promise<Output<typeof searchRepositories>> {
  const parsed = await admitted(ctx, input.q, "repositories");
  const scoped = await authorizeScope(ctx, parsed);
  const repos = new Map(scoped.map((r) => [r.entry.id, r.entry]));
  return reading(ctx, "repositories", async (db, reservation, indexing) => {
    const matches = await matchRepositories(
      db,
      reservation,
      parsed,
      scoped,
      { page: input.page, perPage: input.per_page },
      indexing,
    );
    return pageOf(ctx, repos, matches, (items) =>
      hydrateRepositories(db, reservation, items, repos),
    );
  });
}

/** The query, parsed, once the principal's searches are within their rate. */
async function admitted(ctx: OpContext, q: string, target: SearchTarget): Promise<ParsedQuery> {
  if (!(await ctx.env.RATE_LIMIT_SEARCH.limit({ key: ctx.auth.principalId })).success)
    throw new OperationError(
      429,
      "search_rate_limited",
      "Too many searches. Try again in a minute.",
      undefined,
      undefined,
      SEARCH_RATE_RETRY,
    );
  let parsed: ParsedQuery;
  try {
    parsed = parseSearchQuery(q, target);
  } catch (error) {
    if (error instanceof SearchQueryError) throw new OperationError(422, error.code, error.message);
    throw error;
  }
  if (target === "repositories" && parsed.text.length === 0)
    throw new OperationError(
      422,
      "search_text_required",
      "A repository search needs text to match, besides its qualifiers.",
    );
  return parsed;
}

interface Page<T> {
  readonly result: { total_count: number; incomplete_results: boolean; items: T[] };
  readonly reads: number;
}

/** A page of `matches`, hydrated; refused when the query was. */
async function pageOf<M, T>(
  ctx: OpContext,
  repos: ReadonlyMap<string, RepoEntry>,
  matches: Matches<M> | null,
  hydrate: (items: readonly M[]) => Promise<{ items: T[]; reads: number }>,
): Promise<Page<T>> {
  if (!matches) throw new Error("a repository search with text matched nothing ranked");
  if (matches.refused === "sort_needs_scope")
    throw new Refused(
      matches.reads,
      new OperationError(
        422,
        "sort_needs_scope",
        "A search without text, or sorted, needs one repository (repo:owner/name) and one state (is:open, is:closed or is:merged).",
      ),
    );
  if (matches.refused === "prefix_too_broad")
    throw new Refused(
      matches.reads,
      new OperationError(
        422,
        "prefix_too_broad",
        "A word ending in * stands for too many words here. Write more of it.",
      ),
    );
  if (matches.refused === "query_too_broad")
    throw new Refused(
      matches.reads,
      new OperationError(
        422,
        "query_too_broad",
        "The query matches too much to rank. Add words, or narrow its scope.",
      ),
    );
  const hydrated = await hydrate(matches.items);
  const reads = matches.reads + hydrated.reads;
  // The scope's repositories as the directory's primary has them after everything was read: one
  // gone, or another owner's since the search was authorized, makes the whole answer (its count
  // and completeness too) one decided for another state of things: refused, to be asked again.
  const now = new Map(
    (await findReposById(ctx.env, [...repos.keys()], ctx.metrics)).map((e) => [e.id, e]),
  );
  for (const [id, entry] of repos)
    if (now.get(id)?.ownerId !== entry.ownerId)
      throw new Refused(
        reads,
        new OperationError(
          503,
          "search_authorization_unavailable",
          "A repository searched changed hands or was deleted meanwhile. Try again.",
        ),
      );
  const { items } = hydrated;
  // Refused whole past the bound, never shortened.
  if (new TextEncoder().encode(JSON.stringify(items)).byteLength > MAX_PAGE_BYTES)
    throw new Refused(
      reads,
      new OperationError(
        422,
        "page_too_large",
        "This page of results is larger than 1 MiB. Ask for fewer a page (per_page).",
      ),
    );
  return {
    result: {
      total_count: matches.totalCount,
      incomplete_results: matches.incomplete,
      items,
    },
    reads,
  };
}

/** A refusal after reads, which its settlement charges. */
class Refused extends Error {
  constructor(
    readonly reads: number,
    readonly refusal: OperationError,
  ) {
    super(refusal.message);
  }
}

/**
 * `search`'s page, read within a reservation of the day's searches' reads,
 * settled at what it read; once more on the new day when its day ends.
 */
async function reading<T>(
  ctx: OpContext,
  target: SearchTarget,
  search: (
    db: D1Database,
    reservation: InteractiveReservation,
    indexing: IndexingState,
  ) => Promise<Page<T>>,
): Promise<Page<T>["result"]> {
  ctx.metrics.count("d1.query", { db: "directory", op: "search_indexing" });
  const indexing = await searchIndexingState(ctx.env);
  const db = readModelFor(ctx.env, DEFAULT_ORG_SHARD);
  for (let attempt = 0; ; attempt++) {
    const reservation = await reserveInteractive(db, SEARCH_RESERVE[target]);
    let reads = 0;
    try {
      const page = await search(db, reservation, indexing);
      reads = page.reads;
      return page.result;
    } catch (error) {
      if (error instanceof Refused) {
        reads = error.reads;
        throw error.refusal;
      }
      // What its last batch read is the new day's already; the rest is unknown, so charged whole.
      reads = reservation.reads;
      if (error instanceof InteractiveDayEnded && attempt === 0) continue;
      throw error;
    } finally {
      // A settlement that fails leaves the reservation spent.
      await settleInteractive(db, reservation, reads).catch(() => {});
    }
  }
}
