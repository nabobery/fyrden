#!/usr/bin/env node
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { type DeployDeps, deploy, type Plan } from "./commands/deploy.ts";
import { destroy } from "./commands/destroy.ts";
import { doctor } from "./commands/doctor.ts";
import { parseRepairArgs, REPAIR_USAGE, repairEffects } from "./commands/effects.ts";
import { PUSH_USAGE, parsePushArgs, push } from "./commands/push.ts";
import { nodePushDeps } from "./commands/push-node.ts";
import { exportReadModel, parseReadModelArgs, READ_MODEL_USAGE } from "./commands/read-model.ts";
import { readSource } from "./source.ts";
import { nodeWranglerRunner } from "./wrangler.ts";

const USAGE = `usage:
  fyrden deploy [--plan free|paid] [--internal-calls N] [--discretionary resource=n,...]
                [--watch-audiences on|off] [--live on|off [--live-sockets N]]
                [--read-model-maintenance on|off] [--quiesced on]
                [--email resend --email-from ADDRESS --email-secrets-file PATH
                                 [--email-sending on|off] [--email-daily-limit N]
                                 [--email-monthly-limit N] [--email-reserve N]
                                 [--public-origin https://HOST]]
                                     create resources, migrate and deploy both Workers;
                                     Paid: N calls to D1, R2 and Durable Objects an invocation
                                     (1,000 to 10,000,000; default 1,000);
                                     a daily allowance for watched activity per resource
                                     (do_requests, do_rows_read, do_rows_written, do_duration_ms,
                                     d1_rows_read, d1_rows_written, queue_ops; Free: a fifth of
                                     each of its limits unless set, Paid: uncapped unless set);
                                     watchers, thread subscribers and authors told of events
                                     only with --watch-audiences on (limits.md says when);
                                     email sent only with --email-sending on (its secrets file
                                     also holding the webhook's RESEND_WEBHOOK_SECRET, its key
                                     full-access), at most the daily and monthly limits (default
                                     100 and 3,000: Resend Free's), notifications stopping the
                                     reserve (default 10) short of them; a daily limit of 0: none;
                                     notification emails link to --public-origin, or else to
                                     the web Worker's URL (the API deployed again with it);
                                     --read-model-maintenance on holds back the work that writes
                                     the read model (API writes refused, queue messages put back,
                                     its crons skipped) until a deploy without it;
                                     writes outside the read model's executor refused from
                                     org migration 0018 on: installed over data only with
                                     --quiesced on (a test deployment with nothing running);
                                     the read model's restore floor recorded once it is
  fyrden doctor                      check login, resources and D1 schemas without changing anything
  fyrden destroy [--yes]             list what deploy created; with --yes delete it all (data loss)
  ${REPAIR_USAGE}
                                     count effects that failed for good and may still matter; with --yes reopen
                                     them (FYRDEN_TOKEN: an instance administrator's token)
  ${READ_MODEL_USAGE}
                                     pause the read model's writers, write every table and a
                                     manifest of digests to a new directory, then resume them
                                     (FYRDEN_TOKEN: an instance administrator's token)
  ${PUSH_USAGE}
                                     push, checking the size first; --chunked uploads a large push in parts`;

function findRepoRoot(from: string): string {
  let dir = resolve(from);
  while (!existsSync(join(dir, "apps", "api", "wrangler.jsonc"))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error("run fyrden inside a Fyrden checkout");
    dir = parent;
  }
  return dir;
}

/**
 * Deploy settings taken from the environment. In CI (any non-empty `CI`) a
 * bootstrap secret is never generated, because it would be printed into a
 * shared run log; the deploy fails instead unless one is preset.
 */
export function envDeployOptions(
  env: Record<string, string | undefined>,
  random: () => string = () => randomBytes(32).toString("base64url"),
): Pick<DeployDeps, "presetBootstrapSecret" | "randomSecret" | "envAccountId"> {
  return {
    // An unset GitHub secret arrives as "", so empty means unset.
    presetBootstrapSecret: env.FYRDEN_BOOTSTRAP_SECRET || undefined,
    randomSecret: env.CI ? undefined : random,
    envAccountId: env.CLOUDFLARE_ACCOUNT_ID || undefined,
  };
}

