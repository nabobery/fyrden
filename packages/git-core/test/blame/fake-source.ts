import { createHash } from "node:crypto";
import type { BlameCommitInfo, BlameSource } from "../../src/blame/walk.js";
import type { Oid } from "../../src/object/oid.js";
import { oidFromHex, oidToHex } from "../../src/object/oid.js";

/** One commit of a made-up history: its parents by name, and the file at the path, or none. */
export interface FakeCommit {
  readonly parents?: readonly string[];
  /** The file's text, or absent. */
  readonly file?: string;
  readonly kind?: "file" | "symlink";
  /** Parents past the limit, none materialized. */
  readonly tooManyParents?: boolean;
}

export const oidOfName = (name: string): Oid =>
  oidFromHex(createHash("sha1").update(`commit ${name}`).digest("hex"));
const blobOid = (text: string): Oid =>
  oidFromHex(createHash("sha1").update(`blob ${text}`).digest("hex"));

export const PATH = [new TextEncoder().encode("f")];

/**
 * A history in memory, as the engine sees one. Generations follow from the
 * parents. `failOn` throws from a read, the way a source does when a limit or
 * a failure stops it.
 */
export class FakeSource implements BlameSource {
  readonly names = new Map<string, string>();
  readonly #commits = new Map<string, FakeCommit & { generation: number; tree: Oid }>();
  readonly #blobs = new Map<string, string>();
  readonly #trees = new Map<string, FakeCommit>();
  /** Blobs read, in order, by text. */
  readonly blobReads: string[] = [];
  readonly factsRead: string[] = [];
  /** Called before each read, with what's being read. */
  failOn: (what: string) => void = () => {};
  maxBlobBytes = Number.POSITIVE_INFINITY;

  constructor(history: Readonly<Record<string, FakeCommit>>) {
    const generationOf = (name: string): number => {
      const commit = history[name];
      if (!commit) return 0;
      const parents = commit.parents ?? [];
      return 1 + Math.max(0, ...parents.map(generationOf));
    };
    for (const [name, commit] of Object.entries(history)) {
      const oid = oidOfName(name);
      this.names.set(oidToHex(oid), name);
      const tree = oidOfName(`tree of ${name}`);
      this.#trees.set(oidToHex(tree), commit);
      this.#commits.set(oidToHex(oid), { ...commit, generation: generationOf(name), tree });
      if (commit.file !== undefined) this.#blobs.set(oidToHex(blobOid(commit.file)), commit.file);
    }
    for (const commit of Object.values(history)) {
      for (const parent of commit.parents ?? [])
        this.names.set(oidToHex(oidOfName(parent)), parent);
    }
  }

  async commit(oid: Oid) {
    this.failOn(`commit ${this.names.get(oidToHex(oid))}`);
    const commit = this.#commits.get(oidToHex(oid));
    if (!commit) return undefined;
    return {
      tree: commit.tree,
      parents: commit.tooManyParents
        ? ("too_many" as const)
        : (commit.parents ?? []).map(oidOfName),
      generation: commit.generation,
      level: commit.generation,
    };
  }

  async fileAt(tree: Oid) {
    const commit = this.#trees.get(oidToHex(tree));
    this.failOn("tree");
    if (commit?.file === undefined) return null;
    return { oid: blobOid(commit.file), kind: commit.kind ?? ("file" as const) };
  }

  async blob(oid: Oid, maxBytes: number) {
    const text = this.#blobs.get(oidToHex(oid)) as string;
    this.failOn(`blob ${text}`);
    if (text.length > Math.min(maxBytes, this.maxBlobBytes)) return "too_large" as const;
    this.blobReads.push(text);
    return new Uint8Array(Buffer.from(text, "latin1"));
  }

  async commitInfo(oid: Oid): Promise<BlameCommitInfo> {
    const name = this.names.get(oidToHex(oid)) as string;
    this.failOn(`info ${name}`);
    this.factsRead.push(name);
    return { summary: `made ${name}`, name, email: `${name}@test`, date: "2026-01-01T00:00:00Z" };
  }
}
