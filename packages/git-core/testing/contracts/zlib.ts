import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type Zlib, ZlibError, type ZlibErrorKind } from "../../src/ports/zlib.js";

function kindOf(run: () => unknown): ZlibErrorKind | "ok" | "other" {
  try {
    run();
    return "ok";
  } catch (error) {
    return error instanceof ZlibError ? error.kind : "other";
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/** The behaviour every `Zlib` implementation must have. */
export function describeZlibContract(name: string, create: () => Promise<Zlib>): void {
  describe(`${name}: Zlib contract`, () => {
    it("round-trips any bytes at any level and reports the stream length as consumed", async () => {
      const zlib = await create();
      await fc.assert(
        fc.property(
          fc.uint8Array({ maxLength: 3000 }),
          fc.integer({ min: 0, max: 9 }),
          fc.uint8Array({ maxLength: 40 }),
          (data, level, trailing) => {
            const stream = zlib.deflate(data, { level });
            const { output, consumed } = zlib.inflate(concat(stream, trailing), {
              maxOutput: data.length + 1,
            });
            expect(output).toEqual(data);
            expect(consumed).toBe(stream.length);
          },
        ),
        { numRuns: 100 },
      );
    });

    it("handles outputs larger than one internal chunk", async () => {
      const zlib = await create();
      const data = new Uint8Array(300_000);
      for (let i = 0; i < data.length; i++) data[i] = (i * 7919) % 251;
      const stream = zlib.deflate(data);
      const { output, consumed } = zlib.inflate(concat(stream, new Uint8Array([1, 2, 3])), {
        maxOutput: data.length,
      });
      expect(output).toEqual(data);
      expect(consumed).toBe(stream.length);
    });

    it("inflates an empty stream", async () => {
      const zlib = await create();
      const stream = zlib.deflate(new Uint8Array(0));
      const { output, consumed } = zlib.inflate(stream, { maxOutput: 1 });
      expect(output.length).toBe(0);
      expect(consumed).toBe(stream.length);
    });

    it("reports every proper prefix of a stream as truncated", async () => {
      const zlib = await create();
      const stream = zlib.deflate(new TextEncoder().encode("hello hello hello world"));
      for (let cut = 0; cut < stream.length; cut++) {
        expect(kindOf(() => zlib.inflate(stream.subarray(0, cut), { maxOutput: 100 }))).toBe(
          "truncated",
        );
      }
    });

    it("refuses to produce more than maxOutput bytes", async () => {
      const zlib = await create();
      const data = new Uint8Array(100_000); // compresses to about 100 bytes: a small bomb
      const stream = zlib.deflate(data);
      expect(kindOf(() => zlib.inflate(stream, { maxOutput: 99_999 }))).toBe("output-limit");
      expect(kindOf(() => zlib.inflate(stream, { maxOutput: 10 }))).toBe("output-limit");
      expect(zlib.inflate(stream, { maxOutput: 100_000 }).output.length).toBe(100_000);
    });

    it("reports bad headers, bad blocks, bad checksums and preset dictionaries as corrupt", async () => {
      const zlib = await create();
      const stream = zlib.deflate(new TextEncoder().encode("some object body"));
      const badAdler = stream.slice();
      badAdler[badAdler.length - 1] = (badAdler[badAdler.length - 1] as number) ^ 1;
      const cases = [
        new Uint8Array([0x12, 0x34, 0x56, 0x78]), // header check fails
        new Uint8Array([0x78, 0x9c, 0xff, 0xff, 0xff]), // reserved block type
        badAdler,
        // FDICT set (0x78 0xbb passes the header check): git never uses a dictionary.
        new Uint8Array([0x78, 0xbb, 0, 0, 0, 1, 0x03, 0x00]),
      ];
      for (const input of cases)
        expect(kindOf(() => zlib.inflate(input, { maxOutput: 100 }))).toBe("corrupt");
    });

    it("rejects a maxOutput that is not a positive safe integer", async () => {
      const zlib = await create();
      const stream = zlib.deflate(new Uint8Array(1));
      for (const maxOutput of [0, -1, 1.5, Number.NaN]) {
        expect(() => zlib.inflate(stream, { maxOutput })).toThrow(RangeError);
      }
    });

    it("never throws anything but ZlibError on arbitrary input", async () => {
      const zlib = await create();
      fc.assert(
        fc.property(fc.uint8Array({ maxLength: 200 }), (input) => {
          expect(kindOf(() => zlib.inflate(input, { maxOutput: 4096 }))).not.toBe("other");
        }),
        { numRuns: 300 },
      );
    });
  });
}
