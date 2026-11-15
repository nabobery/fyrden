// The log flush rule driven by a model of the runner's reporter against a
// fake chunk store, through bursts, trickles, lost answers, store failures,
// resets and a final call in either form. The invariants are the ones the log
// path relies on: an ack is only ever sent for rows already stored, stored
// rows are contiguous and never duplicated, and the runner is never made to
// hold rows longer than the flush thresholds allow.
//
// Runner behaviour modelled, as measured against the runner's two supported
// releases and read in their reporter source: it keeps every row past its
// acked offset and sends all of them, from that offset, on each call. It calls
// when its log ticker fires (every 5 s by default), when its maximum-latency
// timer fires (3 s by default, armed when a row arrives while it is idle, and
// stopped by any other call), at once on a step transition, and at once when
// 100 or more rows are buffered; it makes no call with nothing buffered. An
// ack above what it sent is clamped, one below its offset is an error and the
// rows are kept; the final call carries the
// trailing rows with `noMore`, and when none are left the newer release sends
// zero rows while the older one sends one row with empty content at the next
// index.
//
// A row too large for any request the server reads (a line of more than 4 MiB,
// which the runner sends whole) is modelled as the decoder sees it: a request
// whose body is cut inside that row. With rows before it, those rows are what
// decodes; with it first, the decoder proves it oversized and the server
// records an omission for that position. Every position below the ack is then
// either the row the runner printed or an omission of a row that was too
// large, never anything else, and a log with an omission never completes.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  decideLogFlush,
  LOG_FLUSH_AGE_MS,
  LOG_FLUSH_BYTES,
  LOG_FLUSH_ROWS,
  LOG_HOLD_MAX_ROWS,
  type LogFlushRequest,
  settleFlush,
} from "../../src/ci/index.js";

const RUNNER_BATCH = 100;
/** The runner's default `log_report_max_latency`. */
const RUNNER_MAX_LATENCY_MS = 3_000;
/** Padding that makes a printed row large enough to reach the byte threshold in a few rows. */
const PAD = "x".repeat(200 * 1024);
/** The encoded size the model's oversized rows declare. */
const HUGE_BYTES = 5 * 1024 * 1024;
/** An omission record's object holds no line of content. */
const NO_LINES: readonly string[] = [];

type Fault = "none" | "putFails" | "casLost";

interface SendOptions {
  /** The answer is lost: the server handled the call but the runner never sees it. */
  lost: boolean;
  /** Pass a strict prefix of the rows (this many, modulo their count), marked not whole: a cut body or a capped decode. Null keeps all. */
  cut: number | null;
  fault: Fault;
  /** Rows printed after the request left and before the server handles it. */
  printDuring: number;
}

const healthy: SendOptions = { lost: false, cut: null, fault: "none", printDuring: 0 };

type Action =
  /** `huge`: the first printed row is too large for any request (the rest are ordinary). */
  | { kind: "print"; count: number; big: boolean; huge: boolean }
  /** The log ticker fires; `jitter` skips ticks that find the buffer empty or are not modelled. */
  | { kind: "timer"; jitter: number; send: SendOptions }
  /** The maximum-latency timer fires, if armed. */
  | { kind: "latency"; send: SendOptions }
  /** A step starts or ends: an immediate call, `after` ms from the last event. */
  | { kind: "step"; after: number; send: SendOptions }
  | { kind: "reset" }
  /** The runner closes, `after` ms (default 0) from the last event, and makes its final call. */
  | { kind: "final"; send: SendOptions; after?: number };

interface Chunk {
  start: number;
  end: number;
  lines: readonly string[];
  /** An omission record for the one position `start`, with no line of content. */
  omitted: boolean;
  key: string;
}

/** The runner's side: everything it printed, its acked offset, and whether it has closed. */
class ModelRunner {
  printed: string[] = [];
  /** Positions of rows too large for any request. */
  huge = new Set<number>();
  offset = 0;
  closing = false;
  sentinel = false;
  rowsSent = 0;
  lastTimer = 0;
  /** When the maximum-latency timer was armed, or null while it is idle. */
  latencyArmedAt: number | null = null;

  constructor(readonly olderRelease: boolean) {}

  /** Every position the runner has produced: printed rows plus the older release's sentinel. */
  get positions(): number {
    return this.printed.length + (this.sentinel ? 1 : 0);
  }

