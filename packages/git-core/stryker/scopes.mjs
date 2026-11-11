// The mutation scopes: one directory under src/ each (or some of its files),
// the fast tests that run per mutant, and the score below which a run fails.
// stryker.config.mjs runs one of them; CI runs the ones a pull request changed
// (tools/ci/src/select-mutation.ts) and the nightly workflow runs them all.

const PUSH_FSCK = ["fsck.ts", "gitmodules.ts", "special-names.ts", "git-config.ts"];

/**
 * A scope mutates `src/<dir>` (default: the scope's name), or only `files`
 * there; `skip` leaves files of the directory to another scope.
 * @type {Record<string, { dir?: string; files?: string[]; skip?: string[]; tests: string[]; exclude?: string[]; break: number }>}
 */
export const SCOPES = {
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
  reader: { tests: ["test/reader/"], exclude: ["**/*.bench.test.ts"], break: 61 },
  blame: {
    tests: ["test/blame/"],
    exclude: ["**/*.git-oracle.test.ts", "**/*.fixtures.test.ts", "**/*.generate.test.ts"],
    break: 92,
  },
  diff: { tests: ["test/diff/"], exclude: ["**/*.git-oracle.test.ts"], break: 80 },
  merge: { tests: ["test/merge/"], exclude: ["**/*.git-oracle.test.ts"], break: 77 },
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
