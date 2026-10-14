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

/** What a signature check says, and whose commit it is on. */
export interface SignedFact {
  readonly reason: SignatureCheck["reason"];
  /** The signing key's fingerprint, when the signature is valid. */
  readonly key: string | null;
  readonly committerEmail: string;
}

/**
 * Whether each fact is a verified signature. A valid signature is verified
 * when its key is the platform's (current or retired), or a user's whose
 * no-reply address (`<user id>@users.noreply.<host>`) is the commit's
 * committer (`bad_email` otherwise); by any other key it is `unknown_key`.
 * Every other outcome is unverified with its reason. Keys are read only
 * when a signature needs them.
 */
export async function verdicts(
  ctx: VerifyContext,
  facts: readonly SignedFact[],
): Promise<{ verified: boolean; reason: string }[]> {
  const signed = new Set(facts.flatMap((f) => (f.reason === "signed" && f.key ? [f.key] : [])));
  const platform =
    signed.size > 0
      ? new Set((await platformKeys(ctx.env)).map((k) => k.fingerprint))
      : new Set<string>();
  const users = await userKeys(
    ctx,
    [...signed].filter((key) => !platform.has(key)),
  );
  return facts.map((fact) => {
    if (fact.reason !== "signed" || fact.key === null)
      return { verified: false, reason: fact.reason };
    if (platform.has(fact.key)) return { verified: true, reason: "valid" };
    const owner = users.get(fact.key);
    if (owner === undefined) return { verified: false, reason: "unknown_key" };
    return isNoReplyOf(fact.committerEmail, owner)
      ? { verified: true, reason: "valid" }
      : { verified: false, reason: "bad_email" };
  });
}

/** Resolves the signature checks of `views` into GitHub's `verification` (see `verdicts`). */
export async function resolveVerification(
  ctx: VerifyContext,
  views: readonly CommitView[],
): Promise<VerifiedCommit[]> {
  const results = await verdicts(
    ctx,
    views.map((v) => ({
      reason: v.commit.verification.reason,
      key: v.commit.verification.key,
      committerEmail: v.commit.committer.email,
    })),
  );
  return views.map((view, i) => ({
    ...view,
    commit: {
      ...view.commit,
      verification: {
        ...(results[i] as { verified: boolean; reason: string }),
        signature: view.commit.verification.signature,
        payload: view.commit.verification.payload,
        verified_at: null,
      },
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
