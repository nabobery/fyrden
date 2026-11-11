import { type ChildProcess, spawn } from "node:child_process";
import {
  type BlameCommitInfo,
  BlameObjectUnreadable,
  type BlameSource,
} from "../../src/blame/walk.js";
import { parseCommit } from "../../src/object/commit.js";
import { GitObjectError } from "../../src/object/fsck.js";
import { type Oid, oidFromHex, oidToHex } from "../../src/object/oid.js";
import { isTreeMode, treeEntries } from "../../src/object/tree.js";
import { gitBinary } from "../../testing/git-cli.js";

const SYMLINK_MODE = 0o120000;
const GITLINK_MODE = 0o160000;

/** One request at a time to a long-running `git cat-file --batch`, or `--batch-check` for headers only. */
class CatFile {
  readonly #headersOnly: boolean;
  readonly #child: ChildProcess;
  #buffered: Buffer = Buffer.alloc(0);
  #wake: (() => void) | undefined;
  #closed = false;
  #tail: Promise<unknown> = Promise.resolve();
  /** Bodies read so far. */
  bodies = 0;

  constructor(dir: string, env: NodeJS.ProcessEnv, headersOnly = false) {
    this.#headersOnly = headersOnly;
    const mode = headersOnly ? "--batch-check" : "--batch";
    this.#child = spawn(gitBinary, ["cat-file", mode], { cwd: dir, env, stdio: "pipe" });
    this.#child.stdout?.on("data", (chunk: Buffer) => {
      this.#buffered = this.#buffered.length === 0 ? chunk : Buffer.concat([this.#buffered, chunk]);
      this.#wake?.();
    });
    this.#child.on("close", () => {
      this.#closed = true;
      this.#wake?.();
    });
  }

  async #need(ready: () => boolean): Promise<void> {
    while (!ready()) {
      if (this.#closed) throw new Error("git cat-file stopped");
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
    }
  }

  /** The object's type and size, and its bytes unless this process reads headers only. */
  read(hex: string): Promise<{ type: string; size: number; bytes: Uint8Array } | undefined> {
    const job = this.#tail.then(async () => {
      this.#child.stdin?.write(`${hex}\n`);
      await this.#need(() => this.#buffered.includes(10));
      const end = this.#buffered.indexOf(10);
      const header = this.#buffered.subarray(0, end).toString("latin1").split(" ");
      this.#buffered = this.#buffered.subarray(end + 1);
      if (header[1] === "missing") return undefined;
      const size = Number(header[2]);
      if (this.#headersOnly) return { type: header[1] as string, size, bytes: new Uint8Array(0) };
      this.bodies++;
      await this.#need(() => this.#buffered.length >= size + 1);
      const bytes = new Uint8Array(this.#buffered.subarray(0, size));
      this.#buffered = this.#buffered.subarray(size + 1);
      return { type: header[1] as string, size, bytes };
    });
    this.#tail = job.catch(() => undefined);
    return job;
  }

  close(): void {
    this.#child.stdin?.end();
    this.#child.kill();
  }
}

interface GraphRow {
  readonly tree: Oid;
  readonly parents: readonly Oid[];
  readonly generation: number;
}

/**
 * The engine's source over a real repository: commit rows from `git log`,
 * with generations computed as the commit graph has them, and objects from
 * `git cat-file`. Prints nothing of what it reads.
 */
export class GitBlameSource implements BlameSource {
  readonly #objects: CatFile;
  readonly #headers: CatFile;
  readonly #rows: Map<string, GraphRow>;
  readonly #trees = new Map<string, Uint8Array>();
  readonly maxParents: number;

  private constructor(
    objects: CatFile,
    headers: CatFile,
    rows: Map<string, GraphRow>,
    maxParents: number,
  ) {
    this.#objects = objects;
    this.#headers = headers;
    this.#rows = rows;
    this.maxParents = maxParents;
  }

  /** `log` lines of `tree parent...` per commit, for a tip's whole ancestry. */
  static async open(
    dir: string,
    env: NodeJS.ProcessEnv,
    tip: string,
    maxParents = 16,
  ): Promise<GitBlameSource> {
    const log = spawn(gitBinary, ["log", "--format=%H %T %P", "--topo-order", tip], {
      cwd: dir,
      env,
      stdio: ["ignore", "pipe", "inherit"],
    });
    let text = "";
    log.stdout.setEncoding("latin1");
    const exited = new Promise<number | null>((resolve) => log.on("close", resolve));
    for await (const chunk of log.stdout) text += chunk;
    const code = await exited;
    if (code !== 0) throw new Error(`git log of ${tip} failed: ${String(code)}`);
    const rows = new Map<
      string,
      { tree: Oid; parents: Oid[]; parentHex: string[]; generation: number }
    >();
    const lines = text.split("\n").filter((line) => line.length > 0);
    // Children come first in this order, so ancestors are resolved from the end.
    for (let k = lines.length - 1; k >= 0; k--) {
      // A root commit's line ends in a space: no parents, not an empty one.
      const [hex, tree, ...listed] = (lines[k] as string).split(" ");
      const parents = listed.filter((parent) => parent.length > 0);
      const generation =
        1 + Math.max(0, ...parents.map((parent) => rows.get(parent)?.generation ?? 0));
      rows.set(hex as string, {
        tree: oidFromHex(tree as string),
        parents: parents.map(oidFromHex),
        parentHex: parents,
        generation,
      });
    }
    return new GitBlameSource(new CatFile(dir, env), new CatFile(dir, env, true), rows, maxParents);
  }