  contentAt(position: number): string {
    return position < this.printed.length ? (this.printed[position] as string) : "";
  }

  print(count: number, big: boolean, now: number, huge = false): void {
    if (this.closing) return;
    for (let i = 0; i < count; i++) {
      const n = this.printed.length;
      if (huge && i === 0) this.huge.add(n);
      this.printed.push(big && i % 2 === 0 ? `row ${n} ${PAD}` : `row ${n}`);
    }
    if (count > 0 && this.latencyArmedAt === null) this.latencyArmedAt = now;
  }

  buffered(): number {
    return this.positions - this.offset;
  }

  snapshot(): LogFlushRequest {
    const rows: { content: string }[] = [];
    for (let p = this.offset; p < this.positions; p++) rows.push({ content: this.contentAt(p) });
    this.rowsSent += rows.length;
    return { index: this.offset, rows, noMore: this.closing, whole: true };
  }

  /**
   * What the server decodes of a request: cut inside the first oversized row
   * it carries, so only the rows before that row, and never `noMore` (written
   * after the rows); with that row first, the decoder's evidence instead.
   */
  decoded(sent: LogFlushRequest): LogFlushRequest {
    for (let k = 0; k < sent.rows.length; k++) {
      if (!this.huge.has(sent.index + k)) continue;
      return k === 0
        ? {
            index: sent.index,
            rows: [],
            noMore: false,
            whole: false,
            oversizedFirstRow: { bytes: HUGE_BYTES },
          }
        : { index: sent.index, rows: sent.rows.slice(0, k), noMore: false, whole: false };
    }
    return sent;
  }

  close(): void {
    if (this.closing) return;
    this.closing = true;
    if (this.olderRelease && this.buffered() === 0) this.sentinel = true;
  }

  receive(request: LogFlushRequest, ack: number): void {
    const sentEnd = request.index + request.rows.length;
    // Below the offset is an error to the runner: it keeps its rows. Above what it sent is clamped.
    if (ack < this.offset) throw new Error(`ack ${ack} below the runner's offset ${this.offset}`);
    this.offset = Math.min(ack, sentEnd);
  }
}

/** The server's side: a durable ack and chunk manifest, and the in-memory first-seen time. */
class FakeStore {
  ack = 0;
  complete = false;
  /** A whole final call committed; complete only with no omission. */
  ended = false;
  omitted = 0;
  sentinelAt: number | null = null;
  manifest = new Map<number, Chunk>();
  objects = new Map<string, readonly string[]>();
  firstUnackedSeenAt: number | undefined;
  private writes = 0;

  reset(): void {
    this.firstUnackedSeenAt = undefined;
  }

  /**
   * Handles one request the way the log path does; answers the ack to send.
   * `held`, when set, is how many of the request's new rows masking leaves
   * unsettled, and the hold rule decides what is stored.
   */
  handle(
    request: LogFlushRequest,
    now: number,
    fault: Fault,
    held: number | null = null,
  ): { ack: number; committed: boolean; final: boolean; held: boolean } {
    const decision = decideLogFlush(
      { ackIndex: this.ack, firstUnackedSeenAt: this.firstUnackedSeenAt },
      request,
      now,
    );
    if (decision.kind === "ahead") throw new Error("request ahead of the stored ack");
    if (decision.kind === "omit") return this.omit(decision.index, now, fault);
    if (decision.kind === "hold") {
      this.firstUnackedSeenAt = decision.firstUnackedSeenAt;
      // The decision's ack is what the runner hears; it must be the durable one.
      return { ack: decision.ackIndex, committed: false, final: false, held: true };
    }
    let { start, end, lines, final } = decision;
    let seenAfter: number | undefined;
    if (held !== null) {
      const settled = Math.max(0, decision.end - decision.start - held);
      const settle = settleFlush(
        decision,
        settled,
        { ackIndex: this.ack, firstUnackedSeenAt: this.firstUnackedSeenAt },
        now,
      );
      if (settle.kind === "hold") {
        expect(settle.ackIndex).toBe(this.ack);
        this.firstUnackedSeenAt = settle.firstUnackedSeenAt;
        return { ack: this.ack, committed: false, final: false, held: true };
      }
      ({ start, end, lines, final } = settle);
      seenAfter = settle.firstUnackedSeenAt;
    }
    const failed = () => {
      // The rows stay unacked, so their clock keeps running.
      this.firstUnackedSeenAt ??= now;
      return { ack: this.ack, committed: false, final: false, held: false };
    };
    let key: string | null = null;
    if (lines.length > 0) {
      if (fault === "putFails") return failed();
      key = `${start}-${end}-${this.writes++}`;
      this.objects.set(key, lines);
      if (fault === "casLost") {
        // An equal flush from a call the runner abandoned commits first.
        this.commit(start, end, lines, final, this.put(start, end, lines));
      }
    }
    if (this.ack !== start) {
      if (key !== null) this.objects.delete(key);
      this.firstUnackedSeenAt = undefined;
      return { ack: this.ack, committed: false, final: false, held: false };
    }
    this.commit(start, end, lines, final, key);
    this.firstUnackedSeenAt = seenAfter;
    return { ack: this.ack, committed: true, final, held: false };
  }

