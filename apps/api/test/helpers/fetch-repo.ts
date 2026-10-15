import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createWorkersZlib } from "@fyrden/adapters-cloudflare";
import { packObjectKey, promotePendingCommits } from "@fyrden/adapters-cloudflare/git";
import { createFakeDataset } from "@fyrden/adapters-cloudflare/obs/testing";
import {
  addPendingCommits,
  createSha1Hasher,
  decodeSidebandPacket,
  type ExternalBaseLookup,
  oidFromHex,
  oidToHex,
  type PackId,
  PktLineReader,
  parsePack,
  type RefUpdate,
  writeIdx,
} from "@fyrden/git-core";
import { uniqueId } from "@fyrden/testing";
import { createApp } from "../../src/app.js";
import type { RepoDO } from "../../src/do/RepoDO.js";
import { concatBytes } from "../../src/git/protocol.js";
import type { FetchFixtureRepo } from "./fetch-fixtures.js";
import { fromHex } from "./git-oracle.js";
import { inRepo } from "./repo-git.js";

function pkt(line: string): string {
  return (new TextEncoder().encode(line).length + 4).toString(16).padStart(4, "0") + line;
}

/** A protocol v2 fetch command request body. */
export function fetchBody(args: readonly string[]): string {
  return [
    pkt("command=fetch\n"),
    pkt("object-format=sha1\n"),
    "0001",
    ...args.map((a) => pkt(`${a}\n`)),
    "0000",
  ].join("");
}

const text = (data: Uint8Array) => new TextDecoder().decode(data).replace(/\n$/, "");

/**
 * Stores a fixture the way completed pushes leave it: each pack (with an
 * `.idx` the engine writes) live in the registry, every commit as a
 * verified commit-graph row, the refs. With `allReachable`, the packs are
 * flagged as maintenance flags packs every object of which the refs reach.
 * Returns the pack ids, oldest first.
 */
export async function loadFixture(
  stub: DurableObjectStub<RepoDO>,
  fixture: FetchFixtureRepo,
  { allReachable = true }: { allReachable?: boolean } = {},
): Promise<PackId[]> {
  return inRepo(stub, async ({ git }) => {
    const packIds: PackId[] = [];
    for (const hex of fixture.packs) {
      const bytes = fromHex(hex);
      const parsed = await parsePack(
        (async function* () {
          yield bytes;
        })(),
        {
          zlib: createWorkersZlib(),
          memory: git.memory,
          readRange: async (offset, length) => bytes.subarray(offset, offset + length),
        },
      );
      const idx = await writeIdx(parsed.entries, parsed.checksum, {
        createHasher: () => createSha1Hasher({ detectCollisions: false }),
      });
      const count = parsed.entries.count;
      parsed.release();
      const writer = git.packStore.beginPack();
      await writer.write(bytes);
      await writer.finish();
      await git.bucket.put(packObjectKey(git.networkId(), writer.packId, "idx"), idx.bytes);
      idx.release();
      // Created in the fixture's order, a millisecond apart, whatever the clock did: what is
      // ordered by age (repack, tail merges) comes out the same for every copy of a fixture.
      git.context.storage.sql.exec(
        `UPDATE packs SET object_count = ?, all_reachable = ?, created_at = created_at + ?
         WHERE pack_id = ?`,
        count,
        allReachable ? 1 : 0,
        packIds.length,
        writer.packId,
      );
      packIds.push(writer.packId);
    }
    const uploadId = uniqueId("fixture");
    await addPendingCommits(
      git.commitGraph,
      uploadId,
      fixture.commits.map((c) => ({
        oid: oidFromHex(c.oid),
        tree: oidFromHex(c.tree),
        parents: c.parents.map(oidFromHex),
        commitTime: c.time,
      })),
    );
    promotePendingCommits(git.context, uploadId);
    const refUpdates: RefUpdate[] = fixture.refs.map((ref) => ({
      name: ref.name,
      oldOid: null,
      newOid: oidFromHex(ref.oid),
    }));
    const result = git.refStore.commitSync({
      addPacks: packIds,
      removePacks: [],
      refUpdates,
      expectedVersion: git.refStore.readRefsSync().version,
    });
    if (!result.ok) throw new Error(`commit failed: ${JSON.stringify(result)}`);
    return packIds;
  });
}

export interface ParsedFetchResponse {
  readonly acknowledgments?: readonly string[];
  readonly ready: boolean;
  readonly shallowInfo?: readonly string[];
  readonly pack?: Uint8Array;
  readonly progress: string;
  /** The `ERR` message when the response was a refusal. */
  readonly error?: string;
  /** Band-1 packet sizes, for framing checks. */
  readonly packetSizes: readonly number[];
}

