// What the garbage-collection fixtures (test/setup/gc-fixtures.ts, run by
// Node before the workerd suites) hand the tests: a repository git built and
// packed, and what git says is reachable after each step of a scenario.
// Ids and packs are hex. No Node or workerd imports.
import type { FetchFixtureRepo } from "./fetch-fixtures.js";

/**
 * History: main (several commits, annotated tag v1 on main~1), `side`
 * branched from main~2 with two commits of its own, `feature` with f1 and
 * f2 on main, and `rewritten` (f1', a rewrite of f1) that no ref names.
 * One pack holds every object, `rewritten` included.
 */
export interface GcFixtures {
  /** Packs, commits and refs (main, side, feature, tags/v1) as the fetch fixtures shape them. */
  readonly repo: FetchFixtureRepo;
  /** The same objects stored as three packs (old history, newer history, the rest). */
  readonly packs: readonly string[];
  readonly side: string;
  readonly f2: string;
  readonly rewritten: string;
  /** Every object in the pack, sorted. */
  readonly all: readonly string[];
  /** `git rev-list --objects` of every ref but `side`, sorted. */
  readonly withoutSide: readonly string[];
  /** The same after `feature` is force-pushed to `rewritten`, sorted. */
  readonly afterForce: readonly string[];
}

declare module "vitest" {
  export interface ProvidedContext {
    gcFixtures: GcFixtures;
  }
}
