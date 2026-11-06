// The search page: the one API call each navigation makes (its query with
// the scope chosen beside it, its type's endpoint and its page), the scope
// asked for before any call, refusals shown beside the controls that made
// them, fewer results a page when a page is too large, links built from
// each result's repository as it is now, hostile text shown as text, and
// nothing of it kept by a cache.

import { describe, expect, it } from "vitest";
import { searchFormOf, searchHref } from "../app/lib/search.js";
import { headers, loader, default as Search } from "../app/routes/search.js";
import { fakeApi, json, ORIGIN } from "./helpers/context.js";
import { pathOf } from "./helpers/pulls.js";
import { ACTIVE_TAG, escaped, HOSTILE, renderPage } from "./helpers/render.js";

const NO_STORE = "private, no-store";

function issueItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    number: 7,
    title: "Lantern flickers",
    body: "It flickers when **cold**.",
    state: "open",
    state_reason: null,
    user: { id: "usr_ada", login: "ada" },
    assignees: [],
    labels: [{ id: 1, name: "bug", color: "d73a4a", description: null }],
    milestone: null,
    locked: false,
    active_lock_reason: null,
    created_at: Date.parse("2026-10-01T10:00:00Z"),
    updated_at: Date.parse("2026-10-02T10:00:00Z"),
    closed_at: null,
    repository: { id: "rep_1", owner: { login: "ada" }, name: "forge", full_name: "ada/forge" },
    ...overrides,
  };
}

function repositoryItem(overrides: Record<string, unknown> = {}) {
  return {
    id: "rep_1",
    owner: { id: "usr_ada", login: "ada" },
    name: "forge",
    full_name: "ada/forge",
    visibility: "private",
    description: "A forge for lanterns",
    default_branch: "main",
    created_at: 1,
    ...overrides,
  };
}

const results = (items: unknown[], total = items.length, incomplete = false) =>
  json({ total_count: total, incomplete_results: incomplete, items });

const problem = (code: string, status = 422, detail = `refused: ${code}`) =>
  json({ type: "about:blank", title: "Refused", status, code, detail }, status);

interface Loaded {
  data: Awaited<ReturnType<typeof loader>>["data"];
  init: ResponseInit | undefined;
  calls: Request[];
}

/** The loader run on `path`, the API answering `answer`. */
async function load(path: string, answer: () => Response = () => results([])): Promise<Loaded> {
  const { context, calls } = fakeApi(answer);
  const out = await loader({
    request: new Request(`${ORIGIN}${path}`, { headers: { Cookie: "__Host-fyrden_session=s" } }),
    context,
    params: {},
  } as never);
  return { data: out.data, init: out.init ?? undefined, calls };
}

/** The response the loader throws on `path` (a redirect). */
async function thrownBy(
  path: string,
  answer: () => Response,
): Promise<{ res: Response; calls: Request[] }> {
  const { context, calls } = fakeApi(answer);
  try {
    await loader({
      request: new Request(`${ORIGIN}${path}`, { headers: { Cookie: "__Host-fyrden_session=s" } }),
      context,
      params: {},
    } as never);
  } catch (thrown) {
    if (thrown instanceof Response) return { res: thrown, calls };
    throw thrown;
  }
  throw new Error("the loader was expected to throw a response");
}

const render = (path: string, loaded: Loaded) => renderPage(Search, path, loaded.data);

const cacheControl = (init: ResponseInit | undefined) =>
  new Headers(init?.headers).get("Cache-Control");

