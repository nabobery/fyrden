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

/**
 * Resolves the signature checks of `views`: a valid signature by the
 * platform's key (current or retired) is verified; by any other key it is
 * `unknown_key`; every other outcome is unverified with its reason.
 */
export async function resolveVerification(
  env: object,
  views: readonly CommitView[],
): Promise<VerifiedCommit[]> {
  // The keys are read only when a signature needs them.
  const platform = views.some((v) => v.commit.verification.reason === "signed")
    ? new Set((await platformKeys(env)).map((k) => k.fingerprint))
    : new Set<string>();
  return views.map((view) => ({
    ...view,
    commit: { ...view.commit, verification: verificationOf(view.commit.verification, platform) },
  }));
}

/** `resolveVerification` for one commit, or none. */
export async function resolveOne<T extends CommitView | null>(
  env: object,
  view: T,
): Promise<T extends null ? null : VerifiedCommit> {
  if (view === null) return null as T extends null ? null : VerifiedCommit;
  const [resolved] = await resolveVerification(env, [view]);
  return resolved as T extends null ? null : VerifiedCommit;
}

function verificationOf(check: SignatureCheck, platform: ReadonlySet<string>): Verification {
  const known = check.reason === "signed" && check.key !== null && platform.has(check.key);
  return {
    verified: known,
    reason: check.reason === "signed" ? (known ? "valid" : "unknown_key") : check.reason,
    signature: check.signature,
    payload: check.payload,
    verified_at: null,
  };
}
