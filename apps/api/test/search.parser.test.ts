// Search's query language: free text folded exactly as the indexes'
// tokenizer folds it (every vetted character compared with a real FTS5
// table), qualifiers parsed and refused, and the compiled FTS5 expression
// made of escaped literals only: whatever is typed, it parses as FTS5 and
// user text never matches a generated repository, kind or owner token.

import { env } from "cloudflare:workers";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { compileMatch } from "../src/search/compiler.js";
import {
  fold,
  parseSearchQuery,
  QUERY_LIMITS,
  SearchQueryError,
  tokens,
  vetted,
} from "../src/search/parser.js";

/** A scratch FTS5 table with the indexes' tokenizer (this file's database alone). */
async function scratch(): Promise<void> {
  await env.ORG_READ.exec(
    "CREATE VIRTUAL TABLE IF NOT EXISTS zz_parse USING fts5(title, body, repo, kind, tokenize = 'unicode61 remove_diacritics 2')",
  );
  await env.ORG_READ.exec(
    "CREATE VIRTUAL TABLE IF NOT EXISTS zz_parse_vocab USING fts5vocab(zz_parse, 'row')",
  );
  await env.ORG_READ.prepare("DELETE FROM zz_parse").run();
}

const refused = (q: string, target: "issues" | "repositories" = "issues") => {
  try {
    parseSearchQuery(q, target);
  } catch (error) {
    expect(error).toBeInstanceOf(SearchQueryError);
    return (error as SearchQueryError).code;
  }
  throw new Error(`${q} was not refused`);
};

describe("search's free text", () => {
  it("folds every vetted letter and digit as the indexes' tokenizer does", async () => {
    await scratch();
    const chars: string[] = [];
    for (let c = 0x20; c <= 0x24f; c++) {
      const ch = String.fromCodePoint(c);
      if (vetted(ch)) chars.push(ch);
    }
    expect(chars.length).toBeGreaterThan(400);
    // Each as a word of its own row: the vocabulary's term is the tokenizer's folding.
    const rows = chars.map((ch, i) => `x${i}x${ch}x`);
    for (let i = 0; i < rows.length; i += 50)
      await env.ORG_READ.batch(
        rows
          .slice(i, i + 50)
          .map((row) => env.ORG_READ.prepare("INSERT INTO zz_parse (title) VALUES (?)").bind(row)),
      );
    const { results } = await env.ORG_READ.prepare("SELECT term FROM zz_parse_vocab").all<{
      term: string;
    }>();
    const terms = new Set(results.map((r) => r.term));
    const differ = rows.filter((row) => !terms.has([...row].map(fold).join("")));
    expect(differ).toEqual([]);
  });

  it("splits at ASCII punctuation and refuses characters it cannot fold for certain", () => {
    expect(tokens("Fix-crash, in  the café.")).toEqual(["fix", "crash", "in", "the", "cafe"]);
    expect(tokens("Ærøskøbing")).toEqual(["aerøskøbing".replace("ae", "æ")]);
    expect(refused("日本語")).toBe("unsupported_search_text");
    // A combining mark typed apart from its letter.
    expect(refused("café")).toBe("unsupported_search_text");
    // Qualifier values may hold any text.
    expect(parseSearchQuery("label:日本語 crash", "issues").labels).toEqual([{ name: "日本語" }]);
  });
});

