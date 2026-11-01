import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertConfigAccount, pinAccount, resolveAccount } from "../account.ts";
import {
  checkD1Schema,
  driftMessage,
  migrationGap,
  queryRemote,
  SCHEMA_RUNBOOK,
} from "../d1-schema.ts";
import { parseJsonc } from "../jsonc.ts";
import { readApiConfig, resourcePlan } from "../resources.ts";
import { commitLabel, type SourceState } from "../source.ts";
import { WranglerError, type WranglerRunner, wrangler } from "../wrangler.ts";
import { provision } from "./provision.ts";

export type Plan = "free" | "paid";

export interface DeployDeps {
  repoRoot: string;
  plan: Plan;
  /**
   * Paid only: calls to internal services (D1, R2, Durable Objects, Queues)
   * one invocation may make, set as `FYRDEN_INTERNAL_CALLS` (1,000 when not
   * given: each Paid deploy sets it, so leaving the flag out goes back to
   * 1,000), and as `limits.subrequests` when past the Worker's subrequest
   * limit (Paid's default 10,000, or the committed config's).
   */
  internalCalls?: number | undefined;
  /**
   * The daily allowance for discretionary work (watched activity), set as
   * `FYRDEN_DISCRETIONARY_DAILY` (`resource=n,…`); left out, the plan's
   * default (each deploy sets the variables, so leaving it out goes back).
   */
  discretionary?: string | undefined;
  /**
   * Watchers, thread subscribers and authors added to events' audiences
   * (`FYRDEN_WATCH_AUDIENCES=on`); left out, not (each deploy sets the
   * variables). limits.md says when a deployment may turn it on.
   */
  watchAudiences?: true | undefined;
  /**
   * The read model's maintenance: the work that writes it held back
   * (`FYRDEN_READ_MODEL_MAINTENANCE=on`); left out, not (each deploy sets the
   * variables).
   */
  readModelMaintenance?: true | undefined;
  /**
   * The deployment is a test deployment with nothing running against it:
   * refusing writes outside the read model's executor (org migration 0018)
   * may be installed over the data it holds. Not needed on a fresh database.
   */
  quiesced?: true | undefined;
  /** How the deployed API is asked which read model protocol it serves (default: fetch). */
  fetch?: typeof fetch;
  /**
   * Live notification hints, on (`FYRDEN_LIVE=on`, and `FYRDEN_LIVE_SOCKETS`
   * when given); left out, off (each deploy sets the variables).
   */
  live?: { sockets?: number } | undefined;
  /**
   * The email provider, set as `FYRDEN_EMAIL_PROVIDER` and
   * `FYRDEN_EMAIL_FROM`, its key uploaded as the secret `RESEND_API_KEY`
   * and its webhook's signing secret, when given, as
   * `RESEND_WEBHOOK_SECRET` (each deploy given them uploads them again: a
   * new value rotates it); `FYRDEN_EMAIL_SENDING=on` when sending, and the
   * allowance's limits given as `FYRDEN_EMAIL_DAILY_LIMIT`,
   * `FYRDEN_EMAIL_MONTHLY_LIMIT` and `FYRDEN_EMAIL_RESERVE`. Left out, none
   * of the variables is set and the deployment sends no email.
   */
  email?:
    | {
        provider: "resend";
        from: string;
        apiKey: string;
        webhookSecret?: string;
        sending?: boolean;
        limits?: { daily?: number; monthly?: number; reserve?: number };
        /**
         * Where notification emails' links point (`FYRDEN_PUBLIC_ORIGIN`, a
         * custom domain's origin); left out while sending, the web
         * Worker's URL, set by deploying the API again once it is known.
         */
        publicOrigin?: string;
      }
    | undefined;
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

/** The queue of the API's events, paused while the API deploys. */
const EVENTS_QUEUE = "fyrden-events";

/** Internal calls an invocation makes without `--internal-calls` (Free's, measured). */
const DEFAULT_INTERNAL_CALLS = 1_000;

/** The subrequests a Paid invocation gets without `limits.subrequests` (platform default). */
const PAID_DEFAULT_SUBREQUESTS = 10_000;

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
/** The variables `deploy` sets from its flags on every run (left out: unset). */
const DEPLOY_SWITCHES = new Set([
  "FYRDEN_INTERNAL_CALLS",
  "FYRDEN_DISCRETIONARY_DAILY",
  "FYRDEN_WATCH_AUDIENCES",
  "FYRDEN_READ_MODEL_MAINTENANCE",
  "FYRDEN_LIVE",
  "FYRDEN_LIVE_SOCKETS",
  "FYRDEN_EMAIL_PROVIDER",
  "FYRDEN_EMAIL_FROM",
  "FYRDEN_EMAIL_SENDING",
  "FYRDEN_EMAIL_DAILY_LIMIT",
  "FYRDEN_EMAIL_MONTHLY_LIMIT",
  "FYRDEN_EMAIL_RESERVE",
]);

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

