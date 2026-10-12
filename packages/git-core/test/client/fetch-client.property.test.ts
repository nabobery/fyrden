import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  FetchClientError,
  parseLsRefsLine,
  SmartHttpClient,
} from "../../src/client/fetch-client.js";
import type { HttpTransport } from "../../src/client/transport.js";
import { concatBytes } from "../../src/object/bytes.js";
import { type Oid, oidFromBytes, oidToHex } from "../../src/object/oid.js";
import { ProtocolError } from "../../src/protocol/errors.js";
import { encodePktLine, flushPkt } from "../../src/protocol/pktline.js";
import { encodeSideband } from "../../src/protocol/sideband.js";

const SEED = 20261011;
const enc = new TextEncoder();

const oidArb = fc.uint8Array({ minLength: 20, maxLength: 20 }).map((b) => oidFromBytes(b));
/** Ref-name-like bytes: anything but space, LF and NUL. */
const nameArb = fc
  .uint8Array({ minLength: 1, maxLength: 60 })
  .map((b) => b.map((x) => (x === 0x20 || x === 0x0a || x === 0 ? 0x61 : x)));

function encodeLine(ref: {
  name: Uint8Array;
  oid: Oid;
  symrefTarget?: Uint8Array;
  peeled?: Oid;
}): Uint8Array {
  return concatBytes([
    enc.encode(`${oidToHex(ref.oid)} `),
    ref.name,
    ...(ref.symrefTarget ? [enc.encode(" symref-target:"), ref.symrefTarget] : []),
    ...(ref.peeled ? [enc.encode(` peeled:${oidToHex(ref.peeled)}`)] : []),
  ]);
}

describe("parseLsRefsLine", () => {
  it("reads back every line it could have been sent", () => {
    fc.assert(
      fc.property(
        oidArb,
        nameArb,
        fc.option(nameArb, { nil: undefined }),
        fc.option(oidArb, { nil: undefined }),
        (oid, name, symrefTarget, peeled) => {
          const ref = {
            name,
            oid,
            ...(symrefTarget ? { symrefTarget } : {}),
            ...(peeled ? { peeled } : {}),
          };
          const parsed = parseLsRefsLine(encodeLine(ref));
          expect(parsed).toEqual(ref);
        },
      ),
      { seed: SEED, numRuns: 500 },
    );
  });

  it("skips attributes it does not know", () => {
    const oid = oidFromBytes(new Uint8Array(20).fill(7));
    const line = enc.encode(`${oidToHex(oid)} refs/heads/main future:thing`);
    expect(parseLsRefsLine(line)).toEqual({ name: enc.encode("refs/heads/main"), oid });
  });

  it.each([
    "",
    "abc refs/heads/main",
    `${"a".repeat(40)}`,
    `${"a".repeat(40)} `,
    `${"a".repeat(40)}xrefs/heads/main`,
    `${"a".repeat(40)} refs/heads/main peeled:abc`,
    `${"a".repeat(40)} refs/heads/main symref-target:`,
    `${"a".repeat(40)} refs/heads/main  `,
    `unborn refs/heads/main`,
  ])("refuses %j with a ProtocolError", (line) => {
    expect(() => parseLsRefsLine(enc.encode(line))).toThrow(ProtocolError);
  });

  it("throws only ProtocolError for mutated lines", () => {
    const valid = encodeLine({
      name: enc.encode("refs/heads/main"),
      oid: oidFromBytes(new Uint8Array(20).fill(1)),
      symrefTarget: enc.encode("refs/heads/x"),
      peeled: oidFromBytes(new Uint8Array(20).fill(2)),
    });
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.nat(), fc.integer({ min: 0, max: 255 })), { maxLength: 6 }),
        fc.nat({ max: valid.length }),
        (flips, cut) => {
          const bytes = valid.slice(0, cut);
          for (const [at, value] of flips) if (bytes.length) bytes[at % bytes.length] = value;
          try {
            parseLsRefsLine(bytes);
          } catch (error) {
            expect(error).toBeInstanceOf(ProtocolError);
          }
        },
      ),
      { seed: SEED, numRuns: 2_000 },
    );
  });
});

/** A server answering from canned bytes: the advertisement, then `responses` in order. */
function canned(responses: Uint8Array[]): HttpTransport {
  const adv = concatBytes([
    encodePktLine("version 2\n"),
    encodePktLine("ls-refs\n"),
    encodePktLine("fetch\n"),
    flushPkt(),
  ]);
  let call = 0;
  return async () => {
    const body = call === 0 ? adv : (responses[call - 1] ?? new Uint8Array());
    const type =
      call === 0
        ? "application/x-git-upload-pack-advertisement"
        : "application/x-git-upload-pack-result";
    call++;
    return {
      status: 200,
      contentType: type,
      body: (async function* () {
        for (let at = 0; at < body.length; at += 3) yield body.slice(at, at + 3);
      })(),
      cancel: async () => {},
    };
  };
}

describe("response readers under mutation", () => {
  const oid = oidFromBytes(new Uint8Array(20).fill(9));
  const pack = concatBytes([enc.encode("PACK"), new Uint8Array(40).fill(5)]);
  const lsRefs = concatBytes([
    encodePktLine(`${oidToHex(oid)} refs/heads/main\n`),
    encodePktLine(`${oidToHex(oid)} HEAD symref-target:refs/heads/main\n`),
    flushPkt(),
  ]);
  const fetch = concatBytes([
    encodePktLine("packfile\n"),
    encodeSideband(1, pack, 10),
    encodeSideband(2, enc.encode("Counting\n")),
    flushPkt(),
  ]);

  it("reads the canned answers", async () => {
    const client = await SmartHttpClient.connect({ transport: canned([lsRefs, fetch]), url: "x" });
    expect(await client.lsRefs()).toHaveLength(2);
    const chunks: Uint8Array[] = [];
    expect(await client.fetchPack([oid], { write: (c) => void chunks.push(c) })).toEqual({
      bytes: pack.length,
    });
    expect(concatBytes(chunks)).toEqual(pack);
  });

  it("throws only typed errors for mutated answers", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(lsRefs, fetch),
        fc.array(fc.tuple(fc.nat(), fc.integer({ min: 0, max: 255 })), { maxLength: 4 }),
        fc.nat(),
        async (valid, flips, cutAt) => {
          const bytes = valid.slice(0, cutAt % (valid.length + 1));
          for (const [at, value] of flips) if (bytes.length) bytes[at % bytes.length] = value;
          const client = await SmartHttpClient.connect({
            transport: canned([bytes, bytes]),
            url: "x",
          });
          try {
            if (valid === lsRefs) await client.lsRefs();
            else await client.fetchPack([oid], { write: () => {} });
          } catch (error) {
            expect(
              error instanceof ProtocolError || error instanceof FetchClientError,
              String(error),
            ).toBe(true);
          }
        },
      ),
      { seed: SEED, numRuns: 1_000 },
    );
  });
});
