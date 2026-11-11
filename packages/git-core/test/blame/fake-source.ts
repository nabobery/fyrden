import { createHash } from "node:crypto";
import type { BlameCommitInfo, BlameSource } from "../../src/blame/walk.js";
import type { Oid } from "../../src/object/oid.js";
import { oidFromHex, oidToHex } from "../../src/object/oid.js";
import { encodeTree, FILE_MODES, type TreeEntry } from "../../src/object/tree.js";

/** One commit of a made-up history: its parents by name, and the file at the path, or none. */
export interface FakeCommit {
  readonly parents?: readonly string[];
  /** The file's text, or absent. */
  readonly file?: string;
  readonly kind?: "file" | "symlink";
  /** Parents past the limit, none materialized. */
  readonly tooManyParents?: boolean;
  /**
   * Other paths in the commit's tree, by `/`-separated path, and their text. A text that
   * starts `120000 ` is a symlink's. A path under `f/` makes `f` a directory.
   */
  readonly others?: Readonly<Record<string, string>>;
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
  /** Every tree object's body, by hex id: roots and directories. */
  readonly #treeBodies = new Map<string, Uint8Array>();
  /** Tree bodies read through `tree`, in order, by size. */
  readonly treeReads: number[] = [];
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
      const tree = this.#buildTree(commit);
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

  /** The commit's tree as git would write it, `f` included: its directories are trees too. */
  #buildTree(commit: FakeCommit): Oid {
    const files: [string, number, string][] = [];
    if (commit.file !== undefined)
      files.push([
        "f",
        commit.kind === "symlink" ? FILE_MODES.symlink : FILE_MODES.file,
        commit.file,
      ]);
    for (const [path, text] of Object.entries(commit.others ?? {})) {
      const symlink = text.startsWith("120000 ");
      files.push([
        path,
        symlink ? FILE_MODES.symlink : FILE_MODES.file,
        symlink ? text.slice(7) : text,
      ]);
    }
    const write = (prefix: string): Oid => {
      const entries: TreeEntry[] = [];
      const dirs = new Set<string>();
      for (const [path, mode, text] of files) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        const slash = rest.indexOf("/");
        if (slash >= 0) {
          dirs.add(rest.slice(0, slash));
          continue;
        }
        const oid = blobOid(text);
        this.#blobs.set(oidToHex(oid), text);
        entries.push({ mode, name: new TextEncoder().encode(rest), oid });
      }
      for (const dir of dirs) {
        entries.push({
          mode: FILE_MODES.tree,
          name: new TextEncoder().encode(dir),
          oid: write(`${prefix}${dir}/`),
        });
      }
      const body = encodeTree(entries);
      const oid = oidFromHex(createHash("sha1").update("tree ").update(body).digest("hex"));
      this.#treeBodies.set(oidToHex(oid), body);
      return oid;
    };
    return write("");
  }

  /** The tree of the commit by this name. */
  treeOf(name: string): Oid {
    return this.#commits.get(oidToHex(oidOfName(name)))?.tree as Oid;
  }

  async tree(oid: Oid, maxBytes: number) {
    this.failOn("tree body");
    const body = this.#treeBodies.get(oidToHex(oid));
    if (!body) throw new Error("a tree is missing");
    if (body.length > maxBytes) return "too_large" as const;
    this.treeReads.push(body.length);
    return body;
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
