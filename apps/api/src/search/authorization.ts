import type { RepoPermission } from "@fyrden/domain";
import { MAX_READER_REPOS } from "../do/OrgDO.js";
import { FreshAccess } from "../feed/access.js";
import { type OpContext, OperationError } from "../ops/execute.js";
import {
  allowedWithRole,
  listOwnedRepos,
  type RepoEntry,
  resolveRepo,
} from "../repos/directory.js";
import type { ParsedQuery } from "./parser.js";

/*
 * Which repositories a search may read, decided afresh for every request
 * (never from a repository's cached ACL window): its scope (`repo:`,
 * `org:`, `user:`, which intersect) resolved on the directory's primary to
 * the repositories active there now, at most `SEARCH_SCOPE.repositories`;
 * then the caller's role on each as its account's object has it now
 * (`FreshAccess`, its ceilings applied), and what its token allows there
 * with that role (its scopes and repository list). Search needs a scope:
 * there is no deployment-wide search. An answer that could not be had is a
 * refusal, never a smaller scope.
 */

/** The repositories one search's scope may hold at most (an owner's, past which it is refused). */
export const SEARCH_SCOPE = { repositories: 1_000 } as const;

/** A repository of a search's scope, and what the caller may read of it. */
export interface ScopedRepo {
  readonly entry: RepoEntry;
  readonly metadata: boolean;
  readonly issues: boolean;
  readonly pulls: boolean;
}

const READS = {
  metadata: "metadata:read",
  issues: "issues:read",
  pulls: "pull_requests:read",
} as const satisfies Record<string, RepoPermission>;

/** The owner a handle names now, of the type asked, or none. */
async function ownerOf(
  ctx: Pick<OpContext, "env" | "metrics">,
  handle: string,
  type: "org" | "user",
): Promise<string | null> {
  ctx.metrics.count("d1.query", { db: "directory", op: "search_owner" });
  const row = await ctx.env.DIRECTORY.withSession("first-primary")
    .prepare(
      `SELECT id FROM principals WHERE handle = ? COLLATE NOCASE AND type = ?
         AND lifecycle IN ('active', 'suspended')`,
    )
    .bind(handle, type)
    .first<{ id: string }>();
  return row?.id ?? null;
}

/**
 * The repositories `parsed`'s scope holds that the caller may read
 * something of, each with what. Refused when there is no scope
 * (`search_scope_required`), when an owner's holds more than a search may
 * (`search_scope_too_broad`), and when a decision could not be had
 * (`search_authorization_unavailable`); a `repo:` the caller may read
 * nothing of is not found, as any repository it may not read.
 */
export async function authorizeScope(ctx: OpContext, parsed: ParsedQuery): Promise<ScopedRepo[]> {
  if (parsed.repos.length === 0 && parsed.orgs.length === 0 && parsed.users.length === 0)
    throw new OperationError(
      422,
      "search_scope_required",
      "A search needs a scope: repo:owner/name, org:handle or user:handle.",
    );
  return unavailableUnless(async () => {
    // The owners named: they all must be the one owner (scopes intersect).
    const owners = new Set<string | null>();
    for (const handle of parsed.orgs) owners.add(await ownerOf(ctx, handle, "org"));
    for (const handle of parsed.users) owners.add(await ownerOf(ctx, handle, "user"));
    if (parsed.repos.length > 0) {
      // Each named repository, as the directory's primary has it now, decided before anything is
      // intersected: one the caller may read nothing of is not found, as one missing is (an
      // empty intersection would tell them it exists).
      const found = new Map<string, RepoEntry>();
      for (const { owner: handle, name } of parsed.repos) {
        const entry = await resolveRepo(ctx.env, handle, name, {
          consistency: "primary",
          metrics: ctx.metrics,
        });
        if (!entry) throw notFound(`${handle}/${name}`);
        found.set(entry.id, entry);
      }
      const named = await decided(ctx, [...found.values()]);
      for (const entry of found.values())
        if (!named.some((r) => r.entry.id === entry.id))
          throw notFound(parsed.repos.map((r) => `${r.owner}/${r.name}`).join(", "));
      // Then the scopes intersect: one repository, of the one owner named (if any).
      if (found.size > 1 || owners.has(null) || owners.size > 1) return [];
      const [owner] = [...owners];
      return named.filter((r) => owner === undefined || r.entry.ownerId === owner);
    }
    if (owners.has(null) || owners.size > 1) return [];
    const [owner] = [...owners] as string[];
    // The owner's active repositories (among the token's, when it names some), one past the most.
    const entries = await listOwnedRepos(
      ctx.env,
      owner as string,
      { after: "", limit: SEARCH_SCOPE.repositories + 1, onlyIds: ctx.auth.repoIds ?? null },
      ctx.metrics,
    );
    if (entries.length > SEARCH_SCOPE.repositories)
      throw new OperationError(
        422,
        "search_scope_too_broad",
        `A search's scope holds at most ${SEARCH_SCOPE.repositories} repositories: name a repository (repo:owner/name).`,
      );
    return decided(ctx, entries);
  });
}

/** What the caller may read of each of `entries` (those it may read something of). */
async function decided(ctx: OpContext, entries: readonly RepoEntry[]): Promise<ScopedRepo[]> {
  // The caller's role on each, as each account's object has it now, a confirmation's worth at a time.
  const fresh = new FreshAccess(ctx, ctx.auth);
  const scoped: ScopedRepo[] = [];
  for (let i = 0; i < entries.length; i += MAX_READER_REPOS) {
    const chunk = entries.slice(i, i + MAX_READER_REPOS);
    const decisions = await fresh.decide(chunk);
    for (const entry of chunk) {
      const decision = decisions.get(entry.id);
      if (!decision || decision === "unknown") throw unavailable();
      const may = (permission: RepoPermission) =>
        decision.held && allowedWithRole(ctx.auth, entry, permission, decision.role);
      const repo = {
        entry,
        metadata: may(READS.metadata),
        issues: may(READS.issues),
        pulls: may(READS.pulls),
      };
      if (repo.metadata || repo.issues || repo.pulls) scoped.push(repo);
    }
  }
  return scoped;
}

const unavailable = () =>
  new OperationError(
    503,
    "search_authorization_unavailable",
    "Who may read the repositories searched could not be decided now. Try again.",
  );

/** `work`'s answer; a failure of what it reads (not a refusal of its own) is an unavailable one. */
async function unavailableUnless<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof OperationError) throw error;
    throw unavailable();
  }
}

const notFound = (name: string) =>
  new OperationError(404, "repo_not_found", `No repository ${name} you may read.`);
