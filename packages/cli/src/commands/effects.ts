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

export interface RepairArgs {
  /** The API's origin (its workers.dev URL or custom domain). */
  readonly url: string;
  /** An instance administrator's token (`FYRDEN_TOKEN`). */
  readonly token: string;
  readonly sink: RepairableSink;
  /** Effects journaled from then on (milliseconds since the epoch). */
  readonly since: number;
  readonly confirmed: boolean;
}

export const REPAIR_USAGE =
  "fyrden effects repair --url <API URL> --sink feed|webhooks|references --since <ISO date> [--yes]";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** What a bearer token may hold. */
const TOKEN_SHAPE = /^[\x21-\x7e]{1,4096}$/;

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
  let origin: URL | undefined;
  try {
    origin = url === undefined ? undefined : new URL(url);
  } catch {}
  const secure =
    origin?.protocol === "https:" ||
    (origin?.protocol === "http:" && LOCAL_HOSTS.has(origin.hostname));
  if (!origin || !secure)
    return {
      error: `--url must be the API's https URL (http only on localhost)\nusage: ${REPAIR_USAGE}`,
    };
  if (!sink || !(REPAIRABLE_SINKS as readonly string[]).includes(sink))
    return {
      error: `--sink must be one of ${REPAIRABLE_SINKS.join(", ")}\nusage: ${REPAIR_USAGE}`,
    };
  const at = since === undefined ? Number.NaN : Date.parse(since);
  if (!Number.isFinite(at)) return { error: `--since must be a date\nusage: ${REPAIR_USAGE}` };
  if (at > now) return { error: "--since is in the future" };
  const token = env.FYRDEN_TOKEN;
  if (!token) return { error: "set FYRDEN_TOKEN to an instance administrator's token" };
  // Checked here, so no header error ever repeats it.
  if (!TOKEN_SHAPE.test(token))
    return { error: "FYRDEN_TOKEN is not a token (printable characters, no spaces)" };
  return { url: origin.origin, token, sink: sink as RepairableSink, since: at, confirmed };
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
  const origin = new URL(args.url).origin;
  let response: Response;
  try {
    response = await deps.fetch(`${origin}/api/admin/effects/repair`, {
      method: "POST",
      headers: { Authorization: `Bearer ${args.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sink: args.sink, since: args.since, dry_run: !args.confirmed }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    // Its message, never the token.
    throw new Error(
      `could not reach ${origin} (${String(error).replaceAll(args.token, "<token>")})`,
    );
  }
  if (!response.ok) {
    const problem = (await response.json().catch(() => ({}))) as {
      code?: string;
      detail?: string;
    };
    throw new Error(
      `the API answered ${response.status}${problem.code ? ` ${problem.code}` : ""}` +
        (problem.detail ? `: ${problem.detail}` : ""),
    );
  }
  const { eligible, oldest, reopened } = (await response.json()) as Repair;
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
