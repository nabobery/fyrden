import type { TokenRecord } from "@fyrden/adapters-cloudflare/auth";
import type { Metrics } from "@fyrden/adapters-cloudflare/obs";
import type { AuthState } from "../../middleware/auth.js";
import { authorize, type RepoEntry, resolveRepo } from "../../repos/directory.js";
import type { GitContext } from "../http.js";
import type { PushDecision } from "./commit.js";

export const TOKEN_REVOKED = "the token used for this push is no longer valid";
export const ACCESS_LOST = "you no longer have write access to this repository";

/**
 * Checks the pusher again just before the commit: the token on the D1
 * primary (never the isolate cache), and write access to the repository
 * from the primary directory. A token that merely expired since the upload
 * was accepted does not stop the push; a revoked or disabled token, a
 * deleted principal, or lost access does.
 */
export function reauthorizePush(
  c: GitContext,
  accepted: { readonly auth: TokenRecord; readonly repo: RepoEntry },
  repoName: { readonly owner: string; readonly name: string },
): Promise<PushDecision> {
  return reauthorizeWriter(
    { env: c.env, authState: c.get("authState"), metrics: c.get("metrics") },
    accepted,
    repoName,
  );
}

/** The same check for any request that holds the writer's token (an API operation). */
export async function reauthorizeWriter(
  request: { readonly env: Env; readonly authState: AuthState; readonly metrics: Metrics },
  accepted: { readonly auth: TokenRecord; readonly repo: RepoEntry },
  repoName: { readonly owner: string; readonly name: string },
): Promise<PushDecision> {
  const decide = (refusal?: string): PushDecision => ({
    ...(refusal === undefined ? {} : { refusal }),
    tokenId: accepted.auth.id,
    decidedAt: Date.now(),
  });
  const verified = await request.authState.verifyForWrite();
  // An expired token is judged on what the primary says it holds now.
  const record = verified.ok ? verified.record : verified.expiredRecord;
  if (!record || record.id !== accepted.auth.id) return decide(TOKEN_REVOKED);
  const repo = await resolveRepo(request.env, repoName.owner, repoName.name, {
    consistency: "primary",
    metrics: request.metrics,
  });
  if (
    !repo ||
    repo.id !== accepted.repo.id ||
    !(await authorize(request.env, record, repo, "contents:write", request.metrics))
  ) {
    return decide(ACCESS_LOST);
  }
  return decide();
}