  /** An omission record, stored like a chunk: its own object, then the manifest and the ack by compare-and-set. */
  private omit(
    index: number,
    now: number,
    fault: Fault,
  ): { ack: number; committed: boolean; final: boolean; held: boolean } {
    expect(index).toBe(this.ack);
    if (fault === "putFails") {
      this.firstUnackedSeenAt ??= now;
      return { ack: this.ack, committed: false, final: false, held: false };
    }
    const key = `${index}-${index + 1}-${this.writes++}`;
    this.objects.set(key, NO_LINES);
    if (fault === "casLost") {
      const other = `${index}-${index + 1}-${this.writes++}`;
      this.objects.set(other, NO_LINES);
      this.recordOmission(index, other);
    }
    if (this.ack !== index) {
      this.objects.delete(key);
      this.firstUnackedSeenAt = undefined;
      return { ack: this.ack, committed: false, final: false, held: false };
    }
    this.recordOmission(index, key);
    this.firstUnackedSeenAt = undefined;
    return { ack: this.ack, committed: true, final: false, held: false };
  }

  private recordOmission(index: number, key: string): void {
    if (this.ack !== index) return;
    this.manifest.set(index, { start: index, end: index + 1, lines: NO_LINES, omitted: true, key });
    this.ack = index + 1;
    this.omitted++;
  }

  private put(start: number, end: number, lines: readonly string[]): string {
    const key = `${start}-${end}-${this.writes++}`;
    this.objects.set(key, lines);
    return key;
  }

  private commit(
    start: number,
    end: number,
    lines: readonly string[],
    final: boolean,
    key: string | null,
  ): void {
    if (this.ack !== start) return;
    if (key !== null)
      this.manifest.set(start, { start, end: start + lines.length, lines, omitted: false, key });
    if (lines.length < end - start) this.sentinelAt = start + lines.length;
    this.ack = end;
    if (final) {
      this.ended = true;
      // An omission is sticky: no final call, late or repeated, completes the log.
      if (this.omitted === 0) this.complete = true;
    }
  }
}

const sendOptions = (healthy: boolean): fc.Arbitrary<SendOptions> =>
  healthy
    ? fc.record({
        lost: fc.constant(false),
        cut: fc.constant(null),
        fault: fc.constant<Fault>("none"),
        printDuring: fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 120 })),
      })
    : fc.record({
        lost: fc.integer({ min: 0, max: 4 }).map((n) => n === 0),
        cut: fc.option(fc.integer({ min: 0, max: 400 }), { freq: 4 }),
        fault: fc.constantFrom<Fault>("none", "none", "none", "putFails", "casLost"),
        printDuring: fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 120 })),
      });

