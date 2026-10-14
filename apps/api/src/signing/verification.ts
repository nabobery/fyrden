import type { Metrics } from "@fyrden/adapters-cloudflare/obs";
import type { CommitView } from "../do/repo/browse.js";
import type { SignatureCheck } from "../do/repo/signature.js";
import { platformKeys } from "./platform-key.js";

/** GitHub's `commit.verification`. */
export interface Verification {
  readonly verified: boolean;
  readonly reason: string;
  readonly signature: string | null;
  readonly payload: string | null;
  readonly verified_at: string | null;
}

/** A commit as the API answers it: its signature resolved into GitHub's `verification`. */
export type VerifiedCommit = Omit<CommitView, "commit"> & {
  readonly commit: Omit<CommitView["commit"], "verification"> & { verification: Verification };
};

/** What resolving needs: the platform's keys (`env`) and the directory's users' keys. */
export interface VerifyContext {
  readonly env: Env;
  readonly metrics?: Metrics;
}

/**
 * Resolves the signature checks of `views`. A valid signature is verified
 * when its key is the platform's (current or retired), or a user's whose
 * no-reply address (`<user id>@users.noreply.<host>`) is the commit's
 * committer (`bad_email` otherwise); by any other key it is `unknown_key`.
 * Every other outcome is unverified with its reason.
 */
export async function resolveVerification(
  ctx: VerifyContext,
  views: readonly CommitView[],
): Promise<VerifiedCommit[]> {
  const signed = new Set(
    views.flatMap((v) =>
      v.commit.verification.reason === "signed" && v.commit.verification.key
        ? [v.commit.verification.key]
        : [],
    ),
  );
  // The keys are read only when a signature needs them.
  const platform =
    signed.size > 0
      ? new Set((await platformKeys(ctx.env)).map((k) => k.fingerprint))
      : new Set<string>();
  const users = await userKeys(
    ctx,
    [...signed].filter((key) => !platform.has(key)),
  );
  return views.map((view) => ({
    ...view,
    commit: {
      ...view.commit,
      verification: verificationOf(view.commit, platform, users),
    },
  }));
}

/** `resolveVerification` for one commit, or none. */
export async function resolveOne<T extends CommitView | null>(
  ctx: VerifyContext,
  view: T,
): Promise<T extends null ? null : VerifiedCommit> {
  if (view === null) return null as T extends null ? null : VerifiedCommit;
  const [resolved] = await resolveVerification(ctx, [view]);
  return resolved as T extends null ? null : VerifiedCommit;
}

/** The users (enabled ones) whose keys have these fingerprints, by fingerprint. */
async function userKeys(
  ctx: VerifyContext,
  fingerprints: readonly string[],
): Promise<Map<string, string>> {
  if (fingerprints.length === 0) return new Map();
  ctx.metrics?.count("d1.query", { db: "directory", op: "signing_keys_owners" });
  const { results } = await ctx.env.DIRECTORY.prepare(
    `SELECT k.fingerprint, k.principal_id FROM ssh_signing_keys k
     JOIN principals p ON p.id = k.principal_id
     WHERE k.fingerprint IN (SELECT value FROM json_each(?)) AND p.disabled_at IS NULL`,
  )
    .bind(JSON.stringify(fingerprints))
    .all<{ fingerprint: string; principal_id: string }>();
  return new Map(results.map((r) => [r.fingerprint, r.principal_id]));
}

/** Whether `email` is `principalId`'s no-reply address (on any host of the deployment). */
function isNoReplyOf(email: string, principalId: string): boolean {
  const lower = email.toLowerCase();
  const at = lower.indexOf("@");
  return (
    at > 0 &&
    lower.slice(0, at) === principalId.toLowerCase() &&
    lower.slice(at + 1).startsWith("users.noreply.")
  );
}

function verificationOf(
  commit: CommitView["commit"],
  platform: ReadonlySet<string>,
  users: ReadonlyMap<string, string>,
): Verification {
  const check: SignatureCheck = commit.verification;
  const shown = { signature: check.signature, payload: check.payload, verified_at: null };
  if (check.reason !== "signed" || check.key === null)
    return { verified: false, reason: check.reason, ...shown };
  if (platform.has(check.key)) return { verified: true, reason: "valid", ...shown };
  const owner = users.get(check.key);
  if (owner === undefined) return { verified: false, reason: "unknown_key", ...shown };
  return isNoReplyOf(commit.committer.email, owner)
    ? { verified: true, reason: "valid", ...shown }
    : { verified: false, reason: "bad_email", ...shown };
}
