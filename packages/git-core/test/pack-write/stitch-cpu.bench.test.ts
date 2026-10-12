import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { frameSidebandData } from "../../src/pack-write/sideband-frame.js";
import {
  type PackRangeStream,
  planVerbatimPack,
  streamVerbatimPack,
} from "../../src/pack-write/verbatim.js";
import type { PackId } from "../../src/ports/pack-store.js";
import { prng } from "../pack/repo-fixture.js";

/*
 * CPU per MiB of the stitched clone path (copy, hash, new trailer) and of
 * side-band pre-framing, under Node. Sources arrive in 4 KiB chunks (what
 * an R2 body stream gives a default reader, measured) or 64 KiB chunks (a
 * BYOB reader). The trailer hasher is git-core's TypeScript SHA-1, or
 * node:crypto standing in for the Workers DigestStream. It reports numbers
 * and asserts nothing about them, so it only runs on request:
 *
 *   FYRDEN_BENCH=1 npx vitest run test/pack-write/stitch-cpu.bench.test.ts
 */

const MIB = 1024 * 1024;
const PACKS = 3;
const PACK_BYTES = 32 * MIB;

function syntheticPacks(): Map<PackId, Uint8Array> {
  const rand = prng(3);
  const packs = new Map<PackId, Uint8Array>();
  for (let p = 0; p < PACKS; p++) {
    const bytes = new Uint8Array(PACK_BYTES);
    for (let i = 0; i < bytes.length; i += 4) bytes[i] = Math.floor(rand() * 256);
    packs.set(`01ARZ3NDEKTSV4RRFFQ69G5FA${p}` as PackId, bytes);
  }
  return packs;
}

function chunkedSource(packs: Map<PackId, Uint8Array>, chunk: number): PackRangeStream {
  return async function* (packId, offset, length) {
    const bytes = packs.get(packId) as Uint8Array;
    for (let at = offset; at < offset + length; at += chunk) {
      yield bytes.subarray(at, Math.min(at + chunk, offset + length));
    }
  };
}

function nodeHasher() {
  const hash = createHash("sha1");
  return {
    update: async (chunk: Uint8Array) => {
      hash.update(chunk);
    },
    digest: async () => new Uint8Array(hash.digest()),
  };
}

async function cpuMs(run: () => Promise<number>): Promise<{ ms: number; bytes: number }> {
  const start = process.cpuUsage();
  const bytes = await run();
  const used = process.cpuUsage(start);
  return { ms: (used.user + used.system) / 1000, bytes };
}

async function drain(stream: AsyncIterable<Uint8Array>): Promise<number> {
  let n = 0;
  for await (const chunk of stream) n += chunk.length;
  return n;
}

describe.runIf(process.env.FYRDEN_BENCH)("stitch and framing CPU", () => {
  it("reports CPU per MiB", { timeout: 300_000 }, async () => {
    const packs = syntheticPacks();
    const plan = planVerbatimPack(
      [...packs.keys()].map((packId) => ({ packId, packLength: PACK_BYTES, objectCount: 1 })),
    );
    const rows: string[] = [];
    for (const [hasherName, createHasher] of [
      ["ts-sha1", undefined],
      ["node-crypto", nodeHasher],
    ] as const) {
      for (const chunk of [4096, 65536]) {
        await drain(streamVerbatimPack(plan, chunkedSource(packs, chunk))); // warm up
        const { ms, bytes } = await cpuMs(() =>
          drain(
            streamVerbatimPack(plan, chunkedSource(packs, chunk), {
              ...(createHasher ? { createHasher } : {}),
            }),
          ),
        );
        rows.push(`stitch ${hasherName} in=${chunk}: ${(ms / (bytes / MIB)).toFixed(2)} ms/MiB`);
      }
    }
    for (const chunk of [4096, 65536]) {
      const { ms, bytes } = await cpuMs(async () => {
        const source = chunkedSource(packs, chunk);
        const id = [...packs.keys()][0] as PackId;
        await drain(frameSidebandData(source(id, 0, PACK_BYTES)));
        return PACK_BYTES;
      });
      rows.push(`frame in=${chunk}: ${(ms / (bytes / MIB)).toFixed(2)} ms/MiB`);
    }
    console.info(rows.join("\n"));
    expect(rows.length).toBe(6);
  });
});
