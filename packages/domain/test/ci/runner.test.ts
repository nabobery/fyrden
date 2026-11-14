// The runner protocol's pure rules: which runner may take a job, when a log
// request's rows are stored and acked, and the error-message guard.
import { describe, expect, it } from "vitest";
import {
  decideLogFlush,
  endsLikeUnregisteredRunner,
  isFinalSentinel,
  LOG_FLUSH_AGE_MS,
  LOG_FLUSH_BYTES,
  LOG_FLUSH_ROWS,
  type LogFlushRequest,
  labelsMatch,
} from "../../src/ci/index.js";

describe("labelsMatch", () => {
  it.each([
    { job: ["ubuntu-latest"], runner: ["ubuntu-latest"], match: true },
    { job: ["Ubuntu-Latest"], runner: ["ubuntu-latest"], match: true },
    { job: ["self-hosted", "linux"], runner: ["LINUX", "Self-Hosted", "x64"], match: true },
    { job: ["linux", "gpu"], runner: ["linux"], match: false },
    { job: ["linux"], runner: [], match: false },
    { job: [], runner: ["linux"], match: false },
    { job: [], runner: [], match: false },
    { job: ["linux", "linux"], runner: ["linux"], match: true },
    { job: ["linux"], runner: ["linux", "LINUX"], match: true },
    { job: ["linux-x64"], runner: ["linux"], match: false },
    { job: ["linux"], runner: ["linux-x64"], match: false },
    // Only ASCII letters fold, as SQLite's lower() does: other letters match in exact case only.
    { job: ["ünix"], runner: ["ünix"], match: true },
    { job: ["Ünix"], runner: ["ünix"], match: false },
    { job: ["GPU-ü"], runner: ["gpu-ü"], match: true },
  ])("$job on $runner → $match", ({ job, runner, match }) => {
    expect(labelsMatch(job, runner)).toBe(match);
  });
});

const rows = (count: number, prefix = "line"): { content: string }[] =>
  Array.from({ length: count }, (_, i) => ({ content: `${prefix} ${i}` }));

function request(overrides: Partial<LogFlushRequest>): LogFlushRequest {
  return { index: 0, rows: [], noMore: false, whole: true, ...overrides };
}

