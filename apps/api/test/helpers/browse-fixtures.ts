// What the browse fixtures (test/setup/browse-fixtures.ts, run by Node
// before the workerd suites) hand the tests: a repository real git built,
// its pack and refs, and what git itself answers about it. No Node or
// workerd imports.

/** One commit as `git log` prints it with the fields GitHub's API shows. */
export interface OracleCommit {
  readonly sha: string;
  readonly tree: string;
  readonly parents: readonly string[];
  readonly authorName: string;
  readonly authorEmail: string;
  /** Unix seconds. */
  readonly authorTime: number;
  readonly committerName: string;
  readonly committerEmail: string;
  readonly committerTime: number;
  readonly message: string;
}

export interface BrowseFixtures {
  /** Every object (`git pack-objects --all`), hex. */
  readonly packHex: string;
  /** A commit (branch `sibling`, from `main`) only a fork gets: not in `packHex`; its pack is thin on `main`. */
  readonly siblingCommit: string;
  readonly siblingPackHex: string;
  /** `main`'s first-parent commits, oldest first, each with a pack of what it adds. */
  readonly mainSteps: readonly { readonly commit: string; readonly packHex: string }[];
  /** Every ref but HEAD. */
  readonly refs: readonly { readonly name: string; readonly oid: string }[];
  /** Every commit by sha. */
  readonly commits: Readonly<Record<string, OracleCommit>>;
  /** `git log --format=%H <rev> [-- <path>]`, by `<rev>` or `<rev> -- <path>`. */
  readonly logs: Readonly<Record<string, readonly string[]>>;
  /** `git rev-list --count a..b`, by `a..b`. */
  readonly counts: Readonly<Record<string, number>>;
  /** `git merge-base a b`, by `a b`. */
  readonly mergeBases: Readonly<Record<string, string>>;
  /** `git rev-parse <rev>^{commit}`, by `<rev>`. */
  readonly revs: Readonly<Record<string, string>>;
}

declare module "vitest" {
  export interface ProvidedContext {
    browseFixtures: BrowseFixtures;
  }
}

/** The revisions and paths the fixtures record logs for. */
export const BROWSE_LOGS = {
  revs: ["main", "feature/ü-slash", "v1", "v1-light"],
  paths: ["README.md", "src", "src/lib/util.ts", "docs/ünï.md", "missing", "src/app.ts"],
} as const;

/** The `a..b` pairs the fixtures count, and the `a b` pairs they find merge bases for. */
export const BROWSE_PAIRS = [
  ["main", "feature/ü-slash"],
  ["feature/ü-slash", "main"],
  ["v1", "main"],
  ["main", "main"],
] as const;
