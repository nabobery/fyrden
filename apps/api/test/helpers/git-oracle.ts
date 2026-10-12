// What the git oracle (test/setup/git-oracle.ts, run by Node before the
// workerd suites) hands the tests: a repository's pack, refs and commits,
// and the bytes real git writes for each advertisement and ls-refs request.
// Binary values travel as hex. Shared by both sides; no Node or workerd imports.

/** ls-refs argument lists the oracle answers, by name. */
export const LS_REFS_VARIANTS = {
  /** What `git ls-remote` and `git fetch` send. */
  lsRemote: ["symrefs", "peel", "unborn"],
  none: [],
  peelTags: ["peel", "ref-prefix refs/tags/"],
  headAndMa: ["symrefs", "ref-prefix HEAD", "ref-prefix refs/heads/ma"],
  unicode: ["peel", "ref-prefix refs/heads/x"],
  prefixesOverlap: ["ref-prefix refs/", "ref-prefix refs/heads/", "ref-prefix refs/tags/v1"],
  unbornOnly: ["unborn"],
} as const satisfies Record<string, readonly string[]>;

export type LsRefsVariant = keyof typeof LS_REFS_VARIANTS;

export interface OracleRepo {
  /** `git repack -adf` output: every object of the repository. */
  readonly packHex: string;
  /** Every ref but HEAD, as `git for-each-ref` lists it. */
  readonly refs: readonly { readonly name: string; readonly oid: string }[];
  readonly head: string;
  /** Root commits, for the commit graph (others are left to the object reader). */
  readonly rootCommits: readonly {
    readonly oid: string;
    readonly tree: string;
    readonly time: number;
  }[];
  /** `git upload-pack --stateless-rpc` answers to each ls-refs request. */
  readonly lsRefs: Readonly<Record<LsRefsVariant, string>>;
  /** `git receive-pack --advertise-refs`, protocol v0 and v1. */
  readonly receivePackV0: string;
  readonly receivePackV1: string;
}

export interface GitOracle {
  /** e.g. `git/2.53.0` (the agent git advertises, to replace with Fyrden's). */
  readonly gitAgent: string;
  /** `GIT_PROTOCOL=version=2 git upload-pack --advertise-refs --stateless-rpc`. */
  readonly uploadPackV2: string;
  readonly full: OracleRepo;
  readonly empty: OracleRepo;
}

declare module "vitest" {
  export interface ProvidedContext {
    gitOracle: GitOracle;
  }
}

export const fromHex = (hex: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(hex.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));

export const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** Text of pkt-line bytes, for readable assertion diffs. */
export const asText = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
