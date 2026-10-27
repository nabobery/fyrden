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
import { readSource } from "./source.ts";
import { nodeWranglerRunner } from "./wrangler.ts";

const USAGE = `usage:
  fyrden deploy [--plan free|paid] [--internal-calls N] [--discretionary resource=n,...]
                [--email resend --email-from ADDRESS --email-secrets-file PATH]
                                     create resources, migrate and deploy both Workers;
                                     Paid: N calls to D1, R2 and Durable Objects an invocation
                                     (1,000 to 10,000,000; default 1,000);
                                     a daily allowance for watched activity per resource
                                     (do_requests, do_rows_read, do_rows_written, do_duration_ms,
                                     d1_rows_read, d1_rows_written, queue_ops; Free: a fifth of
                                     each of its limits unless set, Paid: uncapped unless set)
  fyrden doctor                      check login, resources and D1 schemas without changing anything
  fyrden destroy [--yes]             list what deploy created; with --yes delete it all (data loss)
  ${REPAIR_USAGE}
                                     count effects that failed for good and may still matter; with --yes reopen them
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
  /** Where the provider's key is: a JSON object `{ "RESEND_API_KEY": "re_…" }`. */
  secretsFile: string;
}

/**
 * The deploy's plan (Paid by default), internal calls, discretionary
 * allowance and email provider if `args` are exactly what `deploy`
 * accepts; undefined otherwise. Anything unknown (a typo, `--help`, a flag
 * twice, internal calls on Free, which cannot raise its 1,000, an
 * allowance the API would not read whole, an email provider given in part)
 * must never start a deploy.
 */
export function parseDeployArgs(
  args: readonly string[],
): { plan: Plan; internalCalls?: number; discretionary?: string; email?: EmailArgs } | undefined {
  const given = new Map<string, string>();
  const flags = [
    "--plan",
    "--internal-calls",
    "--discretionary",
    "--email",
    "--email-from",
    "--email-secrets-file",
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
  const email = emailArgs(given);
  if (email === null) return undefined;
  const extra = {
    ...(discretionary !== undefined && { discretionary }),
    ...(email !== undefined && { email }),
  };
  const calls = given.get("--internal-calls");
  if (calls === undefined) return { plan, ...extra };
  const internalCalls = /^\d+$/.test(calls) ? Number(calls) : Number.NaN;
  if (plan !== "paid" || !(internalCalls >= 1_000 && internalCalls <= 10_000_000)) return undefined;
  return { plan, internalCalls, ...extra };
}

/**
 * The email flags: all three or none (undefined); null for anything else
 * (a provider but Resend, a sending address that is not one).
 */
function emailArgs(given: ReadonlyMap<string, string>): EmailArgs | undefined | null {
  const [provider, from, secretsFile] = [
    given.get("--email"),
    given.get("--email-from"),
    given.get("--email-secrets-file"),
  ];
  if (provider === undefined && from === undefined && secretsFile === undefined) return undefined;
  if (provider !== "resend" || !from || !secretsFile) return null;
  // `Name <address>` or a bare address.
  if (!/^(?:[^<>]+ <[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+>|[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)$/.test(from))
    return null;
  return { provider, from, secretsFile };
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
  if (command === "effects") {
    const [sub, ...args] = rest;
    const parsed = sub === "repair" ? parseRepairArgs(args, Date.now()) : { error: USAGE };
    if ("error" in parsed) {
      console.error(parsed.error);
      return 2;
    }
    const repoRoot = findRepoRoot(process.cwd());
    await repairEffects({
      repoRoot,
      runner: nodeWranglerRunner(repoRoot),
      args: parsed,
      now: Date.now,
      envAccountId: process.env.CLOUDFLARE_ACCOUNT_ID || undefined,
      log,
    });
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
  const { plan, internalCalls, discretionary, email } = parseDeployArgs(rest) as {
    plan: Plan;
    internalCalls?: number;
    discretionary?: string;
    email?: EmailArgs;
  };
  const result = await deploy({
    repoRoot,
    plan,
    internalCalls,
    discretionary,
    email: email && {
      provider: email.provider,
      from: email.from,
      apiKey: await emailKey(email.secretsFile),
    },
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

/** The provider's key from its secrets file, checked before anything is provisioned. */
async function emailKey(path: string): Promise<string> {
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
  const key = (parsed as { RESEND_API_KEY?: unknown } | null)?.RESEND_API_KEY;
  if (typeof key !== "string" || !/^re_[A-Za-z0-9_-]{8,}$/.test(key))
    throw new Error(`--email-secrets-file ${path}: RESEND_API_KEY is missing or not a Resend key`);
  return key;
}
