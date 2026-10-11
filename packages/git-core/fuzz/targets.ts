// What the long-running fuzzer feeds: every parser that reads bytes a client
// controls, its seed corpus, and the errors it may throw. Anything else
// thrown (a TypeError, a RangeError, a stack overflow) is a finding.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Sha1CollisionError } from "../src/hash/sha1.js";
import { parseCommit } from "../src/object/commit.js";
import { GitObjectError } from "../src/object/fsck.js";
import { oidFromHex } from "../src/object/oid.js";
import { parseTag } from "../src/object/tag.js";
import { parseTree } from "../src/object/tree.js";
import { applyDelta } from "../src/pack/delta-apply.js";
import { PackError } from "../src/pack/errors.js";
import { IdxError } from "../src/pack/idx-format.js";
import { PackIdx } from "../src/pack/idx-read.js";
import { writeIdx } from "../src/pack/idx-write.js";
import { ProtocolError } from "../src/protocol/errors.js";
import { encodeReceivePackRequest } from "../src/protocol/receive-pack-request.js";
import { bytesBody, readPushBody } from "../src/receive-pack/body.js";
import { parseGitConfig } from "../src/receive-pack/git-config.js";
import { checkGitmodules } from "../src/receive-pack/gitmodules.js";
import { makeDelta } from "../test/pack/pack-builder.js";
import { parseBytes } from "../test/pack/parse-helpers.js";
import { idxHasher, randomOids, syntheticEntries } from "../test/pack-index/support.js";
import { CORPUS, caseBytes } from "../test/protocol/corpus.js";
import { runTarget, TARGETS } from "../test/protocol/targets.js";
import { createMemoryBudget } from "../testing/fakes/memory-budget.js";

export interface FuzzTarget {
  readonly name: string;
  /** Inputs mutation starts from: valid ones first, then known-bad ones. */
  seeds(): Promise<Uint8Array[]>;
  /** Parses `input`; resolves, or rejects with whatever the parser threw. */
  run(input: Uint8Array): Promise<void>;
  /** The errors the parser is allowed to throw. */
  expected(error: unknown): boolean;
}

const corpusDir = join(import.meta.dirname, "../test/corpus");
const encoder = new TextEncoder();
const text = (s: string) => encoder.encode(s);
const hexOid = "a776c30ab4d5ecc43f0fd7746c73095827c929d6";

/** Explicit bounds per input (Proposed; raise them only with a reason). */
export const LIMITS = {
  /** pkt-line reader limits, as the fuzz tests use. */
  pktLines: { maxLines: 10_000, maxBytes: 1 << 20 },
  /**
   * MemoryBudget for pack parsing: the per-object-operation pool (Proposed
   * 72 MiB). A smaller pool makes the reservation for one entry at the
   * object-size cap (size plus its compressed bound, about 68 MiB) throw
   * the budget's RangeError instead of a PackError.
   */
  packMemoryBytes: 72 * 1024 * 1024,
  /** Largest delta result or object a parser may build. */
  maxObjectBytes: 16 * 1024 * 1024,
};

let packs: Promise<Uint8Array[]> | undefined;
/** The pack corpus (`test/corpus/packs`), valid packs first. */
function packCorpus(): Promise<Uint8Array[]> {
  packs ??= (async () => {
    const dir = join(corpusDir, "packs");
    const names = (await readdir(dir)).sort(
      (a, b) => Number(b.startsWith("ok-")) - Number(a.startsWith("ok-")) || a.localeCompare(b),
    );
    return Promise.all(names.map(async (n) => new Uint8Array(await readFile(join(dir, n)))));
  })();
  return packs;
}

let objects: Promise<Map<string, Uint8Array[]>> | undefined;
/** Every object in the valid corpus packs, by type, plus hand-made edge cases. */
function objectCorpus(): Promise<Map<string, Uint8Array[]>> {
  objects ??= (async () => {
    const byType = new Map<string, Uint8Array[]>([
      [
        "commit",
        [
          text(
            `tree ${hexOid}\nparent ${hexOid}\nauthor A U <a@x> 1 +0000\ncommitter C O <c@x> 2 -0130\nencoding UTF-8\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n -----END PGP SIGNATURE-----\n\nmessage\n`,
          ),
        ],
      ],
      ["tag", [text(`object ${hexOid}\ntype commit\ntag v1\ntagger T <t@x> 1 +0000\n\nrelease\n`)]],
      [
        "tree",
        [
          new Uint8Array([
            ...text("100644 a\0"),
            ...new Uint8Array(20).fill(1),
            ...text("40000 d\0"),
            ...new Uint8Array(20).fill(2),
          ]),
        ],
      ],
      ["blob", [text('[submodule "a"]\n\tpath = a\n\turl = https://example.invalid/a.git\n')]],
    ]);
    for (const pack of await packCorpus()) {
      try {
        const { pack: parsed, objects: found } = await parseBytes(pack);
        parsed.release();
        for (const { type, data } of found.values()) byType.get(type)?.push(data);
      } catch {
        // Bad packs give no objects.
      }
    }
    return byType;
  })();
  return objects;
}

