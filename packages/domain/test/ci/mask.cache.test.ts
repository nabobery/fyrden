// Matchers kept between calls: a task's `MaskMatcherCache` is reused when its
// masks are unchanged, extended when masks were appended, and built again
// otherwise, and masked output never depends on it. Every result is compared
// with the masker as it was before the cache (`mask-oracle.ts`): masked
// lines, the settled count, the carry and gap at every boundary, and the
// values registered and dropped.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  buildVariants,
  type LogMask,
  type LogMaskCarry,
  MASK_MAX_VALUES,
  MaskMatcherCache,
  type MaskRowsOptions,
  type MaskRowsResult,
  maskRows,
} from "../../src/ci/index.js";
import * as oracle from "./mask-oracle.js";

/** Everything a call reports, as one comparable value. */
function snapshot(result: MaskRowsResult | oracle.MaskRowsResult, rows: number): unknown {
  const carries: (LogMaskCarry | null)[] = [];
  const gaps: number[] = [];
  for (let k = 0; k <= rows; k++) {
    carries.push(result.carryAt(k));
    gaps.push(result.gapRemainingAt(k));
  }
  return {
    lines: result.lines,
    settled: result.settled,
    carries,
    gaps,
    added: result.added,
    dropped: result.dropped,
  };
}

/** Masks `rows` with the cache, without it and with the oracle; all three must agree. */
function expectSame(
  masks: readonly LogMask[],
  carry: LogMaskCarry | null,
  rows: readonly string[],
  options: MaskRowsOptions,
  cache: MaskMatcherCache,
): oracle.MaskRowsResult {
  const { cache: _, work: __, ...plain } = options;
  const want = oracle.maskRows(masks, carry, rows, plain);
  const expected = snapshot(want, rows.length);
  expect(snapshot(maskRows(masks, carry, rows, { ...plain, cache }), rows.length)).toEqual(
    expected,
  );
  expect(snapshot(maskRows(masks, carry, rows, plain), rows.length)).toEqual(expected);
  return want;
}

const TOKEN = "fyrden_job_Q8x2LmN4pR7sT1vW3yZ5bC6dF9gH0jK";
const SECRET = "s3cr3t-v4lue-with-length";

// Small pieces so values overlap, share prefixes and form partial matches; CR, LF, `%`,
// non-ASCII, a surrogate pair and a lone high surrogate among them.
const piece = fc.constantFrom(
  "a",
  "b",
  "ab",
  "c",
  "abab",
  "x",
  "\n",
  "\r",
  "%",
  "é",
  "😀",
  "\ud83d",
);
const word = (min: number, max: number) =>
  fc.array(piece, { minLength: min, maxLength: max }).map((list) => list.join(""));

const initialMask = fc.record({
  value: word(1, 8),
  kind: fc.constantFrom("plain", "reserved", "secret"),
});

type Row =
  | { kind: "text"; text: string }
  | { kind: "add"; value: string }
  | { kind: "empty" }
  /** A variant of a mask the task has, by index modulo the masks and their variants, cut at `cut`. */
  | { kind: "variant"; mask: number; variant: number; cut: number };

const row: fc.Arbitrary<Row> = fc.oneof(
  { weight: 3, arbitrary: fc.record({ kind: fc.constant("text" as const), text: word(0, 8) }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant("add" as const), value: word(1, 6) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("empty" as const) }) },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("variant" as const),
      mask: fc.nat(),
      variant: fc.nat(),
      cut: fc.nat(),
    }),
  },
);

interface Request {
  rows: Row[];
  /** Resets the gap protection to this many units, as after an omitted row. */
  gap: number | null;
  final: boolean;
  force: boolean;
  /** Store the settled rows, or this many rows (modulo the count + 1). */
  keep: "settled" | number;
  /** Masks a request appends after storing: as the token and secret paths and a stored mask would. */
  append: { value: string; kind: "reserved" | "secret" | "pending"; ahead: number }[];
  /** The task's cache is lost (eviction, reset) before the next request. */
  drop: boolean;
}

const request: fc.Arbitrary<Request> = fc.record({
  rows: fc.array(row, { maxLength: 24 }),
  gap: fc.option(fc.nat({ max: 10 }), { freq: 6 }),
  final: fc.nat({ max: 19 }).map((n) => n === 0),
  force: fc.boolean(),
  keep: fc.oneof(fc.constant("settled" as const), fc.nat()),
  append: fc.array(
    fc.record({
      value: word(2, 8),
      kind: fc.constantFrom("reserved" as const, "secret" as const, "pending" as const),
      ahead: fc.nat({ max: 4 }),
    }),
    { maxLength: 2 },
  ),
  drop: fc.nat({ max: 9 }).map((n) => n === 0),
});