const HELP_FLAGS = new Set(["--help", "-h"]);

/** The email provider a deploy configures (passed on every deploy: left out, email is off). */
export interface EmailArgs {
  provider: "resend";
  from: string;
  /**
   * Where the provider's secrets are: a JSON object `{ "RESEND_API_KEY": "re_…" }`, with
   * `"RESEND_WEBHOOK_SECRET": "whsec_…"` (its webhook's signing secret) to send.
   */
  secretsFile: string;
  /** Whether email is sent (`--email-sending on`; off unless given). */
  sending: boolean;
  /** The allowance's limits given (each left out: its default). */
  limits: EmailLimitArgs;
  /** Where notification emails' links point (`--public-origin`); left out: the web Worker's URL. */
  publicOrigin?: string;
}

export interface EmailLimitArgs {
  daily?: number;
  monthly?: number;
  reserve?: number;
}

/**
 * An `https` origin with no path, query or credentials, as the API reads
 * `FYRDEN_PUBLIC_ORIGIN` (canonical: the host lower-cased, a default port
 * dropped); null for anything else.
 */
export function canonicalOrigin(text: string): string | null {
  try {
    const url = new URL(text);
    const bare =
      url.protocol === "https:" &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password;
    return bare ? url.origin : null;
  } catch {
    return null;
  }
}

/** The API's defaults for the email allowance (Resend Free's), and its rule for them. */
export const EMAIL_LIMIT_DEFAULTS = { daily: 100, monthly: 3_000, reserve: 10 } as const;

/** Whether limits fit: a daily limit of 0 (no email), or `0 ≤ reserve < daily ≤ monthly`. */
export function emailLimitsFit(limits: EmailLimitArgs): boolean {
  const { daily, monthly, reserve } = { ...EMAIL_LIMIT_DEFAULTS, ...limits };
  if (daily === 0) return true;
  return reserve < daily && daily <= monthly;
}

/**
 * The deploy's plan (Paid by default), internal calls, discretionary
 * allowance and email provider if `args` are exactly what `deploy`
 * accepts; undefined otherwise. Anything unknown (a typo, `--help`, a flag
 * twice, internal calls on Free, which cannot raise its 1,000, an
 * allowance the API would not read whole, an email provider given in part)
 * must never start a deploy.
 */
export function parseDeployArgs(args: readonly string[]):
  | {
      plan: Plan;
      internalCalls?: number;
      discretionary?: string;
      email?: EmailArgs;
      live?: LiveArgs;
      watchAudiences?: true;
      readModelMaintenance?: true;
      quiesced?: true;
    }
  | undefined {
  const given = new Map<string, string>();
  const flags = [
    "--plan",
    "--internal-calls",
    "--discretionary",
    "--watch-audiences",
    "--read-model-maintenance",
    "--quiesced",
    "--live",
    "--live-sockets",
    "--email",
    "--email-from",
    "--email-secrets-file",
    "--email-sending",
    "--email-daily-limit",
    "--email-monthly-limit",
    "--email-reserve",
    "--public-origin",
  ];
  for (let i = 0; i < args.length; i += 2) {
    const [flag, value] = [args[i] as string, args[i + 1]];
    if (value === undefined || given.has(flag)) return undefined;
    if (!flags.includes(flag)) return undefined;
    given.set(flag, value);
  }
  const plan = given.get("--plan") ?? "paid";
  if (plan !== "free" && plan !== "paid") return undefined;
  const discretionary = given.get("--discretionary");
  if (discretionary !== undefined && !validAllowance(discretionary)) return undefined;
  const watch = given.get("--watch-audiences");
  if (watch !== undefined && watch !== "on" && watch !== "off") return undefined;
  const maintenance = given.get("--read-model-maintenance");
  if (maintenance !== undefined && maintenance !== "on" && maintenance !== "off") return undefined;
  const quiesced = given.get("--quiesced");
  if (quiesced !== undefined && quiesced !== "on") return undefined;
  const live = liveArgs(given);
  if (live === null) return undefined;
  const email = emailArgs(given);
  if (email === null) return undefined;
  const extra = {
    ...(discretionary !== undefined && { discretionary }),
    ...(watch === "on" && { watchAudiences: true as const }),
    ...(maintenance === "on" && { readModelMaintenance: true as const }),
    ...(quiesced === "on" && { quiesced: true as const }),
    ...(live !== undefined && { live }),
    ...(email !== undefined && { email }),
  };
  const calls = given.get("--internal-calls");
  if (calls === undefined) return { plan, ...extra };
  const internalCalls = /^\d+$/.test(calls) ? Number(calls) : Number.NaN;
  if (plan !== "paid" || !(internalCalls >= 1_000 && internalCalls <= 10_000_000)) return undefined;
  return { plan, internalCalls, ...extra };
}

