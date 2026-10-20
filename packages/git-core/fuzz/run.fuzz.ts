// Long-running mutation fuzzer over the byte parsers (fuzz/targets.ts):
// fast-check mutates seed corpora (byte edits, splices between seeds,
// rewritten lengths) for a time budget per target, with explicit bounds.
// The per-commit tests run the same idea for a fixed, small number of
// inputs; this runner is for long budgets (nightly).
//
//   pnpm --filter @fyrden/git-core fuzz
//   FYRDEN_FUZZ_SECONDS=300   budget per target (default 10)
//   FYRDEN_FUZZ_SEED=1234     reproduce a run (default: random, printed)
//   FYRDEN_FUZZ_TARGET=pack   only targets whose name contains this
//   FYRDEN_FUZZ_OUT=dir       where failing inputs are written
//
// Bounds: inputs up to 1 MiB; each input must finish in FYRDEN_FUZZ_INPUT_MS
// (default 2000; measured after the fact, so a parser that never returns is
// caught by the job's timeout instead); live memory (JavaScript heap plus
// ArrayBuffers, after a garbage collection; the config runs Node with
// --expose-gc) must stay under FYRDEN_FUZZ_MAX_LIVE_MB (default 1024), which
// catches leaks across inputs; the process's resident memory must stay under
// FYRDEN_FUZZ_MAX_RSS_MB (default 2048), a hard cap that protects the machine;
// the heap itself is capped by --max-old-space-size (vitest.fuzz.config.ts);
// parsers run with the limits in LIMITS (fuzz/targets.ts).
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as eventLoopTurn } from "node:timers/promises";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { FUZZ_TARGETS, type FuzzTarget } from "./targets.js";

const SECONDS = Number(process.env.FYRDEN_FUZZ_SECONDS ?? 10);
const SEED = Number(process.env.FYRDEN_FUZZ_SEED ?? Math.floor(Math.random() * 2 ** 31));
const INPUT_MS = Number(process.env.FYRDEN_FUZZ_INPUT_MS ?? 2000);
const MAX_LIVE = Number(process.env.FYRDEN_FUZZ_MAX_LIVE_MB ?? 1024) * 1024 * 1024;
const MAX_RSS = Number(process.env.FYRDEN_FUZZ_MAX_RSS_MB ?? 2048) * 1024 * 1024;
const OUT = process.env.FYRDEN_FUZZ_OUT ?? join(tmpdir(), "fyrden-fuzz-findings");
const ONLY = process.env.FYRDEN_FUZZ_TARGET;
const MAX_INPUT = 1024 * 1024;
const BATCH = 200;

console.log(`fuzz seed ${SEED}, ${SECONDS} s per target (FYRDEN_FUZZ_SEED reproduces)`);

type Edit = (input: Uint8Array, seeds: readonly Uint8Array[]) => Uint8Array;
const at = (n: number, length: number) => (length === 0 ? 0 : n % length);
const join2 = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
};
const hexDigits = "0123456789abcdefABCDEF".split("").map((c) => c.charCodeAt(0));

const editArb: fc.Arbitrary<Edit> = fc.oneof(
  fc.tuple(fc.nat(), fc.integer({ min: 0, max: 7 })).map(
    ([i, bit]): Edit =>
      (x) => {
        const out = x.slice();
        if (out.length > 0)
          out[at(i, out.length)] = (out[at(i, out.length)] as number) ^ (1 << bit);
        return out;
      },
  ),
  fc.tuple(fc.nat(), fc.constantFrom(0, 1, 0x7f, 0x80, 0xff, 0x0a, 0x20)).map(
    ([i, b]): Edit =>
      (x) => {
        const out = x.slice();
        if (out.length > 0) out[at(i, out.length)] = b;
        return out;
      },
  ),
  fc.tuple(fc.nat(), fc.uint8Array({ minLength: 1, maxLength: 16 })).map(
    ([i, bytes]): Edit =>
      (x) => {
        const p = at(i, x.length + 1);
        return join2(x.subarray(0, p), bytes, x.subarray(p));
      },
  ),
  fc.tuple(fc.nat(), fc.integer({ min: 1, max: 64 })).map(
    ([i, n]): Edit =>
      (x) => {
        const p = at(i, x.length);
        return join2(x.subarray(0, p), x.subarray(p + n));
      },
  ),
  // Duplicates a run of bytes (repeated sections, long lines).
  fc.tuple(fc.nat(), fc.integer({ min: 1, max: 256 }), fc.integer({ min: 1, max: 8 })).map(
    ([i, n, times]): Edit =>
      (x) => {
        const p = at(i, x.length);
        const run = x.subarray(p, p + n);
        return join2(x.subarray(0, p), ...Array.from({ length: times }, () => run), x.subarray(p));
      },
  ),
  // Four hex digits written over the input: a plausible pkt-line length.
  fc.tuple(fc.nat(), fc.array(fc.constantFrom(...hexDigits), { minLength: 4, maxLength: 4 })).map(
    ([i, digits]): Edit =>
      (x) => {
        const out = x.slice();
        const p = at(i, out.length);
        out.set(Uint8Array.from(digits).subarray(0, out.length - p), p);
        return out;
      },
  ),
  // A big-endian 32-bit word (counts, sizes, offsets) set to an edge value.
  fc.tuple(fc.nat(), fc.constantFrom(0, 1, 0x7fffffff, 0x80000000, 0xffffffff)).map(
    ([i, value]): Edit =>
      (x) => {
        const out = x.slice();
        if (out.length < 4) return out;
        new DataView(out.buffer, out.byteOffset).setUint32(at(i, out.length - 3), value);
        return out;
      },
  ),
  fc.nat().map(
    (i): Edit =>
      (x) =>
        x.subarray(0, at(i, x.length)),
  ),
  // Splices the tail of another seed in.
  fc.tuple(fc.nat(), fc.nat(), fc.nat()).map(
    ([i, which, from]): Edit =>
      (x, seeds) => {
        const other = seeds[at(which, seeds.length)] ?? new Uint8Array();
        return join2(x.subarray(0, at(i, x.length)), other.subarray(at(from, other.length)));
      },
  ),
);

