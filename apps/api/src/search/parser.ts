/*
 * Search's query language: free text (terms, quoted phrases, a trailing
 * prefix) and qualifiers, parsed into what the compiler turns into an FTS5
 * expression of escaped literals and the query applies as predicates. User
 * text never reaches FTS5 as syntax: `OR`, `NEAR`, column selectors and
 * stars inside a term are words or refusals, never operators.
 *
 * Free text is limited to the characters whose folding is proven against
 * the indexes' tokenizer (`unicode61 remove_diacritics 2`): ASCII letters
 * and digits, and the letters through Latin Extended-B (U+024F), folded as
 * it folds them (test/search.parser.test.ts compares every one with a real
 * FTS5 table). Other free text is refused rather than folded by a guess;
 * qualifier values may hold any text.
 */

/** The longest query (Unicode code points), and the free-text expressions it holds at most. */
export const QUERY_LIMITS = { codePoints: 256, expressions: 8, prefixMinimum: 3 } as const;

export type SearchTarget = "issues" | "repositories";

/** A free-text expression: a term or a phrase (its folded tokens), the last one maybe a prefix. */
export interface TextExpression {
  readonly tokens: readonly string[];
  readonly prefix: boolean;
}

export interface ParsedQuery {
  readonly text: readonly TextExpression[];
  /** `repo:owner/name`, as written (resolved by the caller). */
  readonly repos: readonly { readonly owner: string; readonly name: string }[];
  readonly orgs: readonly string[];
  readonly users: readonly string[];
  /** `is:issue`, `is:pr`. */
  readonly kinds: readonly ("issue" | "pr")[];
  /** `is:open`, `is:closed`, `is:merged`. */
  readonly states: readonly ("open" | "closed" | "merged")[];
  readonly labels: readonly ({ readonly name: string } | { readonly id: number })[];
  readonly authors: readonly string[];
  readonly assignees: readonly string[];
  readonly milestones: readonly ({ readonly title: string } | { readonly number: number })[];
  /** `in:` columns: title/body for documents, name/description for repositories. */
  readonly columns: readonly ("title" | "body" | "name" | "description")[];
}

/** A query refused, with the code the API answers and what to say. */
export class SearchQueryError extends Error {
  constructor(
    readonly code: "invalid_search_query" | "unsupported_search_text",
    message: string,
  ) {
    super(message);
    this.name = "SearchQueryError";
  }
}

const SYNTAX =
  'free text (words, "quoted phrases", a last word ending in * for a prefix of 3 or more) and qualifiers: repo:owner/name, org:, user:, is:issue|pr|open|closed|merged, label:, author:, assignee:, milestone:, in:title|body (repositories: in:name|description)';

/**
 * How the tokenizer folds the vetted letters it does not fold as
 * NFD-without-marks, lowercased (found by comparing every one).
 */
const FOLDS: Readonly<Record<string, string>> = {
  µ: "μ",
  ſ: "s",
  Ǡ: "ǡ",
  ǡ: "ǡ",
  Ǣ: "ǣ",
  ǣ: "ǣ",
  Ǯ: "ǯ",
  ǯ: "ǯ",
  Ǽ: "ǽ",
  ǽ: "ǽ",
  Ǿ: "ǿ",
  ǿ: "ǿ",
};

/** Whether `ch` is a letter or digit free text may hold (its folding proven). */
export const vetted = (ch: string): boolean => {
  const code = ch.codePointAt(0) ?? 0;
  return code <= 0x24f && /[\p{L}\p{N}]/u.test(ch);
};

/** One vetted character folded as the tokenizer folds it. */
export const fold = (ch: string): string =>
  FOLDS[ch] ?? ch.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/**
 * Free text's tokens, folded: runs of vetted letters and digits, split at
 * ASCII punctuation and spaces (as the tokenizer splits them). Any other
 * character is refused.
 */
