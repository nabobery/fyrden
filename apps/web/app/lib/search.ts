/**
 * The search page's URL and what it asks of the API: its parameters
 * checked as a form's are (their shapes only: the API parses the query and
 * decides what may be searched), the query sent, and the page's links.
 * Types of the API's answers come from its contract (types only: nothing
 * of it is in the browser's bundle).
 */

import type { Output, searchIssues, searchRepositories } from "@fyrden/api-contract";
import { HANDLE_SHAPE, MAX_HANDLE_LENGTH } from "@fyrden/domain";
import { issuePage, issueStatus } from "./issues.js";
import { pullPage } from "./pulls.js";

export type IssueResults = Output<typeof searchIssues>;
export type RepositoryResults = Output<typeof searchRepositories>;

export const SEARCH_TYPES = ["issues", "repositories"] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];
export const SCOPE_KINDS = ["repo", "org", "user"] as const;
export type ScopeKind = (typeof SCOPE_KINDS)[number];
export const SEARCH_SORTS = ["created", "updated"] as const;
export type SearchSort = (typeof SEARCH_SORTS)[number];
export const SEARCH_ORDERS = ["desc", "asc"] as const;
export type SearchOrder = (typeof SEARCH_ORDERS)[number];

/** The API's bounds on a search (its contract): the query's length, a page's size, the depth paged. */
export const SEARCH_LIMITS = {
  queryCodePoints: 256,
  perPage: 100,
  defaultPerPage: 30,
  depth: 1_000,
} as const;

/** What the page's URL asks for, as its controls show it. */
export interface SearchForm {
  /** The query as written. */
  readonly q: string;
  readonly type: SearchType;
  /** The scope chosen beside the query, if any. */
  readonly scope: ScopeKind | "";
  readonly scopeValue: string;
  /** Results a page and the page, as written (checked by `searchRequestOf`). */
  readonly perPage: string;
  readonly page: string;
  /** Issues only. */
  readonly sort: SearchSort | "";
  readonly order: SearchOrder;
  /** Whether anything was asked (the query's field was sent): a bare page shows the form only. */
  readonly asked: boolean;
}

const oneOf = <T extends string>(values: readonly T[], value: string | null): T | undefined =>
  values.find((v) => v === value);

/** The search page's URL read as its form (a value not offered reads as the default). */
export function searchFormOf(url: URL): SearchForm {
  const get = (name: string) => url.searchParams.get(name);
  return {
    q: get("q") ?? "",
    type: oneOf(SEARCH_TYPES, get("type")) ?? "issues",
    scope: oneOf(SCOPE_KINDS, get("scope")) ?? "",
    scopeValue: (get("scope_value") ?? "").trim(),
    perPage: get("per_page")?.trim() || String(SEARCH_LIMITS.defaultPerPage),
    page: get("page")?.trim() || "1",
    sort: oneOf(SEARCH_SORTS, get("sort")) ?? "",
    order: oneOf(SEARCH_ORDERS, get("order")) ?? "desc",
    asked: url.searchParams.has("q"),
  };
}

/** A search ready to send: its endpoint's type, the query with its scope, and its page. */
export interface SearchRequest {
  readonly type: SearchType;
  readonly q: string;
  readonly page: number;
  readonly perPage: number;
  readonly sort: SearchSort | "";
  readonly order: SearchOrder;
}

/** What the page does with its form: nothing yet, ask for a scope, say what is wrong, or search. */
export type SearchPlan =
  | { readonly state: "idle" }
  | { readonly state: "scope" }
  | { readonly state: "invalid"; readonly message: string }
  | { readonly state: "ready"; readonly request: SearchRequest };

/**
 * Whether `q` may hold a scope qualifier: an item starting `repo:`,
 * `org:` or `user:` (any case). Items are apart only at white space, so
 * a query this misses holds none; one it takes wrongly (inside a quoted
 * phrase) is sent, and the API's refusal asks for a scope.
 */
