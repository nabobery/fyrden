import { env } from "cloudflare:workers";
import { D1TokenStore } from "@fyrden/adapters-cloudflare/auth";
import type { PrincipalType, TokenType } from "@fyrden/domain";
import { createIdFactory, PRINCIPAL_ID_PREFIX, secureRandomBytes } from "@fyrden/domain";

const newId = createIdFactory(() => Date.now(), secureRandomBytes);

/** Creates a principal and a token for it directly in D1. */
export async function principalWithToken(
  type: Exclude<PrincipalType, "installation" | "org"> = "user",
  tokenType: TokenType = "pat",
  // `owner`: an agent's owner; a new user when absent.
  { admin = false, owner }: { admin?: boolean; owner?: string } = {},
): Promise<{ principalId: string; token: string }> {
  const principalId = newId(PRINCIPAL_ID_PREFIX[type]);
  let ownerId: string | null = null;
  if (type === "agent") ownerId = owner ?? (await principalWithToken("user")).principalId;
  await env.DIRECTORY.prepare(
    "INSERT INTO principals (id, type, handle, owner_id, is_instance_admin, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(
      principalId,
      type,
      principalId.toLowerCase().replace("_", "-"),
      ownerId,
      admin ? 1 : 0,
      Date.now(),
    )
    .run();
  return { principalId, token: await scopedToken(principalId, [], tokenType) };
}

/**
 * Mints a token for an existing principal, limited to `scopes` (none: its
 * full rights) and, when given, to the repositories `repoIds`.
 */
export async function scopedToken(
  principalId: string,
  scopes: string[],
  tokenType: TokenType = "pat",
  repoIds?: string[],
): Promise<string> {
  const store = new D1TokenStore(env.DIRECTORY, {
    clock: () => Date.now(),
    newId,
    randomBytes: secureRandomBytes,
  });
  const { token } = await store.mint({
    principalId,
    type: tokenType,
    scopes,
    ...(repoIds && { repoIds }),
    ttlMs: 60 * 60 * 1000,
    audit: { actorId: principalId },
  });
  return token;
}
