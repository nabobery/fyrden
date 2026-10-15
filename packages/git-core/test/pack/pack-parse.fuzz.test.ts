import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Sha1CollisionError } from "../../src/hash/sha1.js";
import { PackError } from "../../src/pack/errors.js";
import { createGitSandbox, type GitSandbox } from "../../testing/git-cli.js";
import { gitAccepts } from "./git-oracle.js";
import { withTrailer } from "./pack-builder.js";
import { parseBytes } from "./parse-helpers.js";

/*
 * Mutation fuzz: valid packs from the corpus, mutated (bit flips, byte
 * overwrites, truncation, insertion, deletion), with the trailer recomputed
 * half the time so the second pass runs on broken entries too. The parser
 * must either accept or throw a typed error, finish quickly, and agree with
 * `git index-pack` on accept or reject.
 */

const CORPUS = join(import.meta.dirname, "../corpus/packs");
const TIME_LIMIT_MS = 5000;

let seeds: Uint8Array[];
let sandbox: GitSandbox;
beforeAll(async () => {
  const names = (await readdir(CORPUS)).filter((n) => n.startsWith("ok-"));
  seeds = await Promise.all(
    names.map(async (n) => new Uint8Array(await readFile(join(CORPUS, n)))),
  );
  sandbox = await createGitSandbox();
  await sandbox.git(["init", "-q"]);
});
afterAll(() => sandbox.dispose());

type Mutation =
  | { op: "flip"; at: number; bit: number }
  | { op: "set"; at: number; value: number }
  | { op: "truncate"; at: number }
  | { op: "insert"; at: number; bytes: Uint8Array }
  | { op: "delete"; at: number; length: number };

const mutationArb: fc.Arbitrary<Mutation> = fc.oneof(
  fc.record({
    op: fc.constant("flip" as const),
    at: fc.nat(),
    bit: fc.integer({ min: 0, max: 7 }),
  }),
  fc.record({
    op: fc.constant("set" as const),
    at: fc.nat(),
    value: fc.integer({ min: 0, max: 255 }),
  }),
  fc.record({ op: fc.constant("truncate" as const), at: fc.nat() }),
  fc.record({
    op: fc.constant("insert" as const),
    at: fc.nat(),
    bytes: fc.uint8Array({ minLength: 1, maxLength: 8 }),
  }),
  fc.record({
    op: fc.constant("delete" as const),
    at: fc.nat(),
    length: fc.integer({ min: 1, max: 8 }),
  }),
);

function mutate(pack: Uint8Array, mutations: readonly Mutation[], fixTrailer: boolean): Uint8Array {
  let bytes = fixTrailer ? pack.slice(0, pack.length - 20) : pack.slice();
  for (const m of mutations) {
    const at = bytes.length === 0 ? 0 : m.at % bytes.length;
    if (m.op === "flip") bytes[at] = (bytes[at] as number) ^ (1 << m.bit);
    else if (m.op === "set") bytes[at] = m.value;
    else if (m.op === "truncate") bytes = bytes.slice(0, at);
    else if (m.op === "insert")
      bytes = new Uint8Array([...bytes.subarray(0, at), ...m.bytes, ...bytes.subarray(at)]);
    else bytes = new Uint8Array([...bytes.subarray(0, at), ...bytes.subarray(at + m.length)]);
  }
  return fixTrailer ? withTrailer(bytes) : bytes;
}

async function verdict(bytes: Uint8Array, chunkSize: number): Promise<"ok" | "rejected"> {
  // biome-ignore lint/style/noRestrictedGlobals: a hang guard (the fuzz target must finish), far above any normal run; it reports a stuck parser rather than timing anything.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    // biome-ignore lint/style/noRestrictedGlobals: the same hang guard.
    timer = setTimeout(() => reject(new Error("parser did not finish in time")), TIME_LIMIT_MS);
  });
  try {
    const { pack } = await Promise.race([parseBytes(bytes, { chunkSize }), timeout]);
    pack.release();
    return "ok";
  } catch (error) {
    if (error instanceof PackError || error instanceof Sha1CollisionError) return "rejected";
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

describe("pack-parse mutation fuzz", () => {
  it("throws only typed errors, never hangs, and agrees with git index-pack", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.nat(),
        fc.array(mutationArb, { minLength: 1, maxLength: 3 }),
        fc.boolean(),
        fc.integer({ min: 1, max: 5000 }),
        async (which, mutations, fixTrailer, chunkSize) => {
          const seed = seeds[which % seeds.length] as Uint8Array;
          const bytes = mutate(seed, mutations, fixTrailer);
          const ours = await verdict(bytes, chunkSize);
          const git = (await gitAccepts(sandbox, bytes)) ? "ok" : "rejected";
          expect(ours).toBe(git);
        },
      ),
      // FYRDEN_FUZZ_RUNS raises the count for a longer local or nightly run.
      { numRuns: Number(process.env.FYRDEN_FUZZ_RUNS ?? 400) },
    );
  }, 300_000);
});