/** One `@`, a dot inside the domain, no spaces or angle brackets: checked without backtracking. */
function bareAddress(text: string): boolean {
  if (/[\s<>]/.test(text)) return false;
  const at = text.indexOf("@");
  const domain = text.slice(at + 1);
  return at > 0 && !domain.includes("@") && domain.slice(1, -1).includes(".");
}

/** `Name <address>` or a bare address. */
function senderAddress(from: string): boolean {
  const open = from.indexOf(" <");
  if (open > 0 && from.endsWith(">"))
    return !/[<>]/.test(from.slice(0, open)) && bareAddress(from.slice(open + 2, -1));
  return bareAddress(from);
}

/**
 * The email flags: the provider's three or none (undefined), the sending
 * switch and limits only with them; null for anything else (a provider but
 * Resend, a sending address that is not one, limits that do not fit).
 */
function emailArgs(given: ReadonlyMap<string, string>): EmailArgs | undefined | null {
  const [provider, from, secretsFile, sending] = [
    given.get("--email"),
    given.get("--email-from"),
    given.get("--email-secrets-file"),
    given.get("--email-sending"),
  ];
  const limitFlags = {
    daily: given.get("--email-daily-limit"),
    monthly: given.get("--email-monthly-limit"),
    reserve: given.get("--email-reserve"),
  };
  const anyLimit = Object.values(limitFlags).some((v) => v !== undefined);
  const origin = given.get("--public-origin");
  if (provider === undefined && from === undefined && secretsFile === undefined) {
    return sending === undefined && !anyLimit && origin === undefined ? undefined : null;
  }
  const publicOrigin = origin === undefined ? undefined : canonicalOrigin(origin);
  if (publicOrigin === null) return null;
  if (provider !== "resend" || !from || !secretsFile) return null;
  if (!senderAddress(from)) return null;
  if (sending !== undefined && sending !== "on" && sending !== "off") return null;
  const limits: EmailLimitArgs = {};
  for (const [name, text] of Object.entries(limitFlags) as [keyof EmailLimitArgs, string][]) {
    if (text === undefined) continue;
    if (!/^\d{1,9}$/.test(text)) return null;
    limits[name] = Number(text);
  }
  if (!emailLimitsFit(limits)) return null;
  return {
    provider,
    from,
    secretsFile,
    sending: sending === "on",
    limits,
    ...(publicOrigin !== undefined && { publicOrigin }),
  };
}

/** Live notification hints a deploy turns on (passed on every deploy: left out, they are off). */
export interface LiveArgs {
  /** Sockets the deployment admits at once (`FYRDEN_LIVE_SOCKETS`; left out: the API's 50). */
  sockets?: number;
}

/**
 * `--live on|off` and `--live-sockets N` (1 to 100,000, with `--live on`
 * only): on (undefined when off or left out); null for anything else.
 */
function liveArgs(given: ReadonlyMap<string, string>): LiveArgs | undefined | null {
  const [live, sockets] = [given.get("--live"), given.get("--live-sockets")];
  if (live === undefined) return sockets === undefined ? undefined : null;
  if (live === "off") return sockets === undefined ? undefined : null;
  if (live !== "on") return null;
  if (sockets === undefined) return {};
  if (!/^[1-9]\d{0,5}$/.test(sockets) || Number(sockets) > 100_000) return null;
  return { sockets: Number(sockets) };
}

