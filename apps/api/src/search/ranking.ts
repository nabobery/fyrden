import { SAME_DAY } from "./admission.js";
import { compileClauses, type GeneratedFilters } from "./compiler.js";
import { type InteractiveReservation, readOnDay } from "./interactive.js";
import type { ParsedQuery, SearchTarget } from "./parser.js";

/*
 * A ranked search's admission and its candidates, in one statement (so one
 * snapshot: no write between the decision and the ranking): what each
 * clause of its FTS5 expression would cover, by its index's vocabulary
 * (`cnt`, the occurrences of a term in all its columns: a clause covers its
 * terms', each as often as it is written, a prefix's every term's, and a
 * generated filter's every token's), bounded a clause and the whole
 * expression; then, only when that was admitted and the search's
 * reservation's day is still today, the index's best candidates by rank,
 * at most `RANKING.candidates`. A query refused takes no candidates, and
 * matches a token no repository or owner is ever given (`r0`, `o0`).
 */

export const RANKING = {
  /** Candidates a ranked search takes from its index at most. */
  candidates: 10_000,
  /** The terms a prefix may stand for, past which it is refused (`prefix_too_broad`). */
  expansions: 1_000,
  /** Occurrences one clause may cover (Proposed: measured locally, to qualify on D1). */
  clauseOccurrences: 1_000_000,
  /** Occurrences the whole expression may cover, its generated filters' included (Proposed). */
  queryOccurrences: 2_000_000,
  /**
   * Occurrences its narrowest clause may cover: the documents it scores at
   * most (each it matches holds one of every clause's at least), which a
   * ranking reads about three rows each and a listing's match four
   * (measured locally; Proposed).
   */
  matches: 10_000,
} as const;

const INDEX: Record<SearchTarget, { fts: string; vocab: string; none: string }> = {
  issues: { fts: "search_fts", vocab: "search_vocab", none: '(repo : "r0")' },
  repositories: { fts: "search_repos_fts", vocab: "search_repos_vocab", none: '(owner : "o0")' },
};

export type RankingLimits = { readonly [K in keyof typeof RANKING]: number };

/** What a ranked search's expression covers: its prefix's terms, its widest clause's, its whole's and its narrowest clause's occurrences. */
export interface RankingCharge {
  readonly expansions: number;
  readonly clause: number;
  readonly total: number;
  /** Its narrowest clause's. */
  readonly narrowest: number;
}

export interface Ranked {
  /** Why the query was refused, if it was (nothing was ranked). */
  readonly refused?: "prefix_too_broad" | "query_too_broad";
  readonly charge: RankingCharge;
  /** The best candidates by rank (ties by rowid), at most `RANKING.candidates`. */
  readonly candidates: readonly { readonly rowid: number; readonly rank: number }[];
  /** What the statement read. */
  readonly reads: number;
}

/** The first string past every one `prefix` begins (binary, as the vocabulary orders terms). */
const past = (prefix: string): string => {
  const last = prefix.codePointAt(prefix.length - 1) as number;
  return prefix.slice(0, -1) + String.fromCodePoint(last + 1);
};

/**
 * `parsed`'s free text, with `generated`'s filters, admitted and ranked in
 * `target`'s index, read on `reservation`'s day (`readOnDay`); null when it
 * has no free text. With `within` (rowids, a listing's), those of them it
 * matches instead, in their order (`rank` their place): its whole match
 * taken once, which its admission bounds as it bounds a ranking.
 */
