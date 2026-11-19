// The runner protocol's pure rules: which runner may take a job, when a log
// request's rows are stored and acked, and the error-message guard.
import { describe, expect, it } from "vitest";
import {
  decideLogFlush,
  endsLikeUnregisteredRunner,
  isFinalSentinel,
  isLogOmission,
  LOG_FLUSH_AGE_MS,
  LOG_FLUSH_BYTES,
  LOG_FLUSH_ROWS,
  LOG_HOLD_MAX_ROWS,
  LOG_ROW_TOO_LARGE,
  type LogFlushDecision,
  type LogFlushRequest,
  type LogFlushTrigger,
  labelsMatch,
  maskRows,
  type StoredLogLine,
  settleFlush,
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
      trigger: "rows",
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
      trigger: "bytes",
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
    ).toEqual({
      kind: "flush",
      start: 0,
      end: 1,
      lines: ["line 0"],
      final: false,
      trigger: "age",
    });
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
      trigger: "rows",
    });
  });

  it("stores a whole final call's trailing rows however few", () => {
    expect(
      decideLogFlush({ ackIndex: 4 }, request({ index: 2, rows: rows(4), noMore: true }), now),
    ).toEqual({
      kind: "flush",
      start: 4,
      end: 6,
      lines: ["line 2", "line 3"],
      final: true,
      trigger: "final",
    });
  });

  it("completes on a final call with zero rows", () => {
    expect(decideLogFlush({ ackIndex: 7 }, request({ index: 7, noMore: true }), now)).toEqual({
      kind: "flush",
      start: 7,
      end: 7,
      lines: [],
      final: true,
      trigger: "final",
    });
  });

  it("completes on a resent final call whose rows are all stored", () => {
    expect(
      decideLogFlush({ ackIndex: 7 }, request({ index: 5, rows: rows(2), noMore: true }), now),
    ).toEqual({ kind: "flush", start: 7, end: 7, lines: [], final: true, trigger: "final" });
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
      trigger: "final",
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
      trigger: "final",
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
      trigger: "final",
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
    ).toEqual({
      kind: "flush",
      start: 3,
      end: 5,
      lines: ["line 0", "line 1"],
      final: false,
      trigger: "partial-final",
    });
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
    ).toEqual({
      kind: "flush",
      start: 3,
      end: 4,
      lines: [""],
      final: false,
      trigger: "partial-final",
    });
  });

  it("stores the new rows of a cut request at once: waiting cannot make it whole", () => {
    // A body cut by the request cap never shows `no_more` (written after the rows), and every
    // resend is cut at the same row until the rows before it are stored.
    expect(decideLogFlush({ ackIndex: 0 }, request({ rows: rows(1), whole: false }), now)).toEqual({
      kind: "flush",
      start: 0,
      end: 1,
      lines: ["line 0"],
      final: false,
      trigger: "partial",
    });
    expect(
      decideLogFlush({ ackIndex: 0 }, request({ rows: rows(50), whole: false }), now),
    ).toMatchObject({ kind: "flush", end: 50, final: false });
    expect(
      decideLogFlush({ ackIndex: 3 }, request({ index: 1, rows: rows(2), whole: false }), now),
    ).toEqual({ kind: "hold", ackIndex: 3, firstUnackedSeenAt: undefined });
  });
});

