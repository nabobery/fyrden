import { describe, expect, it } from "vitest";
import {
  type BlameState,
  BlameStateError,
  BlameStateTooLarge,
  decodeBlameState,
  encodeBlameState,
  MAX_BLAME_LINES,
  MAX_STATE_BYTES,
  UNRESOLVED_REASONS,
} from "../../src/blame/state.js";
import { oidFromHex } from "../../src/object/oid.js";

/*
 * Each check of a checkpoint, met by the one corruption it's there for. The
 * property tests show any change is refused; these show which check refuses
 * it, so a check that stops working can't hide behind a later one.
 */

const oid = (k: number) => oidFromHex(k.toString(16).padStart(40, "0"));
const HEADER = 48;
const fact = { summary: "s", name: "n", email: "e", date: "d" };

/** Four lines: two pending at one commit, one at an older one, one settled. */
function base(overrides: Partial<BlameState> = {}): BlameState {
  return {
    commit: oid(99),
    path: [new TextEncoder().encode("f")],
    lines: 4,
    steps: 3,
    queue: [
      { oid: oid(2), generation: 9, level: 9, pairs: Int32Array.from([10, 0, 11, 1]) },
      { oid: oid(3), generation: 5, level: 5, pairs: Int32Array.from([12, 2]) },
    ],
    ranges: Int32Array.from([3, 1, 0, 7]),
    rangeCount: 1,
    facts: { [oid(99).toString()]: fact },
    factOrder: [oid(99)],
    stateLimit: false,
    ...overrides,
  } as BlameState;
}

function withFactsKeyed(state: BlameState): BlameState {
  const hex = Buffer.from(state.factOrder[0] as Uint8Array).toString("hex");
  return { ...state, facts: { [hex]: fact } };
}

const encoded = (overrides: Partial<BlameState> = {}) =>
  encodeBlameState(withFactsKeyed(base(overrides)));

// Where things sit in `encoded()`: the header, the path "f", three counts, then records.
const AT = { lines: 26, segments: 34, queueCount: 39, rangeCount: 43, factCount: 47 };
const QUEUE1 = 51; // oid, generation, level, count, then two pairs
const QUEUE2 = QUEUE1 + 32 + 16;
const RANGE = QUEUE2 + 32 + 8;
const FACTS = RANGE + 16;

function patched(edit: (view: DataView, bytes: Uint8Array) => void, from = encoded()): Uint8Array {
  const bytes = Uint8Array.from(from);
  edit(new DataView(bytes.buffer), bytes);
  return bytes;
}

const refuses = (bytes: Uint8Array, detail: string) =>
  expect(() => decodeBlameState(bytes)).toThrow(new BlameStateError(`checkpoint: ${detail}`));

