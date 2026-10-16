import { join } from "node:path";
import { AccountError, pinAccount, resolveAccount } from "../account.ts";
import { readApiConfig, resourcePlan } from "../resources.ts";
import { WranglerError, type WranglerRunner } from "../wrangler.ts";
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
}

/** `fyrden doctor`: checks login and resources without changing anything. */
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
    return { authenticated: false, missing: [] };
  }

  const config = await readApiConfig(join(repoRoot, "apps", "api", "wrangler.jsonc"));
  let missing: string[] = [];
  try {
    ({ missing } = await provision(runner, resourcePlan(config), false));
    log(
      missing.length === 0
        ? "ok   every resource exists"
        : `WARN missing (fyrden deploy creates them): ${missing.join(", ")}`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(
      error instanceof WranglerError && error.hint
        ? `FAIL ${error.hint}`
        : `FAIL could not list resources: ${message}`,
    );
    return { authenticated: true, missing: ["unknown"] };
  }
  // The key webhook secrets are sealed with (deploy makes it when there is none).
  const secrets = await workerSecrets(runner, config.name).catch(() => null);
  if (secrets && !secrets.has("WEBHOOKS_KEY"))
    log("WARN WEBHOOKS_KEY is not set: webhooks cannot be created (fyrden deploy makes it)");
  else if (secrets) log("ok   WEBHOOKS_KEY is set");
  // wrangler has no read-only check for this; deploy names it if it is off.
  log("info Workers Analytics Engine must be enabled once in the dashboard");
  log(
    `info largest single push = request body limit: ${Object.entries(BODY_LIMITS_MB)
      .map(([plan, mb]) => `${plan} ${mb} MB`)
      .join(", ")}; larger pushes need \`fyrden push --chunked\``,
  );
  return { authenticated: true, missing };
}