describe("decideLogFlush with an oversized first row", () => {
  const now = 1_000_000;
  const cut = (overrides: Partial<LogFlushRequest>) =>
    request({ whole: false, oversizedFirstRow: { bytes: 5 * 1024 * 1024 }, ...overrides });

  it("omits the row at the ack when the decoder proved it cannot fit", () => {
    expect(decideLogFlush({ ackIndex: 7 }, cut({ index: 7 }), now)).toEqual({
      kind: "omit",
      index: 7,
      bytes: 5 * 1024 * 1024,
    });
  });

  it("omits it whatever the age of the rows waiting behind it", () => {
    expect(
      decideLogFlush({ ackIndex: 0, firstUnackedSeenAt: now - 1 }, cut({ index: 0 }), now),
    ).toMatchObject({ kind: "omit", index: 0 });
  });

  it("holds a resend below the ack that carries the omitted row again", () => {
    // The answer to the omission was lost: the runner starts at the omitted row once more.
    expect(decideLogFlush({ ackIndex: 8 }, cut({ index: 7 }), now)).toEqual({
      kind: "hold",
      ackIndex: 8,
      firstUnackedSeenAt: undefined,
    });
  });

  it("refuses evidence that starts past the ack", () => {
    expect(decideLogFlush({ ackIndex: 3 }, cut({ index: 4 }), now)).toEqual({ kind: "ahead" });
  });

  it("never omits without the decoder's evidence: zero rows of a cut body at the ack are held", () => {
    // What a large unknown field before a small first row looks like once cut.
    expect(decideLogFlush({ ackIndex: 7 }, request({ index: 7, whole: false }), now)).toEqual({
      kind: "hold",
      ackIndex: 7,
      firstUnackedSeenAt: undefined,
    });
  });

  it("ignores evidence alongside decoded rows or on a whole request", () => {
    expect(decideLogFlush({ ackIndex: 0 }, cut({ index: 0, rows: rows(1) }), now)).toMatchObject({
      kind: "flush",
      start: 0,
      end: 1,
      final: false,
    });
    expect(decideLogFlush({ ackIndex: 0 }, cut({ index: 0, rows: rows(50) }), now)).toMatchObject({
      kind: "flush",
      start: 0,
      end: 50,
      final: false,
    });
    expect(decideLogFlush({ ackIndex: 2 }, cut({ index: 2, whole: true }), now)).toEqual({
      kind: "hold",
      ackIndex: 2,
      firstUnackedSeenAt: undefined,
    });
  });
});

describe("stored log lines", () => {
  it("tell an omitted row from a stored one by its `omitted` reason", () => {
    const row: StoredLogLine = { i: 0, t: null, c: "omitted" };
    const gap: StoredLogLine = { i: 1, omitted: LOG_ROW_TOO_LARGE, bytes: 5_000_000 };
    expect(isLogOmission(row)).toBe(false);
    expect(isLogOmission(gap)).toBe(true);
    expect(LOG_ROW_TOO_LARGE).toBe("row_too_large");
    expect(JSON.parse(JSON.stringify(gap))).toEqual({
      i: 1,
      omitted: "row_too_large",
      bytes: 5_000_000,
    });
  });
});

describe("decideLogFlush triggers", () => {
  const now = 1_000_000;

  it("reports age before rows and bytes", () => {
    const state = { ackIndex: 0, firstUnackedSeenAt: now - LOG_FLUSH_AGE_MS };
    expect(decideLogFlush(state, request({ rows: rows(LOG_FLUSH_ROWS) }), now)).toMatchObject({
      kind: "flush",
      trigger: "age",
    });
    const big = [{ content: "x".repeat(LOG_FLUSH_BYTES) }];
    expect(decideLogFlush(state, request({ rows: big }), now)).toMatchObject({ trigger: "age" });
  });

  it("reports rows before bytes", () => {
    const many = Array.from({ length: LOG_FLUSH_ROWS }, () => ({
      content: "x".repeat(LOG_FLUSH_BYTES / LOG_FLUSH_ROWS + 1),
    }));
    expect(decideLogFlush({ ackIndex: 0 }, request({ rows: many }), now)).toMatchObject({
      trigger: "rows",
    });
  });
});

type Flush = Extract<LogFlushDecision, { kind: "flush" }>;

function flush(start: number, count: number, trigger: LogFlushTrigger, final = false): Flush {
  const lines = Array.from({ length: count }, (_, i) => `line ${start + i}`);
  return { kind: "flush", start, end: start + count, lines, final, trigger };
}

