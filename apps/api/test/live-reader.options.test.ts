// The live reader's options for blame: an object cap, a strict delta-base
// cache, a prepaid memory adapter and a work meter, each forwarded to the
// reader and each off unless asked for, so no other caller changes.
import { createClockBlockCache } from "@fyrden/adapters-cloudflare";
import {
  createPrepaidMemory,
  createReaderWorkMeter,
  ObjectReader,
  oidFromHex,
  PackError,
  PrepaidMemoryExceeded,
  ReaderWorkSpent,
} from "@fyrden/git-core";
import { describe, expect, inject, it, vi } from "vitest";
import type { RepoDO } from "../src/do/RepoDO.js";
import { openLiveReader } from "../src/git/live-reader.js";
import { postPush, pushTarget } from "./helpers/push.js";
import { pushBody, ZERO } from "./helpers/push-fixtures.js";
import { inRepo } from "./helpers/repo-git.js";

const fx = inject("blameFixtures");
const CACHE = 1 << 20;

async function pushed(): Promise<DurableObjectStub<RepoDO>> {
  const target = await pushTarget();
  const reply = await postPush(
    target,
    pushBody([{ old: ZERO, new: fx.tip, ref: "refs/heads/main" }], { pack: fx.pack }),
  );
  expect(reply.report).toContain("ok refs/heads/main\n");
  return target.repo.stub;
}

type Options = Parameters<typeof openLiveReader>[1];

/** Opens a reader in the repository with `options`, runs `use`, and releases it. */
function withReader<R>(
  stub: DurableObjectStub<RepoDO>,
  options: Partial<Options>,
  use: (reader: ObjectReader) => Promise<R>,
): Promise<R> {
  return inRepo(stub, async (repo) => {
    const reader = await openLiveReader(
      { git: repo.git, memoryBlocks: createClockBlockCache() },
      { deltaBaseCacheBytes: CACHE, maxCacheCalls: 0, ...options },
    );
    if (!reader) throw new Error("no packs");
    try {
      return await use(reader);
    } finally {
      reader.release();
    }
  });
}

/** What reached `ObjectReader.open`, the parts these options set. */
function opened(stub: DurableObjectStub<RepoDO>, options: Partial<Options>) {
  return inRepo(stub, async (repo) => {
    const open = vi.spyOn(ObjectReader, "open");
    try {
      const reader = await openLiveReader(
        { git: repo.git, memoryBlocks: createClockBlockCache() },
        { deltaBaseCacheBytes: CACHE, maxCacheCalls: 0, ...options },
      );
      reader?.release();
      const given = open.mock.calls[0]?.[0];
      return {
        maxObjectBytes: given?.limits?.maxObjectBytes,
        strictDeltaCache: given?.strictDeltaCache,
        work: given?.work,
        gitMemory: given?.memory === repo.git.memory,
      };
    } finally {
      open.mockRestore();
    }
  });
}

describe("openLiveReader's blame options", () => {
  it("forwards none of them unless asked, and each one when asked", async () => {
    const stub = await pushed();
    expect(await opened(stub, {})).toEqual({
      maxObjectBytes: undefined,
      strictDeltaCache: undefined,
      work: undefined,
      gitMemory: true,
    });
    const work = createReaderWorkMeter({ limit: 1_000_000 });
    const memory = createPrepaidMemory(12 << 20);
    expect(
      await opened(stub, { maxObjectBytes: 4096, strictDeltaCache: true, work, memory }),
    ).toEqual({ maxObjectBytes: 4096, strictDeltaCache: true, work, gitMemory: false });
  });

  it("refuses an object over the cap as object-too-large, and reads one under it", async () => {
    const stub = await pushed();
    const seen = await withReader(stub, { maxObjectBytes: 4096 }, async (reader) => {
      const tip = await reader.readObject(oidFromHex(fx.tip));
      const refused = await reader.readObject(oidFromHex(fx.commits.fits as string)).then(
        () => "read",
        (error) => (error instanceof PackError ? error.code : String(error)),
      );
      return { tip: tip?.type, refused };
    });
    expect(seen).toEqual({ tip: "commit", refused: "object-too-large" });
  });

  it("charges the work meter, and stops at its limit", async () => {
    const stub = await pushed();
    const work = createReaderWorkMeter({ limit: 1_000_000 });
    await withReader(stub, { work }, (reader) => reader.readObject(oidFromHex(fx.tip)));
    expect(work.spent()).toBeGreaterThan(0);
    const tight = createReaderWorkMeter({ limit: 1 });
    const refused = await withReader(stub, { work: tight }, (reader) =>
      reader.readObject(oidFromHex(fx.tip)).then(
        () => "read",
        (error) => (error instanceof ReaderWorkSpent ? "ReaderWorkSpent" : String(error)),
      ),
    );
    expect(refused).toBe("ReaderWorkSpent");
  });

  it("reserves through the prepaid adapter, whose refusal passes through unchanged", async () => {
    const stub = await pushed();
    const memory = createPrepaidMemory(12 << 20);
    await withReader(stub, { memory }, (reader) => reader.readObject(oidFromHex(fx.tip)));
    expect(memory.peak()).toBeGreaterThanOrEqual(CACHE);
    const short = createPrepaidMemory(CACHE - 1);
    const refused = await inRepo(stub, (repo) =>
      openLiveReader(
        { git: repo.git, memoryBlocks: createClockBlockCache() },
        { deltaBaseCacheBytes: CACHE, maxCacheCalls: 0, memory: short },
      ).then(
        () => "opened",
        (error) =>
          error instanceof PrepaidMemoryExceeded ? "PrepaidMemoryExceeded" : String(error),
      ),
    );
    expect(refused).toBe("PrepaidMemoryExceeded");
  });
});
