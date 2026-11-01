import { type ApiTarget, apiTarget, callApi } from "../api.ts";

/*
 * Repairing effects that failed for good while what they deliver can
 * still matter: an operator reopens them through the deployment's API
 * (`POST /api/admin/effects/repair`, as an instance administrator), which
 * selects them and writes through the read model's executor. They keep
 * their ids and what they carry, and the effects cron sends them again.
 */

/** The sinks whose effects may be repaired. */
export const REPAIRABLE_SINKS = ["feed", "webhooks", "references"] as const;
export type RepairableSink = (typeof REPAIRABLE_SINKS)[number];

export interface RepairArgs extends ApiTarget {
  readonly sink: RepairableSink;
  /** Effects journaled from then on (milliseconds since the epoch). */
  readonly since: number;
  readonly confirmed: boolean;
}

export const REPAIR_USAGE =
  "fyrden effects repair --url <API URL> --sink feed|webhooks|references --since <ISO date> [--yes]";

/** `effects repair`'s arguments, or why they are not; the token comes from `FYRDEN_TOKEN`. */
export function parseRepairArgs(
  args: readonly string[],
  now: number,
  env: Record<string, string | undefined>,
): RepairArgs | { error: string } {
  let url: string | undefined;
  let sink: string | undefined;
  let since: string | undefined;
  let confirmed = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--yes") confirmed = true;
    else if (arg === "--url") url = args[++i];
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
  const target = apiTarget(url, env, REPAIR_USAGE);
  if ("error" in target) return target;
  return { ...target, sink: sink as RepairableSink, since: at, confirmed };
}

export interface RepairDeps {
  readonly args: RepairArgs;
  readonly fetch: typeof fetch;
  readonly log: (line: string) => void;
}

interface Repair {
  readonly eligible: number;
  readonly oldest: number | null;
  readonly reopened: number;
}

/**
 * Counts the effects a repair would reopen; with `confirmed`, reopens up
 * to 1,000 of them. Returns how many it reopened (0 on a dry run).
 */
export async function repairEffects(deps: RepairDeps): Promise<number> {
  const { args, log } = deps;
  const { eligible, oldest, reopened } = await callApi<Repair>(
    deps.fetch,
    args,
    "POST",
    "/admin/effects/repair",
    { sink: args.sink, since: args.since, dry_run: !args.confirmed },
  );
  const since = new Date(args.since).toISOString();
  log(
    `${eligible} failed ${args.sink} effect(s) journaled since ${since} can be reopened` +
      (oldest ? ` (the oldest journaled ${new Date(oldest).toISOString()})` : ""),
  );
  if (!args.confirmed) {
    if (eligible > 0) log("dry run: run again with --yes to reopen them");
    return 0;
  }
  if (eligible === 0) return 0;
  log(
    `reopened ${reopened}; the effects cron sends overdue effects 100 a run, every 5 minutes, the longest overdue first` +
      (eligible > reopened ? `; run again for the other ${eligible - reopened}` : ""),
  );
  return reopened;
}
