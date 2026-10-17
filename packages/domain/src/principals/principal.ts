import type { IdPrefix } from "../ids.js";

/** Principal types. */
export const PRINCIPAL_TYPES = ["user", "org", "agent", "installation"] as const;
export type PrincipalType = (typeof PRINCIPAL_TYPES)[number];

export const PRINCIPAL_ID_PREFIX = {
  user: "usr",
  org: "org",
  agent: "agt",
  installation: "ins",
} as const satisfies Record<PrincipalType, IdPrefix>;

/** The type of principal an id names, by its prefix; undefined for any other id. */
export function principalTypeOf(id: string): PrincipalType | undefined {
  const prefix = id.slice(0, id.indexOf("_"));
  return PRINCIPAL_TYPES.find((type) => PRINCIPAL_ID_PREFIX[type] === prefix);
}

export interface Principal {
  id: string;
  type: PrincipalType;
  /** Login name; installations have none. */
  handle: string | null;
  isInstanceAdmin: boolean;
}

/** GitHub-style handle: 1-39 chars, alphanumerics and single inner hyphens. */
export const HANDLE_PATTERN = /^(?=.{1,39}$)[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9]))*$/;

/** The longest handle. */
export const MAX_HANDLE_LENGTH = 39;

/**
 * A handle's shape apart from its length: alphanumerics and single inner
 * hyphens. With the length bounded on its own (1 to `MAX_HANDLE_LENGTH`),
 * it accepts exactly the handles `HANDLE_PATTERN` does; it is written
 * without lookaheads, which schema-driven generators (API fuzzers) cannot
 * follow, so API schemas use it.
 */
export const HANDLE_SHAPE = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;

export function isValidHandle(handle: string): boolean {
  return HANDLE_PATTERN.test(handle);
}

/**
 * Handles no new user, organization or agent may take: the names the web
 * origin's paths start with (the API's and the pages'), where an owner's
 * pages would otherwise be. A new top-level page adds its name here (the
 * web's routing test holds every one to it).
 */
const RESERVED_HANDLES: ReadonlySet<string> = new Set([
  // The API's paths on the web origin.
  "api",
  "auth",
  "mcp",
  "oauth",
  "v0",
  // The web's own pages, and the built assets served before it runs.
  "assets",
  "healthz",
  "settings",
  "sign-out",
]);

/** Whether `handle` is reserved (ignoring case, as handles are unique). */
export function isReservedHandle(handle: string): boolean {
  return RESERVED_HANDLES.has(handle.toLowerCase());
}
