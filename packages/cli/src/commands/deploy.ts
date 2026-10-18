import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertConfigAccount, pinAccount, resolveAccount } from "../account.ts";
import { checkD1Schema, driftMessage, SCHEMA_RUNBOOK } from "../d1-schema.ts";
import { parseJsonc } from "../jsonc.ts";
import { readApiConfig, resourcePlan } from "../resources.ts";
import { commitLabel, type SourceState } from "../source.ts";
import { WranglerError, type WranglerRunner, wrangler } from "../wrangler.ts";
import { provision } from "./provision.ts";

export type Plan = "free" | "paid";

export interface DeployDeps {
  repoRoot: string;
  plan: Plan;
  runner: WranglerRunner;
  /** Builds fyrden-web (react-router build). */
  buildWeb: () => Promise<void>;
  /** The checkout being deployed, recorded on fyrden-api as FYRDEN_COMMIT. */
  source: SourceState;
  /** A preset bootstrap secret (CI passes one from a GitHub secret), or undefined to generate one. */
  presetBootstrapSecret?: string | undefined;
  /**
   * Generates a bootstrap secret when none is preset. Omitted in CI, where a
   * generated secret would be printed into a shared run log: the deploy then
   * fails instead.
   */
  randomSecret?: (() => string) | undefined;
  /**
   * Called as soon as a generated bootstrap secret is installed, before any
   * later step can fail, so the operator never loses it.
   */
  onSecretGenerated: (secret: string) => void;
  log: (line: string) => void;
  /** CLOUDFLARE_ACCOUNT_ID, if set: the account wrangler acts on. */
  envAccountId?: string | undefined;
}

export interface DeployResult {
  created: string[];
  apiUrl: string | undefined;
  webUrl: string | undefined;
}

/** The deploy config wrangler uses: the committed config plus this account's resource ids. */
export const API_DEPLOY_CONFIG = "wrangler.deploy.jsonc";

/** Config keys for features the Free plan does not have (Tail Workers are Paid and Enterprise only). */
const PAID_ONLY_KEYS = ["tail_consumers"] as const;

const WEB_WORKER = "fyrden-web";

/** Generated per account and ignored by git; the committed config stays account-free. */
async function writeDeployConfig(apiDir: string, config: Record<string, unknown>): Promise<void> {
  await writeFile(join(apiDir, API_DEPLOY_CONFIG), `${JSON.stringify(config, null, 2)}\n`);
}

const workersDevUrl = (output: string) => /https:\/\/[a-z0-9.-]+\.workers\.dev/.exec(output)?.[0];

/**
 * Whether a configured migrations folder holds any migration. A folder that
 * cannot be read is an error: skipping it would deploy against an old schema.
 */
async function hasSqlFiles(dir: string): Promise<boolean> {
  return (await readdir(dir)).some((f) => f.endsWith(".sql"));
}

// Wrangler's answer for a Worker that has never been deployed.
const WORKER_NOT_FOUND = /code: 10007|worker does not exist|not found/i;

/**
 * The Worker's secret names, or `null` when the Worker does not exist yet.
 * Any other failure is an error: treating it as "no secrets" would make the
 * deploy replace the existing bootstrap secret.
 */
export async function workerSecrets(
  runner: WranglerRunner,
  worker: string,
): Promise<Set<string> | null> {
  const args = ["secret", "list", "--name", worker, "--format", "json"];
  const result = await runner.run(args);
  if (result.code === 0)
    return new Set((JSON.parse(result.stdout) as { name: string }[]).map((s) => s.name));
  if (WORKER_NOT_FOUND.test(result.stderr + result.stdout)) return null;
  throw new WranglerError(args, result);
}

/**
 * `fyrden deploy`: provisions resources, applies D1 migrations and stops
 * unless each database then matches its expected schema, deploys
 * fyrden-api first and fyrden-web second (fyrden-api must accept the current
 * and previous web RPC version). The required BOOTSTRAP_SECRET and the
 * platform's commit signing key (SIGNING_KEY) are uploaded with the first
 * API deploy that lacks them, from a 0600 file that is removed after.
 */
