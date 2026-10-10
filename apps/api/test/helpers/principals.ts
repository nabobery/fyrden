import { env } from "cloudflare:workers";
import { D1TokenStore } from "@fyrden/adapters-cloudflare/auth";
import type { PrincipalType, TokenType } from "@fyrden/domain";
import { createIdFactory, PRINCIPAL_ID_PREFIX, secureRandomBytes } from "@fyrden/domain";

const newId = createIdFactory(() => Date.now(), secureRandomBytes);

/** Creates a principal and a token for it directly in D1. */
export async function principalWithToken(
  type: Exclude<PrincipalType, "installation" | "org"> = "user",
  tokenType: TokenType = "pat",
  { admin = false }: { admin?: boolean } = {},
): Promise<{ principalId: string; token: string }> {
  const principalId = newId(PRINCIPAL_ID_PREFIX[type]);
  let ownerId: string | null = null;
  if (type === "agent") ownerId = (await principalWithToken("user")).principalId;
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
  const store = new D1TokenStore(env.DIRECTORY, {
    clock: () => Date.now(),
    newId,
    randomBytes: secureRandomBytes,
  });
  const { token } = await store.mint({
    principalId,
    type: tokenType,
    scopes: [],
    ttlMs: 60 * 60 * 1000,
    audit: { actorId: principalId },
  });
  return { principalId, token };
}
