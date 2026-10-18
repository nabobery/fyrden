import { addPendingCommits } from "../graph/commit-graph.js";
import { MissingCommitError } from "../graph/errors.js";
import { OidTable } from "../graph/oid-table.js";
import { createSha1Hasher, Sha1CollisionError } from "../hash/sha1.js";
import { OBJECT_TYPES, type ObjectType } from "../object/object.js";
import { type Oid, oidToHex } from "../object/oid.js";
import { PackError } from "../pack/errors.js";
import { IdxError } from "../pack/idx-format.js";
import { PackIdx } from "../pack/idx-read.js";
import { writeIdx } from "../pack/idx-write.js";
import { DEFAULT_PACK_LIMITS, type PackLimits, parsePack } from "../pack/parse.js";
import { PackBuilder } from "../pack-write/pack-builder.js";
import type { BlockCache } from "../ports/block-cache.js";
import type { CommitGraph, CommitGraphEntry, CommitInfo } from "../ports/commit-graph.js";
import type { MemoryBudget } from "../ports/memory-budget.js";
import type { PackId, PackStore, PackWriter } from "../ports/pack-store.js";
import type { RefStore } from "../ports/ref-store.js";
import type { Zlib } from "../ports/zlib.js";
import { excerpt } from "../protocol/errors.js";
import { DEFAULT_READER_LIMITS, ObjectReader } from "../reader/object-reader.js";
import type { RepoView, ViewPack } from "../reader/view.js";
import { bodyChunks, type StoredBody } from "./body.js";
import { RepoClosure } from "./closure.js";
import type { PushPlan } from "./commands.js";
import {
  decodeCursor,
  encodeCursor,
  type IndexPhase,
  type IndexState,
  type UnpackFailure,
  type WrittenPack,
} from "./cursor.js";
import { PushFsck, PushFsckError, type PushFsckPolicy } from "./fsck.js";
import { LinkError, LinkTable } from "./links.js";
import { BodyRangeCache } from "./range-cache.js";
import { StepView } from "./step-view.js";

/*
 * Indexing a push, in phases that each end at a checkpoint:
 *
 *   parse       read the pack from the stored body once, copying it into
 *               the received pack; check every object (push fsck), collect
 *               new commits and links; resolve deltas, thin bases from the
 *               repository; write the `.idx`; check links into the pack
 *   completion  write the thin pack's external bases whole into a
 *               completion pack, so the pack unit is self-contained
 *   connect     check links out of the pack (commits against verified
 *               commit-graph rows, other objects by type in the
 *               repository's packs), pending `.gitmodules` blobs, ref tips;
 *               in slices that each stay within a store-call budget
 *   graph       insert the new commits as pending rows of this upload
 *
 * A phase interrupted by an eviction runs again from its start, using the
 * last checkpoint; the parse phase starts over from the body. Refs never
 * move here: the commit point comes after `done`.
 *
 * Existing objects come from the repository's packs. One found only in a
 * pack shared with the fork network (which may hold another member's
 * objects) is used, as a thin base, link target or ref tip, only once
 * `RepoClosure` proves it reachable from this repository's verified
 * commits or refs; otherwise it counts as absent, with the same message.
 */

export interface PushLimits {
  /** Limits of the pack parser (object size, count, delta depth). */
  readonly pack: Partial<PackLimits>;
  /** Sequential read size over the stored body. Proposed: 8 MiB. */
  readonly readBytes: number;
  /** Block size of the second pass's range cache. Proposed: 1 MiB. */
  readonly rangeBlockBytes: number;
  /** Blocks the range cache keeps. Proposed: 8. */
  readonly rangeBlocks: number;
  /** Most distinct objects new objects may link to. Proposed: 4,000,000. Fails closed. */
  readonly maxLinks: number;
  /** Most objects outside the pack the check may look up. Proposed: 200,000. Fails closed. */
  readonly maxExternalLookups: number;
  /**
   * Store calls (pack reads, and the `.idx` reads the indexes report)
   * after which a connect slice stops and checkpoints; the next slice goes
   * on. Proposed: 400, well below the 1,000 internal calls (R2 included) a
   * Free invocation may make (measured). A slice always checks
   * its first batch whole; after that, no `.idx` read starts that could
   * pass the limit and no header read starts at it, so a batch may end
   * part way. Reachability proofs for shared packs are bounded by
   * `closureReads` instead. The caller must also stop running slices in
   * one invocation once its calls near that limit.
   */
  readonly connectCalls: number;
  /** Links checked per batch of a connect slice. Proposed: 512. */
  readonly connectBatch: number;
  /**
   * Most trees and tags one reachability proof may read (objects found
   * only in shared packs). Proposed: 200, about 800 store calls. Fails
   * closed: what is not found counts as absent.
   */
  readonly closureReads: number;
}

