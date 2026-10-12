import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { concatBytes, latin1 } from "../../src/object/bytes.js";
import { oidToHex } from "../../src/object/oid.js";
import { type Capability, encodeRefAdvertisement } from "../../src/protocol/capabilities.js";
import { PktLineStreamReader } from "../../src/protocol/pktline.js";
import { readReceivePackRequest } from "../../src/protocol/receive-pack-request.js";
import { bytesBody } from "../../src/receive-pack/body.js";
import type { PushPolicy } from "../../src/receive-pack/commands.js";
import type { PushFsckPolicy } from "../../src/receive-pack/fsck.js";
import type { PushLimits } from "../../src/receive-pack/indexer.js";
import { receivePack } from "../../src/receive-pack/receive-pack.js";
import { refStoreCommitter } from "../../src/receive-pack/ref-store-commit.js";
import { createMemoryBudget } from "../fakes/memory-budget.js";
import { createNodeZlib } from "../node-zlib.js";
import { FileRepo } from "./file-repo.js";
import type { GitServiceHandler } from "./server.js";

/** The capabilities Fyrden's receive-pack advertises, in git's order. */
export const TEST_RECEIVE_PACK_CAPABILITIES: readonly Capability[] = [
  { name: "report-status" },
  { name: "report-status-v2" },
  { name: "delete-refs" },
  { name: "side-band-64k" },
  { name: "quiet" },
  { name: "atomic" },
  { name: "ofs-delta" },
  { name: "push-options" },
  { name: "object-format", value: "sha1" },
  { name: "agent", value: "fyrden-test" },
];

/** Test knobs, read from `ext-config.json` in the repository directory when present. */
export interface ExtConfig {
  /** Re-authorization at the commit point refuses with this message (a revoked token). */
  readonly revoked?: string;
  readonly policy?: PushPolicy;
  readonly fsck?: PushFsckPolicy;
  readonly limits?: Partial<PushLimits>;
  readonly denyNonFastForwards?: boolean;
}

async function readConfig(dir: string): Promise<ExtConfig> {
  try {
    return JSON.parse(await readFile(join(dir, "ext-config.json"), "utf8")) as ExtConfig;
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return {};
    throw error;
  }
}

/** Records every chunk read through it. */
function recording(source: AsyncIterable<Uint8Array>): {
  stream: AsyncIterable<Uint8Array>;
  chunks: Uint8Array[];
} {
  const chunks: Uint8Array[] = [];
  return {
    chunks,
    stream: {
      async *[Symbol.asyncIterator]() {
        for await (const chunk of source) {
          const copy = new Uint8Array(chunk);
          chunks.push(copy);
          yield copy;
        }
      },
    },
  };
}

/** `git receive-pack` over the file repository, through git-core's push path. */
export const receivePackHandler: GitServiceHandler = async (io) => {
  const repo = await FileRepo.open(io.repoDir);
  const config = await readConfig(io.repoDir);
  const snapshot = await repo.refStore.readRefs();
  const encoder = new TextEncoder();
  await io.write(
    encodeRefAdvertisement({
      capabilities: TEST_RECEIVE_PACK_CAPABILITIES,
      refs: [...snapshot.refs]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([name, oid]) => ({ oid, name: encoder.encode(name) })),
    }),
  );

  // Read the commands to learn whether a pack follows (none for a delete-only
  // push, and git does not close its end then); then read to the end.
  const input = recording(io.input);
  const reader = new PktLineStreamReader(input.stream);
  const request = await readReceivePackRequest(reader, { pushOptionsAdvertised: true });
  if (request.commands.length === 0) return;
  if (request.commands.some((c) => c.newOid.some((b) => b !== 0))) {
    for await (const _ of reader.rest()) {
      // Recorded.
    }
  }
  const body = concatBytes(input.chunks);

  const uploadId = `upload-${Date.now()}`;
  const view = await repo.view();
  const outcome = await receivePack({
    body: bytesBody(body),
    refs: snapshot,
    uploadId,
    ...(config.policy ? { policy: config.policy } : {}),
    index: {
      zlib: createNodeZlib(),
      memory: createMemoryBudget(512 * 1024 * 1024),
      commitGraph: repo.commitGraph,
      packStore: repo.packStore,
      beginPack: () => repo.packStore.beginPack(),
      storeIdx: (packId, idx) => repo.storeIdx(packId, idx),
      loadIdx: (packId) => repo.loadIdx(packId),
      view,
      refStore: repo.refStore,
      ...(config.fsck ? { fsck: config.fsck } : {}),
      ...(config.limits ? { limits: config.limits } : {}),
    },
    finalize: {
      commitGraph: repo.commitGraph,
      reauthorize: async () => config.revoked,
      commit: refStoreCommitter(repo.refStore, {
        onUploadCommitted: (id) => repo.commitGraph.promote(id),
      }),
      ...(config.denyNonFastForwards ? { denyNonFastForwards: true } : {}),
    },
  });
  if (outcome.result) {
    if (outcome.result.uploadCommitted || outcome.result.applied.length > 0) {
      repo.logPush({
        uploadId,
        pushOptions: outcome.result.pushOptions.map(latin1),
        applied: outcome.result.applied.map((u) => ({
          name: u.name,
          oldOid: u.oldOid && oidToHex(u.oldOid),
          newOid: u.newOid && oidToHex(u.newOid),
        })),
      });
    }
    if (!outcome.result.uploadCommitted && outcome.indexed) {
      for (const packId of outcome.indexed.packs) await repo.discard(packId);
    }
  }
  await repo.save();
  await io.write(outcome.response);
};