const protocolTargets: FuzzTarget[] = TARGETS.map((target) => ({
  name: `protocol ${target}`,
  async seeds() {
    return CORPUS.map(caseBytes).filter((bytes) => bytes.length < 64 * 1024);
  },
  async run(input) {
    // Buffer and stream readers must both hold; the stream is cut in three.
    await runTarget(target, input, LIMITS.pktLines);
    const third = Math.floor(input.length / 3);
    await runTarget(target, input, LIMITS.pktLines, [third, 2 * third]);
  },
  expected: (error) => error instanceof ProtocolError,
}));

const objectTarget = (
  type: "commit" | "tag" | "tree",
  parse: (body: Uint8Array) => unknown,
): FuzzTarget => ({
  name: `object ${type}`,
  async seeds() {
    return (await objectCorpus()).get(type) ?? [];
  },
  async run(input) {
    parse(input);
  },
  expected: (error) => error instanceof GitObjectError,
});

export const FUZZ_TARGETS: readonly FuzzTarget[] = [
  ...protocolTargets,
  {
    name: "receive-pack body",
    async seeds() {
      const packed = (await packCorpus())[0] ?? new Uint8Array();
      return CORPUS.filter((c) => c.target === "receive-pack")
        .map(caseBytes)
        .concat([
          new Uint8Array([
            ...encodeReceivePackRequest({
              shallow: [],
              commands: [
                {
                  oldOid: oidFromHex("0".repeat(40)),
                  newOid: oidFromHex(hexOid),
                  refName: text("refs/heads/main"),
                },
              ],
              capabilities: [
                { name: "report-status" },
                { name: "side-band-64k" },
                { name: "push-options" },
                { name: "object-format", value: "sha1" },
              ],
              pushOptions: [text("ci.skip")],
            }),
            ...packed,
          ]),
        ]);
    },
    async run(input) {
      await readPushBody(bytesBody(input), { pushOptionsAdvertised: true });
    },
    expected: (error) => error instanceof ProtocolError,
  },
  {
    name: "pack parse",
    seeds: packCorpus,
    async run(input) {
      const { pack } = await parseBytes(input, {
        chunkSize: 1 + (input.length % 4093),
        memory: createMemoryBudget(LIMITS.packMemoryBytes),
      });
      pack.release();
    },
    expected: (error) => error instanceof PackError || error instanceof Sha1CollisionError,
  },
  {
    name: "pack delta",
    async seeds() {
      const base = text("the quick brown fox jumps over the lazy dog\n".repeat(20));
      const target = text("the quick brown cat jumps over the lazy dog\n".repeat(21));
      // The first 64 bytes of a seed are the base, the rest the delta program.
      return [
        new Uint8Array([
          ...base.subarray(0, 64),
          ...makeDelta(base.subarray(0, 64), target.subarray(0, 200)),
        ]),
      ];
    },
    async run(input) {
      applyDelta(input.subarray(0, 64), input.subarray(64), LIMITS.maxObjectBytes);
    },
    expected: (error) => error instanceof PackError,
  },
  {
    name: "pack idx",
    async seeds() {
      const out: Uint8Array[] = [];
      for (const count of [0, 1, 7, 300]) {
        const input = syntheticEntries(randomOids(count, count + 1), count + 1);
        out.push((await writeIdx(input, new Uint8Array(20), { createHasher: idxHasher })).bytes);
      }
      return out;
    },
    async run(input) {
      const idx = PackIdx.parse(input);
      idx.lookup(new Uint8Array(20));
      idx.lookup(new Uint8Array(20).fill(0xff));
    },
    expected: (error) => error instanceof IdxError,
  },
  objectTarget("commit", parseCommit),
  objectTarget("tag", parseTag),
  objectTarget("tree", parseTree),
  {
    name: "gitmodules config",
    async seeds() {
      return (await objectCorpus()).get("blob") ?? [];
    },
    async run(input) {
      parseGitConfig(input, () => {});
      checkGitmodules(input);
    },
    // Total functions: they report findings and never throw.
    expected: () => false,
  },
];
