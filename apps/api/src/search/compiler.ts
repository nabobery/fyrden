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

/**
 * The FTS5 expression of `parsed`'s free text for `target`, with
 * `generated`'s filters; null when it has no free text (a listing).
 */
export function compileMatch(
  parsed: ParsedQuery,
  target: SearchTarget,
  generated: GeneratedFilters = {},
): string | null {
  if (parsed.text.length === 0) return null;
  const clauses: string[] = [];
  for (const expression of parsed.text) {
    const phrase = `${literal(expression.tokens.join(" "))}${expression.prefix ? "*" : ""}`;
    // Each `in:` column must hold it (repeated, they all must); none named, any content column.
    if (parsed.columns.length === 0) clauses.push(`(${CONTENT[target]} : ${phrase})`);
    else for (const column of parsed.columns) clauses.push(`(${column} : ${phrase})`);
  }
  const any = (column: string, prefix: string, values: readonly number[]) =>
    `(${column} : (${values.map((v) => literal(`${prefix}${v}`)).join(" OR ")}))`;
  if (generated.repos)
    clauses.push(any("repo", "r", generated.repos.length > 0 ? generated.repos : [0]));
  if (generated.kinds)
    clauses.push(any("kind", "k", generated.kinds.length > 0 ? generated.kinds : [0]));
  if (generated.owner !== undefined) clauses.push(any("owner", "o", [generated.owner]));
  return clauses.join(" AND ");
}