/** Reads a protocol v2 fetch response section by section (gitprotocol-v2, "fetch"). */
export function parseFetchResponse(bytes: Uint8Array): ParsedFetchResponse {
  const reader = new PktLineReader(bytes, { maxLines: 10_000_000, maxBytes: 2 ** 40 });
  let acknowledgments: string[] | undefined;
  let shallowInfo: string[] | undefined;
  let ready = false;
  let progress = "";
  const pack: Uint8Array[] = [];
  const packetSizes: number[] = [];
  let sawPack = false;
  if (bytes.length === 0) return { ready, progress, packetSizes };
  for (;;) {
    const header = reader.read();
    if (header === undefined) throw new Error("response ended without a flush");
    if (header.kind === "flush") break;
    if (header.kind !== "data") throw new Error(`unexpected ${header.kind} packet`);
    const name = text(header.data);
    if (name.startsWith("ERR ")) {
      if (reader.read() !== undefined) throw new Error("bytes after ERR");
      return { ready, progress, packetSizes, error: name.slice(4) };
    }
    const lines: string[] = [];
    let end: string;
    for (;;) {
      const pkt = reader.read();
      if (pkt === undefined) throw new Error(`section ${name} not terminated`);
      if (pkt.kind !== "data") {
        end = pkt.kind;
        break;
      }
      if (name === "packfile") {
        const frame = decodeSidebandPacket(pkt.data);
        if (frame.band === 1) {
          pack.push(frame.payload);
          packetSizes.push(frame.payload.length);
        } else if (frame.band === 2) progress += text(frame.payload);
        else throw new Error(`band 3: ${text(frame.payload)}`);
      } else lines.push(text(pkt.data));
    }
    if (name === "acknowledgments") {
      ready = lines.includes("ready");
      acknowledgments = lines.filter((line) => line !== "ready");
    } else if (name === "shallow-info") shallowInfo = lines;
    else if (name === "packfile") sawPack = true;
    else throw new Error(`unknown section ${name}`);
    if (end === "flush") break;
    if (end !== "delim") throw new Error(`section ${name} ended by ${end}`);
  }
  if (reader.read() !== undefined) throw new Error("bytes after the final flush");
  return {
    ...(acknowledgments ? { acknowledgments } : {}),
    ready,
    ...(shallowInfo ? { shallowInfo } : {}),
    ...(sawPack ? { pack: concatBytes(pack) } : {}),
    progress,
    packetSizes,
  };
}

/** The objects in a pack, as sorted hex (the trailer and every object are checked). */
export async function packObjects(
  pack: Uint8Array,
  externalBase?: ExternalBaseLookup,
): Promise<{ oids: string[]; thinBases: string[] }> {
  const parsed = await parsePack(
    (async function* () {
      yield pack;
    })(),
    {
      zlib: createWorkersZlib(),
      memory: {
        reserve: async (bytes) => ({ bytes, release() {} }),
        tryReserve: (bytes) => ({ bytes, release() {} }),
      },
      readRange: async (offset, length) => pack.subarray(offset, offset + length),
      ...(externalBase ? { externalBase } : {}),
    },
  );
  const oids: string[] = [];
  for (let i = 0; i < parsed.entries.count; i++) oids.push(oidToHex(parsed.entries.oid(i)));
  const thinBases = parsed.thinBases.map(oidToHex);
  parsed.release();
  return { oids: oids.sort(), thinBases };
}

/**
 * Records Analytics Engine data points, for metric assertions. Like the
 * platform, the dataset throws past 250 points in one invocation.
 */
export function recordingMetrics() {
  return createFakeDataset();
}

/** R2 calls the Worker makes, by method. */
export function countingBucket(bucket: R2Bucket) {
  const calls: string[] = [];
  const counted = new Proxy(bucket, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        calls.push(String(property));
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { bucket: counted, calls };
}

export type Plan = "free" | "paid" | undefined;

/**
 * Sends one request through the Worker with the given plan setting and
 * bindings, and waits for its background work (lease release) to finish
 * after `consume` has read the body.
 */
export async function throughWorker(
  request: Request,
  options: { plan: Plan; bucket?: R2Bucket; metrics?: AnalyticsEngineDataset },
  consume: (response: Response) => Promise<void>,
): Promise<void> {
  const ctx = createExecutionContext();
  const bindings = {
    ...env,
    ...(options.plan ? { FYRDEN_PLAN: options.plan } : {}),
    ...(options.bucket ? { GIT: options.bucket } : {}),
    ...(options.metrics ? { METRICS: options.metrics } : {}),
  };
  const response = await createApp().fetch(request, bindings as Env, ctx);
  await consume(response);
  await waitOnExecutionContext(ctx);
}
