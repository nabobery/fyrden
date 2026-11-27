import type { IncomingRow, LogState, LogStore, RowRange } from "./log-store.js";

export interface PageAnswer {
  readonly status: number;
  readonly body: unknown;
  readonly retryAfter: string | null;
}

export interface Refusal {
  readonly status: number;
  readonly code: string | undefined;
  readonly retryAt?: number;
}

/** Bytes of rows one page asks for. Proposed. */
export const PAGE_BYTES = 262_144;
/** Pages one viewer reads a minute at most: the write rate class is shared with the user's own writes. Proposed. */
export const READS_PER_MINUTE = 20;
/** The largest row index a page may start at (`actions.runs.jobs.logs.read`'s `from`). */
export const MAX_FROM = 2 ** 31 - 1;
const TRANSIENT_RETRIES = 5;
const MINUTE_MS = 60_000;

interface Page {
  readonly rows: readonly IncomingRow[];
  readonly state: LogState;
  readonly end: number;
  readonly next_cursor: string | null;
}

interface Continued {
  readonly i: number;
  readonly at: number;
}

const isPage = (body: unknown): body is Page =>
  typeof body === "object" &&
  body !== null &&
  Array.isArray((body as Page).rows) &&
  typeof (body as Page).end === "number";

/**
 * Reads a job's log pages into `store` as a viewer asks for rows: one page at
 * a time and `READS_PER_MINUTE` at most; a row split across pages is read on
 * by its page's cursor; rows at or past a closed log's `durable` are never
 * asked for; a busy or rate-limited log is waited out `TRANSIENT_RETRIES`
 * times in a row, the refused read asked again by `retry`; any other refusal
 * stops reading until `clearRefusal`.
 */
export class LogReader {
  refusal: Refusal | null = null;
  readonly #store: LogStore;
  readonly #fetch: (query: string) => Promise<PageAnswer>;
  readonly #now: () => number;
  readonly #continuations = new Map<number, { readonly cursor: string; readonly at: number }>();
  readonly #restart = new Set<number>();
  #moreAsked = false;
  #startedForward = false;
  #startedQuery: string | null = null;
  #refusedContinuation: Continued | null = null;
  #followCursor: string | null = null;
  #inflight = false;
  #answered = false;
  #refused: string | null = null;
  #refusedForward = false;
  #asks: number[] = [];
  #waited = 0;
  #until = 0;
  #transient = false;
  readonly #settled = new Set<() => void>();

  constructor(options: {
    store: LogStore;
    fetchPage: (query: string) => Promise<PageAnswer>;
    now?: () => number;
  }) {
    this.#store = options.store;
    this.#fetch = options.fetchPage;
    this.#now = options.now ?? Date.now;
  }

