/*
 * A copy of the ceiling apps/api/src/ci/budget.ts clamps CI's Free allowance to
 * (`ciAllowance`, `fleetReservation`, `LIVE_DAILY`, `FREE_DAILY`, `FREE_SHARE`),
 * so `fyrden deploy` can refuse values the API would not honor. The CLI depends
 * on no workspace package; apps/api/test/ci.capacity-copy.test.ts fails when the
 * copies differ.
 */

export const CI_DAILY_RESOURCES = [
  "do_requests",
  "do_rows_read",
  "do_rows_written",
  "do_duration_ms",
  "d1_rows_read",
  "d1_rows_written",
  "queue_ops",
  "worker_requests",
  "r2_class_b",
] as const;
export type CiDailyResource = (typeof CI_DAILY_RESOURCES)[number];
export type CiDaily = Record<CiDailyResource, number>;

const DISCRETIONARY: ReadonlySet<CiDailyResource> = new Set([
  "do_requests",
  "do_rows_read",
  "do_rows_written",
  "do_duration_ms",
  "d1_rows_read",
  "d1_rows_written",
  "queue_ops",
]);

export const CI_FREE_DAILY: CiDaily = {
  do_requests: 100_000,
  do_rows_read: 5_000_000,
  do_rows_written: 100_000,
  do_duration_ms: 101_562_500,
  d1_rows_read: 5_000_000,
  d1_rows_written: 100_000,
  queue_ops: 10_000,
  worker_requests: 100_000,
  r2_class_b: Math.floor(10_000_000 / 31),
};

const LIVE_DAILY: Partial<CiDaily> = {
  do_requests: 30_000,
  do_rows_read: 2_000_000,
  do_rows_written: 50_000,
  do_duration_ms: 20_000_000,
  d1_rows_read: 1_000_000,
  d1_rows_written: 30_000,
  queue_ops: 0,
};

const DISCRETIONARY_SHARE = 0.2;

export const CI_FREE_FLEET = 2;

const POLL_BUDGET = 21_600;
const POLL_SLACK_PERCENT = 5;
const POLL_LEASE = 60;
const POLL_D1_ROWS_READ = 5;
const LEASE_D1_ROWS_WRITTEN = 2;

export function fleetReservation(cap: number): CiDaily {
  const polls = cap * (POLL_BUDGET + Math.ceil((POLL_BUDGET * POLL_SLACK_PERCENT) / 100));
  const leases = Math.ceil(polls / POLL_LEASE);
  const none = Object.fromEntries(CI_DAILY_RESOURCES.map((r) => [r, 0])) as CiDaily;
  return {
    ...none,
    worker_requests: polls,
    d1_rows_read: polls * POLL_D1_ROWS_READ + leases * (1 + cap),
    d1_rows_written: leases * LEASE_D1_ROWS_WRITTEN,
  };
}

/** The caller has checked the `resource=n,…` form. */
export function dailyValues(value: string | undefined): Partial<Record<string, number>> {
  if (value === undefined) return {};
  return Object.fromEntries(
    value.split(",").map((part) => {
      const [name, n] = part.trim().split("=");
      return [name as string, Number(n)];
    }),
  );
}

/** Negative where the fleet, live hints and discretionary work alone pass Free's limit. */
export function ciDailyCeiling(fleet: number, discretionary?: string): CiDaily {
  const reserved = fleetReservation(fleet);
  const set = dailyValues(discretionary);
  return Object.fromEntries(
    CI_DAILY_RESOURCES.map((r) => {
      const limit = CI_FREE_DAILY[r];
      const others = DISCRETIONARY.has(r)
        ? (LIVE_DAILY[r] ?? 0) + Math.min(set[r] ?? limit * DISCRETIONARY_SHARE, limit)
        : 0;
      return [r, limit - reserved[r] - others];
    }),
  ) as CiDaily;
}

/** One message per resource that cannot hold; empty when the settings fit. */
export function ciCapacityProblems(options: {
  fleet: number;
  daily?: string | undefined;
  discretionary?: string | undefined;
}): string[] {
  const ceiling = ciDailyCeiling(options.fleet, options.discretionary);
  const daily = dailyValues(options.daily);
  const problems: string[] = [];
  for (const r of CI_DAILY_RESOURCES) {
    if (ceiling[r] < 0)
      problems.push(
        `${r}: a fleet of ${options.fleet} runners, live hints and discretionary work need ${CI_FREE_DAILY[r] - ceiling[r]}, past Free's ${CI_FREE_DAILY[r]}`,
      );
    else if ((daily[r] ?? 0) > ceiling[r])
      problems.push(`${r}: --ci-daily asks ${daily[r]}, at most ${ceiling[r]} is left`);
  }
  return problems;
}
