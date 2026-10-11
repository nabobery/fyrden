import { copyBytes } from "../../src/object/bytes.js";
import { type Oid, oidEquals, oidFromBytes } from "../../src/object/oid.js";
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
  ReflogEntry,
  RefStore,
} from "../../src/ports/ref-store.js";
import { refnameConflicts, sortedRefNamespace } from "../../src/refs/namespace.js";
import { isValidRefname } from "../../src/refs/refname.js";

export interface MemoryRepoStore {
  packStore: PackStore;
  refStore: RefStore;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * In-memory `PackStore` and `RefStore` sharing one registry, as the
 * Durable Object implementation does. For tests of code that uses the ports.
 */
export function createMemoryRepoStore(
  options: { now?: () => number; head?: string | null } = {},
): MemoryRepoStore {
  const now = options.now ?? Date.now;
  const finished = new Map<PackId, Uint8Array>();
  const live = new Set<PackId>();
  const refs = new Map<string, Oid>();
  const reflogs = new Map<string, ReflogEntry[]>();
  let version = 0;
  let nextPack = 0;

  function newPackId(): PackId {
    let n = ++nextPack;
    let text = "";
    for (let i = 0; i < 26; i++, n = Math.floor(n / 32)) text = CROCKFORD[n % 32] + text;
    return asPackId(text);
  }

  const packStore: PackStore = {
    async listPacks() {
      return [...live].map(
        (packId): PackInfo => ({ packId, bytes: (finished.get(packId) as Uint8Array).length }),
      );
    },
    beginPack(): PackWriter {
      const packId = newPackId();
      const chunks: Uint8Array[] = [];
      let state: "open" | "finished" | "aborted" = "open";
      const requireOpen = () => {
        if (state !== "open") throw new Error(`pack ${packId} is ${state}`);
      };
      return {
        packId,
        async write(chunk) {
          requireOpen();
          chunks.push(copyBytes(chunk));
        },
        async finish() {
          requireOpen();
          state = "finished";
          const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.length;
          }
          finished.set(packId, bytes);
          return { packId, bytes: bytes.length };
        },
        async abort() {
          if (state === "finished") throw new Error(`pack ${packId} is finished`);
          state = "aborted";
        },
      };
    },
    async openRange(packId, offset, length) {
      const bytes = finished.get(packId);
      if (!bytes) throw new Error(`no pack ${packId}`);
      if (
        !Number.isInteger(offset) ||
        !Number.isInteger(length) ||
        offset < 0 ||
        length < 0 ||
        offset + length > bytes.length
      ) {
        throw new RangeError(
          `range ${offset}+${length} is outside pack ${packId} (${bytes.length} bytes)`,
        );
      }
      return copyBytes(bytes, offset, offset + length);
    },
  };

  const refStore: RefStore = {
    async readRefs() {
      return {
        version,
        refs: new Map([...refs].map(([name, oid]) => [name, copyOid(oid)])),
        head: options.head === undefined ? "refs/heads/main" : options.head,
      };
    },
    async readReflog(name, limit) {
      if (!Number.isSafeInteger(limit) || limit < 0)
        throw new RangeError(`bad reflog limit ${limit}`);
      if (limit === 0) return [];
      return (reflogs.get(name) ?? [])
        .slice(-limit)
        .reverse()
        .map((e) => ({ ...e, oldOid: copyOid(e.oldOid), newOid: copyOid(e.newOid) }));
    },
    async commit(request: RefCommitRequest): Promise<RefCommitResult> {
      validate(request);
      // Everything below is synchronous: no other commit can interleave.
      if (request.expectedVersion !== version)
        return { ok: false, reason: "version-conflict", version };
      for (const { name, oldOid } of request.refUpdates) {
        const current = refs.get(name) ?? null;
        const same =
          current === null || oldOid === null ? current === oldOid : oidEquals(current, oldOid);
        if (!same) return { ok: false, reason: "ref-conflict", ref: name };
      }
      const [collision] = refnameConflicts(request.refUpdates, sortedRefNamespace(refs.keys()));
      if (collision)
        return {
          ok: false,
          reason: "refname-conflict",
          ref: collision.ref,
          conflictsWith: collision.conflictsWith,
        };
      for (const packId of request.addPacks) {
        if (!finished.has(packId) || live.has(packId))
          return { ok: false, reason: "unknown-pack", packId };
      }
      for (const packId of request.removePacks) {
        if (!live.has(packId)) return { ok: false, reason: "unknown-pack", packId };
      }
      version++;
      const at = now();
      for (const { name, oldOid, newOid } of request.refUpdates) {
        if (newOid) refs.set(name, copyOid(newOid));
        else refs.delete(name);
        const log = reflogs.get(name) ?? [];
        log.push({ version, oldOid: copyOid(oldOid), newOid: copyOid(newOid), at });
        reflogs.set(name, log);
      }
      for (const packId of request.addPacks) live.add(packId);
      for (const packId of request.removePacks) live.delete(packId);
      return { ok: true, version };
    },
  };

  return { packStore, refStore };
}

function copyOid<T extends Oid | null>(oid: T): T {
  return (oid === null ? null : oidFromBytes(oid)) as T;
}

function validate(request: RefCommitRequest): void {
  const names = new Set<string>();
  for (const { name } of request.refUpdates) {
    if (!isValidRefname(new TextEncoder().encode(name)))
      throw new RangeError(`invalid ref name: ${name}`);
    if (names.has(name)) throw new RangeError(`ref ${name} is updated twice`);
    names.add(name);
  }
  const packs = [...request.addPacks, ...request.removePacks];
  if (new Set(packs).size !== packs.length) throw new RangeError("a pack is named twice");
}