/** `tickerOnly`: calls only on the log ticker and at 100 buffered rows, no latency timer or step transitions. */
const actions = (healthy: boolean, tickerOnly = false): fc.Arbitrary<Action[]> =>
  fc.array(
    fc.oneof(
      {
        weight: 4,
        arbitrary: fc.record({
          kind: fc.constant("print" as const),
          // Trickles of one or a few rows, and bursts of hundreds.
          count: fc.oneof(fc.integer({ min: 1, max: 5 }), fc.integer({ min: 40, max: 400 })),
          big: fc.boolean(),
          // Rows too large for any request only where failures are modelled: they are overhead.
          huge: healthy ? fc.constant(false) : fc.integer({ min: 0, max: 5 }).map((n) => n === 0),
        }),
      },
      {
        weight: 4,
        arbitrary: fc.record({
          kind: fc.constant("timer" as const),
          jitter: fc.integer({ min: 0, max: 20_000 }),
          send: sendOptions(healthy),
        }),
      },
      ...(tickerOnly
        ? []
        : [
            {
              weight: 2,
              arbitrary: fc.record({
                kind: fc.constant("latency" as const),
                send: sendOptions(healthy),
              }),
            },
            {
              weight: 2,
              arbitrary: fc.record({
                kind: fc.constant("step" as const),
                // Steps can follow each other within milliseconds.
                after: fc.oneof(
                  fc.integer({ min: 0, max: 50 }),
                  fc.integer({ min: 0, max: 20_000 }),
                ),
                send: sendOptions(healthy),
              }),
            },
          ]),
      ...(healthy
        ? []
        : [
            { weight: 1, arbitrary: fc.constant({ kind: "reset" as const }) },
            {
              weight: 1,
              arbitrary: fc.record({
                kind: fc.constant("final" as const),
                send: sendOptions(false),
              }),
            },
          ]),
    ),
    { maxLength: 40 },
  );

/** The runner's report interval: the shortest the measured runs used, a middling one, and five seconds. */
const intervals = fc.constantFrom(200, 1_000, 5_000);

const contentBytes = (rows: readonly { content: string }[]): number =>
  // Every model row is ASCII, so its UTF-8 size is its length.
  rows.reduce((sum, row) => sum + row.content.length, 0);

/** Checks the stored log against what the runner printed. */
function checkStore(store: FakeStore, runner: ModelRunner): void {
  let covered = 0;
  for (const chunk of [...store.manifest.values()].sort((a, b) => a.start - b.start)) {
    expect(chunk.start).toBe(covered);
    expect(store.objects.get(chunk.key)).toBe(chunk.lines);
    if (chunk.omitted) {
      // Only a row too large for any request is ever omitted, one position at a time.
      expect(chunk.end).toBe(chunk.start + 1);
      expect(runner.huge.has(chunk.start)).toBe(true);
      expect(chunk.lines).toEqual([]);
    }
    chunk.lines.forEach((line, i) => {
      expect(runner.huge.has(chunk.start + i)).toBe(false);
      expect(line).toBe(runner.contentAt(chunk.start + i));
    });
    covered = chunk.end;
  }
  // Lines exist only for printed rows: the older release's sentinel is never one.
  expect(covered).toBeLessThanOrEqual(runner.printed.length);
  if (store.sentinelAt === null) {
    expect(store.ack).toBe(covered);
  } else {
    // Only the final call's sentinel is acked without a line, and nothing follows it.
    expect(store.sentinelAt).toBe(covered);
    expect(store.ack).toBe(covered + 1);
    expect(store.ended).toBe(true);
    expect(runner.sentinel).toBe(true);
  }
  expect(store.omitted).toBe([...store.manifest.values()].filter((c) => c.omitted).length);
  if (store.omitted > 0) expect(store.complete).toBe(false);
}

interface RunResult {
  runner: ModelRunner;
  store: FakeStore;
  /** Calls answered with a hold that were whole, healthy and carried no row below the ack. */
  held: number;
  /** Rows carried by every other call that did not commit them: lost, cut, failed, or resent. */
  overhead: number;
}

/**
 * `holds`, when set, makes the server apply the hold rule: each request's
 * unsettled row count is taken in turn from the list.
 */