/** The resources a discretionary allowance names (as the API's `FYRDEN_DISCRETIONARY_DAILY`). */
const DISCRETIONARY_RESOURCES = new Set([
  "do_requests",
  "do_rows_read",
  "do_rows_written",
  "do_duration_ms",
  "d1_rows_read",
  "d1_rows_written",
  "queue_ops",
]);

/** Whether the API reads `value` whole: `resource=n,…`, each resource known and once. */
function validAllowance(value: string): boolean {
  const seen = new Set<string>();
  for (const part of value.split(",")) {
    const match = /^([a-z0-9_]+)=(0|[1-9][0-9]{0,14})$/.exec(part.trim());
    const resource = match?.[1];
    if (!resource || !DISCRETIONARY_RESOURCES.has(resource) || seen.has(resource)) return false;
    seen.add(resource);
  }
  return seen.size > 0;
}

/**
 * Whether the command line asks for help. A bare `help` counts only where no
 * command takes it as a value (a push can name a remote or branch `help`).
 */
export function asksForHelp(argv: readonly string[]): boolean {
  const [command, ...rest] = argv;
  return (
    command === "help" ||
    HELP_FLAGS.has(command ?? "") ||
    rest.some((arg) => HELP_FLAGS.has(arg)) ||
    (command !== "push" && rest.length === 1 && rest[0] === "help")
  );
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const log = (line: string) => console.log(line);
  // Help is answered before anything else runs, for every command.
  if (command === undefined || asksForHelp(argv)) {
    console.log(USAGE);
    return command === undefined ? 2 : 0;
  }
  if (command === "push") {
    // Runs in any git repository, not only a Fyrden checkout.
    const parsed = parsePushArgs(rest, process.env);
    if ("error" in parsed) {
      console.error(parsed.error);
      return 2;
    }
    return push(parsed, nodePushDeps());
  }
  if (command === "read-model") {
    const parsed = parseReadModelArgs(rest, process.env);
    if ("error" in parsed) {
      console.error(parsed.error);
      return 2;
    }
    await exportReadModel({
      args: parsed,
      fetch,
      sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
      now: Date.now,
      log,
    });
    return 0;
  }
  if (command === "effects") {
    const [sub, ...args] = rest;
    const parsed =
      sub === "repair" ? parseRepairArgs(args, Date.now(), process.env) : { error: USAGE };
    if ("error" in parsed) {
      console.error(parsed.error);
      return 2;
    }
    await repairEffects({ args: parsed, fetch, log });
    return 0;
  }
  const known = command === "deploy" || command === "doctor" || command === "destroy";
  const badArgs =
    (command === "destroy" && rest.some((arg) => arg !== "--yes")) ||
    (command === "doctor" && rest.length > 0) ||
    (command === "deploy" && parseDeployArgs(rest) === undefined);
  if (!known || badArgs) {
    console.error(USAGE);
    return 2;
  }
  const repoRoot = findRepoRoot(process.cwd());
  const runner = nodeWranglerRunner(repoRoot);
  if (command === "doctor") {
    const report = await doctor(repoRoot, runner, log);
    return report.authenticated && report.missing.length === 0 && report.schemaDrift.length === 0
      ? 0
      : 1;
  }
  if (command === "destroy") {
    // Without --yes (in CI too) this is a dry run.
    const result = await destroy({
      repoRoot,
      runner,
      confirmed: rest.includes("--yes"),
      envAccountId: process.env.CLOUDFLARE_ACCOUNT_ID || undefined,
      log,
    });
    return result.complete ? 0 : 1;
  }
  const {
    plan,
    internalCalls,
    discretionary,
    email,
    live,
    watchAudiences,
    readModelMaintenance,
    quiesced,
  } = parseDeployArgs(rest) as {
    plan: Plan;
    internalCalls?: number;
    discretionary?: string;
    email?: EmailArgs;
    live?: LiveArgs;
    watchAudiences?: true;
    readModelMaintenance?: true;
    quiesced?: true;
  };
  const result = await deploy({
    repoRoot,
    plan,
    internalCalls,
    discretionary,
    watchAudiences,
    readModelMaintenance,
    quiesced,
    live,
    email: email && (await emailDeploy(email)),
    runner,
    buildWeb: async () => {
      await promisify(execFile)("pnpm", ["--filter", "@fyrden/web", "build"], { cwd: repoRoot });
    },
    source: await readSource(repoRoot),
    ...envDeployOptions(process.env),
    onSecretGenerated: (secret) =>
      log(
        `\nBOOTSTRAP_SECRET=${secret}\nKeep it: first-run setup needs it, and it is not shown again.\n`,
      ),
    log,
  });
  log(
    `\nAPI: ${result.apiUrl ?? "(see wrangler output)"}\nWeb: ${result.webUrl ?? "(see wrangler output)"}`,
  );
  return 0;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    },
  );
}

