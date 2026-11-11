/** What `git blame --line-porcelain` says of one line. */
export interface GitBlameLine {
  readonly commit: string;
  /** The line's number in that commit's file, 1-based. */
  readonly line: number;
  readonly summary: string;
  readonly name: string;
  readonly email: string;
  /** The author time, seconds since the epoch, as git prints it. */
  readonly time: string;
  /** The author's offset, as git prints it. */
  readonly tz: string;
  /** The path in that commit, as git prints it: another path when git followed a rename. */
  readonly filename: string;
}

/**
 * A history git built, packed as `git push` would send it, and what git
 * blame says of each path at its tip.
 */
export interface BlameFixtures {
  readonly pack: string;
  readonly tip: string;
  /** Commits by name, for the refusals the test expects. */
  readonly commits: Readonly<Record<string, string>>;
  /** Sizes of commit objects by name, for the 64 KiB boundary. */
  readonly sizes: Readonly<Record<string, number>>;
  readonly blames: Readonly<Record<string, readonly GitBlameLine[]>>;
  /** Each recorded path's blob at the tip, in hex. */
  readonly blobs: Readonly<Record<string, string>>;
  /** An annotated tag of the tip, named v1, in hex: pushed as refs/tags/v1 where a test needs it. */
  readonly tag: string;
}

declare module "vitest" {
  export interface ProvidedContext {
    blameFixtures: BlameFixtures;
  }
}

/** The paths the fixtures record blames for. */
export const BLAME_PATHS = [
  "f.txt",
  "link",
  "dir/inner.txt",
  "o16.txt",
  "big.txt",
  "block.txt",
  "legacydir/link",
  "facts.txt",
  "renamed.txt",
  "added.txt",
  "merged.txt",
] as const;
