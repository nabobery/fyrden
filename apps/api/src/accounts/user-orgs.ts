import type { Input, listUserOrgs, Output } from "@fyrden/api-contract";
import { type OrgRole, principalTypeOf } from "@fyrden/domain";
import { type ListResult, listResult, type OpContext, OperationError } from "../ops/execute.js";
import { type Account, actingRoleIn } from "./account.js";
import { toApiRole } from "./orgs.js";

const MAX_LISTED = 200;
const CANDIDATES = 250;
const MAX_CANDIDATES = 500;

/** The candidates of principal `?1` after organization `?2`, at most `?3`; see `memberships.ts`. */
export const MEMBERSHIPS_SQL = `SELECT o.id, o.type, o.handle
  FROM memberships m INDEXED BY memberships_principal JOIN principals o ON o.id = m.org_id
  WHERE m.principal_id = ?1 AND m.org_id > ?2 AND o.disabled_at IS NULL
  ORDER BY m.org_id LIMIT ?3`;

interface Listed {
  readonly org: Account;
  readonly role: OrgRole;
}

/**
 * The `users.orgs.list` operation. Everything the answer shows (items,
 * order, count) comes from organizations whose object gives the caller a
 * role, and nothing is read of one the token may not see.
 */
export async function listUserOrgsOperation(
  ctx: OpContext,
  input: Input<typeof listUserOrgs>,
): Promise<ListResult<Output<typeof listUserOrgs>>> {
  const listed = await listedOrgs(ctx);
  const from = (input.page - 1) * input.per_page;
  return listResult(
    listed.slice(from, from + input.per_page).map(({ org, role }) => {
      const url = `${ctx.requestOrigin}/api/orgs/${org.handle}`;
      return {
        login: org.handle,
        id: org.id,
        repos_url: `${url}/repos`,
        members_url: `${url}/members`,
        description: null,
        role: toApiRole(role),
      };
    }),
    listed.length,
  );
}

async function listedOrgs(ctx: OpContext): Promise<Listed[]> {
  const { auth } = ctx;
  if (auth.repoIds !== null || principalTypeOf(auth.principalId) !== "user") return [];
  const ceilings = [...new Set(auth.ceilingIds)].filter((id) => id !== auth.principalId);
  // What two users share cannot be read without work that depends on what they do not.
  if (ceilings.some((id) => principalTypeOf(id) !== "org"))
    throw new OperationError(
      403,
      "delegated_listing",
      "List organizations with the user's own credentials, or an agent of the user's own.",
    );
  const [owner] = ceilings;
  if (owner !== undefined) return confirmed(ctx, await namedOrg(ctx, owner));
  const listed: Listed[] = [];
  let after = "";
  for (let read = 0; read < MAX_CANDIDATES && listed.length < MAX_LISTED; read += CANDIDATES) {
    const candidates = await recordedOrgs(ctx, after);
    listed.push(...(await confirmed(ctx, candidates)));
    const last = candidates.at(-1);
    if (!last || candidates.length < CANDIDATES) break;
    after = last.id;
  }
  return listed.slice(0, MAX_LISTED);
}

async function recordedOrgs({ env, auth, metrics }: OpContext, after: string): Promise<Account[]> {
  metrics.count("d1.query", { db: "directory", op: "user_orgs" });
  const { results } = await env.DIRECTORY.withSession("first-primary")
    .prepare(MEMBERSHIPS_SQL)
    .bind(auth.principalId, after, CANDIDATES)
    .all<Account>();
  return results;
}

async function namedOrg({ env, metrics }: OpContext, id: string): Promise<Account[]> {
  metrics.count("d1.query", { db: "directory", op: "user_orgs_owner" });
  const { results } = await env.DIRECTORY.withSession("first-primary")
    .prepare("SELECT id, type, handle FROM principals WHERE id = ? AND disabled_at IS NULL")
    .bind(id)
    .all<Account>();
  return results;
}

async function confirmed(ctx: OpContext, candidates: readonly Account[]): Promise<Listed[]> {
  const roles = await Promise.all(
    candidates.map((org) => actingRoleIn(ctx.env, org, ctx.auth, ctx.metrics)),
  );
  return candidates.flatMap((org, i) => {
    const role = roles[i] ?? null;
    return role === null ? [] : [{ org, role }];
  });
}
