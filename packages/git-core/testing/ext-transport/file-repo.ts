import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { concatBytes } from "../../src/object/bytes.js";
import { type Oid, oidEquals, oidFromHex, oidToHex } from "../../src/object/oid.js";
import { PackIdx } from "../../src/pack/idx-read.js";
import type {
  CommitGraph,
  CommitGraphEntry,
  CommitGraphRow,
} from "../../src/ports/commit-graph.js";
import {
  asPackId,
  type PackId,
  type PackInfo,
  type PackStore,
  type PackWriter,
} from "../../src/ports/pack-store.js";
import type {
  RefCommitRequest,
  RefCommitResult,
  RefSnapshot,
  RefStore,
} from "../../src/ports/ref-store.js";
import type { RepoView } from "../../src/reader/view.js";

/*
 * A repository kept in a directory, for the git `ext::` test transport:
 * each `git push` starts a new process, so the port implementations load
 * their state from disk and save it before the process exits. Packs and
 * `.idx` files are files; refs, the live pack list, verified commit-graph
 * rows and a log of pushes are one JSON file. Pending commit rows live only
 * in the process of their upload, as they never outlive one push.
 */

interface RowJson {
  oid: string;
  tree: string;
  parents: string[];
  commitTime: number;
  generation: number;
  level: number;
}

export interface PushLogEntry {
  readonly uploadId: string;
  /** Push options, as latin1 text. */
  readonly pushOptions: string[];
  readonly applied: { name: string; oldOid: string | null; newOid: string | null }[];
}

interface StateJson {
  version: number;
  head: string | null;
  refs: Record<string, string>;
  live: string[];
  nextPack: number;
  commits: RowJson[];
  pushes: PushLogEntry[];
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const STATE = "state.json";

function packIdFor(n: number): PackId {
  let text = "";
  for (let i = 0, k = n; i < 26; i++, k = Math.floor(k / 32)) text = CROCKFORD[k % 32] + text;
  return asPackId(text);
}

export class FileRepo {
  readonly dir: string;
  readonly #state: StateJson;
  readonly #pending = new Map<string, Map<string, CommitGraphRow>>();
  readonly #finished = new Map<PackId, number>();
  readonly packStore: PackStore;
  readonly refStore: RefStore;
  readonly commitGraph: CommitGraph & { promote(uploadId: string): Promise<void> };

  private constructor(dir: string, state: StateJson) {
    this.dir = dir;
    this.#state = state;
    this.packStore = this.#makePackStore();
    this.refStore = this.#makeRefStore();
    this.commitGraph = this.#makeCommitGraph();
  }

  /** Opens (or creates, empty, with HEAD at refs/heads/main) the repository in `dir`. */
  static async open(dir: string): Promise<FileRepo> {
    await mkdir(join(dir, "packs"), { recursive: true });
    let state: StateJson;
    try {
      state = JSON.parse(await readFile(join(dir, STATE), "utf8")) as StateJson;
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") throw error;
      state = {
        version: 0,
        head: "refs/heads/main",
        refs: {},
        live: [],
        nextPack: 0,
        commits: [],
        pushes: [],
      };
    }
    return new FileRepo(dir, state);
  }

  async save(): Promise<void> {
    await writeFile(join(this.dir, STATE), JSON.stringify(this.#state, null, 1));
  }

  get livePacks(): readonly PackId[] {
    return this.#state.live.map(asPackId);
  }

  get pushes(): readonly PushLogEntry[] {
    return this.#state.pushes;
  }

  logPush(entry: PushLogEntry): void {
    this.#state.pushes.push(entry);
  }

  packPath(packId: PackId, ext: "pack" | "idx"): string {
    return join(this.dir, "packs", `${packId}.${ext}`);
  }

  async storeIdx(packId: PackId, bytes: Uint8Array): Promise<void> {
    await writeFile(this.packPath(packId, "idx"), bytes);
  }

  async loadIdx(packId: PackId): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.packPath(packId, "idx")));
  }

