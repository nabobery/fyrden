/** How long a finished run is kept when the deployment sets nothing. GitHub's default (verified, docs/plans). */
export const DEFAULT_RETENTION_DAYS = 90;
/**
 * The shortest retention: past the longest window a run's CI-minute
 * reservation may still settle in (a job's timeout of up to 7,200 minutes,
 * plus margins: `reservations.ts`), so no run is retired with one open.
 */
export const MIN_RETENTION_DAYS = 7;
/** The longest retention: GitHub's maximum for private repositories. */
export const MAX_RETENTION_DAYS = 400;

/**
 * The deployment's run retention in days: the Worker variable
 * `FYRDEN_CI_RUN_RETENTION_DAYS`, a whole number from 7 to 400. Anything
 * else is the default, with a warning; retention cannot be turned off.
 */
export function runRetentionDays(env: object, warn: (message: string) => void): number {
  const value = (env as { FYRDEN_CI_RUN_RETENTION_DAYS?: unknown }).FYRDEN_CI_RUN_RETENTION_DAYS;
  if (value === undefined) return DEFAULT_RETENTION_DAYS;
  const days = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (days >= MIN_RETENTION_DAYS && days <= MAX_RETENTION_DAYS) return days;
  warn(
    `FYRDEN_CI_RUN_RETENTION_DAYS is not a whole number from ${MIN_RETENTION_DAYS} to ${MAX_RETENTION_DAYS}: runs are kept ${DEFAULT_RETENTION_DAYS} days`,
  );
  return DEFAULT_RETENTION_DAYS;
}
