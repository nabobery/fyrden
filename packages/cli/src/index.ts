#!/usr/bin/env node
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { type DeployDeps, deploy, type Plan } from "./commands/deploy.ts";
import { destroy } from "./commands/destroy.ts";
import { doctor } from "./commands/doctor.ts";
import { PUSH_USAGE, parsePushArgs, push } from "./commands/push.ts";
import { nodePushDeps } from "./commands/push-node.ts";
import { nodeWranglerRunner } from "./wrangler.ts";

const USAGE = `usage:
  fyrden deploy [--plan free|paid]   create resources, migrate and deploy both Workers
  fyrden doctor                      check login and resources without changing anything
  fyrden destroy [--yes]             list what deploy created; with --yes delete it all (data loss)
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

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const log = (line: string) => console.log(line);
  if (command === "push") {
    // Runs in any git repository, not only a Fyrden checkout.
    const parsed = parsePushArgs(rest, process.env);
    if ("error" in parsed) {
      console.error(parsed.error);
      return 2;
    }
    return push(parsed, nodePushDeps());
  }
  const known = command === "deploy" || command === "doctor" || command === "destroy";
  if (!known || (command === "destroy" && rest.some((arg) => arg !== "--yes"))) {
    console.error(USAGE);
    return 2;
  }
  const repoRoot = findRepoRoot(process.cwd());
  const runner = nodeWranglerRunner(repoRoot);
  if (command === "doctor") {
    const report = await doctor(repoRoot, runner, log);
    return report.authenticated && report.missing.length === 0 ? 0 : 1;
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
  const planIndex = rest.indexOf("--plan");
  const plan = (planIndex >= 0 ? rest[planIndex + 1] : "paid") as Plan;
  if (plan !== "free" && plan !== "paid") {
    console.error(USAGE);
    return 2;
  }
  const result = await deploy({
    repoRoot,
    plan,
    runner,
    buildWeb: async () => {
      await promisify(execFile)("pnpm", ["--filter", "@fyrden/web", "build"], { cwd: repoRoot });
    },
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