async function findingFile(target: FuzzTarget, input: Uint8Array): Promise<string> {
  await mkdir(OUT, { recursive: true });
  const digest = createHash("sha256").update(input).digest("hex").slice(0, 16);
  const file = join(OUT, `${target.name.replace(/[^a-z0-9]+/gi, "-")}-${digest}.bin`);
  await writeFile(file, input);
  return file;
}

async function check(target: FuzzTarget, input: Uint8Array): Promise<void> {
  const started = performance.now();
  try {
    await target.run(input);
  } catch (error) {
    if (!target.expected(error)) throw error;
  }
  const elapsed = performance.now() - started;
  if (elapsed > INPUT_MS) {
    throw new Error(
      `took ${Math.round(elapsed)} ms (bound ${INPUT_MS} ms) for ${input.length} bytes`,
    );
  }
  if (live() > MAX_LIVE) {
    // Garbage from earlier inputs counts too; judge only what survives a collection, after the
    // callbacks earlier inputs left waiting have run (see the batch loop).
    await eventLoopTurn();
    gc();
    const bytes = live();
    if (bytes > MAX_LIVE) throw new Error(`${bytes} bytes still live, bound ${MAX_LIVE}`);
  }
  const rss = process.memoryUsage.rss();
  if (rss > MAX_RSS) {
    gc();
    if (process.memoryUsage.rss() > MAX_RSS)
      throw new Error(`resident memory ${rss} bytes, cap ${MAX_RSS}`);
  }
}

/** JavaScript heap plus ArrayBuffer memory in use (not RSS, which V8 does not hand back). */
const live = () => {
  const usage = process.memoryUsage();
  return usage.heapUsed + usage.arrayBuffers;
};
const exposedGc = (globalThis as { gc?: () => void }).gc;
if (!exposedGc) throw new Error("run with --expose-gc (vitest.fuzz.config.ts sets it)");
const gc: () => void = exposedGc;

const targets = FUZZ_TARGETS.filter((t) => !ONLY || t.name.includes(ONLY));

describe("fuzz", () => {
  it.each(targets.map((t) => [t.name, t] as const))(
    "%s: only typed errors, within time and memory bounds",
    async (_, target) => {
      const seeds = await target.seeds();
      expect(seeds.length).toBeGreaterThan(0);
      for (const seed of seeds) await check(target, seed);

      const inputArb = fc
        .tuple(fc.nat({ max: seeds.length - 1 }), fc.array(editArb, { minLength: 1, maxLength: 6 }))
        .map(([which, edits]) =>
          edits.reduce((bytes, edit) => edit(bytes, seeds), seeds[which] as Uint8Array),
        )
        .filter((bytes) => bytes.length <= MAX_INPUT);

      const deadline = Date.now() + SECONDS * 1000;
      let runs = 0;
      for (let batch = 0; Date.now() < deadline; batch++) {
        const result = await fc.check(
          fc.asyncProperty(inputArb, (input) => check(target, input)),
          { seed: SEED + batch, numRuns: BATCH },
        );
        runs += result.numRuns;
        // Parsing resolves through promises alone, so without a turn of the event loop the
        // process.nextTick queue never runs: each failed node:zlib inflateSync leaves its
        // destroyed stream there (error and close callbacks) with its buffers, about 1.3 KiB
        // apiece, which passed the live-memory bound within a minute (measured, Node 24).
        await eventLoopTurn();
        if (result.failed) {
          const input = result.counterexample?.[0] as Uint8Array;
          const file = await findingFile(target, input);
          throw new Error(
            `${target.name}: ${String(result.errorInstance)}\ninput written to ${file} (seed ${SEED + batch}, path ${result.counterexamplePath})`,
          );
        }
      }
      console.log(`${target.name}: ${runs} inputs, no findings`);
    },
  );
});