/**
 * The email provider's configuration for `deploy`, from its flags and
 * secrets file, checked before anything is provisioned: to send, the file
 * must hold the webhook's signing secret and the key must be able to read
 * the provider's suppression list (a sending-only key cannot).
 */
export async function emailDeploy(
  email: EmailArgs,
  fetcher: typeof fetch = fetch,
): Promise<NonNullable<DeployDeps["email"]>> {
  const secrets = await emailSecrets(email.secretsFile);
  if (email.sending) {
    if (!secrets.webhookSecret)
      throw new Error(
        `--email-sending on: ${email.secretsFile} has no RESEND_WEBHOOK_SECRET (the signing secret of the webhook sending suppression.added and suppression.removed to https://<web origin>/auth/email/events)`,
      );
    await checkEmailKey(secrets.apiKey, fetcher);
  }
  return {
    provider: email.provider,
    from: email.from,
    apiKey: secrets.apiKey,
    ...(secrets.webhookSecret !== undefined && { webhookSecret: secrets.webhookSecret }),
    sending: email.sending,
    limits: email.limits,
    ...(email.publicOrigin !== undefined && { publicOrigin: email.publicOrigin }),
  };
}

/** Refuses a provider key that cannot read the suppression list (`GET /suppressions?limit=1`). */
export async function checkEmailKey(apiKey: string, fetcher: typeof fetch = fetch): Promise<void> {
  let response: Response;
  try {
    response = await fetcher("https://api.resend.com/suppressions?limit=1", {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new Error(`could not reach Resend to check RESEND_API_KEY (${String(error)})`);
  }
  if (response.ok) return;
  if (response.status === 401 || response.status === 403)
    throw new Error(
      "RESEND_API_KEY cannot read the suppression list: sending needs a full-access key (a sending-only key cannot)",
    );
  throw new Error(`Resend answered ${response.status} when checking RESEND_API_KEY: try again`);
}

/**
 * Whether a webhook signing secret is `whsec_` and canonical padded standard base64 of at
 * least 16 bytes: the API's rule (`webhookSecretBytes`).
 */
function webhookSecretFits(secret: string): boolean {
  const text = /^whsec_([A-Za-z0-9+/]+={0,2})$/.exec(secret)?.[1];
  if (text === undefined) return false;
  const bytes = Buffer.from(text, "base64");
  return bytes.length >= 16 && bytes.toString("base64") === text;
}

/** The provider's secrets from its file. */
async function emailSecrets(path: string): Promise<{ apiKey: string; webhookSecret?: string }> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(
      `--email-secrets-file ${path}: not readable (${(error as { code?: string }).code ?? "error"})`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Never the parser's message: it quotes the file, a secret.
    throw new Error(`--email-secrets-file ${path}: not a JSON object`);
  }
  const fields = parsed as { RESEND_API_KEY?: unknown; RESEND_WEBHOOK_SECRET?: unknown } | null;
  const key = fields?.RESEND_API_KEY;
  if (typeof key !== "string" || !/^re_[A-Za-z0-9_-]{8,}$/.test(key))
    throw new Error(`--email-secrets-file ${path}: RESEND_API_KEY is missing or not a Resend key`);
  const webhookSecret = fields?.RESEND_WEBHOOK_SECRET;
  if (webhookSecret === undefined) return { apiKey: key };
  if (typeof webhookSecret !== "string" || !webhookSecretFits(webhookSecret))
    throw new Error(
      `--email-secrets-file ${path}: RESEND_WEBHOOK_SECRET is not a webhook signing secret (whsec_…)`,
    );
  return { apiKey: key, webhookSecret };
}
