/** What `git blame --line-porcelain` says of one line. */
export interface GitBlameLine {
  readonly commit: string;
  /** The line's number in that commit's file, 1-based. */
  readonly line: number;
  readonly summary: string;
  readonly name: string;
  readonly email: string;
  /** The author time, seconds since the epoch. */
  readonly time: number;
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
}

declare module "vitest" {
  export interface ProvidedContext {
    blameFixtures: BlameFixtures;
  }
}

/** The paths the fixtures record blames for. */
export const BLAME_PATHS = ["f.txt", "link", "dir/inner.txt", "o16.txt", "big.txt"] as const;
