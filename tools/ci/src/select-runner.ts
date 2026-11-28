// Whether CI runs the pinned gitea/runner against `wrangler dev` (the
// `runner` job): on every push and manual run, and on a pull request that
// changed the runner protocol, the run object, the harness that drives them,
// the workflow corpus or CI's workflow.
//   node tools/ci/src/select-runner.ts <base> <head>
// Writes `runner=true|false` to $GITHUB_OUTPUT. Unlike select-ci.ts this
// decides: the job is skipped when it prints false, and the required check
// accepts the skip only then.
import { appendFileSync } from "node:fs";
import { changedPaths } from "./select-mutation.ts";

/** Path prefixes whose change selects the job. */
export const RUNNER_PATHS: readonly string[] = [
  "apps/api/src/runner/",
  "apps/api/src/do/run/",
  "apps/api/src/do/RunDO.ts",
  "apps/api/src/do/schema/run.ts",
  // The workflow payload the runner parses comes from the domain's expansion and expressions.
  "packages/domain/src/ci/",
  "tools/ci/runner/",
  "packages/testing/src/ci-corpus/",
  "tools/ci/corpus/",
  "tools/ci/vitest.corpus.config.ts",
  // The suite decodes the runner's recorded log calls with this helper.
  "apps/api/test/helpers/runner-proto.ts",
  // The suite's Vitest config, and its `test:runner` script.
  "tools/ci/vitest.runner.config.ts",
  "tools/ci/package.json",
  // What the suite runs on: wrangler dev, the forge helpers, the test Worker that starts runs,
  // the API Worker's config, and the locked dependencies (wrangler among them).
  "tools/ci/e2e/wrangler-dev.ts",
  "tools/ci/e2e/forge.ts",
  "tools/ci/e2e/auxiliary-api-config.ts",
  "tools/ci/e2e/fixtures/run-seam/",
  "apps/api/wrangler.jsonc",
  "pnpm-lock.yaml",
  "tools/ci/src/select-runner.ts",
  "tools/ci/src/select-mutation.ts",
  // Node, pnpm and the dependency catalog the setup installs.
  ".nvmrc",
  "package.json",
  "pnpm-workspace.yaml",
  // The jobs that run it, and the setup action they use.
  ".github/workflows/ci.yml",
  ".github/workflows/nightly.yml",
  ".github/actions/setup/",
];

export interface RunnerSelection {
  readonly runner: boolean;
  readonly reason: string;
}

export function selectRunner(event: string, paths: readonly string[]): RunnerSelection {
  if (event !== "pull_request") return { runner: true, reason: `${event}: always` };
  const hit = paths.find((path) => RUNNER_PATHS.some((prefix) => path.startsWith(prefix)));
  return hit
    ? { runner: true, reason: `${hit} changed` }
    : { runner: false, reason: "no runner path changed" };
}

if (import.meta.main) {
  const event = process.env.GITHUB_EVENT_NAME ?? "unknown";
  let paths: string[] = [];
  if (event === "pull_request") {
    const [base, head] = process.argv.slice(2);
    if (!base || !head) {
      console.error("usage: select-runner.ts <base> <head>");
      process.exit(2);
    }
    paths = changedPaths(base, head);
  }
  const selection = selectRunner(event, paths);
  console.log(`runner job: ${selection.runner} (${selection.reason})`);
  const output = process.env.GITHUB_OUTPUT;
  if (output) appendFileSync(output, `runner=${selection.runner}\n`);
}
