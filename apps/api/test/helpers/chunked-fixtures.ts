// What test/setup/chunked-import-fixtures.ts (Node, before the workerd
// suites) hands the chunked upload and import tests. Bytes are hex. No Node
// or workerd imports.

/** One request to git's upload-pack and its answer. */
export interface RecordedExchange {
  readonly method: "GET" | "POST";
  readonly request: string;
  readonly response: string;
}

export interface ChunkedFixtures {
  /** A commit with one incompressible 5.5 MiB file. */
  readonly bigCommit: string;
  /** Its pack, as `git push` would send it (a little over 5.5 MiB). */
  readonly bigPack: string;
  readonly source: {
    /** The import client's exchange with upload-pack: advertisement, ls-refs, fetch. */
    readonly exchanges: readonly RecordedExchange[];
    /** The source's branches and tags with UTF-8 names (`refs/heads/café` in Latin-1 is not one). */
    readonly refs: Readonly<Record<string, string>>;
    /** Where the source's HEAD points. */
    readonly head: string;
  };
  /** A source with one branch, `main`: a 6 MiB incompressible file, then a delta appending to it. */
  readonly largeSource: {
    readonly exchanges: readonly RecordedExchange[];
    readonly main: string;
  };
}

declare module "vitest" {
  export interface ProvidedContext {
    chunkedFixtures: ChunkedFixtures;
  }
}