  /** How long until another page may be asked for, by the minute's share. */
  waitMs(): number {
    const now = this.#now();
    this.#asks = this.#asks.filter((at) => now - at < MINUTE_MS);
    if (this.#asks.length < READS_PER_MINUTE) return 0;
    return (this.#asks[0] as number) + MINUTE_MS - now;
  }

  /** When a busy or rate-limited log may be asked again; null when no retry is due. */
  retryAfterMs(): number | null {
    if (!this.refusal || !this.#transient || this.#waited > TRANSIENT_RETRIES) return null;
    return Math.max(0, this.#until - this.#now(), this.waitMs());
  }

  /** Calls `listener` each time a request settles, answered or refused; returns the unsubscribe. */
  onSettle(listener: () => void): () => void {
    this.#settled.add(listener);
    return () => this.#settled.delete(listener);
  }

  get answered(): boolean {
    return this.#answered;
  }

  clearRefusal(): void {
    this.refusal = null;
    this.#transient = false;
    this.#waited = 0;
  }

  /**
   * Asks the refused read again now, or, while the minute's share is spent,
   * keeps the refusal shown and lets `retryAfterMs` say when it is due.
   */
  tryAgain(): Promise<void> | undefined {
    const wait = this.waitMs();
    if (wait > 0 && this.refusal) {
      this.#transient = true;
      this.#waited = 0;
      this.#until = this.#now() + wait;
      return undefined;
    }
    this.clearRefusal();
    return this.retry();
  }

  want(first: number, last: number): Promise<void> | undefined {
    const known = this.#store.closed
      ? this.#store.durable
      : this.#answered
        ? this.#store.length
        : last;
    const end = Math.min(last, known);
    for (let i = first; i < end; i++) {
      const row = this.#store.row(i);
      if (row === undefined)
        return this.#read(new URLSearchParams({ from: String(Math.min(i, MAX_FROM)) }));
      if (row.kind !== "prefix" || row.cut) continue;
      const continuation = this.#continuations.get(i);
      if (continuation?.at === row.next)
        return this.#read(new URLSearchParams({ cursor: continuation.cursor }), false, {
          i,
          at: continuation.at,
        });
      if (this.#restart.has(i) || this.#store.closed) {
        const restart = new URLSearchParams({ from: String(i) });
        const read = this.#read(restart);
        if (read && this.#startedQuery === restart.toString()) {
          this.#restart.add(i);
          this.#continuations.delete(i);
        }
        return read;
      }
    }
    return undefined;
  }

  wantRanges(ranges: readonly RowRange[]): Promise<void> | undefined {
    if (this.moreWaiting) {
      const read = this.more();
      if (read) return read;
    }
    for (const [first, last] of ranges) {
      const read = this.want(first, last);
      if (read) return read;
    }
    return undefined;
  }

  /** Asks the last refused read again, once a refusal allows it. */
  retry(): Promise<void> | undefined {
    if (this.#refused === null) return undefined;
    const continued = this.#refusedContinuation;
    if (continued !== null && !this.#stillContinues(continued)) {
      this.clearRefusal();
      this.#refused = null;
      this.#refusedContinuation = null;
      this.#continuations.delete(continued.i);
      return this.want(continued.i, continued.i + 1);
    }
    if (this.#pastEnd(this.#refused)) {
      this.clearRefusal();
      this.#refused = null;
      this.#refusedContinuation = null;
      return this.wantRanges(this.#store.focused());
    }
    return this.#read(new URLSearchParams(this.#refused), this.#refusedForward, continued);
  }

  tail(rows: number): Promise<void> | undefined {
    return this.#read(new URLSearchParams({ tail: String(rows) }));
  }

  /** The rows stored since the last page that reached the log's end; null once the log is closed. */
  more(): Promise<void> | null {
    if (this.#store.closed) return null;
    const cursor = this.#followCursor;
    const read = this.#read(
      new URLSearchParams(cursor ? { cursor } : { from: String(this.#store.length) }),
      true,
    );
    this.#moreAsked = read === undefined || !this.#startedForward;
    return read ?? null;
  }

  /** A Load new rows press that could not start yet; the next `wantRanges` asks it first. */
  get moreWaiting(): boolean {
    return this.#moreAsked && !this.#store.closed;
  }

  #read(
    query: URLSearchParams,
    forward = false,
    continued: Continued | null = null,
  ): Promise<void> | undefined {
    if (this.#inflight || this.waitMs() > 0) return undefined;
    if (this.refusal) {
      if (!this.#transient || this.#waited > TRANSIENT_RETRIES || this.#now() < this.#until)
        return undefined;
      this.refusal = null;
    }
    query.set("max_bytes", String(PAGE_BYTES));
    let asked = query.toString();
    if (
      this.#refused !== null &&
      (!this.#stillContinues(this.#refusedContinuation) || this.#pastEnd(this.#refused))
    ) {
      this.#refused = null;
      this.#refusedContinuation = null;
    }
    if (this.#refused !== null) {
      forward = this.#refusedForward || (forward && asked === this.#refused);
      continued = this.#refusedContinuation;
      asked = this.#refused;
    }
    this.#inflight = true;
    this.#startedForward = forward;
    this.#startedQuery = asked;
    this.#asks.push(this.#now());
    return this.#fetch(asked)
      .then(
        (answer) => this.#answer(answer, forward, new URLSearchParams(asked)),
        () => {
          this.refusal = { status: 0, code: "network" };
          this.#transient = false;
        },
      )
      .then(() => {
        this.#refused = this.refusal ? asked : null;
        this.#refusedForward = this.refusal ? forward : false;
        this.#refusedContinuation = this.refusal ? continued : null;
      })
      .finally(() => {
        this.#inflight = false;
        for (const listener of this.#settled) listener();
      });
  }

  #stillContinues(continued: Continued | null): boolean {
    if (continued === null) return true;
    const row = this.#store.row(continued.i);
    return row?.kind === "prefix" && !row.cut && row.next === continued.at;
  }

  #pastEnd(query: string): boolean {
    const from = new URLSearchParams(query).get("from");
    return this.#store.closed && from !== null && Number(from) >= this.#store.durable;
  }

  #answer(answer: PageAnswer, forward: boolean, asked: URLSearchParams): void {
    const problem = (answer.body ?? {}) as { code?: unknown; retry_at?: unknown };
    const code = typeof problem.code === "string" ? problem.code : undefined;
    if (answer.status === 200 && isPage(answer.body)) {
      const page = answer.body;
      this.#answered = true;
      this.#waited = 0;
      const from = asked.has("from") ? Number(asked.get("from")) : null;
      if (from !== null && this.#restart.delete(from) && page.rows[0]?.i === from)
        this.#store.forget(from);
      const rows = asked.has("cursor")
        ? page.rows.filter((r) => !("o" in r) || r.o === 0 || this.#store.row(r.i) !== undefined)
        : page.rows;
      this.#store.applyPage({
        rows,
        state: page.state,
        end: page.end,
        next: page.next_cursor,
      });
      const last = page.rows.at(-1);
      if (last && "o" in last && !last.end && page.next_cursor && rows.at(-1) === last)
        this.#continuations.set(last.i, { cursor: page.next_cursor, at: last.o + last.c.length });
      if (forward || !last || last.i + 1 >= page.end) this.#followCursor = page.next_cursor;
      return;
    }
    if (answer.status === 422 && code === "invalid_cursor") {
      for (const i of this.#continuations.keys()) this.#restart.add(i);
      this.#continuations.clear();
      this.#followCursor = null;
      return;
    }
    const seconds = Number(answer.retryAfter);
    const wait = Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : 1_000;
    this.refusal = {
      status: answer.status,
      code,
      ...(typeof problem.retry_at === "number" && { retryAt: problem.retry_at }),
    };
    this.#transient = (answer.status === 503 && code === "log_busy") || code === "rate_limited";
    if (this.#transient) this.#waited += 1;
    this.#until = this.#now() + (code === "rate_limited" ? Math.max(wait, MINUTE_MS) : wait);
  }
}

/**
 * Reads the rows `ranges` names, page after page, starting `settleMs` after
 * the call; when the reader cannot read now, it goes on once the minute's
 * share allows or once any request settles. Returns the stop.
 */
export function readRanges(
  reader: LogReader,
  ranges: () => readonly RowRange[],
  onPage: () => void,
  settleMs: number,
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settling = true;
  const schedule = (ms: number) => {
    clearTimeout(timer);
    timer = setTimeout(pump, ms);
  };
  const pump = () => {
    settling = false;
    const read = reader.wantRanges(ranges());
    if (read) void read.then(onPage);
    else {
      const wait = reader.waitMs();
      if (wait > 0) schedule(wait);
    }
  };
  const off = reader.onSettle(() => {
    if (!settling) schedule(0);
  });
  schedule(settleMs);
  return () => {
    off();
    clearTimeout(timer);
  };
}
