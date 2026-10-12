import type { Interop } from "../harness.ts";

/** One case ported from git's own test suite (git.git `t/`). */
export interface InteropCase {
  /** The git test script it is ported from, e.g. "t5516-fetch-push.sh". */
  readonly from: string;
  /** The `test_expect_success` title in that script (git v2.53.0). */
  readonly test: string;
  /** What Fyrden is expected to do, when it is not simply "the same as git". */
  readonly note?: string;
  /** Part of the subset pull requests run. */
  readonly fast?: boolean;
  /** Oldest git release the case applies to (the feature it uses is newer). */
  readonly minGit?: string;
  run(t: Interop): Promise<void>;
}

/** Tests of a script that are deliberately not ported, and why. */
export interface NotPorted {
  readonly from: string;
  readonly tests: readonly string[];
  readonly reason: string;
}

export interface CaseFile {
  readonly cases: readonly InteropCase[];
  readonly notPorted: readonly NotPorted[];
}
