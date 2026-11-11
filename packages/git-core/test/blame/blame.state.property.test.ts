import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import {
  type BlameCommitInfo,
  type BlameState,
  BlameStateError,
  BlameStateTooLarge,
  decodeBlameState,
  encodeBlameState,
  liveStateBytes,
} from "../../src/blame/state.js";
import { oidFromHex } from "../../src/object/oid.js";

/*
 * A checkpoint is untrusted bytes: a bad object in the bucket must not run
 * arbitrary walks or allocate from a forged count. It either decodes to a
 * state that holds together, or throws BlameStateError.
 */

const oid = (k: number) => oidFromHex(k.toString(16).padStart(40, "0"));

const facts = fc.record({
  summary: fc.string({ maxLength: 20 }),
  name: fc.string({ maxLength: 10 }),
  email: fc.string({ maxLength: 10 }),
  date: fc.constant("2026-01-01T00:00:00Z"),
}) as fc.Arbitrary<BlameCommitInfo>;

/** A state whose lines are split between pending entries and settled ranges at random. */
const states: fc.Arbitrary<BlameState> = fc
  .record({
    lines: fc.integer({ min: 0, max: 60 }),
    splits: fc.array(fc.integer({ min: 0, max: 7 }), { minLength: 60, maxLength: 60 }),
    factsList: fc.array(facts, { minLength: 3, maxLength: 3 }),
    stateLimit: fc.boolean(),
  })
  .map(({ lines, splits, factsList, stateLimit }) => {
    const byCommit = new Map<number, number[]>();
    const settled: number[] = [];
    for (let line = 0; line < lines; line++) {
      const place = splits[line] as number;
      if (place < 3 && !stateLimit) {
        const list = byCommit.get(place) ?? [];
        list.push(line + 5, line);
        byCommit.set(place, list);
      } else if (!stateLimit || place < 5) {
        // A settled line of its own, by commit or by reason.
        settled.push(
          line,
          1,
          place % 2 === 0 ? 0 : -1 - (place % 3),
          place % 2 === 0 ? line + 1 : 0,
        );
      }
    }
    const queue = [...byCommit.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([k, pairs]) => ({
        oid: oid(k + 1),
        generation: 100 - k,
        level: 100 - k,
        pairs: Int32Array.from(pairs),
      }));
    return {
      commit: oid(99),
      path: [new TextEncoder().encode("dir"), new TextEncoder().encode("f.ts")],
      lines,
      steps: splits[0] as number,
      queue,
      ranges: Int32Array.from(settled),
      rangeCount: settled.length / 4,
      facts: Object.fromEntries(factsList.slice(0, 1).map((fact) => [oidHex(99), fact])),
      factOrder: [oid(99)],
      stateLimit,
    } as unknown as BlameState;
  });

function oidHex(k: number): string {
  return k.toString(16).padStart(40, "0");
}