function textOf(r: Row, masks: readonly LogMask[]): string {
  switch (r.kind) {
    case "text":
      return r.text;
    case "empty":
      return "";
    case "add":
      return `::add-mask::${r.value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}`;
    case "variant": {
      const mask = masks[r.mask % Math.max(masks.length, 1)];
      const variants = mask === undefined ? [] : buildVariants(mask.value);
      const variant = variants[r.variant % Math.max(variants.length, 1)];
      return variant === undefined ? "" : variant.text.slice(0, 1 + (r.cut % variant.text.length));
    }
  }
}

/**
 * Drives one task's requests as `RunLogs` does: unstored rows are sent again
 * at the head of the next request, the stored rows' values join the masks,
 * and the carry and gap at the stored boundary feed the next request.
 */
function drive(
  initial: readonly { value: string; kind: string }[],
  requests: readonly Request[],
  reserve: { values: number; bytes: number },
): void {
  const masks: LogMask[] = initial.map(({ value, kind }) => ({
    value,
    fromIndex: 0,
    ...(kind === "reserved" ? { reserved: true } : kind === "secret" ? { secret: true } : {}),
  }));
  let cache = new MaskMatcherCache();
  let ack = 0;
  let carry: LogMaskCarry | null = null;
  let gap = 0;
  let unsent: string[] = [];
  for (const r of requests) {
    const rows = [...unsent, ...r.rows.map((x) => textOf(x, masks))];
    if (r.gap !== null) gap = r.gap;
    const options = { start: ack, final: r.final, force: r.force, gapRemaining: gap, reserve };
    const result = expectSame(masks, carry, rows, options, cache);
    const keep =
      r.final || r.force
        ? rows.length
        : r.keep === "settled"
          ? result.settled
          : r.keep % (rows.length + 1);
    carry = result.carryAt(keep);
    gap = result.gapRemainingAt(keep);
    for (const added of result.added) {
      if (added.index < ack + keep) masks.push({ value: added.value, fromIndex: added.index });
    }
    ack += keep;
    unsent = rows.slice(keep);
    for (const { value, kind, ahead } of r.append) {
      if (kind === "pending") masks.push({ value, fromIndex: ack + ahead });
      else masks.push({ value, fromIndex: 0, [kind]: true });
    }
    if (r.drop) cache = new MaskMatcherCache();
  }
}

