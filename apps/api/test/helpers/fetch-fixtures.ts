// What the fetch fixtures (test/setup/fetch-fixtures.ts, run by Node before
// the workerd suites) hand the fetch tests: repositories built by real git,
// stored as git packed them, and what git itself says a client should get.
// Binary values travel as hex. Shared by both sides; no Node or workerd imports.

export interface FixtureCommit {
  readonly oid: string;
  readonly tree: string;
  readonly parents: readonly string[];
  readonly time: number;
}

export interface FetchFixtureRepo {
  /** The packs git wrote, in the order they were written (oldest first). */
  readonly packs: readonly string[];
  readonly commits: readonly FixtureCommit[];
  /** Every ref but HEAD. */
  readonly refs: readonly { readonly name: string; readonly oid: string }[];
  readonly head: string;
  /** `git rev-list --objects --all`, sorted. */
  readonly objects: readonly string[];
}

export interface FetchFixtures {
  /** One commit with an incompressible 300 KB file: a pack of several side-band packets. */
  readonly large: FetchFixtureRepo;
  /** Two branches, an annotated and a lightweight tag, one pack. */
  readonly single: FetchFixtureRepo;
  /** The same history stored as two packs (`git repack -d` twice). */
  readonly split: FetchFixtureRepo;
  /** `main~1`, a commit the incremental fetch claims to have. */
  readonly have: string;
  /** `git rev-list --objects main ^main~1`, sorted. */
  readonly sinceHave: readonly string[];
  /** `git rev-list --objects --no-walk main`: a depth-1 clone of main, sorted. */
  readonly depthOne: readonly string[];
  /**
   * A history where the newest commit changes a few lines of a large file,
   * stored by git as a delta against the previous version: what a thin
   * fetch from `thinHave` can send as a delta against a base the client has.
   */
  readonly thin: FetchFixtureRepo;
  readonly thinHave: string;
  /** `git rev-list --objects main ^thinHave`, sorted. */
  readonly thinSince: readonly string[];
}

declare module "vitest" {
  export interface ProvidedContext {
    fetchFixtures: FetchFixtures;
  }
}
