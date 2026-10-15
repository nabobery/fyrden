import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PackError } from "../../src/pack/errors.js";
import { ObjectReader } from "../../src/reader/object-reader.js";
import { createReadStats } from "../../src/reader/stats.js";
import { createMemoryBlockCache } from "../../testing/fakes/memory-block-cache.js";
import { createMemoryBudget } from "../../testing/fakes/memory-budget.js";
import { createMemoryRepoStore } from "../../testing/fakes/memory-repo-store.js";
import { createGitSandbox, type GitSandbox } from "../../testing/git-cli.js";
import { createNodeZlib } from "../../testing/node-zlib.js";
import { prng } from "../pack/repo-fixture.js";
import { loadPack, MiB, repackedPack, toOid } from "./support.js";

/*
 * A delta whose program is larger than the large-object size (mostly new
 * bytes on a base): reading its header inflates the program, so it is
 * reserved from the memory budget first, as reading the object is.
 */

let sandbox: GitSandbox;
let packBytes: Uint8Array;
let target: string;

beforeAll(async () => {
  sandbox = await createGitSandbox();
  await sandbox.git(["init", "-q", "-b", "main"]);
  const random = prng(7);
  const bytes = (n: number) => Uint8Array.from({ length: n }, () => Math.floor(random() * 256));
  // Two versions sharing their first 1.5 MiB: either is a delta on the
  // other, with 1.1 MiB of new bytes in its program (git deltifies only
  // below half the object's size).
  const base = bytes(1.5 * MiB);
  writeFileSync(join(sandbox.dir, "f.bin"), Buffer.concat([base, bytes(1.1 * MiB)]));
  await sandbox.git(["add", "f.bin"]);
  await sandbox.git(["commit", "-q", "-m", "base"]);
  writeFileSync(join(sandbox.dir, "f.bin"), Buffer.concat([base, bytes(1.1 * MiB)]));
  await sandbox.git(["add", "f.bin"]);
  await sandbox.git(["commit", "-q", "-m", "grown"]);
  target = (await sandbox.git(["rev-parse", "HEAD:f.bin"])).stdout.trim();
  packBytes = await repackedPack(sandbox);
  // One version is stored as a delta on the other.
  const verify = await sandbox.git(["verify-pack", "-v", ...(await idxPath())]);
  expect(verify.stdout).toMatch(/ blob +\d+ +\d+ +\d+ +1 +[0-9a-f]{40}/);
}, 60_000);
afterAll(() => sandbox.dispose());

async function idxPath(): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const dir = join(sandbox.dir, ".git/objects/pack");
  return (await readdir(dir)).filter((n) => n.endsWith(".idx")).map((n) => join(dir, n));
}

describe("readHeader of a large delta", () => {
  it("reserves the program's memory, and fails when it is not there", async () => {
    const repo = createMemoryRepoStore();
    const pack = await loadPack(repo.packStore, packBytes);
    const open = (memory: number) =>
      ObjectReader.open({
        view: { scope: "net-delta", packs: [pack] },
        packStore: repo.packStore,
        zlib: createNodeZlib(),
        memory: createMemoryBudget(memory),
        blockCache: createMemoryBlockCache(),
        stats: createReadStats(),
        limits: { deltaBaseCacheBytes: MiB, rangeBytes: MiB },
      });
    // Which object is the delta depends on git's choice: find one whose header needs its program.
    const { stdout } = await sandbox.git(["rev-list", "--objects", "--all"]);
    const blobs = stdout
      .split("\n")
      .filter((l) => l.endsWith(" f.bin"))
      .map((l) => l.split(" ")[0] as string);
    expect(blobs).toContain(target);
    const roomy = await open(64 * MiB);
    const sizes = await Promise.all(
      blobs.map(async (b) => (await roomy.readHeader(toOid(b)))?.size),
    );
    roomy.release();
    expect(sizes).toEqual([2.6 * MiB, 2.6 * MiB].map(Math.floor));
    // Room for the cache and nothing else: the delta's header cannot be read.
    const tight = await open(MiB);
    const outcomes = await Promise.all(
      blobs.map((b) =>
        tight.readHeader(toOid(b)).then(
          () => "read",
          (error: unknown) => (error instanceof PackError ? error.code : String(error)),
        ),
      ),
    );
    tight.release();
    expect(outcomes.sort()).toEqual(["exceeds-memory-budget", "read"]);
  });
});
