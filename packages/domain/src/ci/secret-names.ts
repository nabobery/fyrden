/*
 * Names and limits of Actions secrets and variables, as GitHub's (verified:
 * https://docs.github.com/en/actions/reference/security/secrets and
 * https://docs.github.com/en/actions/reference/workflows-and-actions/variables).
 */

/** A value's size at most: GitHub's 48 KB, read as 48 × 1024 bytes of UTF-8 (Proposed: GitHub does not say). */
export const MAX_CI_VALUE_BYTES = 48 * 1024;
export const MAX_ORG_SECRETS = 1_000;
export const MAX_REPO_SECRETS = 100;
export const MAX_ORG_VARIABLES = 1_000;
export const MAX_REPO_VARIABLES = 500;
/** Repositories one organization secret or variable lists at most (Fyrden's; GitHub states none). Proposed. */
export const MAX_SELECTED_REPOS = 1_000;

export type CiNameKind = "secret" | "variable";

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * `name` as stored (uppercase), or undefined when it is not allowed:
 * letters, digits and `_`, not starting with a digit or `GITHUB_` (in any
 * case). A secret may not be named `GITEA_TOKEN`, which carries a job's token
 * to the runner (Fyrden's rule; GitHub has none).
 */
export function ciName(kind: CiNameKind, name: string): string | undefined {
  if (!NAME.test(name)) return undefined;
  const upper = name.toUpperCase();
  if (upper.startsWith("GITHUB_")) return undefined;
  if (kind === "secret" && upper === "GITEA_TOKEN") return undefined;
  return upper;
}

const encoder = new TextEncoder();

/** A value's size in UTF-8 bytes. */
export function ciValueBytes(value: string): number {
  return encoder.encode(value).length;
}