export const DEFAULT_PUSH_LIMITS: PushLimits = Object.freeze({
  pack: {},
  readBytes: 8 * 1024 * 1024,
  rangeBlockBytes: 1024 * 1024,
  rangeBlocks: 8,
  maxLinks: 4_000_000,
  maxExternalLookups: 200_000,
  connectCalls: 400,
  connectBatch: 512,
  closureReads: 200,
});

/**
 * The memory an indexing phase holds at once besides what grows with the
 * pack (tables, ranges of the body, the objects it resolves): its reader's
 * delta-base cache and, while parsing, the parser's and the link table's
 * first step: the share a phase reserves up front, holding nothing else
 * (`DoMemoryBudget.begin`), so that concurrent phases each hold enough to
 * go on instead of a part each of what was free.
 */
export function pushIndexMemoryBytes(limits: Partial<PushLimits> = {}): number {
  const pack = { ...DEFAULT_PACK_LIMITS, ...(limits.pack ?? DEFAULT_PUSH_LIMITS.pack) };
  return (
    DEFAULT_READER_LIMITS.deltaBaseCacheBytes + pack.deltaBaseCacheBytes + LinkTable.RESERVE_STEP
  );
}

/** What indexing needs from the Durable Object (or the in-memory fakes). */
export interface PushIndexEnv {
  readonly zlib: Zlib;
  readonly memory: MemoryBudget;
  readonly commitGraph: CommitGraph;
  /** Reads the repository's packs and this upload's new packs (finished, not yet live). */
  readonly packStore: Pick<PackStore, "openRange">;
  /**
   * A writer for one of this upload's new packs. "received" may be asked for
   * again after an interrupted parse; the writer then starts the pack over.
   */
  beginPack(role: "received" | "completion"): PackWriter;
  /** Stores a new pack's `.idx` beside it. */
  storeIdx(packId: PackId, idx: Uint8Array): Promise<void>;
  /** Reads a stored `.idx` back (after a resume). */
  loadIdx(packId: PackId): Promise<Uint8Array>;
  /**
   * The repository's readable packs: thin bases and link targets are found
   * only here. Build it from the repository's registry, marking packs
   * borrowed from the fork network as `shared`.
   */
  readonly view: RepoView;
  /** The current refs: what proves an object in a shared pack belongs to this repository. */
  readonly refStore: Pick<RefStore, "readRefs">;
  readonly blockCache?: BlockCache;
  readonly fsck?: PushFsckPolicy;
  readonly limits?: Partial<PushLimits>;
}

export type IndexOutcome =
  | {
      readonly ok: true;
      /** The pack unit to make live with the refs: the received pack, then any completion pack. */
      readonly packs: readonly PackId[];
      readonly objectCount: number;
      /** Existing packs the checks relied on (the commit refuses if one is gone). */
      readonly deps: readonly PackId[];
      /** Refusals of single commands (missing tip, branch not a commit, shallow). */
      readonly commandErrors: ReadonlyMap<number, string>;
      readonly messages: readonly string[];
    }
  | {
      readonly ok: false;
      readonly failure: UnpackFailure;
      /** Packs written before the failure, to discard. */
      readonly packs: readonly PackId[];
    };

const UNPACK_FAILED = "index-pack abnormal exit";
const NEXT: Record<IndexPhase, IndexPhase> = {
  parse: "completion",
  completion: "connect",
  connect: "graph",
  graph: "done",
  done: "done",
};

export class PushIndexer {
  readonly #state: IndexState;

  private constructor(state: IndexState) {
    this.#state = state;
  }