function run(
  olderRelease: boolean,
  interval: number,
  script: readonly Action[],
  holds: readonly number[] | null = null,
): RunResult {
  const runner = new ModelRunner(olderRelease);
  let calls = 0;
  /** When the server first decoded each position; checked only while nothing unhealthy happened. */
  const firstSeen: number[] = [];
  let clean = true;
  const store = new FakeStore();
  let now = 0;
  let lastAck = 0;
  let held = 0;
  let overhead = 0;

  const send = (options: SendOptions): void => {
    if (store.ended && runner.closing && runner.buffered() === 0) return;
    const sent = runner.snapshot();
    const seenWhole = runner.decoded(sent);
    const cut = (options.cut !== null && seenWhole.rows.length > 0) || !seenWhole.whole;
    const request: LogFlushRequest =
      options.cut !== null && seenWhole.rows.length > 0
        ? {
            ...seenWhole,
            rows: seenWhole.rows.slice(0, (options.cut ?? 0) % seenWhole.rows.length),
            whole: false,
          }
        : seenWhole;
    // Any call stops the maximum-latency timer; rows printed during the call rearm it.
    runner.latencyArmedAt = null;
    runner.print(options.printDuring, false, now);
    const before = store.ack;
    const wasComplete = store.complete;
    const fresh = Math.max(0, request.index + request.rows.length - before);
    const freshRows = request.rows.slice(Math.max(0, before - request.index));
    const seen = store.firstUnackedSeenAt;
    const unsettled = holds === null ? null : (holds[calls++ % holds.length] as number);
    if (options.lost || options.fault !== "none") clean = false;
    // A request that carries no new row makes the server forget when unacked rows were
    // first seen (the flush rule remembers nothing then), so the bound cannot hold past it.
    const decodedEnd = request.index + request.rows.length;
    if (decodedEnd <= store.ack && firstSeen.length > store.ack) clean = false;
    for (let p = Math.max(request.index, store.ack); p < request.index + request.rows.length; p++) {
      firstSeen[p] ??= now;
    }
    const answer = store.handle(request, now, options.fault, unsettled);

    expect(answer.ack).toBe(store.ack);
    if (answer.held) expect(answer.ack).toBe(before);
    const stale = Math.min(sent.rows.length, Math.max(0, before - sent.index));
    if (options.lost || cut || options.fault !== "none" || stale > 0) {
      overhead += sent.rows.length;
    } else if (answer.held) {
      // A clean hold carries only new rows, and fewer than the row threshold.
      expect(sent.rows.length).toBeLessThan(LOG_FLUSH_ROWS);
      held++;
    }
    expect(store.ack).toBeGreaterThanOrEqual(lastAck);
    lastAck = store.ack;
    checkStore(store, runner);

    if (holds !== null && clean) {
      // Every row is stored by the first request 15 s after the server first saw it that
      // carries it: a cut request cannot store rows past its cut, which it never read.
      const decoded = Math.min(firstSeen.length, request.index + request.rows.length);
      for (let p = store.ack; p < decoded; p++) {
        expect((firstSeen[p] as number) + LOG_FLUSH_AGE_MS).toBeGreaterThan(now);
      }
    }
    if (cut && answer.committed) {
      // Storing a cut request's rows restarts the age clock, so rows past the cut count as
      // first seen when a request next carries them.
      firstSeen.length = Math.min(firstSeen.length, request.index + request.rows.length);
    }
    if (holds !== null) {
      checkHeld(request, options, before, fresh, seen, now, answer, store.firstUnackedSeenAt);
    } else if (request.whole && options.fault === "none") {
      const due =
        fresh >= LOG_FLUSH_ROWS ||
        contentBytes(freshRows) >= LOG_FLUSH_BYTES ||
        (fresh > 0 && seen !== undefined && now - seen >= LOG_FLUSH_AGE_MS) ||
        request.noMore;
      if (due) {
        expect(answer.committed).toBe(true);
        expect(store.ack).toBe(request.index + request.rows.length);
      }
    }
    if (holds === null && !request.whole) {
      expect(answer.final).toBe(false);
      expect(store.complete).toBe(wasComplete);
      if (request.oversizedFirstRow !== undefined) {
        // Past exactly the one row proven too large, and only when it is the row at the ack.
        const omittable = request.index === before ? 1 : 0;
        expect([0, omittable]).toContain(store.ack - before);
        if (options.fault === "none") expect(store.ack - before).toBe(omittable);
      } else {
        // Ack moves only by a flush of this request's new rows: its own, or an equal one that won.
        expect([0, fresh]).toContain(store.ack - before);
        if (options.fault === "none") expect(store.ack - before).toBe(answer.committed ? fresh : 0);
        expect(store.ack).toBeLessThanOrEqual(
          Math.max(before, request.index + request.rows.length),
        );
      }
    }
    if (store.complete && !wasComplete) {
      expect(request.whole && request.noMore).toBe(true);
      expect(store.ack).toBe(runner.positions);
    }

    if (!options.lost) runner.receive(sent, answer.ack);
    if (!runner.closing && runner.buffered() >= RUNNER_BATCH) send(healthy);
  };

  for (const action of script) {
    switch (action.kind) {
      case "print":
        runner.print(action.count, action.big, now, action.huge);
        if (runner.buffered() >= RUNNER_BATCH && !runner.closing) send(healthy);
        break;
      case "timer":
        now = Math.max(now, runner.lastTimer + interval + action.jitter);
        runner.lastTimer = now;
        if (runner.buffered() > 0) send(action.send);
        else runner.latencyArmedAt = null;
        break;
      case "latency":
        if (runner.latencyArmedAt === null) break;
        now = Math.max(now, runner.latencyArmedAt + RUNNER_MAX_LATENCY_MS);
        runner.latencyArmedAt = null;
        if (runner.buffered() > 0) send(action.send);
        break;
      case "step":
        now += action.after;
        if (runner.buffered() > 0) send(action.send);
        break;
      case "reset":
        clean = false;
        store.reset();
        break;
      case "final":
        now += action.after ?? 0;
        runner.close();
        send(action.send);
        break;
    }
  }
  // The runner closes and its final calls reach a healthy server. A row too large still unacked
  // takes a call of its own to omit, and the rows before it one more (the final flush retries).
  runner.close();
  now += interval;
  for (let k = 0; k <= 2 * runner.huge.size && !(store.ended && runner.buffered() === 0); k++)
    send(healthy);
  expect(store.ended).toBe(true);
  expect(store.complete).toBe(runner.huge.size === 0);
  expect(store.omitted).toBe(runner.huge.size);
  expect(store.ack).toBe(runner.positions);
  expect(runner.offset).toBe(runner.positions);
  checkStore(store, runner);
  // Holds on any schedule: a clean flush sends each of its rows once, as distinct positions; a
  // clean hold sends fewer than LOG_FLUSH_ROWS rows; everything else is counted as overhead.
  if (holds === null) {
    expect(runner.rowsSent).toBeLessThanOrEqual(
      runner.positions + (LOG_FLUSH_ROWS - 1) * held + overhead,
    );
  }
  return { runner, store, held, overhead };
}