describe("the search page's call", () => {
  it("sends the query with the chosen scope appended, to its type's endpoint, a page at a time: one call", async () => {
    const { calls, init } = await load(
      "/search?q=lantern+is%3Aopen&type=issues&scope=repo&scope_value=ada%2Fforge&page=2&per_page=10&sort=updated&order=asc",
    );
    expect(calls.map(pathOf)).toEqual([
      `GET /api/search/issues?${new URLSearchParams({
        q: 'lantern is:open repo:"ada/forge"',
        per_page: "10",
        page: "2",
        sort: "updated",
        order: "asc",
      })}`,
    ]);
    expect(cacheControl(init)).toBe(NO_STORE);
  });

  it("sends no sort or order to the repository search, and the defaults when none is asked", async () => {
    const repos = await load(
      "/search?q=forge&type=repositories&scope=org&scope_value=lamps&sort=created&order=asc",
    );
    expect(repos.calls.map(pathOf)).toEqual([
      `GET /api/search/repositories?${new URLSearchParams({ q: 'forge org:"lamps"', per_page: "30", page: "1" })}`,
    ]);
    const issues = await load("/search?q=forge&scope=user&scope_value=ada");
    expect(issues.calls.map(pathOf)).toEqual([
      `GET /api/search/issues?${new URLSearchParams({ q: 'forge user:"ada"', per_page: "30", page: "1", order: "desc" })}`,
    ]);
  });

  it("keeps a scope written in the query, beside or without one chosen (where they meet is the API's to say)", async () => {
    const written = await load("/search?q=++lantern+REPO%3Aada%2Fforge++");
    expect(new URL(written.calls[0]?.url ?? "").searchParams.get("q")).toBe(
      "lantern REPO:ada/forge",
    );
    const both = await load("/search?q=lantern+org%3Alamps&scope=repo&scope_value=ada%2Fforge");
    expect(new URL(both.calls[0]?.url ?? "").searchParams.get("q")).toBe(
      'lantern org:lamps repo:"ada/forge"',
    );
  });

  it("refuses a scope value not of its kind's shape, adding no other syntax, and calls nothing", async () => {
    for (const [scope, value] of [
      ["repo", "ada"],
      ["repo", "ada/forge/x"],
      ["repo", 'ada/forge" org:big'],
      ["repo", "ada/fo rge"],
      ["org", "lamps is:open"],
      ["user", 'ada"'],
      ["user", "a".repeat(40)],
      ["org", "ada/forge"],
    ] as const) {
      const { data, calls } = await load(
        `/search?${new URLSearchParams({ q: "lantern", scope, scope_value: value })}`,
      );
      expect(calls, `${scope}:${value}`).toEqual([]);
      expect(data.outcome.state, `${scope}:${value}`).toBe("invalid");
    }
  });

  it("asks for a scope, calling nothing, when neither the query nor the controls name one", async () => {
    const path = "/search?q=lantern+is%3Aopen&type=issues&scope=repo&scope_value=&per_page=10";
    const loaded = await load(path);
    expect(loaded.calls).toEqual([]);
    expect(loaded.data.outcome).toEqual({ state: "scope" });
    const html = render(path, loaded);
    expect(html).toContain("Choose where to search");
    // The controls keep what was asked.
    expect(html).toMatch(/id="search-q"[^>]*value="lantern is:open"/);
    expect(html).toMatch(/id="search-per-page"[^>]*value="10"/);
    // The page with nothing asked yet shows the form alone.
    const bare = await load("/search");
    expect(bare.calls).toEqual([]);
    expect(bare.data.outcome).toEqual({ state: "idle" });
    expect(render("/search", bare)).not.toContain("Choose where to search");
  });

  it("checks the page and its size as a form does, calling nothing past the depth the API pages to", async () => {
    for (const query of [
      "per_page=0",
      "per_page=101",
      "per_page=ten",
      "page=0",
      "page=-1",
      "page=11&per_page=100",
      "page=35&per_page=30",
    ]) {
      const { data, calls } = await load(`/search?q=lantern+repo%3Aada%2Fforge&${query}`);
      expect(calls, query).toEqual([]);
      expect(data.outcome.state, query).toBe("invalid");
    }
    // The last page the API pages to is asked for.
    const deepest = await load("/search?q=lantern+repo%3Aada%2Fforge&page=34&per_page=30");
    expect(deepest.calls).toHaveLength(1);
  });

  it("refuses a query and scope together past 256 characters before calling", async () => {
    const q = "a".repeat(240);
    const { data, calls } = await load(
      `/search?${new URLSearchParams({ q, scope: "repo", scope_value: "ada/forge-of-lanterns" })}`,
    );
    expect(calls).toEqual([]);
    expect(data.outcome.state).toBe("invalid");
  });

  it("sends a signed-out viewer to sign in and back, uncached", async () => {
    const { res, calls } = await thrownBy("/search?q=x+repo%3Aada%2Fforge", () =>
      json({ code: "unauthenticated" }, 401),
    );
    expect(calls).toHaveLength(1);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      `/auth/sign-in?return_to=${encodeURIComponent("/search?q=x+repo%3Aada%2Fforge")}`,
    );
    expect(res.headers.get("Cache-Control")).toBe(NO_STORE);
  });
});

