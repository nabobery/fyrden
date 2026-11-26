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
  readonly #continuations = new Map<number, string>();
  #followCursor: string | null = null;
  #inflight = false;
  #answered = false;
  #refused: string | null = null;
  #asks: number[] = [];
  #waited = 0;
  #until = 0;
  #transient = false;

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

  get answered(): boolean {
    return this.#answered;
  }

  clearRefusal(): void {
    this.refusal = null;
    this.#transient = false;
    this.#waited = 0;
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
      const cursor = this.#continuations.get(i);
      if (row.kind === "prefix" && !row.cut && cursor)
        return this.#read(new URLSearchParams({ cursor }));
    }
    return undefined;
  }

  wantRanges(ranges: readonly RowRange[]): Promise<void> | undefined {
    for (const [first, last] of ranges) {
      const read = this.want(first, last);
      if (read) return read;
    }
    return undefined;
  }

  /** Asks the last refused read again, once a refusal allows it. */
  retry(): Promise<void> | undefined {
    return this.#refused === null ? undefined : this.#read(new URLSearchParams(this.#refused));
  }

  tail(rows: number): Promise<void> | undefined {
    return this.#read(new URLSearchParams({ tail: String(rows) }));
  }

  /** The rows stored since the last page that reached the log's end; null once the log is closed. */
  more(): Promise<void> | null {
    if (this.#store.closed) return null;
    const cursor = this.#followCursor;
    return (
      this.#read(new URLSearchParams(cursor ? { cursor } : { from: String(this.#store.length) })) ??
      null
    );
  }

  #read(query: URLSearchParams): Promise<void> | undefined {
    if (this.#inflight || this.waitMs() > 0) return undefined;
    if (this.refusal) {
      if (!this.#transient || this.#waited > TRANSIENT_RETRIES || this.#now() < this.#until)
        return undefined;
      this.refusal = null;
    }
    query.set("max_bytes", String(PAGE_BYTES));
    const asked = query.toString();
    this.#inflight = true;
    this.#asks.push(this.#now());
    return this.#fetch(asked)
      .then(
        (answer) => this.#answer(answer),
        () => {
          this.refusal = { status: 0, code: "network" };
          this.#transient = false;
        },
      )
      .then(() => {
        this.#refused = this.refusal ? asked : null;
      })
      .finally(() => {
        this.#inflight = false;
      });
  }

  #answer(answer: PageAnswer): void {
    const problem = (answer.body ?? {}) as { code?: unknown; retry_at?: unknown };
    const code = typeof problem.code === "string" ? problem.code : undefined;
    if (answer.status === 200 && isPage(answer.body)) {
      const page = answer.body;
      this.#answered = true;
      this.#waited = 0;
      this.#store.applyPage({
        rows: page.rows,
        state: page.state,
        end: page.end,
        next: page.next_cursor,
      });
      const last = page.rows.at(-1);
      if (last && "o" in last && !last.end && page.next_cursor)
        this.#continuations.set(last.i, page.next_cursor);
      if (!last || last.i + 1 >= page.end) this.#followCursor = page.next_cursor;
      return;
    }
    if (answer.status === 422 && code === "invalid_cursor") {
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