describe("decideLogFlush", () => {
  const now = 1_000_000;

  it("refuses an index past the stored ack", () => {
    expect(decideLogFlush({ ackIndex: 3 }, request({ index: 4, rows: rows(1) }), now)).toEqual({
      kind: "ahead",
    });
  });

  it("holds a few new rows and remembers when it first saw them", () => {
    expect(decideLogFlush({ ackIndex: 0 }, request({ rows: rows(3) }), now)).toEqual({
      kind: "hold",
      ackIndex: 0,
      firstUnackedSeenAt: now,
    });
  });

  it("keeps the remembered time while holding", () => {
    expect(
      decideLogFlush(
        { ackIndex: 0, firstUnackedSeenAt: now - 5_000 },
        request({ rows: rows(3) }),
        now,
      ),
    ).toEqual({ kind: "hold", ackIndex: 0, firstUnackedSeenAt: now - 5_000 });
  });

  it("remembers nothing when no row is new", () => {
    expect(
      decideLogFlush(
        { ackIndex: 5, firstUnackedSeenAt: now - 20_000 },
        request({ index: 2, rows: rows(3) }),
        now,
      ),
    ).toEqual({ kind: "hold", ackIndex: 5, firstUnackedSeenAt: undefined });
    expect(decideLogFlush({ ackIndex: 5 }, request({ index: 5 }), now)).toEqual({
      kind: "hold",
      ackIndex: 5,
      firstUnackedSeenAt: undefined,
    });
  });

  it("holds 49 new rows and stores 50", () => {
    expect(LOG_FLUSH_ROWS).toBe(50);
    expect(decideLogFlush({ ackIndex: 10 }, request({ index: 10, rows: rows(49) }), now).kind).toBe(
      "hold",
    );
    const fifty = rows(50);
    expect(decideLogFlush({ ackIndex: 10 }, request({ index: 10, rows: fifty }), now)).toEqual({
      kind: "flush",
      start: 10,
      end: 60,
      lines: fifty.map((row) => row.content),
      final: false,
    });
  });

  it("stores new rows whose UTF-8 bytes reach the byte threshold", () => {
    expect(LOG_FLUSH_BYTES).toBe(512 * 1024);
    // "é" is two UTF-8 bytes and one UTF-16 unit: the count is of bytes.
    const half = "é".repeat(LOG_FLUSH_BYTES / 4);
    const below = [{ content: half }, { content: `${half.slice(1)}a` }];
    expect(decideLogFlush({ ackIndex: 0 }, request({ rows: below }), now).kind).toBe("hold");
    const exact = [{ content: half }, { content: half }];
    expect(decideLogFlush({ ackIndex: 0 }, request({ rows: exact }), now)).toMatchObject({
      kind: "flush",
      start: 0,
      end: 2,
      final: false,
    });
  });

  it.each([
    // A surrogate pair is one code point, four UTF-8 bytes.
    { name: "surrogate pairs", text: "😀".repeat(LOG_FLUSH_BYTES / 4) },
    // A lone surrogate is written as U+FFFD, three bytes; high and low, mid-string and at the end.
    { name: "a lone high surrogate", text: `\uD800${"a".repeat(LOG_FLUSH_BYTES - 3)}` },
    { name: "a lone low surrogate", text: `\uDC00${"a".repeat(LOG_FLUSH_BYTES - 3)}` },
    { name: "a trailing high surrogate", text: `${"a".repeat(LOG_FLUSH_BYTES - 3)}\uD800` },
    { name: "two high surrogates", text: `\uD800\uD800${"a".repeat(LOG_FLUSH_BYTES - 6)}` },
  ])("counts UTF-8 bytes of $name at the byte threshold", ({ text }) => {
    const encoder = new TextEncoder();
    expect(encoder.encode(text).length).toBe(LOG_FLUSH_BYTES);
    expect(decideLogFlush({ ackIndex: 0 }, request({ rows: [{ content: text }] }), now).kind).toBe(
      "flush",
    );
    // One byte short: drop the last unit (one ASCII byte, or a whole trailing surrogate) and pad.
    const short = text.endsWith("\uD800")
      ? `${text.slice(0, -1)}ab`
      : text.endsWith("😀")
        ? `${text.slice(0, -2)}abc`
        : text.slice(0, -1);
    expect(encoder.encode(short).length).toBe(LOG_FLUSH_BYTES - 1);
    expect(decideLogFlush({ ackIndex: 0 }, request({ rows: [{ content: short }] }), now).kind).toBe(
      "hold",
    );
  });

  it("answers the stored ack when holding after a flush", () => {
    const first = decideLogFlush({ ackIndex: 0 }, request({ rows: rows(50) }), now);
    expect(first).toMatchObject({ kind: "flush", end: 50 });
    const ackIndex = first.kind === "flush" ? first.end : -1;
    expect(decideLogFlush({ ackIndex }, request({ index: 50, rows: rows(1) }), now)).toEqual({
      kind: "hold",
      ackIndex: 50,
      firstUnackedSeenAt: now,
    });
    expect(decideLogFlush({ ackIndex }, request({ index: 0, rows: rows(51) }), now)).toEqual({
      kind: "hold",
      ackIndex: 50,
      firstUnackedSeenAt: now,
    });
  });

  it("counts bytes of new rows only", () => {
    const big = { content: "x".repeat(LOG_FLUSH_BYTES) };
    expect(
      decideLogFlush({ ackIndex: 1 }, request({ index: 0, rows: [big, { content: "y" }] }), now)
        .kind,
    ).toBe("hold");
  });

  it("stores rows first seen 15 s ago, not 14 999 ms ago", () => {
    expect(LOG_FLUSH_AGE_MS).toBe(15_000);
    const seen = now - 14_999;
    expect(
      decideLogFlush({ ackIndex: 0, firstUnackedSeenAt: seen }, request({ rows: rows(1) }), now),
    ).toEqual({ kind: "hold", ackIndex: 0, firstUnackedSeenAt: seen });
    expect(
      decideLogFlush(
        { ackIndex: 0, firstUnackedSeenAt: now - 15_000 },
        request({ rows: rows(1) }),
        now,
      ),
    ).toEqual({ kind: "flush", start: 0, end: 1, lines: ["line 0"], final: false });
  });

  it("drops resent rows below the ack and counts only new ones", () => {
    const sent = rows(60);
    expect(decideLogFlush({ ackIndex: 16 }, request({ index: 5, rows: sent }), now).kind).toBe(
      "hold",
    );
    expect(decideLogFlush({ ackIndex: 10 }, request({ index: 5, rows: sent }), now)).toEqual({
      kind: "flush",
      start: 10,
      end: 65,
      lines: sent.slice(5).map((row) => row.content),
      final: false,
    });
  });

  it("stores a whole final call's trailing rows however few", () => {
    expect(
      decideLogFlush({ ackIndex: 4 }, request({ index: 2, rows: rows(4), noMore: true }), now),
    ).toEqual({ kind: "flush", start: 4, end: 6, lines: ["line 2", "line 3"], final: true });
  });

  it("completes on a final call with zero rows", () => {
    expect(decideLogFlush({ ackIndex: 7 }, request({ index: 7, noMore: true }), now)).toEqual({
      kind: "flush",
      start: 7,
      end: 7,
      lines: [],
      final: true,
    });
  });

  it("completes on a resent final call whose rows are all stored", () => {
    expect(
      decideLogFlush({ ackIndex: 7 }, request({ index: 5, rows: rows(2), noMore: true }), now),
    ).toEqual({ kind: "flush", start: 7, end: 7, lines: [], final: true });
  });

  it("acks the empty-row sentinel of a final call without storing it as a line", () => {
    const sentinel = request({ index: 7, rows: [{ content: "" }], noMore: true });
    expect(isFinalSentinel(sentinel)).toBe(true);
    expect(decideLogFlush({ ackIndex: 7 }, sentinel, now)).toEqual({
      kind: "flush",
      start: 7,
      end: 8,
      lines: [],
      final: true,
    });
  });

  it("adds no line and no position for a resent sentinel already below the ack", () => {
    const sentinel = request({ index: 7, rows: [{ content: "" }], noMore: true });
    expect(decideLogFlush({ ackIndex: 8 }, sentinel, now)).toEqual({
      kind: "flush",
      start: 8,
      end: 8,
      lines: [],
      final: true,
    });
  });

  it("stores an empty last row among others as a line", () => {
    const final = request({ index: 0, rows: [{ content: "a" }, { content: "" }], noMore: true });
    expect(isFinalSentinel(final)).toBe(false);
    expect(decideLogFlush({ ackIndex: 0 }, final, now)).toEqual({
      kind: "flush",
      start: 0,
      end: 2,
      lines: ["a", ""],
      final: true,
    });
  });

  it("is not a sentinel unless final and whole", () => {
    expect(isFinalSentinel(request({ rows: [{ content: "" }] }))).toBe(false);
    expect(isFinalSentinel(request({ rows: [{ content: "" }], noMore: true, whole: false }))).toBe(
      false,
    );
    expect(isFinalSentinel(request({ rows: [{ content: "x" }], noMore: true }))).toBe(false);
  });

  it("stores the decoded rows of a final call that is not whole, and stays open", () => {
    expect(
      decideLogFlush(
        { ackIndex: 3 },
        request({ index: 3, rows: rows(2), noMore: true, whole: false }),
        now,
      ),
    ).toEqual({ kind: "flush", start: 3, end: 5, lines: ["line 0", "line 1"], final: false });
  });

  it("holds a final call that is not whole and carries no new row", () => {
    expect(
      decideLogFlush(
        { ackIndex: 3 },
        request({ index: 1, rows: rows(2), noMore: true, whole: false }),
        now,
      ),
    ).toEqual({ kind: "hold", ackIndex: 3, firstUnackedSeenAt: undefined });
  });

  it("stores a lone empty row of a final call that is not whole as a line", () => {
    expect(
      decideLogFlush(
        { ackIndex: 3 },
        request({ index: 3, rows: [{ content: "" }], noMore: true, whole: false }),
        now,
      ),
    ).toEqual({ kind: "flush", start: 3, end: 4, lines: [""], final: false });
  });

  it("applies the thresholds to a cut request that is not final", () => {
    expect(
      decideLogFlush({ ackIndex: 0 }, request({ rows: rows(1), whole: false }), now).kind,
    ).toBe("hold");
    expect(
      decideLogFlush({ ackIndex: 0 }, request({ rows: rows(50), whole: false }), now),
    ).toMatchObject({ kind: "flush", end: 50, final: false });
  });
});

describe("endsLikeUnregisteredRunner", () => {
  it.each([
    ["unregistered runner", true],
    ["Unregistered Runner", true],
    ["task refused: unregistered runner.", true],
    ["unregistered runner  \n", true],
    ["unregistered runner!)", true],
    ["unregistered runner。", true],
    ["unregistered runner…", true],
    ["«unregistered runner»", true],
    ["unregistered runner\u00a0", true],
    ["unregistered runners", false],
    ["unregistered runner id 4", false],
    ["runner unregistered", false],
    ["", false],
  ])("%j → %s", (message, expected) => {
    expect(endsLikeUnregisteredRunner(message)).toBe(expected);
  });
});
