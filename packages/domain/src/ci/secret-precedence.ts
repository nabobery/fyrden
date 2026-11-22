/*
 * Which organization secrets and variables reach a repository, and what a run
 * of the repository gets, as GitHub's (verified:
 * https://docs.github.com/en/actions/reference/security/secrets and
 * https://docs.github.com/en/actions/reference/workflows-and-actions/variables).
 * Names are compared as stored (uppercase), ignoring case, and ordered by code
 * unit, as SQLite's default collation orders them.
 */
import { ciValueBytes } from "./secret-names.js";

/** Which repositories of the organization an organization secret or variable reaches. */
export type OrgVisibility = "all" | "private" | "selected";
export type RepoVisibility = "public" | "internal" | "private";

export interface OrgAccess {
  readonly visibility: OrgVisibility;
  /** Whether the repository is on its list of selected repositories. */
  readonly selected: boolean;
}

/**
 * Whether an organization entry reaches a repository of `repoVisibility`:
 * `all` every one, `private` private and internal ones, `selected` the
 * listed ones.
 */
export function reachesRepo(entry: OrgAccess, repoVisibility: RepoVisibility): boolean {
  switch (entry.visibility) {
    case "all":
      return true;
    case "private":
      return repoVisibility !== "public";
    case "selected":
      return entry.selected;
  }
}

/** Organization secrets a run may use at most: the first ones by name, of those that reach it. */
export const MAX_RUN_ORG_SECRETS = 100;

const byName = <T extends { readonly name: string }>(a: T, b: T) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
const key = (name: string) => name.toUpperCase();

/**
 * The secrets a run of a repository may use, by name in order: the first
 * `MAX_RUN_ORG_SECRETS` organization secrets that reach it, then its own,
 * which override an organization secret of the same name.
 */
export function runSecrets<
  O extends OrgAccess & { readonly name: string },
  R extends { readonly name: string },
>(org: readonly O[], repo: readonly R[], repoVisibility: RepoVisibility): Map<string, O | R> {
  const out = new Map<string, O | R>();
  const eligible = org
    .filter((s) => reachesRepo(s, repoVisibility))
    .sort(byName)
    .slice(0, MAX_RUN_ORG_SECRETS);
  for (const s of eligible) out.set(key(s.name), s);
  for (const s of repo) out.set(key(s.name), s);
  return new Map([...out].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** The variables a run gets at most, counted as UTF-8 bytes of their names and values (Proposed: GitHub's unit is not stated). */
export const MAX_RUN_VARIABLES_BYTES = 256 * 1024;

/**
 * The variables a run of a repository gets: its own by name while they fit
 * in `MAX_RUN_VARIABLES_BYTES`, then the organization's that reach it and
 * that it does not override, by name, in the space left. Each part stops at
 * the first variable that does not fit; the run goes on without the rest.
 */
export function runVariables(
  org: readonly (OrgAccess & { readonly name: string; readonly value: string })[],
  repo: readonly { readonly name: string; readonly value: string }[],
  repoVisibility: RepoVisibility,
): Record<string, string> {
  const out: Record<string, string> = {};
  let left = MAX_RUN_VARIABLES_BYTES;
  const take = (vars: readonly { readonly name: string; readonly value: string }[]) => {
    for (const v of [...vars].sort(byName)) {
      const size = ciValueBytes(v.name) + ciValueBytes(v.value);
      if (size > left) return;
      left -= size;
      out[key(v.name)] = v.value;
    }
  };
  const own = new Set(repo.map((v) => key(v.name)));
  take(repo);
  take(org.filter((v) => !own.has(key(v.name)) && reachesRepo(v, repoVisibility)));
  return out;
}
