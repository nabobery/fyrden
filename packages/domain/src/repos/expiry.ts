/**
 * Repository expiry: a repository may name a time it is deleted at
 * (scratch repositories of agents and tests). The cron deletes expired
 * repositories through the ordinary deletion.
 */

/** The furthest ahead an expiry may be set: one year. Proposed. */
export const MAX_REPO_TTL_MS = 365 * 24 * 60 * 60 * 1000;

/** Why `expiresAt` cannot be set at `now`, or undefined when it can. */
export function expiryProblem(expiresAt: number, now: number): string | undefined {
  if (expiresAt <= now) return "expires_at must be in the future.";
  if (expiresAt - now > MAX_REPO_TTL_MS) return "expires_at may be at most one year ahead.";
  return undefined;
}
