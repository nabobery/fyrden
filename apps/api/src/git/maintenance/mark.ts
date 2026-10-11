import type { RepoGitStorage } from "@fyrden/adapters-cloudflare/git";
import {
  BitSet,
  type BlockCache,
  type MarkOutside,
  ObjectMark,
  type ObjectReader,
  type PackId,
} from "@fyrden/git-core";
import type { MaintenancePolicy } from "./policy.js";
import {
  type CallCounter,
  deleteScratch,
  getScratch,
  type LoadedPack,
  LoadedPacks,
  openReader,
  putScratch,
} from "./storage.js";

/*
 * A reachability mark run across alarm slices: the mark's state (one bit
 * per object of each marked pack, and the walk's stack) is saved to a
 * numbered scratch object at the end of each slice, so a reset that loses
 * the job's cursor still finds the checkpoint the cursor names.
 */

export interface MarkContext {
  readonly git: RepoGitStorage;
  readonly policy: MaintenancePolicy;
  readonly runId: string;
  readonly counter: CallCounter;
  readonly blocks?: BlockCache;
  readonly deadline: number;
}

/** Objects walked between budget checks. */
const STEP_OBJECTS = 512;

export const markName = (prefix: string, seq: number) => `${prefix}-${seq}`;

export class MarkSession {
  readonly #context: MarkContext;
  readonly #sources: LoadedPacks;
  readonly #readerPacks: LoadedPacks | undefined;
  readonly #reader: ObjectReader;
  #mark: ObjectMark;

  private constructor(
    context: MarkContext,
    sources: LoadedPacks,
    readerPacks: LoadedPacks | undefined,
    reader: ObjectReader,
    mark: ObjectMark,
  ) {
    this.#context = context;
    this.#sources = sources;
    this.#readerPacks = readerPacks;
    this.#reader = reader;
    this.#mark = mark;
  }

  /**
   * Opens a mark over `sources`: new (`from` absent), or from the scratch
   * checkpoint `from`. Objects are read from `readerPacks` (default: the
   * sources).
   */
  static async open(
    context: MarkContext,
    sources: readonly PackId[],
    options: {
      readonly outside: MarkOutside;
      readonly readerPacks?: readonly PackId[];
      readonly from?: string;
    },
  ): Promise<MarkSession> {
    const { git, counter } = context;
    const loaded = await LoadedPacks.load(git, sources, counter);
    let readerPacks: LoadedPacks | undefined;
    try {
      // Packs already loaded as sources are not loaded twice.
      const extra = (options.readerPacks ?? []).filter((id) => !sources.includes(id));
      readerPacks = extra.length > 0 ? await LoadedPacks.load(git, extra, counter) : undefined;
      const byId = new Map<string, LoadedPack>(
        [...loaded.packs, ...(readerPacks?.packs ?? [])].map((p) => [p.packId, p]),
      );
      const viewPacks = (options.readerPacks ?? sources).map((id) => byId.get(id) as LoadedPack);
      const reader = await openReader(git, viewPacks, counter, context.blocks);
      const markOptions = {
        sources: loaded.packs.map((p) => ({ packId: p.packId, idx: p.idx })),
        reader,
        commits: git.commitGraph,
        outside: options.outside,
      };
      const mark =
        options.from === undefined
          ? ObjectMark.start(markOptions)
          : ObjectMark.resume(
              markOptions,
              await getScratch(git, context.runId, options.from, counter),
            );
      return new MarkSession(context, loaded, readerPacks, reader, mark);
    } catch (error) {
      loaded.release();
      readerPacks?.release();
      throw error;
    }
  }

  get mark(): ObjectMark {
    return this.#mark;
  }

  get bits(): readonly BitSet[] {
    return this.#mark.bits;
  }

  get sources(): readonly LoadedPack[] {
    return this.#sources.packs;
  }

  /** Walks until nothing is left (true) or the slice's budget is spent (false). */
  async run(limit = Number.POSITIVE_INFINITY): Promise<boolean> {
    const { git, policy, counter, deadline } = this.#context;
    const most = Math.min(limit, policy.sliceObjects);
    let walked = 0;
    for (;;) {
      const step = Math.max(1, Math.min(STEP_OBJECTS, most - walked));
      if (await this.#mark.run(step)) return true;
      walked += step;
      if (walked >= most || git.context.now() >= deadline || counter.calls >= policy.sliceR2Calls)
        return false;
    }
  }

  /** Saves the mark as scratch object `name`. */
  async save(name: string): Promise<void> {
    await putScratch(
      this.#context.git,
      this.#context.runId,
      name,
      this.#mark.checkpoint(),
      this.#context.counter,
    );
  }

  /**
   * Deletes a checkpoint no cursor can name any more: the one before the
   * cursor's (a reset that loses the newest cursor falls back to the
   * cursor's own checkpoint, never further).
   */
  async dropCheckpoint(name: string | undefined): Promise<void> {
    if (name !== undefined) await deleteScratch(this.#context.git, this.#context.runId, [name]);
  }

  release(): void {
    this.#reader.release();
    this.#sources.release();
    this.#readerPacks?.release();
  }
}

/** Bit sets as one scratch object: per set, its size (4 bytes) and its bytes. */
export function encodeBitSets(sets: readonly BitSet[]): Uint8Array {
  const parts = sets.map((b) => b.toBytes());
  const out = new Uint8Array(parts.reduce((n, p) => n + 4 + p.length, 0));
  const view = new DataView(out.buffer);
  let at = 0;
  sets.forEach((set, i) => {
    view.setUint32(at, set.size);
    out.set(parts[i] as Uint8Array, at + 4);
    at += 4 + (parts[i] as Uint8Array).length;
  });
  return out;
}

export function decodeBitSets(bytes: Uint8Array, sizes: readonly number[]): BitSet[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: BitSet[] = [];
  let at = 0;
  for (const size of sizes) {
    if (at + 4 > bytes.length || view.getUint32(at) !== size)
      throw new Error("saved marks do not fit their packs");
    const length = 4 * Math.ceil(size / 32);
    out.push(BitSet.fromBytes(size, bytes.subarray(at + 4, at + 4 + length)));
    at += 4 + length;
  }
  if (at !== bytes.length) throw new Error("saved marks do not fit their packs");
  return out;
}