/** What the hold rule guarantees for one request: acks behind storage, few rows left, no row past its age. */
function checkHeld(
  request: LogFlushRequest,
  options: SendOptions,
  before: number,
  fresh: number,
  seen: number | undefined,
  now: number,
  answer: { ack: number; committed: boolean; final: boolean; held: boolean },
  seenAfter: number | undefined,
): void {
  const sentEnd = request.index + request.rows.length;
  // Rows left unacked keep an age clock that has started, so the age rule can store them.
  if (fresh > 0 && answer.ack < sentEnd && (answer.held || answer.committed)) {
    expect(seenAfter).toBeDefined();
    expect(seenAfter).toBeLessThanOrEqual(now);
  }
  const omissionEnd =
    !request.whole &&
    request.rows.length === 0 &&
    request.index === before &&
    request.oversizedFirstRow !== undefined
      ? before + 1
      : before;
  expect(answer.ack).toBeGreaterThanOrEqual(before);
  expect(answer.ack).toBeLessThanOrEqual(Math.max(omissionEnd, sentEnd));
  if (answer.committed) expect(sentEnd - answer.ack).toBeLessThanOrEqual(LOG_HOLD_MAX_ROWS);
  if (options.fault !== "none") return;
  // A final call stores everything; a cut final call always advances over new rows.
  if (request.noMore && request.whole) {
    expect(answer.committed).toBe(true);
    expect(answer.ack).toBe(sentEnd);
  }
  if (request.noMore && fresh > 0) expect(answer.ack).toBeGreaterThan(before);
  if (!request.whole) expect(answer.final).toBe(false);
  // Rows first seen 15 s ago are stored by this request.
  if (fresh > 0 && seen !== undefined && now - seen >= LOG_FLUSH_AGE_MS) {
    expect(answer.committed).toBe(true);
    expect(answer.ack).toBeGreaterThan(before);
  }
}

/** Rows sent per position, and the bound that holds when calls come only on the log ticker. */
function tickerBound(interval: number): number {
  // A row is first sent at some time t; each later ticker call is at least one interval after
  // the previous, and the server holds a row only while fewer than 50 are new and the oldest
  // unacked row was first seen under 15 s ago. Calls made at 100 buffered rows always flush in
  // a healthy run (the runner's offset is the stored ack, so all 100 are new). So a row is held
  // on at most ceil(15 s / interval) - 1 later calls before the call that stores it:
  // ceil(15 s / interval) + 1 sends in all. The latency timer and step transitions can call
  // sooner, so this bound is for ticker-only schedules.
  return Math.ceil(LOG_FLUSH_AGE_MS / interval) + 1;
}

