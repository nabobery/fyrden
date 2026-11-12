// Which CI jobs a pull request needs, from the paths it changed and the
// workspace packages Turbo's dependency graph says those changes affect:
//   node tools/ci/src/select-ci.ts <base> <head>
// Report only for now: CI prints the selection beside the jobs that still all
// run, so its decisions can be checked against real pull requests before any
// job is skipped on its word. Anything it cannot place selects everything.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { changedPaths } from "./select-mutation.ts";

export interface CiSelection {
  readonly api: boolean;
  /** Packages other than the API whose coverage job must run. */
  readonly coveragePackages: readonly string[];
  readonly e2e: boolean;
  readonly contract: boolean;
  readonly interop: boolean;
  readonly shuffleApi: boolean;
  readonly shuffleAdapters: boolean;
  readonly reason: string;
}

export interface SelectionInput {
  readonly event: string;
  readonly paths: readonly string[];
  /** Packages Turbo reports affected (changed, or depending on a changed one), with a coverage task. */
  readonly affected: readonly string[];
  /** Every workspace package with a coverage task. */
  readonly workspace: readonly string[];
}

const API = "@fyrden/api";
const WEB = "@fyrden/web";
const ADAPTERS = "@fyrden/adapters-cloudflare";
const CI_TOOLS = "@fyrden/ci-tools";

/** Paths that change no test's outcome: CI checks them with lint alone. */
const DOCUMENTATION = /^docs\/.+\.md$/;
/** Paths inside a workspace package, where Turbo's graph knows the consumers. */
const PACKAGE_SOURCE = /^(?:apps|packages)\/[^/]+\/|^tools\/ci\//;

/**
 * Paths whose consumers the package graph does not show, so everything runs:
 * dependency and tool configuration, shared test helpers, CI itself, and the
 * API's migrations and Worker config (the CLI's tests read them directly).
 */
const RUN_EVERYTHING: readonly RegExp[] = [
  /(^|\/)package\.json$/,
  /^pnpm-(lock|workspace)\.yaml$/,
  /(^|\/)turbo\.json$/,
  /^tsconfig[^/]*\.json$/,
  /^biome\.json$/,
  /^\.nvmrc$/,
  /^\.github\//,
  /^packages\/testing\//,
  /^apps\/api\/migrations\//,
  /^apps\/api\/wrangler\.jsonc$/,
];

function everything(workspace: readonly string[], reason: string): CiSelection {
  return {
    api: true,
    coveragePackages: workspace.filter((name) => name !== API),
    e2e: true,
    contract: true,
    interop: true,
    shuffleApi: true,
    shuffleAdapters: true,
    reason,
  };
}

export function selectCi({ event, paths, affected, workspace }: SelectionInput): CiSelection {
  if (event !== "pull_request") return everything(workspace, `${event}: every job`);
  if (paths.length === 0) return everything(workspace, "no changed paths: every job");
  const global = paths.find((path) => RUN_EVERYTHING.some((pattern) => pattern.test(path)));
  if (global) return everything(workspace, `${global} changed: every job`);
  const unplaced = paths.find((path) => !DOCUMENTATION.test(path) && !PACKAGE_SOURCE.test(path));
  if (unplaced) return everything(workspace, `${unplaced} is outside any package: every job`);

  const unknown = affected.find((name) => !workspace.includes(name));
  if (unknown) throw new Error(`Turbo reports an unknown package affected: ${unknown}`);
  const api = affected.includes(API);
  // The end-to-end, contract and interop suites live in ci-tools and run the
  // API (and the web Worker) under wrangler dev.
  const integration = api || affected.includes(CI_TOOLS);
  const selection = {
    api,
    coveragePackages: [...new Set(affected)].filter((name) => name !== API).sort(),
    e2e: integration || affected.includes(WEB),
    contract: integration,
    interop: integration,
    shuffleApi: api,
    shuffleAdapters: affected.includes(ADAPTERS),
  };
  const reason =
    affected.length === 0
      ? "documentation only: static checks alone"
      : `affected: ${[...affected].sort().join(", ")}`;
  return { ...selection, reason };
}

/** The packages with a coverage task in a `turbo run test:coverage --dry=json`, checked. */
export function coveragePackages(dryRun: unknown): string[] {
  const tasks = (dryRun as { tasks?: unknown } | null)?.tasks;
  if (!Array.isArray(tasks)) throw new Error("Turbo dry run: no tasks list");
  const names = new Set<string>();
  for (const task of tasks) {
    const { package: name, task: id } = (task ?? {}) as { package?: unknown; task?: unknown };
    if (typeof name !== "string" || typeof id !== "string")
      throw new Error(`Turbo dry run: a task without a package or name: ${JSON.stringify(task)}`);
    if (id === "test:coverage") names.add(name);
  }
  return [...names].sort();
}

function turboDryRun(args: string[], env: NodeJS.ProcessEnv): unknown {
  const out = execFileSync("pnpm", ["turbo", "run", "test:coverage", "--dry=json", ...args], {
    encoding: "utf8",
    env,
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out) as unknown;
}

/** One `name=value` line a job, for $GITHUB_OUTPUT: literal booleans a job's `if` can compare. */
export function outputLines(selection: CiSelection): string[] {
  const { reason: _reason, coveragePackages: packages, ...jobs } = selection;
  return [
    ...Object.entries(jobs).map(([job, selected]) => `${job}=${selected}`),
    `coverage-packages=${JSON.stringify(packages)}`,
  ];
}

if (import.meta.main) {
  // Outside a pull request (or with no event named) every job runs: no diff
  // and no affected-package query, only Turbo's list of the workspace's packages.
  const event = process.env.GITHUB_EVENT_NAME ?? "unknown";
  const [base, head] = process.argv.slice(2);
  let selection: CiSelection;
  if (event !== "pull_request") {
    selection = selectCi({
      event,
      paths: [],
      affected: [],
      workspace: coveragePackages(turboDryRun([], process.env)),
    });
  } else {
    if (!base || !head) {
      console.error("usage: select-ci.ts <base> <head>");
      process.exit(2);
    }
    const workspace = coveragePackages(turboDryRun([], process.env));
    const affected = coveragePackages(
      turboDryRun(["--affected"], { ...process.env, TURBO_SCM_BASE: base, TURBO_SCM_HEAD: head }),
    );
    selection = selectCi({ event, paths: changedPaths(base, head), affected, workspace });
  }
  const report = JSON.stringify(selection, null, 2);
  console.log(report);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary)
    appendFileSync(summary, `### CI selection (report only)\n\n\`\`\`json\n${report}\n\`\`\`\n`);
  const output = process.env.GITHUB_OUTPUT;
  if (output) appendFileSync(output, `${outputLines(selection).join("\n")}\n`);
}
