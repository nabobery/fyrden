import { parseTokenRestrictions } from "@fyrden/adapters-cloudflare/auth";
import type {
  createUserToken,
  Input,
  listUserTokens,
  Output,
  revokeUserToken,
} from "@fyrden/api-contract";
import { isPermission, scopesAllow } from "@fyrden/domain";
import { decodeSeekCursor, encodeSeekCursor } from "../ops/cursor.js";
import { type OpContext, OperationError } from "../ops/execute.js";
import { tokenStore } from "../services.js";

/** A user's own personal access and git tokens: listed, minted (never wider than the caller's), revoked. */

const DAY_MS = 24 * 60 * 60 * 1000;

type TokenRow = {
  id: string;
  type: "pat" | "git";
  scopes: string;
  repo_ids: string | null;
  created_at: number;
  expires_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
};

/** The `users.tokens.list` operation: newest first. */
export function listUserTokensOperation(
  ctx: OpContext,
  input: Input<typeof listUserTokens>,
): Promise<Output<typeof listUserTokens>> {
  return listTokensOf(ctx, ctx.auth.principalId, input);
}

/**
 * The personal access and git tokens `principalId` acts with as itself
 * (not delegated ones), newest first: a user's own, or an agent's for its
 * owner. Never the token values.
 */
export async function listTokensOf(
  ctx: OpContext,
  principalId: string,
  input: { readonly per_page: number; readonly cursor?: string | undefined },
): Promise<Output<typeof listUserTokens>> {
  const before = decodeSeekCursor(input.cursor, "tok") ?? { at: Number.MAX_SAFE_INTEGER, id: "" };
  ctx.metrics.count("d1.query", { db: "directory", op: "user_tokens_list" });
  const { results } = await ctx.env.DIRECTORY.withSession("first-primary")
    .prepare(
      `SELECT id, type, scopes, repo_ids, created_at, expires_at, last_used_at, revoked_at
       FROM tokens WHERE principal_id = ?1 AND type IN ('pat', 'git') AND grant_id IS NULL
         AND (created_at < ?2 OR (created_at = ?2 AND id < ?3))
       ORDER BY created_at DESC, id DESC LIMIT ?4`,
    )
    .bind(principalId, before.at, before.id, input.per_page + 1)
    .all<TokenRow>();
  const page = results.slice(0, input.per_page);
  const last = page.at(-1);
  return {
    tokens: page.map((row) => {
      const restrictions = parseTokenRestrictions(row.scopes, row.repo_ids);
      return {
        id: row.id,
        type: row.type,
        scopes: restrictions?.scopes ?? [],
        repositories: restrictions?.repoIds ?? null,
        created_at: row.created_at,
        expires_at: row.expires_at,
        last_used_at: row.last_used_at,
        revoked: row.revoked_at !== null,
      };
    }),
    next_cursor:
      results.length > input.per_page && last
        ? encodeSeekCursor({ at: last.created_at, id: last.id })
        : null,
  };
}

/** The `users.tokens.create` operation. */
export async function createUserTokenOperation(
  ctx: OpContext,
  input: Input<typeof createUserToken>,
): Promise<Output<typeof createUserToken>> {
  // Never wider than the token (or session) making it.
  const own = ctx.auth.scopes;
  const scopes = input.scopes.length === 0 ? own : input.scopes;
  if (!scopes.every((scope) => isPermission(scope) && scopesAllow(own, scope)))
    throw new OperationError(403, "scope_exceeds_token", "The scopes exceed your token's.");
  const minted = await tokenStore(ctx.env, { metrics: ctx.metrics }).mint({
    principalId: ctx.auth.principalId,
    type: input.type,
    scopes,
    repoIds: ctx.auth.repoIds,
    ttlMs: input.expires_in_days * DAY_MS,
    // Never past the token making it (a session is the user itself, signed in).
    ...(ctx.auth.type !== "ses" && { notAfter: ctx.auth.expiresAt }),
    audit: {
      actorId: ctx.auth.principalId,
      ...(ctx.requestId !== undefined && { requestId: ctx.requestId }),
    },
  });
  return {
    id: minted.id,
    token: minted.token,
    type: input.type,
    scopes,
    expires_at: minted.expiresAt,
  };
}

/** The `users.tokens.revoke` operation: revoking again answers the same. */
export function revokeUserTokenOperation(
  ctx: OpContext,
  input: Input<typeof revokeUserToken>,
): Promise<Output<typeof revokeUserToken>> {
  return revokeTokenOf(ctx, ctx.auth.principalId, input.token_id);
}

/**
 * Revokes one of `principalId`'s own tokens (personal access or git), as
 * the caller: at once for writes, audited. A token of anyone else is not
 * found; revoking again answers the same.
 */
export async function revokeTokenOf(
  ctx: OpContext,
  principalId: string,
  tokenId: string,
): Promise<Output<typeof revokeUserToken>> {
  const row = await ctx.env.DIRECTORY.withSession("first-primary")
    .prepare(
      "SELECT revoked_at FROM tokens WHERE id = ? AND principal_id = ? AND type IN ('pat', 'git')",
    )
    .bind(tokenId, principalId)
    .first<{ revoked_at: number | null }>();
  if (!row) throw new OperationError(404, "token_not_found", `There is no token ${tokenId}.`);
  if (row.revoked_at === null)
    await tokenStore(ctx.env, { metrics: ctx.metrics }).revoke(tokenId, {
      actorId: ctx.auth.principalId,
      ...(ctx.requestId !== undefined && { requestId: ctx.requestId }),
    });
  return { id: tokenId, revoked: true };
}
