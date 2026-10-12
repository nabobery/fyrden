// Stryker mutation testing, one scope (a directory under src/) per run:
//
//   FYRDEN_MUTATION_SCOPE=pack pnpm mutation                 # full run of one scope
//   FYRDEN_MUTATION_SCOPE=pack pnpm mutation --incremental   # reuse the last results
//
// The command runner runs the scope's test command once per mutant (Stryker's
// Vitest runner does not switch mutants under Vitest 5, and the TypeScript 7
// compiler has no API for its tsconfig rewriting). Each scope therefore runs a
// fast subset of the tests: the slow git-oracle files that would dominate the
// per-mutant time are left out, and the full suite still runs on every PR.
// `break` is the recorded baseline (docs/testing.md) rounded down; for
// scopes measured before the timeout below was raised, the share of mutants
// that were killed outright (timeouts not counted), rounded down.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PUSH_FSCK = ["fsck.ts", "gitmodules.ts", "special-names.ts", "git-config.ts"];

/**
 * A scope mutates `src/<dir>` (default: the scope's name), or only `files`
 * there; `skip` leaves files of the directory to another scope.
 * @type {Record<string, { dir?: string; files?: string[]; skip?: string[]; tests: string[]; exclude?: string[]; break: number }>}
 */
const SCOPES = {
  protocol: { tests: ["test/protocol/"], break: 84 },
  object: { tests: ["test/object/"], break: 77 },
  hash: { tests: ["test/hash/"], exclude: ["**/*-throughput.test.ts"], break: 88 },
  refs: { tests: ["test/refs/"], break: 87 },
  pack: {
    tests: ["test/pack/", "test/pack-index/"],
    exclude: ["**/pack-parse.fuzz.test.ts", "**/*.perf.test.ts"],
    break: 77,
  },
  "pack-write": {
    tests: ["test/pack-write/"],
    exclude: ["**/*.bench.test.ts", "**/*.report.test.ts"],
    break: 68,
  },
  graph: {
    tests: ["test/graph/"],
    exclude: ["**/git-differential.test.ts", "**/*.perf.test.ts"],
    break: 59,
  },
  reader: { tests: ["test/reader/"], break: 61 },
  "receive-pack": {
    skip: PUSH_FSCK,
    tests: ["test/receive-pack/"],
    exclude: ["**/receive-pack.git-push.test.ts"],
    break: 61,
  },
  // The push object checks: parsers with their own fast tests, apart from
  // the receive-pack tests (a git-oracle round trip and a budget test per
  // mutant) that made a full receive-pack run outlast a CI job.
  "push-fsck": {
    dir: "receive-pack",
    files: PUSH_FSCK,
    tests: [
      "test/receive-pack/push-fsck.policy.test.ts",
      "test/receive-pack/push-fsck.git-oracle.test.ts",
      "test/receive-pack/receive-pack.property.test.ts",
      "test/receive-pack/receive-pack.long-pathname.test.ts",
      "test/object/tag.long-name.test.ts",
    ],
    break: 69,
  },
  "upload-pack": {
    tests: ["test/upload-pack/"],
    exclude: ["**/upload-pack.git-clone.test.ts"],
    break: 56,
  },
};

const name = process.env.FYRDEN_MUTATION_SCOPE ?? "protocol";
const scope = SCOPES[name];
if (!scope) {
  throw new Error(
    `unknown FYRDEN_MUTATION_SCOPE "${name}"; one of: ${Object.keys(SCOPES).join(", ")}`,
  );
}

/*
 * Two TypeScript patterns Stryker 10 cannot instrument safely (measured):
 * - an `as` expression as the left operand of `|` or `&` is printed without
 *   its parentheses, so `(flags[i] as number) | SEEN` runs as
 *   `flags[i] as (number | SEEN)` and the bit operation disappears (SHA-1
 *   collision detection stopped detecting in the dry run);
 * - `(x as number)++` makes its update-operator mutator throw.
 * Files with either are left out of their scope, with a warning, until the
 * code avoids them (a non-null assertion or a local variable does).
 */
const UNSAFE = [/\bas\s+[\w.<>[\]]+\)+\s*(?:\|(?!\|)|&(?!&))/, /\bas\s+[\w.<>[\]]+\)(?:\+\+|--)/];
const dir = scope.dir ?? name;
const sources = (
  scope.files ??
  readdirSync(`src/${dir}`, { recursive: true })
    .map(String)
    .filter((file) => file.endsWith(".ts"))
).filter((file) => !(scope.skip ?? []).includes(file));
const unsafe = sources.filter((file) => {
  const text = readFileSync(join("src", dir, file), "utf8");
  return UNSAFE.some((pattern) => pattern.test(text));
});
if (unsafe.length > 0) {
  console.warn(
    `mutation scope ${name}: not mutated (Stryker cannot instrument them safely): ${unsafe.join(", ")}`,
  );
}

const command = [
  "node stryker/run-tests.mjs",
  ...scope.tests,
  ...(scope.exclude ?? []).map((glob) => `--exclude '${glob}'`),
  "--bail=1",
].join(" ");

/** @type {import("@stryker-mutator/api/core").PartialStrykerOptions} */
export default {
  packageManager: "pnpm",
  testRunner: "command",
  commandRunner: { command },
  mutate: sources.filter((file) => !unsafe.includes(file)).map((file) => `src/${dir}/${file}`),
  coverageAnalysis: "off",
  reporters: ["clear-text", "progress", "json"],
  jsonReporter: { fileName: `reports/mutation/${name}.json` },
  // Read and written only with --incremental. Without per-test coverage
  // (command runner), Stryker reuses the result of every mutant whose own code
  // is unchanged, so a change elsewhere that weakens tests is seen only by the
  // full nightly run.
  incrementalFile: `reports/mutation/${name}.incremental.json`,
  thresholds: { high: 90, low: 80, break: scope.break },
  // A mutant that makes a test wait forever fails at Vitest's 30 s test
  // timeout (killed); only a loop that never yields reaches Stryker's timeout.
  // The default (5 s over 1.5 times the dry run) counted slow runs on a busy
  // machine as detected: measured, string-literal mutants "timed out".
  timeoutMS: 60_000,
  tsconfigFile: "stryker-has-no-tsconfig.json",
  tempDirName: "../../.stryker-tmp",
};