  /** Removes a pack that never went live. */
  async discard(packId: PackId): Promise<void> {
    if (this.#state.live.includes(packId)) throw new Error(`pack ${packId} is live`);
    await rm(this.packPath(packId, "pack"), { force: true });
    await rm(this.packPath(packId, "idx"), { force: true });
  }

  /** The live packs, newest first, as a reader view. */
  async view(): Promise<RepoView> {
    const packs = [];
    for (const packId of [...this.livePacks].reverse()) {
      const bytes = (await readFile(this.packPath(packId, "pack"))).length;
      packs.push({ packId, bytes, idx: PackIdx.parse(await this.loadIdx(packId)) });
    }
    return { scope: "test-network", packs };
  }

  async readPack(packId: PackId): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.packPath(packId, "pack")));
  }

  #makePackStore(): PackStore {
    return {
      listPacks: async () =>
        Promise.all(
          this.livePacks.map(
            async (packId): Promise<PackInfo> => ({
              packId,
              bytes: (await readFile(this.packPath(packId, "pack"))).length,
            }),
          ),
        ),
      beginPack: (): PackWriter => {
        const packId = packIdFor(++this.#state.nextPack);
        const chunks: Uint8Array[] = [];
        let state: "open" | "finished" | "aborted" = "open";
        return {
          packId,
          write: async (chunk) => {
            if (state !== "open") throw new Error(`pack ${packId} is ${state}`);
            chunks.push(chunk.slice());
          },
          finish: async () => {
            if (state !== "open") throw new Error(`pack ${packId} is ${state}`);
            state = "finished";
            const bytes = concatBytes(chunks);
            await writeFile(this.packPath(packId, "pack"), bytes);
            this.#finished.set(packId, bytes.length);
            return { packId, bytes: bytes.length };
          },
          abort: async () => {
            if (state === "finished") throw new Error(`pack ${packId} is finished`);
            state = "aborted";
          },
        };
      },
      openRange: async (packId, offset, length) => {
        const bytes = new Uint8Array(await readFile(this.packPath(packId, "pack")));
        if (offset < 0 || length < 0 || offset + length > bytes.length) {
          throw new RangeError(`range ${offset}+${length} is outside pack ${packId}`);
        }
        return bytes.subarray(offset, offset + length);
      },
    };
  }

  #makeRefStore(): RefStore {
    const state = this.#state;
    return {
      readRefs: async (): Promise<RefSnapshot> => ({
        version: state.version,
        refs: new Map(Object.entries(state.refs).map(([name, hex]) => [name, oidFromHex(hex)])),
        head: state.head,
      }),
      readReflog: async () => [],
      commit: async (request: RefCommitRequest): Promise<RefCommitResult> => {
        if (request.expectedVersion !== state.version) {
          return { ok: false, reason: "version-conflict", version: state.version };
        }
        for (const { name, oldOid } of request.refUpdates) {
          const hex = state.refs[name];
          const current = hex === undefined ? null : oidFromHex(hex);
          const same =
            current === null || oldOid === null ? current === oldOid : oidEquals(current, oldOid);
          if (!same) return { ok: false, reason: "ref-conflict", ref: name };
        }
        for (const packId of request.addPacks) {
          if (!this.#finished.has(packId) || state.live.includes(packId)) {
            return { ok: false, reason: "unknown-pack", packId };
          }
        }
        state.version++;
        for (const { name, newOid } of request.refUpdates) {
          if (newOid) state.refs[name] = oidToHex(newOid);
          else delete state.refs[name];
        }
        state.live.push(...request.addPacks);
        return { ok: true, version: state.version };
      },
    };
  }

  #makeCommitGraph(): CommitGraph & { promote(uploadId: string): Promise<void> } {
    const state = this.#state;
    const verified = new Map<string, RowJson>(state.commits.map((row) => [row.oid, row]));
    const toRow = (row: RowJson): CommitGraphRow => ({
      oid: oidFromHex(row.oid),
      tree: oidFromHex(row.tree),
      parents: row.parents.map(oidFromHex),
      commitTime: row.commitTime,
      generation: row.generation,
      level: row.level,
    });
    const toJson = (row: CommitGraphRow): RowJson => ({
      oid: oidToHex(row.oid),
      tree: oidToHex(row.tree),
      parents: row.parents.map((p) => oidToHex(p as Oid)),
      commitTime: row.commitTime,
      generation: row.generation,
      level: row.level,
    });
    return {
      read: async (oids, view) => {
        const own = view === "verified" ? undefined : this.#pending.get(view.uploadId);
        return oids.map((oid): CommitGraphEntry | undefined => {
          const key = oidToHex(oid);
          const v = verified.get(key);
          if (v) return { ...toRow(v), state: "verified" };
          const p = own?.get(key);
          return p && { ...p, state: "pending" };
        });
      },
      insertPending: async (uploadId, rows) => {
        const own = this.#pending.get(uploadId) ?? new Map<string, CommitGraphRow>();
        this.#pending.set(uploadId, own);
        for (const row of rows) {
          const key = oidToHex(row.oid);
          if (!verified.has(key)) own.set(key, row);
        }
      },
      discardPending: async (uploadId) => {
        this.#pending.delete(uploadId);
      },
      promote: async (uploadId) => {
        for (const [key, row] of this.#pending.get(uploadId) ?? []) {
          if (verified.has(key)) continue;
          const json = toJson(row);
          verified.set(key, json);
          state.commits.push(json);
        }
        this.#pending.delete(uploadId);
      },
    };
  }
}
