import { join } from "node:path";
import { AccountError, pinAccount, resolveAccount } from "../account.ts";
import { checkD1Schema, driftMessage, queryRemote, SCHEMA_RUNBOOK } from "../d1-schema.ts";
import { readApiConfig, resourcePlan } from "../resources.ts";
import { DIRTY_SUFFIX, UNKNOWN_COMMIT } from "../source.ts";
import { WranglerError, type WranglerRunner, wrangler } from "../wrangler.ts";
import { workerSecrets } from "./deploy.ts";
import { provision } from "./provision.ts";

/**
 * Request body limits by Cloudflare plan, which cap a single git push
 * (verified: developers.cloudflare.com/workers/platform/limits/).
 */
export const BODY_LIMITS_MB = { free: 100, pro: 100, business: 200, enterprise: 500 } as const;

export interface DoctorReport {
  authenticated: boolean;
  missing: string[];
  /** D1 databases that differ from their expected schema, or could not be read. */
  schemaDrift: string[];
}

/** The binding of the database that holds the effects journal. */
const EFFECTS_BINDING = "ORG_READ";

const EFFECTS_SUMMARY =
  "SELECT state, count(*) AS count, min(created_at) AS oldest FROM effects GROUP BY state ORDER BY state";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** `fyrden doctor`: checks login, resources and D1 schemas without changing anything. */
export async function doctor(
  repoRoot: string,
  loginRunner: WranglerRunner,
  log: (line: string) => void,
  envAccountId: string | undefined = process.env.CLOUDFLARE_ACCOUNT_ID,
): Promise<DoctorReport> {
  let runner: WranglerRunner;
  try {
    const account = await resolveAccount(loginRunner, envAccountId);
    log(`ok   wrangler is logged in; checking account ${account.name} (${account.id})`);
    runner = pinAccount(loginRunner, account.id);
  } catch (error) {
    if (!(error instanceof AccountError)) throw error;
    log(`FAIL ${error.message}`);
    return { authenticated: false, missing: [], schemaDrift: [] };
  }

  const apiDir = join(repoRoot, "apps", "api");
  const config = await readApiConfig(join(apiDir, "wrangler.jsonc"));
  const plan = resourcePlan(config);
  let missing: string[] = [];
  try {
    ({ missing } = await provision(runner, plan, false));
    log(
      missing.length === 0
        ? "ok   every resource exists"
        : `WARN missing (fyrden deploy creates them): ${missing.join(", ")}`,
    );
  } catch (error) {
    log(
      error instanceof WranglerError && error.hint
        ? `FAIL ${error.hint}`
        : `FAIL could not list resources: ${message(error)}`,
    );
    return { authenticated: true, missing: ["unknown"], schemaDrift: [] };
  }

  const schemaDrift: string[] = [];
  for (const db of plan.d1) {
    if (missing.includes(`d1:${db.name}`)) continue;
    if (db.migrationsDir) {
      try {
        const check = await checkD1Schema(runner, apiDir, {
          name: db.name,
          migrationsDir: db.migrationsDir,
        });
        if (check.problems.length === 0)
          log(`ok   ${db.name} schema matches ${check.expectedFile}`);
        else {
          schemaDrift.push(db.name);
          log(`FAIL ${driftMessage(db.name, check)} Repair it as ${SCHEMA_RUNBOOK} says.`);
        }
      } catch (error) {
        schemaDrift.push(db.name);
        log(`FAIL could not read the ${db.name} schema: ${message(error)}`);
      }
    }
    if (db.binding === EFFECTS_BINDING) log(await effectsSummary(runner, apiDir, db.name));
  }

  // The key webhook secrets are sealed with (deploy makes it when there is none).
  const secrets = await workerSecrets(runner, config.name).catch(() => null);
  if (secrets && !secrets.has("WEBHOOKS_KEY"))
    log("WARN WEBHOOKS_KEY is not set: webhooks cannot be created (fyrden deploy makes it)");
  else if (secrets) log("ok   WEBHOOKS_KEY is set");
  if (secrets) log(await deployedCommit(runner, config.name));
  // wrangler has no read-only check for this; deploy names it if it is off.
  log("info Workers Analytics Engine must be enabled once in the dashboard");
  log(
    `info largest single push = request body limit: ${Object.entries(BODY_LIMITS_MB)
      .map(([plan, mb]) => `${plan} ${mb} MB`)
      .join(", ")}; larger pushes need \`fyrden push --chunked\``,
  );
  return { authenticated: true, missing, schemaDrift };
}

/** How many effects are in each state, and how old the oldest of each is: a stuck backlog shows here. */
async function effectsSummary(runner: WranglerRunner, apiDir: string, db: string): Promise<string> {
  try {
    const rows = await queryRemote<{ state: string; count: number; oldest: number }>(
      runner,
      apiDir,
      db,
      EFFECTS_SUMMARY,
    );
    const states = rows.map(
      (r) => `${r.state} ${r.count} (oldest ${new Date(r.oldest).toISOString()})`,
    );
    return `info ${db} effects: ${states.length > 0 ? states.join(", ") : "none"}`;
  } catch (error) {
    return `WARN could not summarise the ${db} effects: ${message(error)}`;
  }
}

/**
 * The commit the Worker's current version was deployed from (its FYRDEN_COMMIT
 * var). The JSON shapes are wrangler's `deployments status --json` and
 * `versions view --json` output, read from its source; not yet run against a
 * live account [U].
 */
async function deployedCommit(runner: WranglerRunner, worker: string): Promise<string> {
  try {
    const status = JSON.parse(
      await wrangler(runner, ["deployments", "status", "--name", worker, "--json"]),
    ) as { versions: { version_id: string; percentage: number }[] };
    // fyrden deploy sends all traffic to one version; during a gradual
    // rollout made by hand, the one with the most traffic.
    const current = [...status.versions].sort((a, b) => b.percentage - a.percentage)[0];
    if (!current) return `WARN ${worker} has no current version`;
    const version = JSON.parse(
      await wrangler(runner, ["versions", "view", current.version_id, "--name", worker, "--json"]),
    ) as { resources: { bindings: { type: string; name: string; text?: string }[] } };
    const commit = version.resources.bindings.find(
      (b) => b.type === "plain_text" && b.name === "FYRDEN_COMMIT",
    )?.text;
    if (commit === undefined)
      return `info ${worker} does not record its commit (deployed before fyrden deploy did)`;
    if (commit === UNKNOWN_COMMIT)
      return `WARN ${worker} runs an unknown commit (deployed outside a git checkout)`;
    if (commit.endsWith(DIRTY_SUFFIX))
      return `WARN ${worker} runs ${commit.slice(0, -DIRTY_SUFFIX.length)} with uncommitted changes (deployed from a dirty working tree)`;
    return `ok   ${worker} runs commit ${commit}`;
  } catch (error) {
    return `WARN could not read the commit ${worker} runs: ${message(error)}`;
  }
}