describe("a page too large", () => {
  it("halves the page size from the first page, one call a navigation, down to one; then says so", async () => {
    const asked = (perPage: number, page: number) =>
      `/search?q=lantern&type=issues&scope=repo&scope_value=ada%2Fforge&page=${page}&per_page=${perPage}&sort=created&order=asc`;
    const chain = [100, 50, 25, 12, 6, 3, 1];
    for (const [i, perPage] of chain.slice(0, -1).entries()) {
      const { res, calls } = await thrownBy(asked(perPage, i === 0 ? 4 : 1), () =>
        problem("page_too_large"),
      );
      expect(calls, String(perPage)).toHaveLength(1);
      expect(res.status).toBe(302);
      expect(res.headers.get("Cache-Control")).toBe(NO_STORE);
      expect(res.headers.get("Location")).toBe(asked(chain[i + 1] as number, 1));
      // The query, type, scope and sort stay as asked.
      const next = new URL(res.headers.get("Location") ?? "", ORIGIN).searchParams;
      expect(Object.fromEntries(next)).toEqual({
        q: "lantern",
        type: "issues",
        scope: "repo",
        scope_value: "ada/forge",
        page: "1",
        per_page: String(chain[i + 1]),
        sort: "created",
        order: "asc",
      });
    }
    const last = await load(asked(1, 1), () => problem("page_too_large"));
    expect(last.calls).toHaveLength(1);
    expect(last.data.outcome).toEqual({
      state: "refused",
      message: "This result is larger than a page can show, even alone.",
    });
    expect(render(asked(1, 1), last)).toContain('role="alert"');
  });
});