describe("maskRows with a kept matcher cache", () => {
  it("gives the oracle's results over request sequences, with and without the cache", () => {
    fc.assert(
      fc.property(
        fc.array(initialMask, { minLength: 1, maxLength: 4 }),
        fc.array(request, { minLength: 1, maxLength: 8 }),
        (initial, requests) => drive(initial, requests, { values: 2, bytes: 40 }),
      ),
      { numRuns: 400 },
    );
  }, 120_000);

  it("gives the oracle's results when registrations reach the caps", () => {
    fc.assert(
      fc.property(
        fc.array(initialMask, { minLength: 1, maxLength: 4 }),
        fc.array(request, { minLength: 1, maxLength: 6 }),
        fc.integer({ min: MASK_MAX_VALUES - 8, max: MASK_MAX_VALUES }),
        fc.integer({ min: 16 * 1024 - 64, max: 16 * 1024 }),
        (initial, requests, values, bytes) => drive(initial, requests, { values, bytes }),
      ),
      { numRuns: 150 },
    );
  }, 120_000);

  it("reuses the matchers when the masks are unchanged", () => {
    const masks: LogMask[] = [
      { value: TOKEN, fromIndex: 0 },
      { value: SECRET, fromIndex: 0, secret: true },
    ];
    const cache = new MaskMatcherCache();
    expectSame(masks, null, [`a ${TOKEN} b`], { start: 0 }, cache);
    expect(cache.outcome).toBe("built");
    expect(cache.inserted).toBeGreaterThan(0);
    const rows = [`x ${SECRET} y`, TOKEN.slice(0, 20)];
    expectSame(masks, null, rows, { start: 1 }, cache);
    expect(cache.outcome).toBe("hit");
    expect(cache.inserted).toBe(0);
    expect(cache.linked).toBe(0);
  });

  it("extends the matchers with a value an earlier request registered", () => {
    const masks: LogMask[] = [{ value: TOKEN, fromIndex: 0 }];
    const cache = new MaskMatcherCache();
    const first = maskRows(masks, null, ["::add-mask::hunter2-value"], { start: 0, cache });
    expect(first.added).toEqual([{ value: "hunter2-value", index: 0 }]);
    expect(cache.outcome).toBe("built");
    const stored = [...masks, { value: "hunter2-value", fromIndex: 0 }];
    const rows = ["the value hunter2-value", `and ${TOKEN}`];
    const second = maskRows(stored, null, rows, { start: 1, cache });
    expect(cache.outcome).toBe("extended");
    // Only the new value's variants go in; nothing already kept is inserted again.
    expect(cache.inserted).toBe(buildVariants("hunter2-value").length);
    expect(second.lines).toEqual(["the value ***", "and ***"]);
    expectSame(stored, null, rows, { start: 1 }, new MaskMatcherCache());
  });

  it("counts the variants it keeps of masks not yet in effect in its estimate", () => {
    const cache = new MaskMatcherCache();
    maskRows([], null, ["x"], { start: 1, cache });
    const empty = cache.bytes;
    // Values of a later row: kept with their variants, inserted into no matcher.
    const later = Array.from({ length: 255 }, (_, i) => ({
      value: `${String.fromCharCode(0x100 + i)}%`,
      fromIndex: 100,
    }));
    maskRows(later, null, ["x"], { start: 1, cache });
    expect(cache.inserted).toBe(0);
    const variants = later.reduce((n, m) => n + buildVariants(m.value).length, 0);
    // At least what workerd retains for them: about 350 bytes a mask (tools/bench/mask).
    expect(cache.bytes - empty).toBeGreaterThanOrEqual(350 * later.length);
    expect(variants).toBeGreaterThan(later.length);
  });

  it("builds again when a kept mask changed, the list shrank or a mask joins out of order", () => {
    const token: LogMask = { value: TOKEN, fromIndex: 0 };
    const rows = [`${TOKEN} abcdefgh`];
    const cases: [LogMask[], LogMask[]][] = [
      // The token at position 0 was re-minted.
      [[token], [{ value: "fyrden_job_0000000000000000000000000000000", fromIndex: 0 }]],
      // The flags of a kept mask changed.
      [[token], [{ ...token, reserved: true }]],
      // The list shrank (a log closed and its masks were deleted).
      [[token, { value: "abcdefgh", fromIndex: 0 }], [token]],
      // A mask pending in the first call is in effect in the second, before a mask already kept.
      [
        [{ value: "abcdefgh", fromIndex: 5 }, token],
        [{ value: "abcdefgh", fromIndex: 5 }, token],
      ],
    ];
    for (const [first, second] of cases) {
      const cache = new MaskMatcherCache();
      maskRows(first, null, rows, { start: 1, cache });
      const start = second[0]?.fromIndex === 5 ? 6 : 1;
      expectSame(second, null, rows, { start }, cache);
      expect(cache.outcome).toBe("built");
    }
  });

  it("masks a crossing secret split across rows, requests, a forced store and a lost cache", () => {
    const masks: LogMask[] = [
      { value: TOKEN, fromIndex: 0 },
      { value: SECRET, fromIndex: 0, secret: true },
    ];
    const halves = [`pre ${SECRET.slice(0, 9)}`, `${SECRET.slice(9)} post`];
    // Across two rows of one request.
    expectSame(masks, null, halves, { start: 0 }, new MaskMatcherCache());
    for (const lose of [false, true]) {
      // Held, then resent with the rest.
      let cache = new MaskMatcherCache();
      const held = expectSame(masks, null, halves.slice(0, 1), { start: 0 }, cache);
      expect(held.settled).toBe(0);
      if (lose) cache = new MaskMatcherCache();
      expectSame(masks, null, halves, { start: 0 }, cache);
      // Forced, then resumed from the stored carry.
      cache = new MaskMatcherCache();
      const forced = expectSame(masks, null, halves.slice(0, 1), { start: 0, force: true }, cache);
      const carry = forced.carryAt(1);
      expect(carry).toMatchObject({ mask: 1, length: 9 });
      if (lose) cache = new MaskMatcherCache();
      const resumed = expectSame(masks, carry, halves.slice(1), { start: 1 }, cache);
      expect(resumed.lines).toEqual(["*** post"]);
    }
  });

  it("scans with the same lookups per char, cold or kept, and builds nothing on a hit", () => {
    for (const [prefix, input] of [
      ["a", "aZ"],
      ["abcdefg", "abcdefgZ"],
    ] as const) {
      const text = input.repeat(4096 / input.length);
      const masks = Array.from({ length: MASK_MAX_VALUES }, (_, i) => ({
        value: prefix + String.fromCharCode(0x100 + i),
        fromIndex: 0,
      }));
      const cache = new MaskMatcherCache();
      const count = (options: Partial<MaskRowsOptions>): number => {
        const work = { lookups: 0 };
        maskRows(masks, null, [text], { start: 1, work, ...options });
        return work.lookups;
      };
      const want = (() => {
        const work = { lookups: 0 };
        oracle.maskRows(masks, null, [text], { start: 1, work });
        return work.lookups;
      })();
      // Construction is not scanning: cold, built and kept scans count the same.
      expect(count({})).toBe(want);
      expect(count({ cache })).toBe(want);
      expect(cache.outcome).toBe("built");
      expect(count({ cache })).toBe(want);
      expect(cache.outcome).toBe("hit");
      expect(want).toBeLessThanOrEqual(6 * text.length);
    }
  });

  it("keeps the scan within a constant per tier when batches of masks activate row by row", () => {
    // Batches of 40, 39, …, 1 masks activate on successive rows, then a long row is scanned
    // by every tier left. Tiers merging only when no larger would leave 40 of them.
    const masks: LogMask[] = [];
    let n = 0;
    for (let batch = 40; batch >= 1; batch--) {
      for (let j = 0; j < batch; j++) {
        masks.push({
          value: `abcdefg${String.fromCharCode(0x100 + n++)}`,
          fromIndex: 10 + 40 - batch,
        });
      }
    }
    const rows = [...Array.from({ length: 40 }, () => "x"), "Z".repeat(1 << 14)];
    const work = { lookups: 0 };
    const result = maskRows(masks, null, rows, { start: 10, work });
    const want = oracle.maskRows(masks, null, rows, { start: 10 });
    expect(result.lines).toEqual(want.lines);
    // Two matchers per tier and two for the base, each at most two lookups per char.
    const tiers = Math.ceil(Math.log2(masks.length + 1)) + 1;
    expect(work.lookups).toBeLessThanOrEqual(2 * 2 * (1 + tiers) * (1 << 14));
  });

  describe("directed cases", () => {
    const cases: {
      name: string;
      masks: LogMask[];
      carry: LogMaskCarry | null;
      rows: string[];
      start: number;
      /** The first row's masked text, where a case depends on it. */
      first?: string;
    }[] = [
      {
        // A value of row 1 and the same value of row 0, from row 0: the carry names the
        // mask of row 0, as the oracle's tie-break (lowest `from`, then first inserted) does.
        name: "a tie between a mask of row 0 and an empty row's mask",
        masks: [
          { value: "abcdefgh", fromIndex: 1 },
          { value: "abcdefgh", fromIndex: 0 },
        ],
        carry: null,
        rows: ["", "abcd"],
        start: 0,
      },
      {
        // An `::add-mask::` row inside a crossing partial: the stored carry has `starts`.
        name: "a carry with an activation inside its prefix",
        masks: [
          { value: "abcdefghijkl", fromIndex: 0 },
          { value: "efghijklmnop", fromIndex: 1 },
        ],
        carry: { mask: 0, variant: 0, length: 6, starts: [{ index: 1, offset: -2 }] },
        rows: ["ghijklmnop", "efghijklmnop"],
        start: 2,
      },
      {
        // The carry at the end is a mask registered in the call (a tier's), not the base's.
        name: "a carry whose mask the call registered",
        masks: [{ value: TOKEN, fromIndex: 0 }],
        carry: null,
        rows: ["::add-mask::qwertyuiopasdf", "zz qwertyui"],
        start: 0,
      },
      {
        // The carried prefix's suffix starts a match only another matcher holds: the carried
        // mask does not complete, and the other activates 3 chars before the boundary.
        name: "a match recovered from the carried prefix's suffix",
        masks: [
          { value: "abcdabcf", fromIndex: 0 },
          { value: "abcexyzw", fromIndex: 1 },
        ],
        carry: { mask: 0, variant: 0, length: 7, starts: [{ index: 1, offset: -3 }] },
        rows: ["exyzw", "abcexyzw"],
        start: 2,
        first: "***",
      },
    ];
    for (const c of cases) {
      it(`gives the oracle's results for ${c.name}, cold and kept`, () => {
        const cache = new MaskMatcherCache();
        for (let call = 0; call < 2; call++) {
          const want = expectSame(c.masks, c.carry, c.rows, { start: c.start }, cache);
          if (c.first !== undefined) expect(want.lines[0]).toBe(c.first);
          expectSame(c.masks, c.carry, c.rows, { start: c.start, force: true }, cache);
        }
      });
    }
  });
});
