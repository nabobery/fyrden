// Masking over generated logs: secrets and `::add-mask::` values printed
// whole, split across rows, encoded and wrapped, masked in random batches
// with random holds, partial stores, forced stores and resumes from the carry.
//
// Invariants: (1) the text of every row stored settled or unforced equals the
// text of masking all rows at once, however the requests batched them;
// (2) no stored row contains a registered variant, read from its value's row
// on (rows joined for variants of 8+ chars, row by row for shorter ones);
// (3) masking replaces only matched ranges: all-at-once masking equals a
// direct, quadratic reading of the rules written out here.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  buildVariants,
  type LogMask,
  type LogMaskCarry,
  maskRows,
  parseAddMask,
} from "../../src/ci/index.js";

const CROSS_MIN = 8;
const HOLD_MIN = 4;
const COMMAND = "::add-mask::";

/**
 * The rules read directly: every occurrence of a variant from its value's row
 * on (row-local under 8 chars), the command value of every `::add-mask::`
 * row, a match's part before a row boundary dropped where the deepest
 * partial match there was 1 to 3 chars, merged ranges replaced by `***`.
 */
function reference(initial: readonly LogMask[], rows: readonly string[]): string[] {
  const offsets: number[] = [];
  let total = 0;
  for (const row of rows) {
    offsets.push(total);
    total += row.length;
  }
  const stream = rows.join("");
  const masks = initial.map((m) => ({ value: m.value, fromIndex: m.fromIndex }));
  const known = new Set(masks.map((m) => m.value));
  const ranges: [number, number][] = [];
  rows.forEach((row, t) => {
    const value = parseAddMask(row);
    if (value === null || value === "") return;
    const at = offsets[t] as number;
    // The command's raw data, before unescaping, is what the row shows.
    const raw = row.slice(COMMAND.length).split(/[\r\n]/)[0] as string;
    ranges.push([at + COMMAND.length, at + COMMAND.length + raw.length]);
    if (!known.has(value)) {
      known.add(value);
      masks.push({ value, fromIndex: t });
    }
  });
  const patterns = masks.flatMap((m) =>
    buildVariants(m.value).map((v) => ({
      text: v.text,
      row: m.fromIndex,
      from: offsets[m.fromIndex] ?? total,
    })),
  );
  const long = patterns.filter((p) => p.text.length >= CROSS_MIN);
  const cuts: number[] = [];
  for (let k = 1; k < rows.length; k++) {
    const end = offsets[k] as number;
    let deepest = 0;
    for (const p of long) {
      for (let l = 1; l < p.text.length && l <= end; l++) {
        if (end - l >= p.from && stream.slice(end - l, end) === p.text.slice(0, l)) {
          deepest = Math.max(deepest, l);
        }
      }
    }
    if (deepest >= 1 && deepest < HOLD_MIN) cuts.push(end);
  }
  for (const p of long) {
    for (let a = stream.indexOf(p.text); a !== -1; a = stream.indexOf(p.text, a + 1)) {
      if (a < p.from) continue;
      const b = a + p.text.length;
      const cut = Math.max(a, ...cuts.filter((c) => c > a && c < b));
      ranges.push([cut, b]);
    }
  }
  for (const p of patterns.filter((q) => q.text.length < CROSS_MIN)) {
    rows.forEach((row, t) => {
      if (t < p.row) return;
      for (let a = row.indexOf(p.text); a !== -1; a = row.indexOf(p.text, a + 1)) {
        const at = (offsets[t] as number) + a;
        ranges.push([at, at + p.text.length]);
      }
    });
  }
  ranges.sort((x, y) => x[0] - y[0]);
  const merged: [number, number][] = [];
  for (const [a, b] of ranges) {
    const last = merged.at(-1);
    if (last !== undefined && a <= last[1]) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  return rows.map((row, t) => {
    const start = offsets[t] as number;
    const end = start + row.length;
    let out = "";
    let cursor = start;
    for (const [a, b] of merged) {
      if (b <= start || a >= end) continue;
      const from = Math.max(a, start);
      out += stream.slice(cursor, from);
      if (Math.min(b, end) > from) out += "***";
      cursor = Math.max(cursor, Math.min(b, end));
    }
    return out + stream.slice(cursor, end);
  });
}

// A small alphabet so values overlap, repeat and form partial matches often;
// it includes characters every escaper changes, CR and LF among them. No `*`, so `***`
// never forms a value.
const chars = fc.constantFrom(
  ...'abcx /:%é"<+'.split(""),
  "😀",
  // CR and LF reach add-mask values only escaped (%0D, %0A), and split values into lines.
  "\r",
  "\n",
);
const text = (min: number, max: number) =>
  fc.array(chars, { minLength: min, maxLength: max }).map((list) => list.join(""));
const secret = fc.oneof(text(2, 7), text(8, 18));

type Piece =
  | { kind: "noise"; text: string }
  | { kind: "add"; secret: number }
  | {
      kind: "print";
      secret: number;
      /** Which variant of the value is printed: an index into its variants, modulo their count. */
      form: number;
      before: string;
      after: string;
      /** Cut points, modulo the printed text's length: one row per piece. */
      cuts: number[];
      /** Wrap the printed text at this width instead of cutting it, when set. */
      wrap: number | null;
    };

const piece = (secrets: number): fc.Arbitrary<Piece> =>
  fc.oneof(
    { weight: 3, arbitrary: fc.record({ kind: fc.constant("noise" as const), text: text(0, 10) }) },
    {
      weight: 1,
      arbitrary: fc.record({
        kind: fc.constant("add" as const),
        secret: fc.nat({ max: secrets - 1 }),
      }),
    },
    {
      weight: 4,
      arbitrary: fc.record({
        kind: fc.constant("print" as const),
        secret: fc.nat({ max: secrets - 1 }),
        form: fc.oneof(fc.constant(0), fc.nat({ max: 20 })),
        before: text(0, 4),
        after: text(0, 4),
        cuts: fc.array(fc.nat({ max: 40 }), { maxLength: 2 }),
        wrap: fc.option(fc.integer({ min: 1, max: 12 }), { freq: 4 }),
      }),
    },
  );

type Mode = "settled" | "partial" | "force" | "hold" | "final";
interface Step {
  size: number;
  mode: Mode;
  /** Percentage of the settled rows a partial store keeps. */
  share: number;
}

const step: fc.Arbitrary<Step> = fc.record({
  size: fc.integer({ min: 1, max: 6 }),
  mode: fc.constantFrom<Mode>("settled", "settled", "partial", "force", "hold", "final"),
  share: fc.nat({ max: 100 }),
});

const scenario = fc.array(secret, { minLength: 1, maxLength: 3 }).chain((secrets) =>
  fc.record({
    secrets: fc.constant(secrets),
    tokens: fc.nat({ max: secrets.length }),
    pieces: fc.array(piece(secrets.length), { minLength: 1, maxLength: 12 }),
    steps: fc.array(step, { minLength: 1, maxLength: 12 }),
  }),
);

/** How a step prints a value as workflow-command data. */
function commandEscape(value: string): string {
  return value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

function rowsOf(secrets: readonly string[], pieces: readonly Piece[]): string[] {
  const rows: string[] = [];
  for (const p of pieces) {
    if (p.kind === "noise") rows.push(p.text);
    else if (p.kind === "add") rows.push(`${COMMAND}${commandEscape(secrets[p.secret] as string)}`);
    else {
      const value = secrets[p.secret] as string;
      const variants = buildVariants(value);
      const printed =
        variants.length === 0 ? value : (variants[p.form % variants.length]?.text ?? value);
      const whole = p.before + printed + p.after;
      if (p.wrap !== null) {
        for (let i = 0; i < whole.length; i += p.wrap) rows.push(whole.slice(i, i + p.wrap));
        if (whole.length === 0) rows.push("");
        continue;
      }
      const at = [...new Set(p.cuts.map((c) => c % (whole.length + 1)))].sort((x, y) => x - y);
      let from = 0;
      for (const cut of at) {
        rows.push(whole.slice(from, cut));
        from = cut;
      }
      rows.push(whole.slice(from));
    }
  }
  return rows;
}

interface Batched {
  stored: string[];
  /** Rows stored settled or unforced, which must equal all-at-once masking. */
  comparable: boolean[];
}

/** Masks the rows in the steps' batches, storing and resuming as the log path does. */
function batched(
  initial: readonly LogMask[],
  rows: readonly string[],
  steps: readonly Step[],
): Batched {
  let masks: LogMask[] = [...initial];
  let carry: LogMaskCarry | null = null;
  let at = 0;
  const stored: string[] = [];
  const comparable: boolean[] = [];
  for (let call = 0; at < rows.length; call++) {
    const plan = steps[call % steps.length] as Step;
    const giveUp = call >= 100;
    const size = giveUp ? rows.length - at : Math.min(plan.size, rows.length - at);
    const last = at + size === rows.length;
    const final = giveUp || (plan.mode === "final" && last);
    const force = !final && plan.mode === "force";
    const result = maskRows(masks, carry, rows.slice(at, at + size), { start: at, final, force });
    expect(result.lines).toHaveLength(size);
    expect(result.settled).toBeGreaterThanOrEqual(0);
    expect(result.settled).toBeLessThanOrEqual(size);
    if (final) expect(result.settled).toBe(size);
    let keep: number;
    if (final || force) keep = size;
    else if (plan.mode === "partial") keep = Math.floor((result.settled * plan.share) / 100);
    else if (plan.mode === "hold") keep = 0;
    else keep = result.settled;
    for (let i = 0; i < keep; i++) {
      stored[at + i] = result.lines[i] as string;
      comparable[at + i] = !force || i < result.settled;
    }
    masks = masks.concat(
      result.added
        .filter((added) => added.index < at + keep)
        .map((added) => ({ value: added.value, fromIndex: added.index })),
    );
    carry = result.carryAt(keep);
    at += keep;
  }
  return { stored, comparable };
}

/** No row of `lines` holds a variant of a mask in effect, read as the matcher reads rows. */
function expectNoVariant(masks: readonly LogMask[], lines: readonly string[]): void {
  for (const m of masks) {
    const from = lines.slice(m.fromIndex);
    const joined = from.join("");
    for (const variant of buildVariants(m.value)) {
      if (variant.crosses) expect(joined).not.toContain(variant.text);
      else for (const line of from) expect(line).not.toContain(variant.text);
    }
  }
}

describe("maskRows over generated logs", () => {
  it("masks the same whatever the batching, covers every variant, and replaces only matches", () => {
    fc.assert(
      fc.property(scenario, ({ secrets, tokens, pieces, steps }) => {
        const initial = secrets.slice(0, tokens).map((value) => ({ value, fromIndex: 0 }));
        const rows = rowsOf(secrets, pieces);
        const once = maskRows(initial, null, rows, { start: 0, final: true });
        expect(once.lines).toEqual(reference(initial, rows));

        const registered = initial.concat(
          once.added.map((added) => ({ value: added.value, fromIndex: added.index })),
        );
        expectNoVariant(registered, once.lines);

        const { stored, comparable } = batched(initial, rows, steps);
        expect(stored).toHaveLength(rows.length);
        rows.forEach((_, i) => {
          if (comparable[i]) expect(stored[i]).toBe(once.lines[i]);
        });
        expectNoVariant(registered, stored);
      }),
      { numRuns: 500 },
    );
  }, 60_000);

  it("preserves scheduled-mask activation through random request boundaries", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 8 }),
        fc.integer({ min: 0, max: 8 }),
        fc.array(step, { minLength: 1, maxLength: 12 }),
        (first, extra, steps) => {
          const text = "Xabcdefgh";
          const second = first + (extra % (text.length - first + 1));
          const rows = [
            text.slice(0, first),
            text.slice(first, second),
            "",
            `${text.slice(second)} SAFE`,
          ];
          const initial = [
            { value: "XabcdefghZ", fromIndex: 0 },
            { value: "abcdefgh", fromIndex: 1 },
          ];
          const once = maskRows(initial, null, rows, { start: 0, final: true });
          expect(once.lines).toEqual(reference(initial, rows));
          const { stored, comparable } = batched(initial, rows, steps);
          for (let i = 0; i < rows.length; i++) {
            if (comparable[i]) expect(stored[i]).toBe(once.lines[i]);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("reports settled within the rows when resuming a forced carry into empty rows", () => {
    fc.assert(
      fc.property(scenario, fc.nat(), fc.nat({ max: 3 }), ({ secrets, pieces }, pick, empties) => {
        // Every value in effect from row 0, and rows ending inside a crossing variant.
        const initial = secrets.map((value) => ({ value, fromIndex: 0 }));
        const crossing = secrets.flatMap((v) => buildVariants(v).filter((x) => x.crosses));
        const rows = rowsOf(secrets, pieces);
        const variant = crossing[pick % Math.max(crossing.length, 1)];
        if (variant !== undefined) {
          rows.push(variant.text.slice(0, 4 + (pick % (variant.text.length - 4))));
        }
        const forced = maskRows(initial, null, rows, { start: 0, force: true });
        const masks = initial.concat(
          forced.added.map((added) => ({ value: added.value, fromIndex: added.index })),
        );
        const blank = Array.from({ length: empties }, () => "");
        for (const force of [false, true]) {
          const next = maskRows(masks, forced.carryAt(rows.length), blank, {
            start: rows.length,
            force,
          });
          expect(next.settled).toBe(empties);
        }
      }),
      { numRuns: 300 },
    );
  }, 60_000);

  it("settles every row before the deepest partial match of 4 or more chars", () => {
    fc.assert(
      fc.property(scenario, fc.nat(), ({ secrets, tokens, pieces }, extra) => {
        const initial = secrets.slice(0, tokens).map((value) => ({ value, fromIndex: 0 }));
        const rows = rowsOf(secrets, pieces);
        const result = maskRows(initial, null, rows, { start: 0 });
        // Rows the result calls settled keep their text whatever rows follow.
        const more = rowsOf(secrets, pieces.slice(extra % pieces.length));
        const longer = maskRows(initial, null, [...rows, ...more], { start: 0, final: true });
        for (let i = 0; i < result.settled; i++) expect(longer.lines[i]).toBe(result.lines[i]);
      }),
      { numRuns: 300 },
    );
  }, 60_000);
});