export async function rankCandidates(
  db: D1Database,
  reservation: InteractiveReservation,
  target: SearchTarget,
  parsed: ParsedQuery,
  generated: GeneratedFilters,
  limits: RankingLimits = RANKING,
  within?: readonly number[],
): Promise<Ranked | null> {
  const clauses = compileClauses(parsed, target, generated);
  if (clauses.length === 0) return null;
  const { fts, vocab, none } = INDEX[target];
  const prefix = clauses.find((c) => c.prefix !== null)?.prefix ?? null;
  const [result] = await readOnDay(db, reservation, [
    db
      .prepare(
        `WITH expanded AS MATERIALIZED (
           SELECT count(*) AS n, coalesce(sum(cnt), 0) AS s FROM (
             SELECT cnt FROM ${vocab} WHERE term >= ?2 AND term < ?3 ORDER BY term LIMIT ?4 + 1)),
         charged AS MATERIALIZED (
           SELECT coalesce((SELECT sum(v.cnt) FROM json_each(c.value -> '$.terms') t
                              JOIN ${vocab} v ON v.term = t.value), 0)
             + CASE WHEN c.value ->> '$.prefix' THEN (SELECT s FROM expanded) ELSE 0 END AS n
           FROM json_each(?1) c),
         charges AS MATERIALIZED (
           SELECT (SELECT n FROM expanded) AS expansions, (SELECT max(n) FROM charged) AS clause,
                  (SELECT sum(n) FROM charged) AS total, (SELECT min(n) FROM charged) AS narrowest),
         admission AS MATERIALIZED (
           SELECT *, expansions <= ?4 AND clause <= ?5 AND total <= ?6 AND narrowest <= ?10
             AND ${SAME_DAY(9)} AS ok
           FROM charges),
         ${
           within === undefined
             ? `ranked AS MATERIALIZED (
           SELECT rowid, rank FROM ${fts}
           WHERE ${fts} MATCH (SELECT CASE WHEN ok THEN ?7 ELSE '${none}' END FROM admission)
           ORDER BY rank LIMIT (SELECT CASE WHEN ok THEN ?8 ELSE 0 END FROM admission))`
             : `matched AS MATERIALIZED (
           SELECT rowid FROM ${fts}
           WHERE ${fts} MATCH (SELECT CASE WHEN ok THEN ?7 ELSE '${none}' END FROM admission)),
         ranked AS (
           SELECT w.value AS rowid, CAST(w.key AS INTEGER) AS rank FROM json_each(?11) w
           WHERE w.value IN (SELECT rowid FROM matched) AND (SELECT ok FROM admission))`
         }
         SELECT a.expansions, a.clause, a.total, a.narrowest, r.rowid, r.rank
         FROM admission a LEFT JOIN ranked r ORDER BY r.rank, r.rowid`,
      )
      .bind(
        JSON.stringify(clauses.map((c) => ({ terms: c.terms, prefix: c.prefix !== null }))),
        prefix ?? "",
        prefix === null ? "" : past(prefix),
        limits.expansions,
        limits.clauseOccurrences,
        limits.queryOccurrences,
        clauses.map((c) => c.text).join(" AND "),
        limits.candidates,
        reservation.day,
        limits.matches,
        ...(within === undefined ? [] : [JSON.stringify(within)]),
      ),
  ]);
  const rows = (result?.results ?? []) as {
    expansions: number;
    clause: number;
    total: number;
    narrowest: number;
    rowid: number | null;
    rank: number | null;
  }[];
  const reads = result?.meta.rows_read ?? 0;
  const [first] = rows;
  if (!first) throw new Error("the ranking's admission returned no row");
  const charge = {
    expansions: first.expansions,
    clause: first.clause,
    total: first.total,
    narrowest: first.narrowest,
  };
  if (charge.expansions > limits.expansions)
    return { refused: "prefix_too_broad", charge, candidates: [], reads };
  if (
    charge.clause > limits.clauseOccurrences ||
    charge.total > limits.queryOccurrences ||
    charge.narrowest > limits.matches
  )
    return { refused: "query_too_broad", charge, candidates: [], reads };
  return {
    charge,
    candidates: rows.flatMap((r) =>
      r.rowid === null ? [] : [{ rowid: r.rowid, rank: r.rank as number }],
    ),
    reads,
  };
}