export function tokens(text: string): string[] {
  const out: string[] = [];
  let current = "";
  for (const ch of text) {
    if (vetted(ch)) current += fold(ch);
    else if (/[\x20-\x7e\t\n\r]/.test(ch)) {
      if (current) out.push(current);
      current = "";
    } else
      throw new SearchQueryError(
        "unsupported_search_text",
        `search text may hold Latin letters and digits only (not ${JSON.stringify(ch)}); put other text in a qualifier`,
      );
  }
  if (current) out.push(current);
  return out;
}

/** The qualifiers each search takes. */
const QUALIFIERS: Record<SearchTarget, ReadonlySet<string>> = {
  issues: new Set(["repo", "org", "user", "is", "label", "author", "assignee", "milestone", "in"]),
  repositories: new Set(["repo", "org", "user", "in"]),
};

/** Reads a quoted value from `at` (its opening quote): the value and where it ends. */
function quoted(q: string, at: number): { value: string; end: number } {
  let value = "";
  for (let i = at + 1; i < q.length; i++) {
    const ch = q[i] as string;
    if (ch === "\\") {
      const next = q[i + 1];
      if (next !== '"' && next !== "\\")
        throw new SearchQueryError(
          "invalid_search_query",
          `a \\ in quotes escapes only " or \\. ${SYNTAX}`,
        );
      value += next;
      i++;
    } else if (ch === '"') return { value, end: i + 1 };
    else value += ch;
  }
  throw new SearchQueryError("invalid_search_query", `an unmatched quote. ${SYNTAX}`);
}

/** Parses `q` for `target`; throws `SearchQueryError` for what it refuses. */
export function parseSearchQuery(q: string, target: SearchTarget): ParsedQuery {
  // Its length as given, spaces around it too.
  if ([...q].length > QUERY_LIMITS.codePoints)
    throw new SearchQueryError(
      "invalid_search_query",
      `a query holds at most ${QUERY_LIMITS.codePoints} characters`,
    );
  const parsed = {
    text: [] as TextExpression[],
    repos: [] as { owner: string; name: string }[],
    orgs: [] as string[],
    users: [] as string[],
    kinds: [] as ("issue" | "pr")[],
    states: [] as ("open" | "closed" | "merged")[],
    labels: [] as ({ name: string } | { id: number })[],
    authors: [] as string[],
    assignees: [] as string[],
    milestones: [] as ({ title: string } | { number: number })[],
    columns: [] as ("title" | "body" | "name" | "description")[],
  };
  const trimmed = q.trim();
  if (!trimmed) throw new SearchQueryError("invalid_search_query", `an empty query. ${SYNTAX}`);
  const bad = (what: string) => new SearchQueryError("invalid_search_query", `${what}. ${SYNTAX}`);
  let prefixSeen = false;
  let i = 0;
  while (i < trimmed.length) {
    if (/\s/.test(trimmed[i] as string)) {
      i++;
      continue;
    }
    if (trimmed[i] === '"') {
      // A phrase: its tokens, one expression.
      const { value, end } = quoted(trimmed, i);
      if (end < trimmed.length && !/\s/.test(trimmed[end] as string))
        throw bad("a quoted phrase must be followed by a space");
      const words = tokens(value);
      if (words.length === 0) throw bad("a phrase with no words");
      if (prefixSeen) throw bad("only the last word of the text may be a prefix");
      parsed.text.push({ tokens: words, prefix: false });
      i = end;
      continue;
    }
    // A bare item: a qualifier (`name:value`) or a term.
    let end = i;
    while (end < trimmed.length && !/\s/.test(trimmed[end] as string) && trimmed[end] !== '"')
      end++;
    const item = trimmed.slice(i, end);
    const colon = item.indexOf(":");
    if (colon > 0) {
      const name = item.slice(0, colon).toLowerCase();
      let value = item.slice(colon + 1);
      if (!value && trimmed[end] === '"') {
        const read = quoted(trimmed, end);
        value = read.value;
        end = read.end;
      }
      // Items are apart: nothing but a space (or the end) after one.
      if (end < trimmed.length && !/\s/.test(trimmed[end] as string))
        throw bad(`a space after ${trimmed.slice(i, end)}`);
      if (!QUALIFIERS[target].has(name))
        throw bad(
          `${target === "repositories" && QUALIFIERS.issues.has(name) ? "repository search takes no" : "no such qualifier as"} ${name}:`,
        );
      if (!value) throw bad(`${name}: needs a value`);
      qualify(parsed, target, name, value, bad);
      i = end;
      continue;
    }
    if (trimmed[end] === '"' || item.includes("\\"))
      throw bad(`a quote or \\ inside ${trimmed.slice(i, end + 1)}`);
    // A term (punctuation inside splits it into a phrase of its tokens), a prefix when it ends in *.
    const prefix = item.endsWith("*");
    const word = prefix ? item.slice(0, -1) : item;
    if (word.includes("*")) throw bad(`a * inside ${item}: only a last word may end in one`);
    const words = tokens(word);
    if (words.length === 0) {
      if (prefix) throw bad("a prefix with no letters");
      i = end;
      continue;
    }
    if (prefixSeen) throw bad("only the last word of the text may be a prefix");
    if (prefix) {
      if (words.length > 1) throw bad(`a prefix of one word only, not ${item}`);
      if ([...(words[0] as string)].length < QUERY_LIMITS.prefixMinimum)
        throw bad(`a prefix of at least ${QUERY_LIMITS.prefixMinimum} letters, not ${item}`);
      prefixSeen = true;
    }
    parsed.text.push({ tokens: words, prefix });
    i = end;
  }
  if (parsed.text.length > QUERY_LIMITS.expressions)
    throw bad(`at most ${QUERY_LIMITS.expressions} words or phrases`);
  return parsed;
}