  /** A new job for `plan`'s commands, with the pack at `packOffset` of the body. */
  static start(input: { uploadId: string; packOffset: number; plan: PushPlan }): PushIndexer {
    const tips = input.plan.commands
      .filter((c) => c.error === undefined && c.newOid !== null)
      .map((c) => ({
        index: c.index,
        oid: c.newOid as Oid,
        branch: c.name?.startsWith("refs/heads/") ?? false,
      }));
    return new PushIndexer({
      phase: "parse",
      uploadId: input.uploadId,
      packOffset: input.packOffset,
      tips,
      shallow: input.plan.shallow,
      received: null,
      completion: null,
      thinBases: [],
      commits: [],
      externalLinks: [],
      pendingBlobs: [],
      tipTypes: tips.map(() => null),
      deps: [],
      tipErrors: [],
      messages: [],
      failure: null,
    });
  }

  /** Continues a job from `checkpoint()` bytes. Throws RangeError for bytes it cannot read. */
  static resume(cursor: Uint8Array): PushIndexer {
    return new PushIndexer(decodeCursor(cursor));
  }

  get phase(): IndexPhase {
    return this.#state.phase;
  }

  get uploadId(): string {
    return this.#state.uploadId;
  }

  /** The job's state as bytes to store; `resume` continues from it. */
  checkpoint(): Uint8Array<ArrayBuffer> {
    return encodeCursor(this.#state);
  }

  /**
   * Runs the current phase and moves to the next. A refusal (a bad pack or
   * object, a broken link) ends the job at `done` with a failed outcome;
   * storage errors are thrown and the phase can be run again.
   */
  async step(env: PushIndexEnv, body: StoredBody): Promise<void> {
    const state = this.#state;
    if (state.phase === "done") return;
    const limits = { ...DEFAULT_PUSH_LIMITS, ...env.limits };
    try {
      switch (state.phase) {
        case "parse":
          await parsePhase(state, env, body, limits);
          break;
        case "completion":
          await completionPhase(state, env);
          break;
        case "connect":
          // A slice that stopped at its call budget continues next step.
          if (!(await connectPhase(state, env, limits))) return;
          break;
        case "graph":
          await graphPhase(state, env);
          break;
      }
      state.phase = NEXT[state.phase];
    } catch (error) {
      const failure = refusal(error);
      if (!failure) throw error;
      state.failure = failure;
      state.phase = "done";
    }
  }

  /** Runs every remaining phase, handing each checkpoint to `onCheckpoint`. */
  async run(
    env: PushIndexEnv,
    body: StoredBody,
    onCheckpoint?: (cursor: Uint8Array) => void | Promise<void>,
  ): Promise<IndexOutcome> {
    while (this.phase !== "done") {
      await this.step(env, body);
      await onCheckpoint?.(this.checkpoint());
    }
    return this.outcome();
  }

  /** The result; only after the job is `done`. */
  outcome(): IndexOutcome {
    const state = this.#state;
    if (state.phase !== "done") throw new Error(`indexing is still at phase ${state.phase}`);
    const packs = [state.received, state.completion]
      .filter((p): p is WrittenPack => p !== null)
      .map((p) => p.packId);
    if (state.failure) return { ok: false, failure: state.failure, packs };
    return {
      ok: true,
      packs,
      objectCount: (state.received?.objectCount ?? 0) + (state.completion?.objectCount ?? 0),
      deps: state.deps,
      commandErrors: new Map(state.tipErrors),
      messages: state.messages,
    };
  }
}

/** The refusal an indexing error stands for, or undefined for an error to rethrow. */
function refusal(error: unknown): UnpackFailure | undefined {
  const fail = (messages: string[]) => ({ status: UNPACK_FAILED, messages });
  if (error instanceof PushFsckError) {
    return fail([
      ...error.findings.map(
        (f) =>
          `${f.level === "error" ? "error" : "warning"}: object ${oidToHex(f.oid)}: ${f.message}`,
      ),
      "fatal: fsck error in packed object",
    ]);
  }
  if (error instanceof LinkError) return fail([...error.lines]);
  if (error instanceof PackError || error instanceof Sha1CollisionError) {
    return fail([`fatal: ${error.message}`]);
  }
  if (error instanceof IdxError && error.code === "duplicate-object") {
    return fail([`fatal: ${error.detail}`]);
  }
  return undefined;
}

/** The first pack of `view` holding `oid` (the one a reader would use), or undefined. */
async function locate(view: RepoView, oid: Oid): Promise<ViewPack | undefined> {
  for (const pack of view.packs) {
    if (pack.summary && !pack.summary.mayContain(oid)) continue;
    if (await pack.idx.lookup(oid)) return pack;
  }
  return undefined;
}

/** A proof of reachability over `reader`, for objects found only in shared packs. */
function openClosure(env: PushIndexEnv, reader: ObjectReader, limits: PushLimits): RepoClosure {
  return new RepoClosure({
    graph: env.commitGraph,
    reader,
    memory: env.memory,
    maxReads: limits.closureReads,
    refTips: async () => [...(await env.refStore.readRefs()).refs.values()],
  });
}

function noteDep(into: { deps: PackId[] }, pack: ViewPack | undefined): void {
  if (pack && !into.deps.includes(pack.packId)) into.deps.push(pack.packId);
}

function openReader(
  env: PushIndexEnv,
  view: RepoView,
  packStore: Pick<PackStore, "openRange"> = env.packStore,
): Promise<ObjectReader> {
  return ObjectReader.open({
    view,
    packStore,
    zlib: env.zlib,
    memory: env.memory,
    ...(env.blockCache ? { blockCache: env.blockCache } : {}),
  });
}

async function parsePhase(
  state: IndexState,
  env: PushIndexEnv,
  body: StoredBody,
  limits: PushLimits,
): Promise<void> {
  // Start over: a previous attempt may have been interrupted.
  state.received = null;
  state.thinBases = [];
  state.commits = [];
  state.externalLinks = [];
  state.pendingBlobs = [];
  state.deps = [];
  state.messages = [];
  state.tipTypes = state.tips.map(() => null);
  if (state.packOffset >= body.length) {
    throw new LinkError(["fatal: early EOF", "fatal: index-pack failed"]);
  }

  const writer = env.beginPack("received");
  const fsck = new PushFsck(env.fsck);
  const links = new LinkTable(env.memory, limits.maxLinks);
  const commits: CommitInfo[] = [];
  const step = new StepView(env.view, env.packStore);
  const reader = await openReader(env, step.view, step.packStore);
  const ranges = new BodyRangeCache(body, env.memory, limits.rangeBlockBytes, limits.rangeBlocks);
  let closure: RepoClosure | undefined;
  let seeded = 0;
  /** Types of the thin bases used, by hex: links to them are satisfied by the completion pack. */
  const thinTypes = new Map<string, ObjectType>();
  let written = false;
  try {
    const source = (async function* () {
      for await (const chunk of bodyChunks(body, state.packOffset, limits.readBytes)) {
        await writer.write(chunk);
        yield chunk;
      }
    })();
    const parsed = await parsePack(source, {
      zlib: env.zlib,
      memory: env.memory,
      limits: limits.pack,
      readRange: (offset, length) => ranges.read(state.packOffset + offset, length),
      externalBase: async (oid) => {
        const pack = await step.locate(oid);
        if (!pack) return undefined;
        if (pack.shared) {
          // Thin bases are resolved after every in-pack object, so the
          // commits seen so far name the history the push builds on.
          closure ??= openClosure(env, reader, limits);
          for (; seeded < commits.length; seeded++) {
            closure.addSeeds((commits[seeded] as CommitInfo).parents);
          }
          const [type] = await closure.resolve([oid]);
          // Not proven: the same answer as a base that is nowhere.
          if (type === undefined) return undefined;
        }
        const found = await reader.readObject(oid);
        if (!found) return undefined;
        noteDep(state, pack);
        thinTypes.set(oidToHex(oid), found.type);
        return { type: found.type, data: found.bytes };
      },
      onObject: async (object) => {
        const found = fsck.check(object.oid, object.type, object.data);
        if (found.badMode) {
          const mode = found.badMode.mode.toString(8).padStart(6, "0");
          // The pathname is attacker-sized: quote a short, escaped excerpt.
          const name = excerpt(found.badMode.name);
          throw new LinkError([
            `error: in tree ${oidToHex(object.oid)}: entry ${name} has bad mode ${mode}`,
            `fatal: Not all child objects of ${oidToHex(object.oid)} are reachable`,
          ]);
        }
        if (found.commit) commits.push({ oid: object.oid, ...found.commit });
        for (const [oid, type] of found.links) await links.add(oid, type);
      },
    });
    try {
      const { entries } = parsed;
      if (entries.count === 0) {
        await writer.abort();
      } else {
        const info = await writer.finish();
        written = true;
        const idx = await writeIdx(entries, parsed.checksum, {
          createHasher: () => createSha1Hasher({ detectCollisions: false }),
          strict: true,
          memory: env.memory,
        });
        try {
          await env.storeIdx(info.packId, idx.bytes);
        } finally {
          idx.release();
        }
        state.received = { packId: info.packId, bytes: info.bytes, objectCount: entries.count };
      }
      // Links into the pack are checked here; links out of it in the connect phase.
      const inPack = new OidTable(entries.count);
      const types = new Uint8Array(entries.count);
      for (let i = 0; i < entries.count; i++) {
        const before = inPack.size;
        const at = inPack.add(entries.oid(i));
        if (at === before) types[at] = OBJECT_TYPES.indexOf(entries.type(i));
      }
      const typeOf = (oid: Oid): ObjectType | undefined => {
        const at = inPack.indexOf(oid);
        return at < 0 ? undefined : OBJECT_TYPES[types[at] as number];
      };
      for (const [oid, type] of links.entries()) {
        const actual = typeOf(oid) ?? thinTypes.get(oidToHex(oid));
        if (actual === undefined) state.externalLinks.push([oid, type]);
        else if (actual !== type) {
          throw new LinkError([
            `fatal: object ${oidToHex(oid)}: expected type ${type}, found ${actual}`,
          ]);
        }
      }
      state.tipTypes = state.tips.map((tip) => typeOf(tip.oid) ?? null);
      state.thinBases = [...parsed.thinBases];
    } finally {
      parsed.release();
    }
    state.commits = commits;
    state.pendingBlobs = fsck.pending();
    state.messages = fsck.warnings.map((f) => `warning: object ${oidToHex(f.oid)}: ${f.message}`);
  } catch (error) {
    if (!written) await writer.abort().catch(() => {});
    throw error;
  } finally {
    links.release();
    ranges.release();
    closure?.release();
    reader.release();
  }
}

async function completionPhase(state: IndexState, env: PushIndexEnv): Promise<void> {
  state.completion = null;
  if (state.thinBases.length === 0) return;
  const reader = await openReader(env, env.view);
  const writer = env.beginPack("completion");
  let finished = false;
  try {
    const builder = await PackBuilder.start(state.thinBases.length, {
      sink: writer,
      zlib: env.zlib,
      memory: env.memory,
    });
    try {
      for (const oid of state.thinBases) {
        const base = await reader.readObject(oid);
        if (!base) throw new LinkError([`fatal: thin pack base ${oidToHex(oid)} is gone`]);
        await builder.addObject(base.type, base.bytes, oid);
      }
      const pack = await builder.finish();
      try {
        const info = await writer.finish();
        finished = true;
        await env.storeIdx(info.packId, pack.idx.bytes);
        state.completion = {
          packId: info.packId,
          bytes: info.bytes,
          objectCount: state.thinBases.length,
        };
      } finally {
        pack.release();
      }
    } finally {
      builder.release();
    }
  } catch (error) {
    if (!finished) await writer.abort().catch(() => {});
    throw error;
  } finally {
    reader.release();
  }
}

/** Rows read from the commit graph per call. */
const GRAPH_BATCH = 1000;

async function readRows(
  graph: CommitGraph,
  oids: readonly Oid[],
): Promise<(CommitGraphEntry | undefined)[]> {
  const rows: (CommitGraphEntry | undefined)[] = [];
  for (let i = 0; i < oids.length; i += GRAPH_BATCH) {
    for (const row of await graph.read(oids.slice(i, i + GRAPH_BATCH), "verified")) rows.push(row);
  }
  return rows;
}

/**
 * The connect phase, or one slice of it. Returns false when the slice
 * stopped at its call budget: the links still to check stay in
 * `state.externalLinks` (with the commit links, which seed the proofs) and
 * the next slice goes on from there.
 */
async function connectPhase(
  state: IndexState,
  env: PushIndexEnv,
  limits: PushLimits,
): Promise<boolean> {
  // Results go to `state` only at the end of a slice (the links left and
  // the deps so far) or of the phase, so a rerun starts from the last one.
  const result: ConnectResult = { deps: [...state.deps], tipErrors: [], messages: [] };
  const lookups = state.externalLinks.length + state.pendingBlobs.length + state.tips.length;
  if (lookups > limits.maxExternalLookups) {
    throw new LinkError([
      `fatal: connectivity check exceeded its limit of ${limits.maxExternalLookups} lookups`,
    ]);
  }
  const step = new StepView(env.view, env.packStore);
  const reader = await openReader(env, step.view, step.packStore);
  const closure = openClosure(env, reader, limits);
  /**
   * Existing objects and the pack each is in: the type from the entry
   * header (one lookup, remembered for the read) for the repository's own
   * packs, from a proof of reachability for shared packs (undefined: not
   * proven, reported as absent).
   *
   * With `maxCalls`, only the first `answered` oids are answered: no
   * `.idx` read starts that could pass it, and no header read starts at
   * it; the rest are for the next slice.
   */
  const existing = async (oids: readonly Oid[], maxCalls = Number.POSITIVE_INFINITY) => {
    const located = await step.locateMany(oids, maxCalls);
    const unanswered = located.indexOf(null);
    let answered = unanswered < 0 ? oids.length : unanswered;
    const packs: (ViewPack | undefined)[] = [];
    const types: (ObjectType | undefined)[] = [];
    const proofs: number[] = [];
    for (let i = 0; i < answered; i++) {
      const pack = located[i] ?? undefined;
      if (pack && !pack.shared) {
        if (step.calls >= maxCalls) {
          answered = i;
          break;
        }
        types.push((await reader.readHeader(oids[i] as Oid))?.type);
      } else {
        types.push(undefined);
        if (pack) proofs.push(i);
      }
      packs.push(pack);
    }
    if (proofs.length > 0) {
      const proven = await closure.resolve(proofs.map((i) => oids[i] as Oid));
      for (const [k, i] of proofs.entries()) types[i] = proven[k];
    }
    return { packs, types, answered };
  };
  try {
    // Commits outside the pack must be verified rows: never another upload's
    // pending commits, never a commit whose own closure was not proven.
    const commitLinks = state.externalLinks.filter(([, type]) => type === "commit");
    const parents = commitLinks.map(([oid]) => oid);
    const parentRows = await readRows(env.commitGraph, parents);
    const outside = state.tips.filter((_, i) => state.tipTypes[i] === null);
    const tipRows = await readRows(
      env.commitGraph,
      outside.map((tip) => tip.oid),
    );
    const verified = [
      ...parents.filter((_, k) => parentRows[k]),
      ...outside.filter((_, k) => tipRows[k]).map((tip) => tip.oid),
    ];
    closure.addSeeds(verified);

    const shallow = new OidTable(state.shallow.length);
    for (const oid of state.shallow) shallow.add(oid);
    const unverified = parents.filter((oid, k) => !parentRows[k] && !shallow.has(oid));
    if (unverified.length > 0) {
      // Absent, another type, or a commit whose closure was never proven
      // (fail closed in every case).
      const oid = unverified[0] as Oid;
      const [type] = (await existing([oid])).types;
      throw new LinkError([
        type !== undefined && type !== "commit"
          ? `fatal: object ${oidToHex(oid)}: expected type commit, found ${type}`
          : `fatal: did not receive expected object ${oidToHex(oid)}`,
      ]);
    }
    const boundary = parents.find((_, k) => !parentRows[k]);
    if (boundary) {
      // A shallow client's history ends at a commit this repository lacks:
      // the pack can never be complete, so no command may make it live.
      throw new LinkError([
        `fatal: shallow update not allowed: the pushed history ends at ${oidToHex(boundary)}, which this repository does not have`,
      ]);
    }

    const others = state.externalLinks.filter(([, type]) => type !== "commit");
    for (let done = 0; done < others.length; ) {
      if (done > 0 && step.calls >= limits.connectCalls) {
        state.externalLinks = [...commitLinks, ...others.slice(done)];
        state.deps = result.deps;
        return false;
      }
      const batch = others.slice(done, done + limits.connectBatch);
      // The first batch of a slice always runs whole, so every slice makes progress.
      const allowance = done > 0 ? limits.connectCalls : Number.POSITIVE_INFINITY;
      const { packs, types, answered } = await existing(
        batch.map(([oid]) => oid),
        allowance,
      );
      for (const [k, [oid, type]] of batch.slice(0, answered).entries()) {
        const actual = types[k];
        if (actual === undefined) {
          throw new LinkError([`fatal: did not receive expected object ${oidToHex(oid)}`]);
        }
        if (actual !== type) {
          throw new LinkError([
            `fatal: object ${oidToHex(oid)}: expected type ${type}, found ${actual}`,
          ]);
        }
        noteDep(result, packs[k]);
      }
      done += answered;
      if (answered < batch.length) {
        state.externalLinks = [...commitLinks, ...others.slice(done)];
        state.deps = result.deps;
        return false;
      }
    }

    if (state.pendingBlobs.length > 0) await finishBlobs(state, env, step, result);

    // Ref tips outside the pack: a commit needs a verified row (a commit
    // without one never had its closure proven), anything else must exist.
    const unrowed = outside.filter((_, k) => !tipRows[k]);
    const found = await existing(unrowed.map((tip) => tip.oid));
    const tipType = new Map<number, ObjectType>();
    for (const [k, tip] of unrowed.entries()) {
      const type = found.types[k];
      if (type === undefined || type === "commit") continue;
      tipType.set(tip.index, type);
      noteDep(result, found.packs[k]);
    }
    const rowed = new Set(outside.filter((_, k) => tipRows[k]).map((tip) => tip.index));
    for (const [i, tip] of state.tips.entries()) {
      const type = state.tipTypes[i] ?? (rowed.has(tip.index) ? "commit" : tipType.get(tip.index));
      if (type === undefined) result.tipErrors.push([tip.index, "missing necessary objects"]);
      else if (tip.branch && type !== "commit") {
        result.tipErrors.push([tip.index, "branch must point to a commit"]);
        result.messages.push(
          `error: refusing to point a branch at ${type} ${oidToHex(tip.oid)}: branches must point to commits`,
        );
      }
    }
    // The packs of the commits relied on.
    for (const pack of await step.locateMany(verified)) noteDep(result, pack ?? undefined);

    state.deps = result.deps;
    state.tipErrors = result.tipErrors;
    // One message per finding can be many: no argument spreading.
    for (const message of result.messages) state.messages.push(message);
    return true;
  } finally {
    closure.release();
    reader.release();
  }
}

interface ConnectResult {
  deps: PackId[];
  tipErrors: [number, string][];
  messages: string[];
}

/** git's `fsck_finish`: `.gitmodules`/`.gitattributes` blobs not checked during the parse. */
async function finishBlobs(
  state: IndexState,
  env: PushIndexEnv,
  step: StepView,
  result: ConnectResult,
): Promise<void> {
  const own: ViewPack[] = [];
  for (const pack of [state.received, state.completion]) {
    if (!pack) continue;
    own.push({
      packId: pack.packId,
      bytes: pack.bytes,
      idx: PackIdx.parse(await env.loadIdx(pack.packId)),
    });
  }
  const view: RepoView = { scope: step.view.scope, packs: [...own, ...step.view.packs] };
  const reader = await openReader(env, view, step.packStore);
  try {
    const fsck = new PushFsck(env.fsck);
    fsck.restorePending(state.pendingBlobs);
    for (const blob of state.pendingBlobs) {
      const object = await reader.readObject(blob.oid);
      fsck.finishBlob(blob.oid, object && { type: object.type, data: object.bytes });
      if (object && !(await locate({ scope: view.scope, packs: own }, blob.oid))) {
        noteDep(result, await step.locate(blob.oid));
      }
    }
    for (const f of fsck.warnings) {
      result.messages.push(`warning: object ${oidToHex(f.oid)}: ${f.message}`);
    }
  } finally {
    reader.release();
  }
}

async function graphPhase(state: IndexState, env: PushIndexEnv): Promise<void> {
  if (state.commits.length === 0) return;
  try {
    await addPendingCommits(env.commitGraph, state.uploadId, state.commits);
  } catch (error) {
    if (!(error instanceof MissingCommitError)) throw error;
    throw new LinkError(
      error.oids.map((oid) => `fatal: did not receive expected object ${oidToHex(oid)}`),
    );
  }
}
