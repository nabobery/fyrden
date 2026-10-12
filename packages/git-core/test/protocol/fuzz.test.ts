import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { oidFromHex } from "../../src/object/oid.js";
import {
  encodeRefAdvertisement,
  encodeV2CapabilityAdvertisement,
} from "../../src/protocol/capabilities.js";
import { ProtocolError } from "../../src/protocol/errors.js";
import { encodeReceivePackRequest } from "../../src/protocol/receive-pack-request.js";
import { encodeSideband } from "../../src/protocol/sideband.js";
import { encodeV2CommandRequest } from "../../src/protocol/v2-command.js";
import { CORPUS, caseBytes } from "./corpus.js";
import { bin, concat } from "./helpers.js";
import { runTarget, TARGETS, type Target } from "./targets.js";

/*
 * Mutation fuzzing: well-formed messages and the violation corpus, mutated
 * (bytes flipped, inserted, deleted, duplicated, lengths rewritten, cut
 * short), fed to every parser from a buffer and from a chunked stream. The
 * only acceptable outcomes are a result or a ProtocolError; any other
 * exception, or a hang (the test timeout), fails.
 */

const A = oidFromHex("a776c30ab4d5ecc43f0fd7746c73095827c929d6");
const B = oidFromHex("cc1cd4c840ceffbb546d10d2db8a47b5c76d6e5a");
const SEED = 20261011;

const VALID: Uint8Array[] = [
  encodeV2CommandRequest({
    command: "fetch",
    capabilities: [
      { name: "agent", value: "git/2.53.0" },
      { name: "object-format", value: "sha1" },
    ],
    args: [
      "thin-pack",
      "ofs-delta",
      "deepen 1",
      "want a776c30ab4d5ecc43f0fd7746c73095827c929d6",
      "have cc1cd4c840ceffbb546d10d2db8a47b5c76d6e5a",
      "done",
    ].map(bin),
  }),
  encodeV2CommandRequest({
    command: "ls-refs",
    capabilities: [{ name: "object-format", value: "sha1" }],
    args: ["peel", "symrefs", "unborn", "ref-prefix refs/heads/"].map(bin),
  }),
  concat(
    encodeReceivePackRequest({
      shallow: [B],
      commands: [
        { oldOid: A, newOid: B, refName: bin("refs/heads/main") },
        { oldOid: B, newOid: A, refName: bin("refs/tags/v1") },
      ],
      capabilities: [
        { name: "report-status" },
        { name: "push-options" },
        { name: "object-format", value: "sha1" },
      ],
      pushOptions: [bin("ci.skip"), bin("x")],
    }),
    bin("PACK\0\0\0\x02\0\0\0\0"),
  ),
  concat(
    encodeSideband(2, "Counting objects\r"),
    encodeSideband(1, new Uint8Array(300)),
    encodeSideband(3, "x"),
    bin("0000"),
  ),
  encodeRefAdvertisement({
    refs: [{ name: bin("refs/heads/main"), oid: A }],
    capabilities: [{ name: "quiet" }],
    version: 1,
  }),
  encodeV2CapabilityAdvertisement([
    { name: "agent", value: "git/2" },
    { name: "fetch", value: "shallow" },
  ]),
];

const SEEDS: Uint8Array[] = [...VALID, ...CORPUS.map(caseBytes).filter((b) => b.length < 4096)];

const hexDigit = fc.constantFrom(
  ..."0123456789abcdefABCDEFgz".split("").map((c) => c.charCodeAt(0)),
);

type Mutation = (bytes: Uint8Array) => Uint8Array;
const at = (n: number, bytes: Uint8Array) => (bytes.length === 0 ? 0 : n % bytes.length);

const mutationArb: fc.Arbitrary<Mutation> = fc.oneof(
  fc.tuple(fc.nat(), fc.integer({ min: 0, max: 255 })).map(
    ([i, b]): Mutation =>
      (x) => {
        const out = x.slice();
        if (out.length > 0) out[at(i, out)] = b;
        return out;
      },
  ),
  fc.tuple(fc.nat(), fc.uint8Array({ minLength: 1, maxLength: 8 })).map(
    ([i, ins]): Mutation =>
      (x) => {
        const p = at(i, x);
        return concat(x.subarray(0, p), ins, x.subarray(p));
      },
  ),
  fc.tuple(fc.nat(), fc.integer({ min: 1, max: 16 })).map(
    ([i, n]): Mutation =>
      (x) => {
        const p = at(i, x);
        return concat(x.subarray(0, p), x.subarray(p + n));
      },
  ),
  fc.tuple(fc.nat(), fc.integer({ min: 1, max: 64 })).map(
    ([i, n]): Mutation =>
      (x) => {
        const p = at(i, x);
        return concat(x.subarray(0, p + n), x.subarray(p));
      },
  ),
  // Rewrites four bytes as a plausible (or nearly plausible) length.
  fc.tuple(fc.nat(), fc.array(hexDigit, { minLength: 4, maxLength: 4 })).map(
    ([i, digits]): Mutation =>
      (x) => {
        const out = x.slice();
        out.set(
          Uint8Array.from(digits).subarray(0, Math.max(0, out.length - at(i, out))),
          at(i, out),
        );
        return out;
      },
  ),
  fc.nat().map(
    (n): Mutation =>
      (x) =>
        x.subarray(0, at(n, x)),
  ),
);

const inputArb = fc
  .tuple(fc.constantFrom(...SEEDS), fc.array(mutationArb, { minLength: 1, maxLength: 4 }))
  .map(([seed, mutations]) => mutations.reduce((bytes, m) => m(bytes), seed));

async function onlyTypedErrors(target: Target, bytes: Uint8Array, cuts?: number[]): Promise<void> {
  try {
    await runTarget(target, bytes, { maxLines: 10_000, maxBytes: 1 << 20 }, cuts);
  } catch (error) {
    if (!(error instanceof ProtocolError)) throw error;
    expect(error.message.length).toBeLessThan(400);
  }
}

describe("protocol parsers under mutation", () => {
  it.each(TARGETS)("%s throws only ProtocolError, from a buffer", async (target) => {
    await fc.assert(
      fc.asyncProperty(inputArb, (bytes) => onlyTypedErrors(target, bytes)),
      { seed: SEED, numRuns: 1500 },
    );
  });

  it.each(TARGETS)("%s throws only ProtocolError, from a chunked stream", async (target) => {
    await fc.assert(
      fc.asyncProperty(inputArb, fc.array(fc.nat(), { maxLength: 6 }), (bytes, cuts) =>
        onlyTypedErrors(
          target,
          bytes,
          cuts.map((c) => c % (bytes.length + 1)),
        ),
      ),
      { seed: SEED, numRuns: 500 },
    );
  });

  it.each(TARGETS)("%s reaches the same verdict from a buffer and a stream", async (target) => {
    const verdict = (p: Promise<unknown>) =>
      p.then(
        () => "ok",
        (e: unknown) => (e instanceof ProtocolError ? e.code : `other: ${String(e)}`),
      );
    await fc.assert(
      fc.asyncProperty(inputArb, fc.array(fc.nat(), { maxLength: 6 }), async (bytes, cuts) => {
        const limits = { maxLines: 10_000, maxBytes: 1 << 20 };
        const fromBuffer = await verdict(runTarget(target, bytes, limits));
        const fromStream = await verdict(
          runTarget(
            target,
            bytes,
            limits,
            cuts.map((c) => c % (bytes.length + 1)),
          ),
        );
        expect(fromStream).toBe(fromBuffer);
      }),
      { seed: SEED, numRuns: 500 },
    );
  });
});