export const mayHoldScope = (q: string): boolean => /(?:^|\s)(?:repo|org|user):/i.test(q);

const isHandle = (value: string): boolean =>
  value.length <= MAX_HANDLE_LENGTH && HANDLE_SHAPE.test(value);
/** A repository name's characters (the API checks the rest of its rules). */
const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;

/** Whether `value` has the shape of a `kind` scope: `owner/name` for a repository, else a handle. */
export function scopeShaped(kind: ScopeKind, value: string): boolean {
  if (kind !== "repo") return isHandle(value);
  const [owner = "", name = "", ...rest] = value.split("/");
  return rest.length === 0 && isHandle(owner) && REPO_NAME.test(name);
}

const SCOPE_SHAPE: Record<ScopeKind, string> = {
  repo: "a repository as owner/name",
  org: "an organization's handle",
  user: "a user's handle",
};

/** A whole number from 1 to `max`, else undefined. */
function counted(text: string, max: number): number | undefined {
  if (!/^[1-9][0-9]{0,6}$/.test(text)) return undefined;
  const n = Number(text);
  return n <= max ? n : undefined;
}

/**
 * What `form` asks of the API. The scope chosen beside the query is added
 * to it as one qualifier, quoted, once its value has the shape its kind
 * takes (a shape holding no quote, space or backslash, so it adds nothing
 * else to the query; a quote the query left open makes the whole refused,
 * never the scope part of a phrase). A scope already in the query stays:
 * where the two meet is the API's to say.
 */
export function searchRequestOf(form: SearchForm): SearchPlan {
  if (!form.asked) return { state: "idle" };
  const perPage = counted(form.perPage, SEARCH_LIMITS.perPage);
  if (perPage === undefined)
    return {
      state: "invalid",
      message: `Results a page must be a whole number from 1 to ${SEARCH_LIMITS.perPage}.`,
    };
  const page = counted(form.page, Number.MAX_SAFE_INTEGER);
  if (page === undefined)
    return { state: "invalid", message: "The page must be a whole number from 1." };
  if ((page - 1) * perPage >= SEARCH_LIMITS.depth)
    return {
      state: "invalid",
      message: `Only the first ${SEARCH_LIMITS.depth.toLocaleString("en")} results can be paged through.`,
    };
  const q = form.q.trim();
  let scoped = q;
  if (form.scope && form.scopeValue) {
    if (!scopeShaped(form.scope, form.scopeValue))
      return { state: "invalid", message: `The scope must be ${SCOPE_SHAPE[form.scope]}.` };
    scoped = `${q} ${form.scope}:"${form.scopeValue}"`.trim();
  } else if (!mayHoldScope(q)) return { state: "scope" };
  if ([...scoped].length > SEARCH_LIMITS.queryCodePoints)
    return {
      state: "invalid",
      message: `The query and its scope hold at most ${SEARCH_LIMITS.queryCodePoints} characters.`,
    };
  return {
    state: "ready",
    request: { type: form.type, q: scoped, page, perPage, sort: form.sort, order: form.order },
  };
}

/** The API's path for `request`: sort and order go to the issue search alone. */
export function searchApiPath(request: SearchRequest): string {
  const query = new URLSearchParams({
    q: request.q,
    per_page: String(request.perPage),
    page: String(request.page),
  });
  if (request.type === "issues") {
    if (request.sort) query.set("sort", request.sort);
    query.set("order", request.order);
  }
  return `/search/${request.type}?${query}`;
}

/** The search page asking what `form` does, at `page` with `perPage` a page. */
export function searchHref(form: SearchForm, page: number, perPage: number): string {
  const query = new URLSearchParams({ q: form.q, type: form.type });
  if (form.scope) {
    query.set("scope", form.scope);
    query.set("scope_value", form.scopeValue);
  }
  query.set("page", String(page));
  query.set("per_page", String(perPage));
  if (form.type === "issues") {
    if (form.sort) query.set("sort", form.sort);
    query.set("order", form.order);
  }
  return `/search?${query}`;
}