describe("settleFlush", () => {
  const now = 2_000_000;

  it("holds at most 8 rows", () => {
    expect(LOG_HOLD_MAX_ROWS).toBe(8);
  });

  it.each([
    // [what, decision, settled, expected]
    ["final: everything", flush(10, 5, "final", true), 0, { end: 15, force: false }],
    ["nothing held", flush(10, 50, "rows"), 50, { end: 60, force: false }],
    ["more settled than fresh", flush(10, 3, "age"), 9, { end: 13, force: false }],
    ["a few held after settled rows", flush(10, 50, "rows"), 47, { end: 57, force: false }],
    ["8 held after settled rows", flush(10, 10, "rows"), 2, { end: 12, force: false }],
    // On age nothing is kept back: every row of the request has waited long enough.
    ["held after settled rows, age", flush(10, 10, "age"), 2, { end: 20, force: true }],
    ["one held after settled rows, age", flush(10, 50, "age"), 49, { end: 60, force: true }],
    [
      "held, partial final, settled rows",
      flush(10, 6, "partial-final"),
      1,
      { end: 11, force: false },
    ],
    ["9 held", flush(10, 50, "rows"), 41, { end: 60, force: true }],
    ["all held past 8", flush(10, 9, "bytes"), 0, { end: 19, force: true }],
    ["nothing settled, age", flush(10, 3, "age"), 0, { end: 13, force: true }],
    ["nothing settled, partial final", flush(10, 3, "partial-final"), 0, { end: 13, force: true }],
    ["nothing settled, cut non-final", flush(10, 3, "partial"), 0, { end: 13, force: true }],
  ] as const)("%s", (_what, decision, settled, expected) => {
    const result = settleFlush(decision, settled, { ackIndex: decision.start }, now);
    expect(result).toEqual({
      kind: "store",
      start: decision.start,
      end: expected.end,
      lines: decision.lines.slice(0, expected.end - decision.start),
      final: decision.final,
      force: expected.force,
      firstUnackedSeenAt: expected.end < decision.end ? now : undefined,
    });
  });

  it.each(["rows", "bytes", "partial-final"] as const)(
    "keeps the age of rows already seen when storing settled rows on %s",
    (trigger) => {
      const decision = flush(10, 5, trigger);
      const state = { ackIndex: 10, firstUnackedSeenAt: now - 9_000 };
      expect(settleFlush(decision, 3, state, now)).toMatchObject({
        kind: "store",
        end: 13,
        force: false,
        firstUnackedSeenAt: now - 9_000,
      });
    },
  );

  it.each(["rows", "bytes", "partial-final"] as const)(
    "stores everything, forced, once the held rows have waited 15 s, even on %s",
    (trigger) => {
      const decision = flush(10, 2, trigger);
      const aged = { ackIndex: 10, firstUnackedSeenAt: now - LOG_FLUSH_AGE_MS };
      expect(settleFlush(decision, 1, aged, now)).toMatchObject({
        kind: "store",
        end: 12,
        force: true,
        firstUnackedSeenAt: undefined,
      });
      expect(settleFlush(flush(10, 2, trigger), 0, aged, now)).toMatchObject({
        kind: "store",
        end: 12,
        force: true,
      });
      const young = { ackIndex: 10, firstUnackedSeenAt: now - LOG_FLUSH_AGE_MS + 1 };
      expect(settleFlush(decision, 1, young, now)).toMatchObject({ end: 11, force: false });
    },
  );

  it.each(["rows", "bytes"] as const)("holds a request with nothing settled on %s", (trigger) => {
    const decision = flush(10, 3, trigger);
    expect(settleFlush(decision, 0, { ackIndex: 10 }, now)).toEqual({
      kind: "hold",
      ackIndex: 10,
      firstUnackedSeenAt: now,
    });
    expect(settleFlush(decision, 0, { ackIndex: 10, firstUnackedSeenAt: now - 7 }, now)).toEqual({
      kind: "hold",
      ackIndex: 10,
      firstUnackedSeenAt: now - 7,
    });
  });

  it("stores a final sentinel as decided: acked, not a line", () => {
    const sentinel: Flush = {
      kind: "flush",
      start: 7,
      end: 8,
      lines: [],
      final: true,
      trigger: "final",
    };
    expect(settleFlush(sentinel, 0, { ackIndex: 7 }, now)).toEqual({
      kind: "store",
      start: 7,
      end: 8,
      lines: [],
      final: true,
      force: false,
      firstUnackedSeenAt: undefined,
    });
  });

  it("never acks past what it stores", () => {
    for (let fresh = 1; fresh <= 20; fresh++) {
      for (let settled = 0; settled <= fresh; settled++) {
        for (const trigger of ["age", "rows", "bytes", "partial-final"] as const) {
          const decision = flush(100, fresh, trigger);
          const result = settleFlush(decision, settled, { ackIndex: 100 }, now);
          if (result.kind === "hold") {
            expect(result.ackIndex).toBe(100);
            expect(fresh).toBeLessThanOrEqual(LOG_HOLD_MAX_ROWS);
            continue;
          }
          expect(result.lines).toHaveLength(result.end - result.start);
          expect(result.end).toBeGreaterThan(100);
          expect(decision.end - result.end).toBeLessThanOrEqual(LOG_HOLD_MAX_ROWS);
          if (!result.force) expect(result.end - 100).toBe(settled);
        }
      }
    }
  });
});