describe("blame state encoding", () => {
  it("round-trips", () => {
    fc.assert(
      fc.property(states, (state) => {
        const encoded = encodeBlameState(state);
        const decoded = decodeBlameState(encoded);
        expect(encodeBlameState(decoded)).toEqual(encoded);
        expect(decoded.lines).toBe(state.lines);
        expect(decoded.queue.length).toBe(state.queue.length);
        expect(decoded.stateLimit).toBe(state.stateLimit);
      }),
    );
  });

  it("only ever throws its own error, on any change to the bytes", () => {
    fc.assert(
      fc.property(
        states,
        fc.integer({ min: 0 }),
        fc.integer({ min: 1, max: 255 }),
        (state, at, xor) => {
          const encoded = encodeBlameState(state);
          const bad = encoded.slice();
          const place = at % bad.length;
          bad[place] = (bad[place] as number) ^ xor;
          try {
            decodeBlameState(bad);
          } catch (error) {
            expect(error).toBeInstanceOf(BlameStateError);
          }
        },
      ),
    );
  });

  it("refuses every truncation", () => {
    fc.assert(
      fc.property(states, fc.integer({ min: 0 }), (state, cut) => {
        const encoded = encodeBlameState(state);
        const short = encoded.subarray(0, cut % encoded.length);
        expect(() => decodeBlameState(short)).toThrow(BlameStateError);
      }),
    );
  });

  it("refuses bytes past the end, and unknown versions", () => {
    fc.assert(
      fc.property(states, (state) => {
        const encoded = encodeBlameState(state);
        const long = new Uint8Array(encoded.length + 1);
        long.set(encoded);
        expect(() => decodeBlameState(long)).toThrow(BlameStateError);
        const other = encoded.slice();
        other[4] = 99;
        expect(() => decodeBlameState(other)).toThrow(BlameStateError);
      }),
    );
  });

  it("refuses a state that doesn't account for each line exactly once", () => {
    const base: BlameState = {
      commit: oid(9),
      path: [new TextEncoder().encode("f")],
      lines: 2,
      steps: 0,
      queue: [{ oid: oid(1), generation: 1, level: 1, pairs: Int32Array.of(0, 0, 1, 0) }],
      ranges: new Int32Array(0),
      rangeCount: 0,
      facts: {},
      factOrder: [],
      stateLimit: false,
    };
    expect(() => decodeBlameState(encodeBlameState(base))).toThrow(BlameStateError);
    const missing = {
      ...base,
      queue: [{ ...base.queue[0], pairs: Int32Array.of(0, 0) }],
    } as BlameState;
    expect(() => decodeBlameState(encodeBlameState(missing))).toThrow(BlameStateError);
  });

  it("refuses a queue out of order, and a duplicate commit", () => {
    const entry = (k: number, gen: number, final: number) => ({
      oid: oid(k),
      generation: gen,
      level: gen,
      pairs: Int32Array.of(0, final),
    });
    const state = (queue: BlameState["queue"]): BlameState => ({
      commit: oid(9),
      path: [new TextEncoder().encode("f")],
      lines: 2,
      steps: 0,
      queue,
      ranges: new Int32Array(0),
      rangeCount: 0,
      facts: {},
      factOrder: [],
      stateLimit: false,
    });
    expect(() =>
      decodeBlameState(encodeBlameState(state([entry(1, 5, 0), entry(2, 4, 1)]))),
    ).not.toThrow();
    expect(() =>
      decodeBlameState(encodeBlameState(state([entry(1, 4, 0), entry(2, 5, 1)]))),
    ).toThrow(BlameStateError);
    expect(() =>
      decodeBlameState(encodeBlameState(state([entry(1, 5, 0), entry(1, 5, 1)]))),
    ).toThrow(BlameStateError);
  });

  it("checks the room from the counts, before building anything", () => {
    const pairs = new Int32Array(2000);
    for (let k = 0; k < 1000; k++) {
      pairs[2 * k] = k;
      pairs[2 * k + 1] = k;
    }
    const state: BlameState = {
      commit: oid(9),
      path: [new TextEncoder().encode("f")],
      lines: 1000,
      steps: 0,
      queue: [{ oid: oid(1), generation: 1, level: 1, pairs }],
      ranges: new Int32Array(0),
      rangeCount: 0,
      facts: {},
      factOrder: [],
      stateLimit: false,
    };
    const bytes = encodeBlameState(state);
    const live = liveStateBytes(state);
    expect(decodeBlameState(bytes, { maxLiveStateBytes: live }).lines).toBe(1000);
    expect(() => decodeBlameState(bytes, { maxLiveStateBytes: live - 1 })).toThrow(
      BlameStateTooLarge,
    );
  });

  it("counts a path against the room before building its segments", () => {
    const state: BlameState = {
      commit: oid(9),
      path: Array.from({ length: 65_535 }, () => new Uint8Array(0)),
      lines: 1,
      steps: 0,
      queue: [{ oid: oid(1), generation: 1, level: 1, pairs: new Int32Array([0, 0]) }],
      ranges: new Int32Array(0),
      rangeCount: 0,
      facts: {},
      factOrder: [],
      stateLimit: false,
    };
    const bytes = encodeBlameState(state);
    const live = liveStateBytes(state);
    expect(live).toBeGreaterThan(65_535 * 208);
    expect(decodeBlameState(bytes, { maxLiveStateBytes: live }).path).toHaveLength(65_535);
    // Building a segment takes a view or a copy of the checkpoint's bytes. Fewer of
    // both than the path has segments means none was built: a few views are the
    // decoder's own (the commit's id, among others), so their exact count isn't the claim.
    const views = vi.spyOn(Uint8Array.prototype, "subarray");
    const copies = vi.spyOn(Uint8Array.prototype, "slice");
    let thrown: unknown;
    let taken = 0;
    try {
      decodeBlameState(bytes, { maxLiveStateBytes: live - 1 });
    } catch (error) {
      thrown = error;
    } finally {
      taken = views.mock.calls.length + copies.mock.calls.length;
      views.mockRestore();
      copies.mockRestore();
    }
    expect(thrown).toBeInstanceOf(BlameStateTooLarge);
    expect(taken).toBeLessThan(1_000);
  });

  describe("a fact's text", () => {
    const withFact = (fields: readonly Uint8Array[]) => {
      const state: BlameState = {
        commit: oid(9),
        path: [new TextEncoder().encode("f")],
        lines: 1,
        steps: 0,
        queue: [],
        ranges: Int32Array.of(0, 1, 0, 1),
        rangeCount: 1,
        facts: { [oidHex(1)]: { summary: "s", name: "n", email: "e", date: "d" } },
        factOrder: [oid(1)],
        stateLimit: false,
      };
      const bytes = encodeBlameState(state);
      // The fact is last: its one-byte fields are replaced with these.
      const head = bytes.subarray(0, bytes.length - 4 * 3);
      const body = fields.flatMap((field) => [
        Uint8Array.of(field.length >> 8, field.length & 255),
        field,
      ]);
      return Buffer.concat([head, ...body]);
    };

    it.each([
      ["one bad byte", Uint8Array.of(0xff)],
      ["a long run of bad bytes", new Uint8Array(60_000).fill(0xff)],
      ["a stray continuation", Uint8Array.of(0x61, 0x80, 0x62)],
      ["a truncated sequence", Uint8Array.of(0xe2, 0x82)],
      ["an overlong form", Uint8Array.of(0xc0, 0xaf)],
      ["an encoded surrogate", Uint8Array.of(0xed, 0xa0, 0x80)],
    ])("refuses %s, as bytes that aren't a state", (_title, field) => {
      const good = new TextEncoder().encode("ok");
      for (const at of [0, 1, 2, 3]) {
        const fields = [good, good, good, good];
        fields[at] = field;
        expect(() => decodeBlameState(withFact(fields))).toThrow(BlameStateError);
      }
    });

    it("what it admits, it re-encodes to the same bytes, and within the charge it gave", () => {
      const long = new TextEncoder().encode("é€".repeat(10_000));
      const bom = Uint8Array.of(0xef, 0xbb, 0xbf, 0x61);
      const bytes = withFact([long, bom, long, bom]);
      const state = decodeBlameState(bytes);
      expect(Buffer.compare(encodeBlameState(state), bytes)).toBe(0);
    });

    it("charges for what the runtime stores: two bytes a character, once one is wide", () => {
      // 60,000 ASCII characters and one wide one take 120,002 bytes as a string.
      const field = new TextEncoder().encode(`${"a".repeat(60_000)}€`);
      const bytes = withFact([field, field, field, field]);
      const live = liveStateBytes(decodeBlameState(bytes));
      expect(live).toBeGreaterThanOrEqual(4 * 120_002);
      expect(decodeBlameState(bytes, { maxLiveStateBytes: live }).lines).toBe(1);
      expect(() => decodeBlameState(bytes, { maxLiveStateBytes: live - 1 })).toThrow(
        BlameStateTooLarge,
      );
    });
  });

  it("refuses a forged count without allocating for it", () => {
    const state: BlameState = {
      commit: oid(9),
      path: [new TextEncoder().encode("f")],
      lines: 1,
      steps: 0,
      queue: [{ oid: oid(1), generation: 1, level: 1, pairs: Int32Array.of(0, 0) }],
      ranges: new Int32Array(0),
      rangeCount: 0,
      facts: {},
      factOrder: [],
      stateLimit: false,
    };
    const bytes = encodeBlameState(state);
    // Every four-byte field, in turn, made as large as a count can claim.
    for (let at = 5; at + 4 <= bytes.length; at++) {
      const bad = bytes.slice();
      new DataView(bad.buffer).setUint32(at, 0xfffffff0);
      try {
        decodeBlameState(bad);
      } catch (error) {
        expect(error).toBeInstanceOf(BlameStateError);
      }
    }
  });
});
