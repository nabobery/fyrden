import { parseTokenRestrictions } from "@fyrden/adapters-cloudflare/auth";
import { ownsUserAccount, type PrincipalType, type RepoRole } from "@fyrden/domain";
import { allowedWithRole } from "../../repos/directory.js";
import type { PushDecision } from "./commit.js";
import { ACCESS_LOST, TOKEN_REVOKED } from "./reauthorize.js";

type Row = {
  principal_id: string;
  principal_type: PrincipalType;
  scopes: string;
  repo_ids: string | null;
  revoked_at: number | null;
  disabled_at: number | null;
  owner_id: string | null;
  repo_state: string | null;
};

/**
 * The commit-point check for a write the repository object makes itself
 * (an import from its alarm, a file write), with no Worker holding the
 * token: the token (by id) and the repository are read from the D1
 * primary. As for a push, a token that merely expired since the write was
 * accepted does not stop it; a revoked token, a disabled principal, a
 * deleted repository or lost write access does.
 */
export async function reauthorizeByToken(
  db: D1Database,
  accepted: { readonly tokenId: string; readonly principal: string; readonly repoId: string },
  /** The principal's role for a write, from the repository's own ACL snapshot. */
  roleOf: (principalId: string) => Promise<RepoRole | null>,
): Promise<PushDecision> {
  const decide = (refusal?: string): PushDecision => ({
    ...(refusal === undefined ? {} : { refusal }),
    tokenId: accepted.tokenId,
    decidedAt: Date.now(),
  });
  const row = await db
    .withSession("first-primary")
    .prepare(
      `SELECT t.principal_id, p.type AS principal_type, t.scopes,
              t.repo_ids, t.revoked_at, p.disabled_at,
              r.owner_id, r.state AS repo_state
       FROM tokens t JOIN principals p ON p.id = t.principal_id
       LEFT JOIN repos r ON r.id = ?
       WHERE t.id = ?`,
    )
    .bind(accepted.repoId, accepted.tokenId)
    .first<Row>();
  if (
    !row ||
    row.revoked_at !== null ||
    row.disabled_at !== null ||
    row.principal_id !== accepted.principal
  )
    return decide(TOKEN_REVOKED);
  const restrictions = parseTokenRestrictions(row.scopes, row.repo_ids);
  if (!restrictions) return decide(TOKEN_REVOKED);
  if (row.owner_id === null || row.repo_state !== "active") return decide(ACCESS_LOST);
  // The same rule the request path applies, from the fields it reads.
  const token = {
    principalId: row.principal_id,
    principalType: row.principal_type,
    ...restrictions,
  };
  // As on the request path: a user owns its own repositories outright.
  const role = ownsUserAccount(row.principal_id, row.owner_id)
    ? "admin"
    : await roleOf(row.principal_id);
  return allowedWithRole(token, { id: accepted.repoId }, "contents:write", role)
    ? decide()
    : decide(ACCESS_LOST);
}