export async function deploy(deps: DeployDeps): Promise<DeployResult> {
  const { log } = deps;
  const apiDir = join(deps.repoRoot, "apps", "api");
  const webDir = join(deps.repoRoot, "apps", "web");

  const account = await resolveAccount(deps.runner, deps.envAccountId);
  log(`deploying to account ${account.name} (${account.id})`);
  if (deps.source.commit === undefined)
    log("WARN not a git checkout (or git failed): the deployed commit is recorded as unknown");
  else if (deps.source.dirty)
    log(
      `WARN the working tree has uncommitted changes: recorded as ${commitLabel(deps.source)}. ` +
        "D1 records a migration by file name, so a migration applied now is never applied again after it changes",
    );
  // Every command below targets this account, whichever directory it runs in.
  const runner = pinAccount(deps.runner, account.id);

  const config = await readApiConfig(join(apiDir, "wrangler.jsonc"));
  // Both Workers' configs, before anything changes (the web build copies its
  // account_id from apps/web/wrangler.jsonc).
  assertConfigAccount("apps/api/wrangler.jsonc", config, account.id);
  const webConfig = parseJsonc<Record<string, unknown>>(
    await readFile(join(webDir, "wrangler.jsonc"), "utf8"),
  );
  assertConfigAccount("apps/web/wrangler.jsonc", webConfig, account.id);
  const plan = resourcePlan(config);
  const resources = await provision(runner, plan);
  for (const r of resources.created) log(`created ${r}`);

  const deployConfig: Record<string, unknown> = {
    ...config,
    account_id: account.id,
    vars: {
      ...((config.vars as Record<string, string> | undefined) ?? {}),
      FYRDEN_PLAN: deps.plan,
      FYRDEN_COMMIT: commitLabel(deps.source),
    },
    d1_databases: (config.d1_databases ?? []).map((d) => ({
      ...d,
      database_id: resources.d1Ids[d.binding],
    })),
    kv_namespaces: (config.kv_namespaces ?? []).map((k) => ({
      ...k,
      id: resources.kvIds[k.binding],
    })),
  };
  if (deps.plan === "free") for (const key of PAID_ONLY_KEYS) delete deployConfig[key];
  await writeDeployConfig(apiDir, deployConfig);

  for (const db of plan.d1) {
    if (db.migrationsDir && (await hasSqlFiles(join(apiDir, db.migrationsDir)))) {
      await wrangler(
        runner,
        ["d1", "migrations", "apply", db.name, "--remote", "-c", API_DEPLOY_CONFIG],
        { cwd: apiDir },
      );
      log(`applied D1 migrations to ${db.name}`);
      // D1 skips a migration it recorded by name, even if the file changed
      // since: only the resulting schema shows it.
      const check = await checkD1Schema(
        runner,
        apiDir,
        { name: db.name, migrationsDir: db.migrationsDir },
        ["-c", API_DEPLOY_CONFIG],
      );
      if (check.problems.length > 0)
        throw new Error(
          `${driftMessage(db.name, check)} Repair it as ${SCHEMA_RUNBOOK} says before deploying.`,
        );
      log(`ok   ${db.name} schema matches ${check.expectedFile}`);
    }
  }

  // A Tail Worker must exist before a Worker can name it as a consumer, so on
  // the first Paid deploy the API goes out without it and is redeployed with
  // it once fyrden-web exists.
  const webExists = (await workerSecrets(runner, WEB_WORKER)) !== null;
  const attachTailLater = "tail_consumers" in deployConfig && !webExists;
  if (attachTailLater)
    await writeDeployConfig(apiDir, { ...deployConfig, tail_consumers: undefined });

  const deployArgs = ["deploy", "-c", API_DEPLOY_CONFIG];
  let generated: string | undefined;
  let secretsDir: string | undefined;
  const existing = await workerSecrets(runner, config.name);
  const upload: Record<string, string> = {};
  if (!existing?.has("BOOTSTRAP_SECRET")) {
    const secret = deps.presetBootstrapSecret ?? deps.randomSecret?.();
    if (secret === undefined) {
      throw new Error(
        `${config.name} has no BOOTSTRAP_SECRET and generating one is disabled here: set FYRDEN_BOOTSTRAP_SECRET`,
      );
    }
    if (!deps.presetBootstrapSecret) generated = secret;
    upload.BOOTSTRAP_SECRET = secret;
  } else if (deps.presetBootstrapSecret) {
    // An earlier deploy set it: first-run setup needs that value, not this one.
    log(
      `${config.name} already has a BOOTSTRAP_SECRET; FYRDEN_BOOTSTRAP_SECRET was not uploaded (set it with wrangler secret put to replace it)`,
    );
  }
  // The platform's commit signing key: made here once, never shown, kept across deploys.
  if (!existing?.has("SIGNING_KEY")) upload.SIGNING_KEY = signingKey();
  // The key webhook secrets are sealed with: made once, never shown; replace
  // it only as docs/operations/webhooks.md says, or every hook's secret is lost.
  if (!existing?.has("WEBHOOKS_KEY")) upload.WEBHOOKS_KEY = signingKey();
  if (Object.keys(upload).length > 0) {
    secretsDir = await mkdtemp(join(tmpdir(), "fyrden-secrets-"));
    const file = join(secretsDir, "secrets.json");
    await writeFile(file, JSON.stringify(upload), { mode: 0o600 });
    deployArgs.push("--secrets-file", file);
  }
  let apiUrl: string | undefined;
  try {
    apiUrl = workersDevUrl(await wrangler(runner, deployArgs, { cwd: apiDir }));
    // Reported the moment it is installed, before anything else can fail.
    if (generated) deps.onSecretGenerated(generated);
  } finally {
    if (secretsDir) await rm(secretsDir, { recursive: true, force: true });
  }
  log(`deployed ${config.name}${apiUrl ? ` at ${apiUrl}` : ""}`);
  for (const name of Object.keys(upload)) log(`set ${name}`);

  await deps.buildWeb();
  const webUrl = workersDevUrl(await wrangler(runner, ["deploy"], { cwd: webDir }));
  log(`deployed ${WEB_WORKER}${webUrl ? ` at ${webUrl}` : ""}`);

  if (attachTailLater) {
    await writeDeployConfig(apiDir, deployConfig);
    await wrangler(runner, ["deploy", "-c", API_DEPLOY_CONFIG], { cwd: apiDir });
    log(`attached ${WEB_WORKER} as the Tail Worker of ${config.name}`);
  }

  return { created: resources.created, apiUrl, webUrl };
}

/** A new Ed25519 signing key: its 32-byte seed, base64. */
function signingKey(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
}