  close(): void {
    this.#objects.close();
    this.#headers.close();
  }

  /** Object bodies read from git so far. */
  get bodiesRead(): number {
    return this.#objects.bodies;
  }

  async commit(oid: Oid) {
    const row = this.#rows.get(oidToHex(oid));
    if (!row) return undefined;
    return {
      tree: row.tree,
      parents: row.parents.length > this.maxParents ? ("too_many" as const) : row.parents,
      generation: row.generation,
      level: row.generation,
    };
  }

  async #tree(oid: Oid): Promise<Uint8Array | undefined> {
    const hex = oidToHex(oid);
    const known = this.#trees.get(hex);
    if (known) return known;
    const object = await this.#objects.read(hex);
    if (object?.type !== "tree") return undefined;
    if (this.#trees.size > 4096) this.#trees.clear();
    this.#trees.set(hex, object.bytes);
    return object.bytes;
  }

  async fileAt(tree: Oid, path: readonly Uint8Array[]) {
    let current = tree;
    for (let depth = 0; depth < path.length; depth++) {
      const name = path[depth] as Uint8Array;
      const bytes = await this.#tree(current);
      if (!bytes) return null;
      let found: { mode: number; oid: Oid } | undefined;
      try {
        for (const entry of treeEntries(bytes)) {
          if (entry.name.length === name.length && entry.name.every((b, i) => b === name[i])) {
            found = { mode: entry.mode, oid: entry.oid.slice() as Oid };
            break;
          }
        }
      } catch (error) {
        if (error instanceof GitObjectError) return null;
        throw error;
      }
      if (!found) return null;
      if (depth === path.length - 1) {
        if (isTreeMode(found.mode) || found.mode === GITLINK_MODE) return null;
        return {
          oid: found.oid,
          kind: found.mode === SYMLINK_MODE ? ("symlink" as const) : ("file" as const),
        };
      }
      if (!isTreeMode(found.mode)) return null;
      current = found.oid;
    }
    return null;
  }

  /** As the port says: the type and size first, so a tree past `maxBytes` isn't fetched. */
  async tree(oid: Oid, maxBytes: number) {
    const known = this.#trees.get(oidToHex(oid));
    const header = known
      ? { type: "tree", size: known.length }
      : await this.#headers.read(oidToHex(oid));
    if (header?.type !== "tree")
      throw new BlameObjectUnreadable(`tree ${oidToHex(oid)} is missing or isn't a tree`);
    if (header.size > maxBytes) return "too_large" as const;
    return (await this.#tree(oid)) as Uint8Array;
  }

  async blob(oid: Oid, maxBytes: number) {
    const object = await this.#objects.read(oidToHex(oid));
    if (!object) throw new Error("a blob is missing");
    return object.bytes.length > maxBytes ? ("too_large" as const) : object.bytes;
  }

  async commitInfo(oid: Oid): Promise<BlameCommitInfo> {
    const object = await this.#objects.read(oidToHex(oid));
    if (!object) throw new Error("a commit is missing");
    parseCommit(object.bytes);
    return { summary: "", name: "", email: "", date: "" };
  }
}

/** One line of `git blame --line-porcelain`: its commit, source line, and the path it came from. */
export interface GitBlameLine {
  readonly commit: string;
  readonly line: number;
  /**
   * The path in that commit, its bytes one character each (latin1): git's quoting
   * undone. Compare it with `latin1Path`.
   */
  readonly filename: string;
  readonly summary: string;
}

/** What `git blame --line-porcelain` says of each line. */
export function parsePorcelain(output: string): GitBlameLine[] {
  const out: GitBlameLine[] = [];
  let current: { commit: string; line: number; filename: string; summary: string } | undefined;
  for (const line of output.split("\n")) {
    if (!current) {
      const match = /^([0-9a-f]{40}) (\d+) (\d+)/.exec(line);
      if (!match) continue;
      current = { commit: match[1] as string, line: Number(match[2]), filename: "", summary: "" };
    } else if (line.startsWith("\t")) {
      out.push(current);
      current = undefined;
    } else if (line.startsWith("filename ")) {
      current.filename = unquote(line.slice(9));
    } else if (line.startsWith("summary ")) {
      current.summary = line.slice(8);
    }
  }
  return out;
}

/** A path's UTF-8 bytes, one character each, as `GitBlameLine.filename` holds them. */
export const latin1Path = (path: string): string => Buffer.from(path, "utf8").toString("latin1");

const ESCAPES: Record<string, number> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  '"': 34,
  "\\": 92,
};

/**
 * A path as git quotes it when it has to (a control character, a quote, a
 * backslash, or a byte past ASCII): in double quotes, with C escapes and three
 * octal digits a byte. Answers its bytes, one character each; an unquoted path
 * is already that.
 */
export function unquote(text: string): string {
  if (!(text.length >= 2 && text.startsWith('"') && text.endsWith('"'))) return text;
  let out = "";
  for (let k = 1; k < text.length - 1; k++) {
    const c = text[k] as string;
    if (c !== "\\") {
      out += c;
      continue;
    }
    const next = text[++k] as string;
    if (/[0-7]/.test(next)) {
      out += String.fromCharCode(Number.parseInt(text.slice(k, k + 3), 8));
      k += 2;
    } else {
      const code = ESCAPES[next];
      if (code === undefined)
        throw new Error(`git quoted a path with an unknown escape: \\${next}`);
      out += String.fromCharCode(code);
    }
  }
  return out;
}