describe("log flush with masking", () => {
  const TOKEN = "fyrden_job_Q8x2LmN4pR7sT1vW3yZ5bC6dF9gH0jK";
  const masks = [{ value: TOKEN, fromIndex: 0 }];

  /** One request through the flush rule, the masker and the hold, as the log path runs them. */
  function handle(
    state: { ackIndex: number; firstUnackedSeenAt?: number | undefined },
    carry: ReturnType<ReturnType<typeof maskRows>["carryAt"]>,
    req: LogFlushRequest,
    now: number,
    list: readonly { value: string; fromIndex: number }[] = masks,
  ) {
    const decision = decideLogFlush(state, req, now);
    if (decision.kind !== "flush") return { decision, settle: null, lines: [], carry };
    const fresh = req.rows.slice(state.ackIndex - req.index).map((row) => row.content);
    const masked = maskRows(list, carry, fresh, { start: decision.start, final: decision.final });
    const settle = settleFlush(decision, masked.settled, state, now);
    if (settle.kind === "hold") return { decision, settle, lines: [], carry };
    const result = settle.force
      ? maskRows(list, carry, fresh, { start: decision.start, force: true })
      : masked;
    const count = settle.end - settle.start;
    return {
      decision,
      settle,
      lines: result.lines.slice(0, Math.min(count, fresh.length)),
      carry: result.carryAt(Math.min(count, fresh.length)),
    };
  }

  it("stores every row by the first request 15 s after it was first seen", () => {
    // Each "abcd" row extends a partial match of the value, so masking never settles the
    // last rows; the age rule must still store each row on time.
    const list = [{ value: "abcdabcdX", fromIndex: 0 }];
    const printed: string[] = [];
    const firstSeen: number[] = [];
    let state: { ackIndex: number; firstUnackedSeenAt?: number | undefined } = { ackIndex: 0 };
    let carry: ReturnType<ReturnType<typeof maskRows>["carryAt"]> = null;
    for (let now = 0; now <= 60_000; now += 5_000) {
      printed.push("abcd");
      if (now === 0) printed.push("abcd");
      const req = {
        index: state.ackIndex,
        rows: printed.slice(state.ackIndex).map((content) => ({ content })),
        noMore: false,
        whole: true,
      };
      for (let i = state.ackIndex; i < printed.length; i++) firstSeen[i] ??= now;
      const out = handle(state, carry, req, now, list);
      if (out.decision.kind === "hold") {
        state = { ackIndex: state.ackIndex, firstUnackedSeenAt: out.decision.firstUnackedSeenAt };
      } else if (out.settle === null || out.settle.kind === "hold") {
        state = { ackIndex: state.ackIndex, firstUnackedSeenAt: out.settle?.firstUnackedSeenAt };
      } else {
        state = { ackIndex: out.settle.end, firstUnackedSeenAt: out.settle.firstUnackedSeenAt };
        carry = out.carry;
      }
      for (let i = 0; i < printed.length; i++) {
        if ((firstSeen[i] as number) + LOG_FLUSH_AGE_MS <= now)
          expect(state.ackIndex).toBeGreaterThan(i);
      }
    }
    expect(state.ackIndex).toBeGreaterThan(2);
  });

  it("advances a cut non-final row even when its masked suffix is unsettled", () => {
    const result = handle(
      { ackIndex: 0 },
      null,
      { index: 0, rows: [{ content: "abcd" }], noMore: false, whole: false },
      1_000,
      [{ value: "abcdefgh", fromIndex: 0 }],
    );
    expect(result.decision).toMatchObject({ kind: "flush", trigger: "partial" });
    expect(result.settle).toMatchObject({ kind: "store", start: 0, end: 1, force: true });
    expect(result.lines).toEqual(["***"]);
  });

  it("stores an already aged cut final request whole, forced", () => {
    const list = [{ value: "abcdefgh", fromIndex: 0 }];
    const rows = [{ content: "ordinary" }, { content: "abcd" }];
    const first = handle(
      { ackIndex: 0 },
      null,
      { index: 0, rows, noMore: false, whole: true },
      0,
      list,
    );
    expect(first.decision).toEqual({ kind: "hold", ackIndex: 0, firstUnackedSeenAt: 0 });
    // The same rows 15 s later in a final call the decoder cut: its trigger is partial-final.
    const cut = handle(
      { ackIndex: 0, firstUnackedSeenAt: 0 },
      null,
      { index: 0, rows, noMore: true, whole: false },
      LOG_FLUSH_AGE_MS,
      list,
    );
    expect(cut.decision).toMatchObject({ kind: "flush", trigger: "partial-final" });
    expect(cut.settle).toMatchObject({ kind: "store", start: 0, end: 2, force: true });
    expect(cut.lines).toEqual(["ordinary", "***"]);
  });

  it("advances a capped final after a lost ack, and the next request masks the rest", () => {
    // Rows 0..10,000; the decoder stops after 10,000 rows, so the last is not read.
    const all = Array.from({ length: 10_001 }, (_, i) => ({ content: `line ${i}` }));
    all[9_999] = { content: `token: ${TOKEN.slice(0, 12)}` };
    all[10_000] = { content: `${TOKEN.slice(12)} done` };
    const now = 5_000_000;
    // The answer to the request that stored 9,995 rows was lost: the runner resends from 0.
    const capped = { index: 0, rows: all.slice(0, 10_000), noMore: true, whole: false };
    const first = handle({ ackIndex: 9_995 }, null, capped, now);
    expect(first.decision).toMatchObject({ kind: "flush", trigger: "partial-final", start: 9_995 });
    expect(first.settle).toMatchObject({ kind: "store", start: 9_995, end: 9_999, force: false });
    expect(first.lines).toEqual(["line 9995", "line 9996", "line 9997", "line 9998"]);
    // Resent from the new ack, whole this time.
    const rest = { index: 9_999, rows: all.slice(9_999), noMore: true, whole: true };
    const second = handle({ ackIndex: 9_999 }, first.carry, rest, now);
    expect(second.settle).toMatchObject({ kind: "store", start: 9_999, end: 10_001, final: true });
    expect(second.lines).toEqual(["token: ***", "*** done"]);
  });

  it("stores a capped final whose only fresh row holds a partial, forced, and masks the rest", () => {
    const now = 5_000_000;
    const head = { content: `token: ${TOKEN.slice(0, 12)}` };
    const capped = { index: 9_999, rows: [head], noMore: true, whole: false };
    const first = handle({ ackIndex: 9_999 }, null, capped, now);
    expect(first.settle).toMatchObject({ kind: "store", start: 9_999, end: 10_000, force: true });
    expect(first.lines).toEqual(["token: ***"]);
    expect(first.carry).toMatchObject({ length: 12 });
    const rest = {
      index: 10_000,
      rows: [{ content: `${TOKEN.slice(12)} done` }],
      noMore: true,
      whole: true,
    };
    const second = handle({ ackIndex: 10_000 }, first.carry, rest, now);
    expect(second.lines).toEqual(["*** done"]);
  });

  it("holds a first request of one 600 KiB row ending in a partial, then stores it by age", () => {
    const now = 7_000_000;
    const row = { content: `${"p".repeat(600 * 1024)} ${TOKEN.slice(0, 10)}` };
    const req = { index: 0, rows: [row], noMore: false, whole: true };
    const first = handle({ ackIndex: 0 }, null, req, now);
    expect(first.decision).toMatchObject({ kind: "flush", trigger: "bytes" });
    expect(first.settle).toEqual({ kind: "hold", ackIndex: 0, firstUnackedSeenAt: now });
    const seen = first.settle?.firstUnackedSeenAt;
    const before = handle(
      { ackIndex: 0, firstUnackedSeenAt: seen },
      null,
      req,
      now + LOG_FLUSH_AGE_MS - 1,
    );
    expect(before.settle).toMatchObject({ kind: "hold", firstUnackedSeenAt: now });
    const later = handle(
      { ackIndex: 0, firstUnackedSeenAt: seen },
      null,
      req,
      now + LOG_FLUSH_AGE_MS,
    );
    expect(later.decision).toMatchObject({ kind: "flush", trigger: "age" });
    expect(later.settle).toMatchObject({ kind: "store", start: 0, end: 1, force: true });
    expect(later.lines).toEqual([`${"p".repeat(600 * 1024)} ***`]);
    expect(later.carry).toMatchObject({ length: 10 });
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
    ["unregistered runner\u{10100}", true],
    ["unregistered runner😀", false],
    ["unregistered runner\ud800", false],
    ["\t".repeat(8_192) + "x", false],
    ["unregistered runner" + "\t.\u{10100}".repeat(8_192), true],
    ["\t.\u{10100}".repeat(8_192), false],
    ["unregistered runners", false],
    ["unregistered runner id 4", false],
    ["runner unregistered", false],
    ["", false],
  ])("%j → %s", (message, expected) => {
    expect(endsLikeUnregisteredRunner(message)).toBe(expected);
  });
});