describe("each check of a checkpoint", () => {
  it("decodes the base state, so each corruption below is the only fault", () => {
    const state = decodeBlameState(encoded());
    expect(state.lines).toBe(4);
    expect(state.queue.map((e) => e.generation)).toEqual([9, 5]);
    expect([...state.ranges]).toEqual([3, 1, 0, 7]);
  });

  it("the size, at both bounds", () => {
    refuses(new Uint8Array(HEADER - 1), "wrong size");
    refuses(new Uint8Array(HEADER), "not a checkpoint");
    refuses(new Uint8Array(MAX_STATE_BYTES), "not a checkpoint");
    refuses(new Uint8Array(MAX_STATE_BYTES + 1), "wrong size");
  });

  it("the magic, the version and the flags", () => {
    refuses(
      patched((_, b) => {
        b[0] = 0;
      }),
      "not a checkpoint",
    );
    refuses(
      patched((_, b) => {
        b[4] = 2;
      }),
      "unknown version",
    );
    refuses(
      patched((_, b) => {
        b[5] = 2;
      }),
      "unknown flag",
    );
    refuses(
      patched((_, b) => {
        b[5] = 1;
      }),
      "a flagged state with lines pending",
    );
  });

  it("the line count, at the limit and past it", () => {
    const whole = encodeBlameState(
      withFactsKeyed(
        base({
          lines: MAX_BLAME_LINES,
          queue: [],
          ranges: Int32Array.from([0, MAX_BLAME_LINES, -1, 0]),
        }),
      ),
    );
    expect(decodeBlameState(whole).lines).toBe(MAX_BLAME_LINES);
    refuses(
      patched((v) => v.setUint32(AT.lines, MAX_BLAME_LINES + 1), whole),
      "too many lines",
    );
  });

  it("a path segment that runs past the end", () => {
    // A header alone, claiming seven empty segments: the seventh has no length.
    const header = patched((v) => v.setUint16(AT.segments, 7), encoded().slice(0, HEADER));
    expect(() => decodeBlameState(header)).toThrow("checkpoint: runs past the end");
  });

  it("each count against what follows", () => {
    refuses(
      patched((v) => v.setUint32(QUEUE1 + 28, 0)),
      "a commit with no lines pending",
    );
    refuses(
      patched((v) => v.setUint32(QUEUE1 + 28, MAX_BLAME_LINES + 1)),
      "too many pairs",
    );
    refuses(
      patched((v) => v.setUint32(AT.rangeCount, MAX_BLAME_LINES + 1)),
      "too many ranges",
    );
    refuses(
      patched((v) => v.setUint32(AT.factCount, MAX_BLAME_LINES + 1)),
      "too many facts",
    );
    refuses(
      patched((v) => v.setUint16(FACTS + 20, 0xffff)),
      "runs past the end",
    );
    refuses(Uint8Array.from([...encoded(), 0]), "bytes past the end");
  });

  it("pairs at the limit in all, and past it", () => {
    const pairs = (count: number, start: number) =>
      Int32Array.from({ length: 2 * count }, (_, k) => (k % 2 === 0 ? 0 : start + (k >> 1)));
    const half = MAX_BLAME_LINES / 2;
    const atLimit = base({
      lines: MAX_BLAME_LINES,
      queue: [
        { oid: oid(2), generation: 9, level: 9, pairs: pairs(half, 0) },
        { oid: oid(3), generation: 5, level: 5, pairs: pairs(half, half) },
      ],
      ranges: new Int32Array(0),
      rangeCount: 0,
    });
    expect(decodeBlameState(encodeBlameState(withFactsKeyed(atLimit))).queue.length).toBe(2);
    const over = base({
      lines: MAX_BLAME_LINES,
      queue: [
        { oid: oid(2), generation: 9, level: 9, pairs: pairs(half + 1, 0) },
        { oid: oid(3), generation: 5, level: 5, pairs: pairs(half, half + 1) },
      ],
      ranges: new Int32Array(0),
      rangeCount: 0,
    });
    refuses(encodeBlameState(withFactsKeyed(over)), "too many pairs");
  });

  it("the queue's order: generation down, then level down, then object id up", () => {
    const entry = (k: number, generation: number, level: number, line: number) => ({
      oid: oid(k),
      generation,
      level,
      pairs: Int32Array.from([0, line]),
    });
    const queue = (...entries: ReturnType<typeof entry>[]) =>
      encodeBlameState(
        withFactsKeyed(base({ lines: 3, queue: entries, ranges: Int32Array.from([2, 1, 0, 1]) })),
      );
    expect(() => decodeBlameState(queue(entry(2, 9, 1, 0), entry(3, 8, 9, 1)))).not.toThrow();
    expect(() => decodeBlameState(queue(entry(2, 9, 9, 0), entry(3, 9, 8, 1)))).not.toThrow();
    expect(() => decodeBlameState(queue(entry(2, 9, 9, 0), entry(3, 9, 9, 1)))).not.toThrow();
    refuses(queue(entry(2, 8, 9, 0), entry(3, 9, 1, 1)), "queue out of order");
    refuses(queue(entry(2, 9, 8, 0), entry(3, 9, 9, 1)), "queue out of order");
    refuses(queue(entry(3, 9, 9, 0), entry(2, 9, 9, 1)), "queue out of order");
    refuses(queue(entry(2, 9, 9, 0), entry(2, 9, 9, 1)), "queue out of order");
    refuses(queue(entry(2, 9, 9, 0), entry(2, 8, 9, 1)), "a commit twice in the queue");
  });

  it("a length that doesn't fit its two bytes isn't written", () => {
    const withSummary = (length: number) =>
      base({
        facts: { [Buffer.from(oid(99)).toString("hex")]: { ...fact, summary: "s".repeat(length) } },
      });
    expect(() => encodeBlameState(withSummary(0xffff))).not.toThrow();
    expect(() => encodeBlameState(withSummary(0x10000))).toThrow(
      new RangeError("a length of 65536 doesn't fit a checkpoint"),
    );
  });

  it("each line told once, and none left out", () => {
    refuses(
      patched((v) => v.setUint32(QUEUE1 + 32 + 4, 4)),
      "a line past the file",
    );
    refuses(
      patched((v) => v.setUint32(QUEUE1 + 32 + 4, 1)),
      "a line told twice",
    );
    // A current line counts from 0, and is reported from 1: the last one a file can have is the limit less one.
    refuses(
      patched((v) => v.setUint32(QUEUE1 + 32, MAX_BLAME_LINES)),
      "a current line past any file",
    );
    const atLimit = patched((v) => v.setUint32(QUEUE1 + 32, MAX_BLAME_LINES - 1));
    expect(decodeBlameState(atLimit).queue[0]?.pairs[0]).toBe(MAX_BLAME_LINES - 1);
    refuses(
      patched((v) => v.setInt32(RANGE, 0)),
      "a line told twice",
    );
    refuses(encodeBlameState(withFactsKeyed(base({ lines: 5 }))), "a line left out");
  });

  it("each field of a settled range", () => {
    refuses(
      patched((v) => v.setInt32(RANGE, -1)),
      "a range past the file",
    );
    refuses(
      patched((v) => v.setInt32(RANGE + 4, 0)),
      "a range past the file",
    );
    refuses(
      patched((v) => v.setInt32(RANGE + 4, 5)),
      "a range past the file",
    );
    refuses(
      patched((v) => v.setInt32(RANGE + 8, 1)),
      "a range of an unknown commit",
    );
    refuses(
      patched((v) => v.setInt32(RANGE + 12, 0)),
      "a range's source line",
    );
    refuses(
      patched((v) => v.setInt32(RANGE + 12, MAX_BLAME_LINES + 1)),
      "a range's source line",
    );
    const atLimit = patched((v) => v.setInt32(RANGE + 12, MAX_BLAME_LINES));
    expect(decodeBlameState(atLimit).ranges[3]).toBe(MAX_BLAME_LINES);
    // The range's last source line is held to the limit too, not only its first.
    const span = (source: number) =>
      encodeBlameState(
        withFactsKeyed(base({ lines: 2, queue: [], ranges: Int32Array.from([0, 2, 0, source]) })),
      );
    refuses(span(MAX_BLAME_LINES), "a range's source line");
    expect(decodeBlameState(span(MAX_BLAME_LINES - 1)).ranges[3]).toBe(MAX_BLAME_LINES - 1);
    const reason = (k: number, source = 0) =>
      patched((v) => {
        v.setInt32(RANGE + 8, -1 - k);
        v.setInt32(RANGE + 12, source);
      });
    expect(decodeBlameState(reason(UNRESOLVED_REASONS.length - 1)).ranges[2]).toBe(
      -UNRESOLVED_REASONS.length,
    );
    refuses(reason(UNRESOLVED_REASONS.length), "an unknown reason");
    refuses(reason(0, 1), "a refused range with a source line");
  });

  it("a commit's facts given twice", () => {
    refuses(encoded({ factOrder: [oid(99), oid(99)] }), "a commit's facts twice");
  });

  it("a path that holds none of the checkpoint's bytes", () => {
    // A Node Buffer's slice is a view: a short path mustn't keep the whole checkpoint alive.
    const from = Buffer.from(encoded());
    const path = decodeBlameState(from).path;
    expect(path.map((segment) => new TextDecoder().decode(segment))).toEqual(["f"]);
    for (const segment of path) expect(segment.buffer).not.toBe(from.buffer);
  });

  it("a fact's text that isn't UTF-8", () => {
    refuses(
      patched((_, b) => {
        b[FACTS + 22] = 0xff;
      }),
      "a commit's facts aren't UTF-8",
    );
  });

  it("the room, reported as too large rather than as bad bytes", () => {
    const bytes = encoded();
    const error = (() => {
      try {
        decodeBlameState(bytes, { maxLiveStateBytes: 1 });
      } catch (e) {
        return e as Error;
      }
    })();
    expect(error).toBeInstanceOf(BlameStateTooLarge);
    expect(error?.name).toBe("BlameStateTooLarge");
    expect(error?.message).toMatch(/^a state of \d+ bytes doesn't fit 1$/);
    expect(new BlameStateError("x").name).toBe("BlameStateError");
  });
});
