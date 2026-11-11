// The mutation scopes a pull request changed, as the CI mutation job's
// matrix, so a pull request that changes no scope allocates no runner:
//   node tools/ci/src/select-mutation.ts <base> <head>
// A scope runs when its source directory changed; every scope runs when the
// mutation setup itself changed. Prints `matrix=<json>` and `any=<bool>`,
// into $GITHUB_OUTPUT when CI sets it.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";

const GIT_CORE = "packages/git-core/";
// Stryker's setup, and the Vitest config its test command runs every mutant's tests under.
const SETUP = [
  `${GIT_CORE}stryker.config.mjs`,
  `${GIT_CORE}stryker/`,
  `${GIT_CORE}vitest.config.ts`,
];
const NAME = /^[a-z][a-z-]*$/;

export interface MutationScope {
  readonly scope: string;
  /** The directory under packages/git-core/src the scope mutates. */
  readonly dir: string;
}

/** The scope table of stryker/scopes.mjs, checked for the fields used here. */
export function parseScopes(table: unknown): MutationScope[] {
  if (typeof table !== "object" || table === null) throw new Error("mutation scopes: not a table");
  const scopes = Object.entries(table).map(([scope, value]) => {
    const dir = (value as { dir?: unknown } | null)?.dir ?? scope;
    if (!NAME.test(scope) || typeof dir !== "string" || !NAME.test(dir))
      throw new Error(`mutation scopes: invalid scope ${JSON.stringify(scope)}`);
    return { scope, dir };
  });
  if (scopes.length === 0) throw new Error("mutation scopes: none");
  return scopes;
}

/** The scopes of this checkout's packages/git-core/stryker/scopes.mjs. */
export async function loadScopes(): Promise<MutationScope[]> {
  const path = resolve(import.meta.dirname, "../../../packages/git-core/stryker/scopes.mjs");
  const module: { SCOPES?: unknown } = await import(path);
  return parseScopes(module.SCOPES);
}

/** Whether a changed path is part of the mutation setup, which every scope's result depends on. */
export function mutationSetupChanged(changedPaths: readonly string[]): boolean {
  return changedPaths.some((path) =>
    SETUP.some((setup) => (setup.endsWith("/") ? path.startsWith(setup) : path === setup)),
  );
}

/** The scopes whose source, or the mutation setup, is among the changed paths. */
export function selectMutationScopes(
  changedPaths: readonly string[],
  scopes: readonly MutationScope[],
): MutationScope[] {
  if (mutationSetupChanged(changedPaths)) return [...scopes];
  return scopes.filter(({ dir }) =>
    changedPaths.some((path) => path.startsWith(`${GIT_CORE}src/${dir}/`)),
  );
}

/** Paths changed between two commits; a rename counts as both of its paths. */
export function changedPaths(base: string, head: string, cwd = process.cwd()): string[] {
  const out = execFileSync("git", ["diff", "--name-only", "--no-renames", "-z", base, head], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split("\0").filter((path) => path !== "");
}

if (import.meta.main) {
  const [base, head] = process.argv.slice(2);
  if (!base || !head) {
    console.error("usage: select-mutation.ts <base> <head>");
    process.exit(2);
  }
  const selected = selectMutationScopes(changedPaths(base, head), await loadScopes());
  const lines = [`matrix=${JSON.stringify({ include: selected })}`, `any=${selected.length > 0}`];
  console.log(
    selected.length > 0
      ? `Mutation scopes changed: ${selected.map(({ scope }) => scope).join(", ")}`
      : "Mutation scopes changed: none",
  );
  const output = process.env.GITHUB_OUTPUT;
  if (output) appendFileSync(output, `${lines.join("\n")}\n`);
  else console.log(lines.join("\n"));
}
