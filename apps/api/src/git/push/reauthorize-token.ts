import {
  delegationOf,
  parseTokenRestrictions,
  readGrantLinks,
} from "@fyrden/adapters-cloudflare/auth";
import { isId, type PrincipalType, type RepoRole } from "@fyrden/domain";
import { allowedWithRole } from "../../repos/directory.js";
import type { PushDecision } from "./commit.js";
import { ACCESS_LOST, TOKEN_REVOKED } from "./reauthorize.js";

type Row = {
  principal_id: string;
  principal_type: PrincipalType;
  agent_owner_id: string | null;
  agent_owner_disabled_at: number | null;
  scopes: string;
  repo_ids: string | null;
  revoked_at: number | null;
  disabled_at: number | null;
  grant_id: string | null;
  act_chain: string | null;
  owner_id: string | null;
  repo_state: string | null;
};

/**
 * The commit-point check for a write the repository object makes itself
 * (an import from its alarm, a file write), with no Worker holding the
 * token: the token (by id) and the repository are read from the D1
 * primary (or, for one made from the web UI, the signed-in session). As
 * for a push, a token that merely expired since the write was
 * accepted does not stop it; a revoked token (or delegation grant), a
 * disabled principal, agent or owner, a deleted repository or lost write
 * access (the principal's, or an acting agent's owner's) does.
 */
export async function reauthorizeByToken(
  db: D1Database,
  accepted: {
    readonly tokenId: string;
    readonly principal: string;
    readonly repoId: string;
    /** The request making the write, for its audit row. */
    readonly requestId?: string | null;
  },
  /** The principal's role for a write, from the repository's own ACL snapshot. */
  roleOf: (principalId: string) => Promise<RepoRole | null>,
): Promise<PushDecision> {
  let actChain: readonly string[] = [];
  const decide = (refusal?: string): PushDecision => ({
    ...(refusal === undefined ? {} : { refusal }),
    tokenId: accepted.tokenId,
    decidedAt: Date.now(),
    actChain,
    requestId: accepted.requestId ?? null,
  });
  const session = db.withSession("first-primary");
  // A write made from the web UI: a signed-in session, with the user's full rights.
  if (isId(accepted.tokenId, "ses")) {
    const signedIn = await session
      .prepare(
        `SELECT s.user_id, r.owner_id, r.state AS repo_state FROM sessions s
         JOIN principals p ON p.id = s.user_id LEFT JOIN repos r ON r.id = ?
         WHERE s.id = ? AND s.revoked_at IS NULL AND p.disabled_at IS NULL`,
      )
      .bind(accepted.repoId, accepted.tokenId)
      .first<{ user_id: string; owner_id: string | null; repo_state: string | null }>();
    if (!signedIn || signedIn.user_id !== accepted.principal) return decide(TOKEN_REVOKED);
    if (signedIn.owner_id === null || signedIn.repo_state !== "active") return decide(ACCESS_LOST);
    const role = signedIn.user_id === signedIn.owner_id ? "admin" : await roleOf(signedIn.user_id);
    return allowedWithRole(
      { principalId: signedIn.user_id, principalType: "user", scopes: [], repoIds: null },
      { id: accepted.repoId },
      "contents:write",
      role,
    )
      ? decide()
      : decide(ACCESS_LOST);
  }
  const row = await session
    .prepare(
      `SELECT t.principal_id, p.type AS principal_type, p.owner_id AS agent_owner_id,
              o.disabled_at AS agent_owner_disabled_at, t.scopes, t.repo_ids, t.revoked_at,
              p.disabled_at, t.grant_id, t.act_chain, r.owner_id, r.state AS repo_state
       FROM tokens t JOIN principals p ON p.id = t.principal_id
       LEFT JOIN principals o ON o.id = p.owner_id
       LEFT JOIN repos r ON r.id = ?
       WHERE t.id = ?`,
    )
    .bind(accepted.repoId, accepted.tokenId)
    .first<Row>();
  if (
    !row ||
    row.revoked_at !== null ||
    row.disabled_at !== null ||
    row.agent_owner_disabled_at !== null ||
    row.principal_id !== accepted.principal
  )
    return decide(TOKEN_REVOKED);
  const restrictions = parseTokenRestrictions(row.scopes, row.repo_ids);
  // A delegated token holds only while its grants and agents do.
  const delegation =
    row.grant_id !== null && row.act_chain !== null
      ? delegationOf(
          row.grant_id,
          row.act_chain,
          await readGrantLinks(session, row.grant_id),
          Date.now(),
        )
      : null;
  if (!restrictions || delegation === undefined) return decide(TOKEN_REVOKED);
  if (delegation) actChain = JSON.parse(row.act_chain ?? "[]") as string[];
  if (row.owner_id === null || row.repo_state !== "active") return decide(ACCESS_LOST);
  // The same rule the request path applies, from the fields it reads.
  const token = {
    principalId: row.principal_id,
    principalType: delegation ? ("agent" as const) : row.principal_type,
    ...restrictions,
  };
  const repoOwner = row.owner_id;
  // As on the request path: an account administers its own repositories outright.
  const roleNow = (principalId: string) =>
    principalId === repoOwner ? Promise.resolve<RepoRole>("admin") : roleOf(principalId);
  const ceilings = delegation
    ? delegation.ceilingIds
    : row.agent_owner_id === null
      ? []
      : [row.agent_owner_id];
  for (const principalId of [row.principal_id, ...new Set(ceilings)])
    if (
      !allowedWithRole(token, { id: accepted.repoId }, "contents:write", await roleNow(principalId))
    )
      return decide(ACCESS_LOST);
  return decide();
}