describe("runner log acks", () => {
  it("keeps stored rows contiguous and acks only what is stored, through failures", () => {
    fc.assert(
      fc.property(fc.boolean(), intervals, actions(false), (olderRelease, interval, script) => {
        run(olderRelease, interval, script);
      }),
      { numRuns: 400 },
    );
  }, 60_000);

  it("acks only stored rows and leaves at most 8 unacked when masking holds rows", () => {
    // A healthy run that ends in a final call the decoder cut, possibly long after rows
    // were first held: the cut final reports its trigger before age.
    const endsInCutFinal = fc
      .tuple(actions(true), fc.integer({ min: 0, max: 30_000 }), fc.integer({ min: 0, max: 400 }))
      .map(([script, after, cut]): Action[] => [
        ...script,
        { kind: "final", after, send: { ...healthy, cut } },
      ]);
    const holds = fc.array(
      fc.oneof(
        fc.constant(0),
        fc.integer({ min: 1, max: LOG_HOLD_MAX_ROWS }),
        fc.integer({ min: LOG_HOLD_MAX_ROWS + 1, max: 120 }),
      ),
      { minLength: 1, maxLength: 20 },
    );
    fc.assert(
      fc.property(
        fc.boolean(),
        intervals,
        fc.oneof(actions(true), actions(false), endsInCutFinal),
        holds,
        (olderRelease, interval, script, held) => {
          run(olderRelease, interval, script, held);
        },
      ),
      { numRuns: 400 },
    );
  }, 60_000);

  it("bounds the rows a healthy run sends on any schedule", ({ annotate }) => {
    let total = 0;
    let worst = 0;
    let heldCalls = 0;
    let runs = 0;
    fc.assert(
      fc.property(fc.boolean(), intervals, actions(true), (olderRelease, interval, script) => {
        const { runner, held, overhead } = run(olderRelease, interval, script);
        expect(overhead).toBe(0);
        if (runner.printed.length === 0) return;
        const amplification = runner.rowsSent / runner.positions;
        total += amplification;
        worst = Math.max(worst, amplification);
        heldCalls += held;
        runs++;
      }),
      { numRuns: 400 },
    );
    annotate(
      `rows sent per row printed, healthy runs on any schedule: mean ${(total / runs).toFixed(2)}×, worst ${worst.toFixed(2)}×, ${(heldCalls / runs).toFixed(1)} held calls a run`,
    );
  }, 60_000);

  it("bounds how often a healthy ticker-only run sends each row", ({ annotate }) => {
    let worst = 0;
    fc.assert(
      fc.property(
        fc.boolean(),
        intervals,
        actions(true, true),
        (olderRelease, interval, script) => {
          const { runner } = run(olderRelease, interval, script);
          if (runner.printed.length === 0) return;
          const amplification = runner.rowsSent / runner.positions;
          expect(amplification).toBeLessThanOrEqual(tickerBound(interval));
          if (interval === 5_000) worst = Math.max(worst, amplification);
        },
      ),
      { numRuns: 400 },
    );
    annotate(
      `rows sent per row printed, ticker only at a 5 s interval: worst ${worst.toFixed(2)}×`,
    );
  }, 60_000);

  it("resends a quiet log on every rapid step transition until the age threshold", () => {
    // Ten rows, then twenty steps 100 ms apart that print one row each: every call holds
    // (under 50 new rows, the oldest seen under 15 s ago) and resends everything buffered.
    const script: Action[] = [{ kind: "print", count: 10, big: false, huge: false }];
    for (let i = 0; i < 20; i++) {
      script.push({ kind: "print", count: 1, big: false, huge: false });
      script.push({ kind: "step", after: 100, send: healthy });
    }
    const { runner, store, held, overhead } = run(false, 5_000, script);
    expect(held).toBe(20);
    expect(overhead).toBe(0);
    expect(store.ack).toBe(30);
    // 11 + 12 + … + 30 rows across the held calls, then the final call's 30.
    expect(runner.rowsSent).toBe(410 + 30);
    expect(runner.rowsSent / runner.positions).toBeGreaterThan(tickerBound(5_000));
    expect(runner.rowsSent).toBeLessThanOrEqual(runner.positions + (LOG_FLUSH_ROWS - 1) * held);
  });
});