/** Links to a search's other pages, numbered; `null` where there is none. */
export interface SearchPages {
  readonly previous: string | null;
  readonly next: string | null;
  /** The pages around this one, the first and the last; `null` marks pages left out. */
  readonly numbers: readonly ({ readonly page: number; readonly href: string } | null)[];
  readonly page: number;
}

/** Pages either side of the current one that are numbered. */
const NEARBY = 2;

/**
 * The pages of `total` results (counted to the API's depth at most) at
 * `perPage` a page: a next page only while this one ends before the
 * results counted do, and before the depth the API pages to.
 */
export function searchPages(
  form: SearchForm,
  request: Pick<SearchRequest, "page" | "perPage">,
  total: number,
): SearchPages {
  const { page, perPage } = request;
  const at = (p: number) => searchHref(form, p, perPage);
  const found = Math.min(total, SEARCH_LIMITS.depth);
  const last = Math.max(1, Math.ceil(found / perPage));
  const end = page * perPage;
  const numbers: ({ page: number; href: string } | null)[] = [];
  for (let p = 1; p <= last; p++) {
    if (p === 1 || p === last || Math.abs(p - page) <= NEARBY)
      numbers.push({ page: p, href: at(p) });
    else if (numbers.at(-1) !== null) numbers.push(null);
  }
  return {
    previous: page > 1 ? at(page - 1) : null,
    next: end < found && end < SEARCH_LIMITS.depth ? at(page + 1) : null,
    numbers: last > 1 ? numbers : [],
    page,
  };
}

/** Characters of a body an excerpt shows at most. */
export const EXCERPT_LENGTH = 200;

/** The start of `body` as plain text on one line: white space collapsed, cut at `max` characters. */
export function excerpt(body: string | null, max = EXCERPT_LENGTH): string {
  let out = "";
  let length = 0;
  let space = false;
  for (const ch of body ?? "") {
    if (/\s/.test(ch)) {
      space = length > 0;
      continue;
    }
    if (length + (space ? 2 : 1) > max) return `${out}…`;
    if (space) {
      out += " ";
      length++;
      space = false;
    }
    out += ch;
    length++;
  }
  return out;
}

/** An issue or pull request found, as the page lists it. */
export interface IssueHit {
  readonly key: string;
  readonly href: string;
  readonly title: string;
  readonly number: number;
  readonly status: { readonly label: string; readonly className: string };
  readonly pull: boolean;
  readonly repository: { readonly fullName: string; readonly href: string };
  readonly labels: readonly {
    readonly id: number;
    readonly name: string;
    readonly color: string;
  }[];
  readonly author: string;
  readonly updatedAt: number;
  readonly excerpt: string;
}

/** A repository found, as the page lists it. */
export interface RepositoryHit {
  readonly key: string;
  readonly href: string;
  readonly fullName: string;
  readonly visibility: string;
  readonly description: string;
}

const repoPage = (owner: string, name: string): string =>
  `/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;

/** An issue search's item, linked by its repository's identity now (it may have moved since). */
export function issueHit(item: IssueResults["items"][number]): IssueHit {
  const { owner, name, full_name, id } = item.repository;
  return {
    key: `${id}#${item.number}`,
    href: item.pull_request
      ? pullPage(owner.login, name, item.number)
      : issuePage(owner.login, name, item.number),
    title: item.title,
    number: item.number,
    status: issueStatus(item),
    pull: item.pull_request !== undefined,
    repository: { fullName: full_name, href: repoPage(owner.login, name) },
    labels: item.labels.map(({ id, name, color }) => ({ id, name, color })),
    author: item.user.login,
    updatedAt: item.updated_at,
    excerpt: excerpt(item.body),
  };
}

/** A repository search's item. */
export function repositoryHit(item: RepositoryResults["items"][number]): RepositoryHit {
  return {
    key: item.id,
    href: repoPage(item.owner.login, item.name),
    fullName: item.full_name,
    visibility: item.visibility,
    description: excerpt(item.description),
  };
}
