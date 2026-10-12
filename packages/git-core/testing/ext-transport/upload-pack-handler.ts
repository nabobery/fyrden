import { copyBytes } from "../../src/object/bytes.js";
import { asPackId, type PackId, type PackStore } from "../../src/ports/pack-store.js";
import { createReadStats } from "../../src/reader/stats.js";
import { createMemoryBudget } from "../fakes/memory-budget.js";
import { createNodeZlib } from "../node-zlib.js";
import { FileRepo } from "./file-repo.js";
import type { GitServiceHandler } from "./server.js";
import {
  counting,
  directoryMaterialisedStore,
  type LoadedUploadPackRepo,
} from "./upload-pack-repo.js";
import { serveUploadPack } from "./upload-pack-serve.js";

/*
 * Upload-pack for the shared `ext::` test transport (`main.ts` loads this
 * module when it exists), served from the push path's repository
 * directory (`FileRepo`), so a test can push with stock git and clone the
 * result back. Every fetch is regenerated: that directory format keeps no
 * all-reachable flags for verbatim plans.
 */

export const uploadPackHandler: GitServiceHandler = async (io) => {
  const code = await serveUploadPack(
    "git-upload-pack",
    io.repoDir,
    { input: io.input, write: (bytes) => io.write(bytes), env: process.env },
    openFileRepo,
  );
  if (code !== 0) process.exitCode = code;
};

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Materialised objects stay in memory for one process. Their ids start
 * with "7", which `FileRepo` (numbering from zero) does not reach in a
 * test, so reads can be routed by id.
 */
function materialisedPacks(): PackStore & { has(packId: PackId): boolean } {
  const bytes = new Map<PackId, Uint8Array>();
  let next = 0;
  return {
    has: (packId) => bytes.has(packId),
    listPacks: async () => [],
    beginPack() {
      let n = next++;
      let text = "";
      for (let i = 0; i < 25; i++, n = Math.floor(n / 32)) text = CROCKFORD[n % 32] + text;
      const packId = asPackId(`7${text}`);
      const chunks: Uint8Array[] = [];
      return {
        packId,
        write: async (chunk) => {
          chunks.push(copyBytes(chunk));
        },
        finish: async () => {
          const all = new Uint8Array(chunks.reduce((total, c) => total + c.length, 0));
          let at = 0;
          for (const chunk of chunks) {
            all.set(chunk, at);
            at += chunk.length;
          }
          bytes.set(packId, all);
          return { packId, bytes: all.length };
        },
        abort: async () => {},
      };
    },
    async openRange(packId, offset, length) {
      const all = bytes.get(packId);
      if (!all) throw new Error(`no pack ${packId}`);
      if (offset < 0 || length < 0 || offset + length > all.length) throw new RangeError("range");
      return all.slice(offset, offset + length);
    },
  };
}

async function openFileRepo(dir: string): Promise<LoadedUploadPackRepo> {
  const repo = await FileRepo.open(dir);
  const materialised = materialisedPacks();
  const packStore = counting({
    listPacks: () => repo.packStore.listPacks(),
    beginPack: () => materialised.beginPack(),
    openRange: (packId, offset, length) =>
      (materialised.has(packId) ? materialised : repo.packStore).openRange(packId, offset, length),
  });
  const refs = await repo.refStore.readRefs();
  return {
    repository: {
      refs,
      commitGraph: repo.commitGraph,
      view: await repo.view(),
      packStore,
      zlib: createNodeZlib(),
      memory: createMemoryBudget(96 * 1024 * 1024),
      materialised: directoryMaterialisedStore(dir, packStore),
      cacheIdentity: { repoId: dir, registryVersion: refs.version },
    },
    packStore,
    stats: createReadStats(),
    packIds: new Map(),
  };
}