  const internalCalls = deps.internalCalls ?? DEFAULT_INTERNAL_CALLS;
  // The switches each deploy sets: never kept from the committed configuration, so leaving one
  // out turns it off whatever that file says.
  const committedVars = Object.fromEntries(
    Object.entries((config.vars as Record<string, string> | undefined) ?? {}).filter(
      ([name]) => !DEPLOY_SWITCHES.has(name),
    ),
  );
  const deployConfig: Record<string, unknown> = {
    ...config,
    account_id: account.id,
    vars: {
      ...committedVars,
      FYRDEN_PLAN: deps.plan,
      FYRDEN_COMMIT: commitLabel(deps.source),
      ...(deps.plan === "paid" && { FYRDEN_INTERNAL_CALLS: String(internalCalls) }),
      ...(deps.discretionary !== undefined && {
        FYRDEN_DISCRETIONARY_DAILY: deps.discretionary,
      }),
      ...(deps.watchAudiences && { FYRDEN_WATCH_AUDIENCES: "on" }),
      ...(deps.readModelMaintenance && { FYRDEN_READ_MODEL_MAINTENANCE: "on" }),
      ...(deps.live && { FYRDEN_LIVE: "on" }),
      ...(deps.live?.sockets !== undefined && { FYRDEN_LIVE_SOCKETS: String(deps.live.sockets) }),
      ...(deps.email && {
        FYRDEN_EMAIL_PROVIDER: deps.email.provider,
        FYRDEN_EMAIL_FROM: deps.email.from,
        ...(deps.email.sending && { FYRDEN_EMAIL_SENDING: "on" }),
        ...(deps.email.limits?.daily !== undefined && {
          FYRDEN_EMAIL_DAILY_LIMIT: String(deps.email.limits.daily),
        }),
        ...(deps.email.limits?.monthly !== undefined && {
          FYRDEN_EMAIL_MONTHLY_LIMIT: String(deps.email.limits.monthly),
        }),
        ...(deps.email.limits?.reserve !== undefined && {
          FYRDEN_EMAIL_RESERVE: String(deps.email.limits.reserve),
        }),
        ...(deps.email.publicOrigin !== undefined && {
          FYRDEN_PUBLIC_ORIGIN: deps.email.publicOrigin,
        }),
      }),
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
  const limits = (config.limits as { subrequests?: number } | undefined) ?? {};
  if (deps.plan === "paid" && internalCalls > (limits.subrequests ?? PAID_DEFAULT_SUBREQUESTS))
    deployConfig.limits = { ...limits, subrequests: internalCalls };
  await writeDeployConfig(apiDir, deployConfig);

  await checkEnforcementInstall(deps, runner, apiDir, plan);
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
  await recordRestoreFloor(deps, runner, apiDir, plan);

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
  // The key unsubscribe links are signed with: made once, kept across deploys (replacing it
  // breaks every link already sent).
  if (!existing?.has("EMAIL_KEY")) upload.EMAIL_KEY = base64urlKey();
  // The email provider's key, whenever one is given (a new one replaces it).
  if (deps.email) upload.RESEND_API_KEY = deps.email.apiKey;
  if (deps.email?.webhookSecret) upload.RESEND_WEBHOOK_SECRET = deps.email.webhookSecret;
  if (Object.keys(upload).length > 0) {
    secretsDir = await mkdtemp(join(tmpdir(), "fyrden-secrets-"));
    const file = join(secretsDir, "secrets.json");
    await writeFile(file, JSON.stringify(upload), { mode: 0o600 });
    deployArgs.push("--secrets-file", file);
  }
  let apiUrl: string | undefined;
  // The events queue's consumers stop while the new version goes out, so no Worker of the version
  // before it reads an event this one makes (what it would not know it drops); events wait in the
  // queue meanwhile.
  try {
    try {
      await wrangler(runner, ["queues", "pause-delivery", EVENTS_QUEUE]);
      apiUrl = workersDevUrl(await wrangler(runner, deployArgs, { cwd: apiDir }));
      // Reported the moment it is installed, before anything else can fail.
      if (generated) deps.onSecretGenerated(generated);
    } finally {
      // Also after a failed pause: its answer may be what failed, the pause applied.
      await wrangler(runner, ["queues", "resume-delivery", EVENTS_QUEUE]);
    }
  } finally {
    if (secretsDir) await rm(secretsDir, { recursive: true, force: true });
  }
  log(`deployed ${config.name}${apiUrl ? ` at ${apiUrl}` : ""}`);
  for (const name of Object.keys(upload)) log(`set ${name}`);

  await deps.buildWeb();
  const webUrl = workersDevUrl(await wrangler(runner, ["deploy"], { cwd: webDir }));
  log(`deployed ${WEB_WORKER}${webUrl ? ` at ${webUrl}` : ""}`);

  // Sending with no origin given: notification emails' links point to the web Worker, known only
  // now, so the API goes out again with it (every such deploy: its configuration is rebuilt from
  // the committed file each time, so an earlier deploy's value is not carried forward).
  const origin =
    deps.email?.sending && deps.email.publicOrigin === undefined
      ? webUrl?.replace(/\/$/, "")
      : undefined;
  if (deps.email?.sending && deps.email.publicOrigin === undefined && origin === undefined)
    log(
      `${WEB_WORKER} has no workers.dev URL: notification email stays off until --public-origin is given`,
    );
  if (attachTailLater || origin !== undefined) {
    const vars = deployConfig.vars as Record<string, string>;
    await writeDeployConfig(apiDir, {
      ...deployConfig,
      vars: { ...vars, ...(origin !== undefined && { FYRDEN_PUBLIC_ORIGIN: origin }) },
    });
    await wrangler(runner, ["deploy", "-c", API_DEPLOY_CONFIG], { cwd: apiDir });
    if (attachTailLater) log(`attached ${WEB_WORKER} as the Tail Worker of ${config.name}`);
    if (origin !== undefined) log(`set FYRDEN_PUBLIC_ORIGIN to ${origin} on ${config.name}`);
  }

  await verifyReadModelProtocol(deps, runner, apiDir, plan, apiUrl);
  return { created: resources.created, apiUrl, webUrl };
}

/**
 * Asks the deployed API which protocol its read model executor serves
 * (`/healthz`, answered even when its checks are rate limited) and records
 * it in the directory (`read_model_barriers.executor_version`), what a later
 * change to the protocol checks before it applies. Not answered (no
 * workers.dev URL, the API unreachable): nothing recorded, and said so.
 */
async function verifyReadModelProtocol(
  deps: DeployDeps,
  runner: WranglerRunner,
  apiDir: string,
  plan: ReturnType<typeof resourcePlan>,
  apiUrl: string | undefined,
): Promise<void> {
  const directory = plan.d1.find((d) => d.binding === "DIRECTORY")?.name;
  const unverified = (why: string) =>
    deps.log(`WARN the read model protocol the API serves is not verified: ${why}`);
  if (directory === undefined) return unverified("no directory database is configured");
  if (apiUrl === undefined) return unverified("fyrden-api has no workers.dev URL");
  let protocol: unknown;
  try {
    const response = await (deps.fetch ?? fetch)(new URL("/healthz", apiUrl));
    protocol = ((await response.json()) as { readModel?: { protocol?: unknown } }).readModel
      ?.protocol;
  } catch (error) {
    return unverified(`its health check did not answer (${String(error)})`);
  }
  if (!Number.isSafeInteger(protocol) || (protocol as number) < 1)
    return unverified("its health check names no protocol");
  // The shard this deployment's read model is (one database: the default shard).
  const recorded = await queryRemote(
    runner,
    apiDir,
    directory,
    `UPDATE read_model_barriers SET executor_version = ${protocol as number}
     WHERE shard = 'default' RETURNING shard`,
    ["-c", API_DEPLOY_CONFIG],
  );
  if (recorded.length !== 1) return unverified("the directory has no barrier for its read model");
  deps.log(`ok   fyrden-api serves read model protocol ${protocol as number} (recorded)`);
}

/** The org migration from which writes outside the read model's executor are refused. */
const ENFORCEMENT_MIGRATION = "0018_read_model_enforced.sql";

/** The read model's data tables (apps/api/src/read-model/export.ts): rows in any are data. */
const READ_MODEL_TABLES = [
  "consumer_epochs",
  "discretionary_hours",
  "discretionary_state",
  "effects",
  "events_failed",
  "repos",
  "search_budget",
  "search_docs",
  "search_labels",
  "search_milestones",
  "search_reconciles",
  "search_repairs",
  "search_size",
  "search_sources",
  "search_sweep",
  "source_owner",
  "webhook_attempts",
  "webhook_deliveries",
  "webhook_payloads",
];

/** Rows a migration seeds (none of them data while as seeded): `search_size`'s, at zero. */
const SEEDED: Readonly<Record<string, string>> = {
  search_size: "NOT (id = 1 AND clock = 0 AND observed = 0 AND bytes = 0)",
};

/** Whether any of `tables` holds data (`used` 1): a row other than one a migration seeded. */
export function readModelUsedSql(tables: readonly string[]): string {
  const exists = tables.map((name) =>
    SEEDED[name]
      ? `EXISTS (SELECT 1 FROM ${name} WHERE ${SEEDED[name]})`
      : `EXISTS (SELECT 1 FROM ${name})`,
  );
  return `SELECT ${exists.join(" OR ")} AS used`;
}

/**
 * Refuses to install enforcement (org migration 0018) over a read model
 * that holds data unless the operator says the deployment is quiesced: a
 * rolling upgrade with work running is not supported (that work's writes
 * would be refused mid-flight). Nothing to check on a fresh database or
 * once it is installed. Before any migration applies.
 */
async function checkEnforcementInstall(
  deps: DeployDeps,
  runner: WranglerRunner,
  apiDir: string,
  plan: ReturnType<typeof resourcePlan>,
): Promise<void> {
  const org = plan.d1.find((d) => d.binding === "ORG_READ");
  if (!org?.migrationsDir || deps.quiesced) return;
  const db = { name: org.name, migrationsDir: org.migrationsDir };
  const { pending } = await migrationGap(runner, apiDir, db);
  if (!pending.includes(ENFORCEMENT_MIGRATION)) return;
  const present = await queryRemote<{ name: string }>(
    runner,
    apiDir,
    org.name,
    `SELECT name FROM sqlite_schema WHERE type = 'table'
     AND name IN (${READ_MODEL_TABLES.map((t) => `'${t}'`).join(", ")})`,
    ["-c", API_DEPLOY_CONFIG],
  );
  if (present.length === 0) return;
  const [used] = await queryRemote<{ used: number }>(
    runner,
    apiDir,
    org.name,
    readModelUsedSql(present.map(({ name }) => name)),
    ["-c", API_DEPLOY_CONFIG],
  );
  if (used?.used !== 1) return;
  throw new Error(
    `${org.name} holds data, and org migration ${ENFORCEMENT_MIGRATION} (writes outside the read model's executor refused) is not applied yet. ` +
      "It is installed over data only on a test deployment with nothing running against it: stop its traffic, then deploy again with --quiesced on.",
  );
}

/** What a D1 bookmark looks like (hex groups): checked before it goes into SQL. */
const BOOKMARK = /^[0-9a-f]+(?:-[0-9a-f]+)+$/i;

/**
 * Records the read model's restore floor (`read_model_barriers.read_model_protocol_since`)
 * once enforcement is installed: the org database's bookmark taken after
 * its protocol and closed admission are seen, so every write after it went
 * through the executor. Once: a floor recorded stays. A deploy interrupted
 * before it records one records a later one next time; an earlier one is
 * never guessed.
 */
async function recordRestoreFloor(
  deps: DeployDeps,
  runner: WranglerRunner,
  apiDir: string,
  plan: ReturnType<typeof resourcePlan>,
): Promise<void> {
  const directory = plan.d1.find((d) => d.binding === "DIRECTORY")?.name;
  const org = plan.d1.find((d) => d.binding === "ORG_READ")?.name;
  if (directory === undefined || org === undefined) return;
  const config = ["-c", API_DEPLOY_CONFIG];
  const [barrier] = await queryRemote<{ floor: string | null }>(
    runner,
    apiDir,
    directory,
    "SELECT read_model_protocol_since AS floor FROM read_model_barriers WHERE shard = 'default'",
    config,
  );
  if (!barrier) throw new Error(`${directory} has no barrier for its read model`);
  if (barrier.floor !== null) {
    deps.log(`ok   read model restore floor ${barrier.floor}`);
    return;
  }
  const [state] = await queryRemote<{ protocol: number; open: number }>(
    runner,
    apiDir,
    org,
    `SELECT b.protocol_version AS protocol, w.open AS open
     FROM read_model_barrier b JOIN read_model_write w ON w.id = 1 WHERE b.id = 1`,
    config,
  );
  if (!state || state.protocol < 2 || state.open !== 0)
    throw new Error(
      `${org} does not refuse writes outside the read model's executor (protocol ${state?.protocol ?? "missing"}, admission ${state?.open === 0 ? "closed" : "not closed"}): no restore floor recorded`,
    );
  const info = JSON.parse(
    await wrangler(runner, ["d1", "time-travel", "info", org, "--json", ...config], {
      cwd: apiDir,
    }),
  ) as { bookmark?: unknown };
  const bookmark = info.bookmark;
  if (typeof bookmark !== "string" || !BOOKMARK.test(bookmark))
    throw new Error(`${org}'s Time Travel answered no bookmark: no restore floor recorded`);
  const recorded = await queryRemote<{ floor: string }>(
    runner,
    apiDir,
    directory,
    `UPDATE read_model_barriers SET read_model_protocol_since = '${bookmark}'
     WHERE shard = 'default' AND read_model_protocol_since IS NULL
     RETURNING read_model_protocol_since AS floor`,
    config,
  );
  deps.log(
    recorded.length === 1
      ? `ok   read model restore floor ${bookmark} (recorded)`
      : "ok   read model restore floor recorded meanwhile (kept)",
  );
}

/** 32 random bytes as unpadded base64url. */
function base64urlKey(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}

/** A new Ed25519 signing key: its 32-byte seed, base64. */
function signingKey(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
}