describe("search's grammar", () => {
  it("reads terms, phrases, a last prefix and every qualifier", () => {
    expect(
      parseSearchQuery(
        'repo:ada/forge is:issue is:open in:title "Fix crash" label:"good first" label:#12 author:ada assignee:bo milestone:3 milestone:"v1 beta" org:acme user:ada lan*',
        "issues",
      ),
    ).toEqual({
      text: [
        { tokens: ["fix", "crash"], prefix: false },
        { tokens: ["lan"], prefix: true },
      ],
      repos: [{ owner: "ada", name: "forge" }],
      orgs: ["acme"],
      users: ["ada"],
      kinds: ["issue"],
      states: ["open"],
      labels: [{ name: "good first" }, { id: 12 }],
      authors: ["ada"],
      assignees: ["bo"],
      milestones: [{ number: 3 }, { title: "v1 beta" }],
      columns: ["title"],
    });
  });

  it("keeps operators as words and splits punctuated terms into phrases", () => {
    // A column selector is no qualifier of the language: refused, never passed to FTS5.
    expect(refused("crash title:x-y")).toBe("invalid_search_query");
    expect(parseSearchQuery("crash OR NEAR", "issues").text).toEqual([
      { tokens: ["crash"], prefix: false },
      { tokens: ["or"], prefix: false },
      { tokens: ["near"], prefix: false },
    ]);
    expect(parseSearchQuery("foo.bar", "issues").text).toEqual([
      { tokens: ["foo", "bar"], prefix: false },
    ]);
  });

  it("holds the query's bounds: its length, its expressions, a prefix's letters and place", () => {
    expect(() => parseSearchQuery("a".repeat(QUERY_LIMITS.codePoints), "issues")).not.toThrow();
    expect(refused("a".repeat(QUERY_LIMITS.codePoints + 1))).toBe("invalid_search_query");
    // Spaces around it count too; a character past the BMP is one.
    expect(refused(`${" ".repeat(1000)}foo`)).toBe("invalid_search_query");
    expect(() =>
      parseSearchQuery(`label:${"😀".repeat(QUERY_LIMITS.codePoints - 6)}`, "issues"),
    ).not.toThrow();
    expect(parseSearchQuery("a b c d e f g h", "issues").text).toHaveLength(8);
    expect(refused("a b c d e f g h i")).toBe("invalid_search_query");
    expect(parseSearchQuery('"a b c d e f g h i" b c d e f g h', "issues").text).toHaveLength(8);
    expect(refused("lantern la*")).toBe("invalid_search_query");
    expect(parseSearchQuery("lantern lan*", "issues").text.at(-1)).toEqual({
      tokens: ["lan"],
      prefix: true,
    });
    expect(parseSearchQuery("lan* is:open", "issues").states).toEqual(["open"]);
    expect(refused("lan* crash")).toBe("invalid_search_query");
    expect(refused('"lan"*')).toBe("invalid_search_query");
    expect(refused("la*n")).toBe("invalid_search_query");
  });

  it("refuses malformed and unsupported qualifiers, and empty or broken quotes", () => {
    expect(refused("")).toBe("invalid_search_query");
    expect(refused("   ")).toBe("invalid_search_query");
    expect(refused('"unclosed')).toBe("invalid_search_query");
    expect(refused('""')).toBe("invalid_search_query");
    expect(refused('"a\\b"')).toBe("invalid_search_query");
    expect(refused("is:draft")).toBe("invalid_search_query");
    expect(refused("repo:ada")).toBe("invalid_search_query");
    expect(refused("repo:a/b/c")).toBe("invalid_search_query");
    expect(refused("stars:>5")).toBe("invalid_search_query");
    expect(refused("in:body crash", "repositories")).toBe("invalid_search_query");
    expect(refused("label:bug crash", "repositories")).toBe("invalid_search_query");
    expect(refused("label: crash")).toBe("invalid_search_query");
    // Items apart, a space between each.
    expect(refused('label:"bug"author:ada')).toBe("invalid_search_query");
    expect(refused('label:bug"crash"')).toBe("invalid_search_query");
    expect(refused('foo"bar"')).toBe("invalid_search_query");
    expect(parseSearchQuery('label:"bug" author:ada "fix it"', "issues").authors).toEqual(["ada"]);
    // Numbers from 1, exact.
    expect(refused("label:#0")).toBe("invalid_search_query");
    expect(refused("milestone:0")).toBe("invalid_search_query");
    expect(refused("label:#9007199254740993")).toBe("invalid_search_query");
    expect(refused(`milestone:${"9".repeat(230)}`)).toBe("invalid_search_query");
    expect(parseSearchQuery("label:#9007199254740991", "issues").labels).toEqual([
      { id: 9007199254740991 },
    ]);
    expect(parseSearchQuery('label:"a \\"quoted\\" one"', "issues").labels).toEqual([
      { name: 'a "quoted" one' },
    ]);
  });
});

describe("search's compiled expression", () => {
  it("keeps user text inside its content columns, with the generated filters beside it", () => {
    const parsed = parseSearchQuery('in:title "Fix crash" lan*', "issues");
    expect(compileMatch(parsed, "issues", { repos: [42], kinds: [1] })).toBe(
      '(title : "fix crash") AND (title : "lan"*) AND (repo : ("r42")) AND (kind : ("k1"))',
    );
    expect(
      compileMatch(parseSearchQuery("forge", "repositories"), "repositories", { owner: 7 }),
    ).toBe('({name description} : "forge") AND (owner : ("o7"))');
    // In both columns, when both are named; no readable repository: one never numbered.
    expect(
      compileMatch(parseSearchQuery("in:title in:body lantern", "issues"), "issues", { repos: [] }),
    ).toBe('(title : "lantern") AND (body : "lantern") AND (repo : ("r0"))');
    expect(compileMatch(parseSearchQuery("is:open repo:a/b", "issues"), "issues")).toBeNull();
  });

  it("parses as FTS5 whatever is typed, and never lets user text match a generated token", async () => {
    await scratch();
    await env.ORG_READ.prepare(
      "INSERT INTO zz_parse (title, body, repo, kind) VALUES ('lantern', 'flickers', 'r1', 'k1')",
    ).run();
    // Typed text naming a generated token finds nothing: it is looked for in the content alone.
    for (const q of ["r1", "k1", "repo r1", '"r1"'])
      expect(
        await env.ORG_READ.prepare("SELECT count(*) AS n FROM zz_parse WHERE zz_parse MATCH ?")
          .bind(compileMatch(parseSearchQuery(q, "issues"), "issues"))
          .first(),
        q,
      ).toEqual({ n: 0 });
    await fc.assert(
      fc.asyncProperty(
        fc.string({
          maxLength: 60,
          unit: fc.constantFrom(..."ab:*\"\\ -()^{}+NEARORNOT'é日".split("")),
        }),
        async (q) => {
          let match: string | null;
          try {
            match = compileMatch(parseSearchQuery(q, "issues"), "issues", { repos: [1] });
          } catch (error) {
            expect(error).toBeInstanceOf(SearchQueryError);
            return;
          }
          if (match === null) return;
          await env.ORG_READ.prepare("SELECT count(*) FROM zz_parse WHERE zz_parse MATCH ?")
            .bind(match)
            .all();
        },
      ),
      { numRuns: 300 },
    );
  });
});
