import { join } from "node:path";
import { assertConfigAccount, pinAccount, resolveAccount } from "../account.ts";
import { queryRemote } from "../d1-schema.ts";
import { readApiConfig } from "../resources.ts";
import type { WranglerRunner } from "../wrangler.ts";

/*
 * Repairing effects that failed for good while what they deliver can
 * still matter: an operator reopens them, they keep their ids and what
 * they carry, and the effects cron sends them again. Their claims check
 * their sources as any claim does, so one whose repository was deleted
 * or restored since is ended, not delivered, as is a feed or webhook
 * effect whose repository was transferred (references stand across
 * transfers).
 */

/** The sinks whose effects may be repaired. */
export const REPAIRABLE_SINKS = ["feed", "webhooks", "references"] as const;
export type RepairableSink = (typeof REPAIRABLE_SINKS)[number];

/**
 * How long after its change an effect may still be repaired: feeds drop
 * entries older than this on arrival, and a delivery that late tells no
 * one anything they could still act on. Proposed.
 */
export const REPAIR_HORIZON_MS = 7 * 24 * 60 * 60 * 1000;

/** Effects one run reopens at most; run again for more. */
export const REPAIR_BATCH = 1_000;

/** The database that holds the effects journal. */
const EFFECTS_DB_BINDING = "ORG_READ";

/**
 * Failed effects of `sink` journaled since `since` that a repair reopens:
 * not ended because their source moved on, nor because nothing could
 * deliver them any more (past their deadline, a page gone, no such sink),
 * and whose change (or, without one, their journaling) is within the
 * horizon at `now`. Literal values only: wrangler runs it as one command.
 */
function repairable(sink: RepairableSink, since: number, now: number): string {
  return `state = 'failed' AND sink = '${sink}' AND created_at >= ${since}
    AND coalesce(last_error, '') NOT LIKE 'invalidated:%'
    AND coalesce(last_error, '') NOT LIKE 'expired:%'
    AND coalesce(last_error, '') NOT LIKE 'page missing:%'
    AND coalesce(last_error, '') NOT LIKE 'no sink named %'
    AND coalesce(json_extract(payload, '$.occurredAt'), created_at) > ${now - REPAIR_HORIZON_MS}`;
}

/** How many effects a repair would reopen, and the oldest one's journaling time. */
export function repairCountSql(sink: RepairableSink, since: number, now: number): string {
  return `SELECT count(*) AS count, min(created_at) AS oldest FROM effects
    WHERE ${repairable(sink, since, now)}`;
}

/**
 * Reopens up to `REPAIR_BATCH` of them, oldest first: pending again, due
 * now and overdue for the cron, the failure kept in `last_error` after
 * `reopened: `. Their attempts count afresh from one, not zero: one ever
 * claimed stays claimed, as a repository's deletion goes by (an invocation
 * that claimed it may still be running, and the deletion waits for it).
 */
export function repairSql(sink: RepairableSink, since: number, now: number): string {
  return `UPDATE effects SET state = 'pending', attempts = min(attempts, 1), next_attempt_at = ${now},
      recover_at = ${now}, lease_token = NULL, lease_until = NULL,
      last_error = 'reopened: ' || coalesce(last_error, '')
    WHERE effect_id IN (SELECT effect_id FROM effects WHERE ${repairable(sink, since, now)}
      ORDER BY created_at, effect_id LIMIT ${REPAIR_BATCH})
    RETURNING effect_id`;
}

export interface RepairArgs {
  readonly sink: RepairableSink;
  /** Effects journaled from then on (milliseconds since the epoch). */
  readonly since: number;
  readonly confirmed: boolean;
}

export const REPAIR_USAGE =
  "fyrden effects repair --sink feed|webhooks|references --since <ISO date> [--yes]";

/** `effects repair`'s arguments, or why they are not. */
export function parseRepairArgs(
  args: readonly string[],
  now: number,
): RepairArgs | { error: string } {
  let sink: string | undefined;
  let since: string | undefined;
  let confirmed = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--yes") confirmed = true;
    else if (arg === "--sink") sink = args[++i];
    else if (arg === "--since") since = args[++i];
    else return { error: `unknown argument ${arg}\nusage: ${REPAIR_USAGE}` };
  }
  if (!sink || !(REPAIRABLE_SINKS as readonly string[]).includes(sink))
    return {
      error: `--sink must be one of ${REPAIRABLE_SINKS.join(", ")}\nusage: ${REPAIR_USAGE}`,
    };
  const at = since === undefined ? Number.NaN : Date.parse(since);
  if (!Number.isFinite(at)) return { error: `--since must be a date\nusage: ${REPAIR_USAGE}` };
  if (at > now) return { error: "--since is in the future" };
  return { sink: sink as RepairableSink, since: at, confirmed };
}

export interface RepairDeps {
  readonly repoRoot: string;
  readonly runner: WranglerRunner;
  readonly args: RepairArgs;
  readonly now: () => number;
  readonly envAccountId?: string | undefined;
  readonly log: (line: string) => void;
}

/**
 * Counts the effects a repair would reopen; with `confirmed`, reopens up
 * to `REPAIR_BATCH` of them. Returns how many it reopened (0 on a dry run).
 */
export async function repairEffects(deps: RepairDeps): Promise<number> {
  const { args, log } = deps;
  const apiDir = join(deps.repoRoot, "apps", "api");
  const account = await resolveAccount(deps.runner, deps.envAccountId);
  const runner = pinAccount(deps.runner, account.id);
  const config = await readApiConfig(join(apiDir, "wrangler.jsonc"));
  assertConfigAccount("apps/api/wrangler.jsonc", config, account.id);
  const db = config.d1_databases?.find((d) => d.binding === EFFECTS_DB_BINDING)?.database_name;
  if (!db) throw new Error(`apps/api/wrangler.jsonc binds no ${EFFECTS_DB_BINDING} database`);
  const now = deps.now();
  const [found] = await queryRemote<{ count: number; oldest: number | null }>(
    runner,
    apiDir,
    db,
    repairCountSql(args.sink, args.since, now),
  );
  const count = found?.count ?? 0;
  const since = new Date(args.since).toISOString();
  log(
    `${count} failed ${args.sink} effect(s) journaled since ${since} can be reopened` +
      (found?.oldest ? ` (the oldest journaled ${new Date(found.oldest).toISOString()})` : ""),
  );
  if (!args.confirmed) {
    if (count > 0) log("dry run: run again with --yes to reopen them");
    return 0;
  }
  if (count === 0) return 0;
  const reopened = await queryRemote<{ effect_id: string }>(
    runner,
    apiDir,
    db,
    repairSql(args.sink, args.since, now),
  );
  log(
    `reopened ${reopened.length}; the effects cron sends overdue effects 100 a run, every 5 minutes, the longest overdue first` +
      (count > reopened.length ? `; run again for the other ${count - reopened.length}` : ""),
  );
  return reopened.length;
}