/** A qualifier's number: a positive safe integer, or refused. */
function positive(text: string, what: string, bad: (what: string) => SearchQueryError): number {
  const n = Number(text);
  if (!Number.isSafeInteger(n) || n < 1) throw bad(`${what} is not a number from 1`);
  return n;
}

/** Adds one qualifier's value to `parsed`. */
function qualify(
  parsed: {
    repos: { owner: string; name: string }[];
    orgs: string[];
    users: string[];
    kinds: ("issue" | "pr")[];
    states: ("open" | "closed" | "merged")[];
    labels: ({ name: string } | { id: number })[];
    authors: string[];
    assignees: string[];
    milestones: ({ title: string } | { number: number })[];
    columns: ("title" | "body" | "name" | "description")[];
  },
  target: SearchTarget,
  name: string,
  value: string,
  bad: (what: string) => SearchQueryError,
): void {
  switch (name) {
    case "repo": {
      const [owner, repo, rest] = value.split("/");
      if (!owner || !repo || rest !== undefined) throw bad(`repo:${value} is not owner/name`);
      parsed.repos.push({ owner, name: repo });
      return;
    }
    case "org":
      parsed.orgs.push(value);
      return;
    case "user":
      parsed.users.push(value);
      return;
    case "is": {
      const v = value.toLowerCase();
      if (v === "issue" || v === "pr") parsed.kinds.push(v);
      else if (v === "open" || v === "closed" || v === "merged") parsed.states.push(v);
      else throw bad(`is:${value}`);
      return;
    }
    case "label":
      if (/^#\d+$/.test(value))
        parsed.labels.push({ id: positive(value.slice(1), `label:${value}`, bad) });
      else parsed.labels.push({ name: value });
      return;
    case "author":
      parsed.authors.push(value);
      return;
    case "assignee":
      parsed.assignees.push(value);
      return;
    case "milestone":
      if (/^\d+$/.test(value))
        parsed.milestones.push({ number: positive(value, `milestone:${value}`, bad) });
      else parsed.milestones.push({ title: value });
      return;
    case "in": {
      const v = value.toLowerCase();
      const allowed = target === "issues" ? ["title", "body"] : ["name", "description"];
      if (!allowed.includes(v)) throw bad(`in:${value} (${allowed.join(" or ")} here)`);
      if (!parsed.columns.includes(v as "title")) parsed.columns.push(v as "title");
      return;
    }
  }
}
