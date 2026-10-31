import type { ParsedQuery, SearchTarget } from "./parser.js";

/*
 * A parsed query's free text as an FTS5 expression of quoted literals, each
 * inside its content columns (user text never matches a repository, kind or
 * owner token), ANDed with the filters the search itself generates: the
 * repositories, kinds and owner it may match, by their tokens. Bound as one
 * parameter; nothing of the user's is FTS5 syntax.
 */

/** The filters a search generates: tokens of repositories (`r<num>`), kinds (`k<n>`), an owner. */
export interface GeneratedFilters {
  readonly repos?: readonly number[];
  readonly kinds?: readonly number[];
  readonly owner?: number;
}

/** A literal FTS5 string: its quotes doubled (a token holds none; defensively). */
const literal = (text: string) => `"${text.replaceAll('"', '""')}"`;

const CONTENT: Record<SearchTarget, string> = {
  issues: "{title body}",
  repositories: "{name description}",
};

/** A clause of a search's FTS5 expression, and the vocabulary terms it covers (its prefix's too). */
export interface MatchClause {
  readonly text: string;
  /** Its terms, each as often as it is written (a generated filter's, every token of it). */
  readonly terms: readonly string[];
  /** The prefix it ends with, if it does. */
  readonly prefix: string | null;
}

/**
 * The clauses of `parsed`'s free text for `target`, with `generated`'s
 * filters, ANDed in its FTS5 expression; none when it has no free text (a
 * listing).
 */
export function compileClauses(
  parsed: ParsedQuery,
  target: SearchTarget,
  generated: GeneratedFilters = {},
): MatchClause[] {
  if (parsed.text.length === 0) return [];
  const clauses: MatchClause[] = [];
  for (const expression of parsed.text) {
    const phrase = `${literal(expression.tokens.join(" "))}${expression.prefix ? "*" : ""}`;
    const terms = expression.prefix ? expression.tokens.slice(0, -1) : expression.tokens;
    const prefix = expression.prefix ? (expression.tokens.at(-1) as string) : null;
    // Each `in:` column must hold it (repeated, they all must); none named, any content column.
    for (const column of parsed.columns.length > 0 ? parsed.columns : [CONTENT[target]])
      clauses.push({ text: `(${column} : ${phrase})`, terms, prefix });
  }
  const any = (column: string, prefix: string, values: readonly number[]) => {
    const tokens = (values.length > 0 ? values : [0]).map((v) => `${prefix}${v}`);
    clauses.push({
      text: `(${column} : (${tokens.map(literal).join(" OR ")}))`,
      terms: tokens,
      prefix: null,
    });
  };
  if (generated.repos) any("repo", "r", generated.repos);
  if (generated.kinds) any("kind", "k", generated.kinds);
  if (generated.owner !== undefined) any("owner", "o", [generated.owner]);
  return clauses;
}

/**
 * The FTS5 expression of `parsed`'s free text for `target`, with
 * `generated`'s filters; null when it has no free text (a listing).
 */
export function compileMatch(
  parsed: ParsedQuery,
  target: SearchTarget,
  generated: GeneratedFilters = {},
): string | null {
  const clauses = compileClauses(parsed, target, generated);
  return clauses.length > 0 ? clauses.map((c) => c.text).join(" AND ") : null;
}