describe("refusals", () => {
  it("says what each refusal means, keeping the controls as asked; a missing scope asks for one", async () => {
    const path =
      "/search?q=lant*&type=issues&scope=repo&scope_value=ada%2Fforge&per_page=20&sort=updated&order=asc";
    const cases: [string, number, RegExp][] = [
      ["search_scope_too_broad", 422, /Name a repository/],
      ["invalid_search_query", 422, /The query could not be read: refused: invalid_search_query/],
      ["unsupported_search_text", 422, /text search cannot match: refused/],
      ["prefix_too_broad", 422, /stands for too many words/],
      ["query_too_broad", 422, /matches too much to rank/],
      ["sort_needs_scope", 422, /one state \(is:open/],
      ["search_text_required", 422, /needs words to match/],
      ["repo_not_found", 404, /No such repository/],
      ["search_rate_limited", 429, /Try again in a minute/],
      ["search_budget", 429, /allowance for today/],
      ["search_authorization_unavailable", 503, /could not be checked just now/],
      ["read_model_maintenance", 503, /under maintenance/],
      ["invalid_input", 422, /The search was refused: refused: invalid_input/],
      ["something_new", 500, /refused: something_new/],
    ];
    for (const [code, status, message] of cases) {
      const loaded = await load(path, () => problem(code, status));
      expect(loaded.calls, code).toHaveLength(1);
      expect(loaded.data.outcome.state, code).toBe("refused");
      const html = render(path, loaded);
      expect(html, code).toMatch(message);
      expect(html, code).toMatch(/id="search-q"[^>]*value="lant\*"/);
      expect(html, code).toMatch(/id="search-scope-value"[^>]*value="ada\/forge"/);
      expect(html, code).toMatch(/<option value="updated" selected="">/);
      expect(html, code).not.toContain('role="status"');
    }
    const unscoped = await load(path, () => problem("search_scope_required"));
    expect(unscoped.data.outcome).toEqual({ state: "scope" });
    // An answer with no problem document still says what happened.
    const bare = await load(path, () => new Response(null, { status: 502 }));
    expect(bare.data.outcome).toEqual({
      state: "refused",
      message: "The search failed (502). Try again.",
    });
  });
});

describe("results", () => {
  const scoped = "/search?q=lantern&type=issues&scope=user&scope_value=ada";

  it("links each issue, pull request and repository by its repository's identity now", async () => {
    const loaded = await load(scoped, () =>
      results([
        issueItem({
          repository: {
            id: "rep_9",
            owner: { login: "grace" },
            name: "lamp",
            full_name: "grace/lamp",
          },
        }),
        issueItem({
          id: 8,
          number: 8,
          title: "Brighter",
          pull_request: { merged_at: 5 },
          state: "closed",
          draft: false,
        }),
      ]),
    );
    const html = render(scoped, loaded);
    expect(html).toContain('href="/grace/lamp/issues/7"');
    expect(html).toContain('href="/grace/lamp"');
    expect(html).toContain("grace/lamp");
    expect(html).toContain('href="/ada/forge/pull/8"');
    expect(html).toContain("Merged");
    const repos = await load("/search?q=forge&type=repositories&scope=user&scope_value=ada", () =>
      results([
        repositoryItem({
          owner: { id: "usr_g", login: "grace" },
          name: "lamp",
          full_name: "grace/lamp",
        }),
      ]),
    );
    const listed = render("/search?q=forge&type=repositories", repos);
    expect(listed).toContain('href="/grace/lamp"');
    expect(listed).toContain("private");
    expect(listed).toContain("A forge for lanterns");
    // The issue search's sort and order are not offered for repositories.
    expect(listed).not.toContain('id="search-sort"');
  });

  it("shows hostile titles, labels and bodies as text, and a body as a short plain excerpt", async () => {
    const long = `**bold**   ${"word ".repeat(100)}`;
    const loaded = await load(scoped, () =>
      results([
        issueItem({
          title: HOSTILE,
          body: `${HOSTILE}\n\n**bold**`,
          labels: [{ id: 2, name: HOSTILE, color: "ededed", description: null }],
        }),
        issueItem({ id: 9, number: 9, body: long }),
      ]),
    );
    const html = render(scoped, loaded);
    expect(html).not.toMatch(ACTIVE_TAG);
    expect(html).toContain(escaped(HOSTILE));
    expect(html).not.toContain("<strong>");
    expect(html).toContain(`${escaped(HOSTILE)} **bold**`);
    const excerpt =
      loaded.data.outcome.state === "results" ? loaded.data.outcome.issues[1]?.excerpt : "";
    expect(excerpt?.startsWith("**bold** word word")).toBe(true);
    expect(excerpt?.endsWith("…")).toBe(true);
    expect([...(excerpt ?? "")].length).toBeLessThanOrEqual(201);
  });

  it("tells an empty result, a result that may be missing some, and a refusal apart", async () => {
    const empty = render(scoped, await load(scoped, () => results([], 0, false)));
    expect(empty).toContain("No results.");
    expect(empty).not.toContain("Results may be missing");
    expect(empty).not.toContain('role="alert"');
    const partial = render(scoped, await load(scoped, () => results([], 0, true)));
    expect(partial).toContain("No results.");
    expect(partial).toContain("Results may be missing");
    const some = render(scoped, await load(scoped, () => results([issueItem()], 1, true)));
    expect(some).toContain("1 result.");
    expect(some).toContain("Results may be missing");
    const refused = render(scoped, await load(scoped, () => problem("query_too_broad")));
    expect(refused).toContain('role="alert"');
    expect(refused).not.toContain("No results.");
    expect(refused).not.toContain("Results may be missing");
  });

  it("offers a form that starts again from the first page, without scripts", async () => {
    const path = `${scoped}&page=3&per_page=10`;
    const html = render(path, await load(path, () => results([issueItem()], 40)));
    const form =
      /<form[^>]*role="search"[^>]*aria-label="Search"[^>]*>[\s\S]*?<\/form>/.exec(html)?.[0] ?? "";
    expect(form).toMatch(/method="get"/);
    expect(form).toMatch(/action="\/search"/);
    expect(form).toContain('name="q"');
    expect(form).toContain('name="per_page"');
    expect(form).not.toContain('name="page"');
  });
});

describe("result pages", () => {
  const pagesOf = async (query: string, total: number, incomplete = false) => {
    const path = `/search?q=lantern+repo%3Aada%2Fforge&${query}`;
    const loaded = await load(path, () => results([issueItem()], total, incomplete));
    if (loaded.data.outcome.state !== "results") throw new Error("results expected");
    return { pages: loaded.data.outcome.pages, html: render(path, loaded) };
  };
  const pageOf = (href: string | null | undefined) =>
    href ? new URL(href, ORIGIN).searchParams.get("page") : null;

  it("goes on only while this page ends before the results counted, and the depth paged", async () => {
    const first = await pagesOf("per_page=30", 95);
    expect(first.pages.previous).toBeNull();
    expect(pageOf(first.pages.next)).toBe("2");
    expect(first.pages.numbers.map((n) => n?.page ?? null)).toEqual([1, 2, 3, 4]);
    const last = await pagesOf("page=4&per_page=30", 95);
    expect(pageOf(last.pages.previous)).toBe("3");
    expect(last.pages.next).toBeNull();
    // Exactly full: no page past it.
    expect((await pagesOf("page=3&per_page=30", 90)).pages.next).toBeNull();
    // Counted to the depth: the page that would start past it is not offered.
    expect((await pagesOf("page=10&per_page=100", 1_000)).pages.next).toBeNull();
    expect(pageOf((await pagesOf("page=33&per_page=30", 1_000)).pages.next)).toBe("34");
    expect((await pagesOf("page=34&per_page=30", 1_000)).pages.next).toBeNull();
    // Results that may be missing make no page more.
    expect((await pagesOf("per_page=30", 30, true)).pages.next).toBeNull();
    expect((await pagesOf("per_page=30", 1)).pages.numbers).toEqual([]);
  });

  it("numbers the pages around this one, the first and the last, marking this one", async () => {
    const { pages, html } = await pagesOf("page=10&per_page=10", 1_000);
    expect(pages.numbers.map((n) => n?.page ?? null)).toEqual([
      1,
      null,
      8,
      9,
      10,
      11,
      12,
      null,
      100,
    ]);
    expect(html).toContain('aria-label="Result pages"');
    expect(html).toMatch(
      /<span aria-current="page"><span class="visually-hidden">Page <\/span>10<\/span>/,
    );
    expect(html).toContain('rel="prev"');
    expect(html).toContain('rel="next"');
    // Each page link asks the same search at the same size.
    const next = new URL(pages.next ?? "", ORIGIN).searchParams;
    expect(Object.fromEntries(next)).toEqual({
      q: "lantern repo:ada/forge",
      type: "issues",
      page: "11",
      per_page: "10",
      order: "desc",
    });
  });

  it("links to the page with its canonical parameters", () => {
    const form = searchFormOf(
      new URL(`${ORIGIN}/search?q=lantern&scope=repo&scope_value=ada/forge`),
    );
    expect(searchHref(form, 1, 30)).toBe(
      "/search?q=lantern&type=issues&scope=repo&scope_value=ada%2Fforge&page=1&per_page=30&order=desc",
    );
  });
});

describe("caching", () => {
  it("keeps the page, its data and its redirects out of every cache", async () => {
    expect(new Headers(headers()).get("Cache-Control")).toBe(NO_STORE);
    expect(cacheControl((await load("/search")).init)).toBe(NO_STORE);
    expect(cacheControl((await load("/search?q=x")).init)).toBe(NO_STORE);
    expect(
      cacheControl((await load("/search?q=x+repo%3Aa%2Fb", () => problem("query_too_broad"))).init),
    ).toBe(NO_STORE);
  });
});
