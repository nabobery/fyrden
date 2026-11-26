import type { Logger, Metrics } from "@fyrden/adapters-cloudflare/obs";
import type { StoredLogOmission, StoredLogRow } from "@fyrden/domain/ci";
import type { RunEngine } from "./engine.js";
import { type DecodedLogText, type ReadLogLine, readLogLines } from "./log-reader.js";
import type { JobLog, LogChunk, StoredLogs } from "./stored-logs.js";

/* Pages are read from the stored chunks only, masked when they were written: no mask is opened here. */

export const LOG_PAGE_POLICY = {
  /** Proposed. */
  chunks: 32,
  bytes: 2 * 1024 * 1024,
  minRowBytes: 1024,
  defaultRowBytes: 64 * 1024,
  maxRowBytes: 512 * 1024,
  maxTail: 10_000,
} as const;

const PIECE_OVERHEAD = 128;
const CUT_UNITS = 8192;

/** `offset` in UTF-16 units. Task 0: the start of a job's log, made before it had a task. */
export interface LogPosition {
  readonly task: number;
  readonly row: number;
  readonly offset: number;
}

/** At most one of `from`, `tail` and `cursor`. */
export interface LogPageQuery {
  readonly from?: number;
  readonly tail?: number;
  readonly cursor?: LogPosition;
  readonly maxBytes: number;
}

/** A piece of a row too long for one page: from UTF-16 offset `o`; `end` when it reaches the row's end. */
export interface LogPiece extends StoredLogRow {
  readonly o: number;
  readonly end: boolean;
}

export type LogPageRow = StoredLogRow | LogPiece | StoredLogOmission;

export type LogPageAnswer =
  | {
      readonly ok: true;
      readonly rows: LogPageRow[];
      readonly state: "none" | "streaming" | "complete" | "incomplete";
      readonly end: number;
      /** Null once the log is closed and was read to its end. */
      readonly next: LogPosition | null;
    }
  | {
      readonly ok: false;
      readonly code:
        | "run_not_found"
        | "job_not_found"
        | "invalid_cursor"
        | "log_unavailable"
        | "log_busy"
        | "log_unreadable"
        | "log_reads_unavailable";
    }
  | {
      readonly ok: false;
      readonly code: "log_reads_spent";
      readonly retryAt: number;
      readonly retryAfter: number;
    };

export type LogReadCharge =
  | { readonly status: "granted" }
  | { readonly status: "spent"; readonly retryAt: number; readonly retryAfter: number }
  | { readonly status: "unavailable" };

export interface LogPagesHost {
  readonly env: Env;
  readonly engine: RunEngine;
  readonly metrics: Metrics;
  readonly log: Logger;
  readonly stored: StoredLogs;
  /** Whether the run is answered as no run. */
  hidden(): boolean;
  uploadWaiting(): boolean;
  charge(chunks: number): Promise<LogReadCharge>;
}

/** Pause points, for tests. */
export interface LogPageHooks {
  beforeChunkGet?: (key: string) => Promise<void> | void;
  afterChunkGet?: (key: string) => Promise<void> | void;
}

export const logPageHooks: LogPageHooks = {};

interface Page {
  add(line: ReadLogLine): "more" | "full" | "invalid_cursor";
}

export class LogPages {
  constructor(private readonly host: LogPagesHost) {}

  async read(repoId: string, jobId: number, query: LogPageQuery): Promise<LogPageAnswer> {
    const { host } = this;
    if (host.hidden() || host.engine.run()?.repo_id !== repoId)
      return { ok: false, code: "run_not_found" };
    if (!host.engine.instance(jobId)) return { ok: false, code: "job_not_found" };
    const log = host.stored.jobLog(jobId);
    if (log.unmasked) return { ok: false, code: "log_unavailable" };
    const start = startOf(query, log);
    if (start === null) return { ok: false, code: "invalid_cursor" };
    const { task, linesEnd } = log;
    if (task === null)
      return {
        ok: true,
        rows: [],
        state: "none",
        end: 0,
        next: log.ended ? null : { task: 0, row: 0, offset: 0 },
      };
    const answer = (rows: LogPageRow[], row: number, offset: number): LogPageAnswer => ({
      ok: true,
      rows,
      state: log.state ?? "streaming",
      end: linesEnd,
      next: log.ended && row === linesEnd ? null : { task, row, offset },
    });
    if (start.row >= linesEnd) return answer([], linesEnd, 0);

    const fromEnd = query.tail !== undefined;
    const chunks = fromEnd
      ? this.#chunksBack(task, start.row, linesEnd, query.maxBytes)
      : this.#chunksOn(task, start.row, query.maxBytes);
    if (chunks.length === 0) return this.#unreadable(task, start.row);
    if (host.uploadWaiting()) return { ok: false, code: "log_busy" };
    // The memory first, so that a page refused as busy pays nothing.
    const reservation = host.stored.reserve(
      Math.max(...chunks.map((c) => c.bytes)),
      2 * query.maxBytes,
    );
    if (!reservation) return { ok: false, code: "log_busy" };
    const read = host.stored.beginRead();
    try {
      const charged = await host.charge(chunks.length);
      if (host.hidden()) return { ok: false, code: "run_not_found" };
      if (charged.status === "spent")
        return {
          ok: false,
          code: "log_reads_spent",
          retryAt: charged.retryAt,
          retryAfter: charged.retryAfter,
        };
      if (charged.status === "unavailable") return { ok: false, code: "log_reads_unavailable" };
      if (read.signal.aborted || host.engine.instance(jobId)?.task !== task)
        return { ok: false, code: "log_busy" };
      if (fromEnd) {
        const page = new TailPage(start.row, query.maxBytes);
        const ended = await this.#readChunks(chunks, page, read.signal);
        if (host.hidden()) return { ok: false, code: "run_not_found" };
        if (ended === "aborted") return { ok: false, code: "log_busy" };
        if (ended === "unreadable") return this.#unreadable(task, start.row);
        return answer(page.rows(), linesEnd, 0);
      }
      const page = new ForwardPage(start.row, start.offset, query.maxBytes);
      const ended = await this.#readChunks(chunks, page, read.signal);
      if (host.hidden()) return { ok: false, code: "run_not_found" };
      if (ended === "invalid_cursor") return { ok: false, code: "invalid_cursor" };
      // What was read before it ended is whole: the next page starts after it, and finds the fault.
      const resumes = ended !== "unreadable" || page.row < linesEnd;
      if (page.rows.length > 0 && resumes) return answer(page.rows, page.row, page.offset);
      return ended === "unreadable"
        ? this.#unreadable(task, start.row)
        : { ok: false, code: "log_busy" };
    } finally {
      reservation.release();
      read.finish();
    }
  }

  #unreadable(task: number, row: number): LogPageAnswer {
    this.host.log.error("a stored log could not be read", {
      runId: this.host.engine.run()?.run_id ?? "",
      task,
      row,
    });
    return { ok: false, code: "log_unreadable" };
  }

  #chunksOn(task: number, row: number, maxBytes: number): LogChunk[] {
    const first = this.host.stored.chunkAt(task, row);
    if (!first) return [];
    const chunks = [first];
    let filled = Math.floor((first.bytes * (first.end - row)) / (first.end - first.start));
    let read = first.bytes;
    for (const chunk of this.host.stored.chunksFrom(task, first.end, LOG_PAGE_POLICY.chunks - 1)) {
      const reached = chunks.at(-1)?.end;
      if (filled >= maxBytes || read >= LOG_PAGE_POLICY.bytes || chunk.start !== reached) break;
      chunks.push(chunk);
      filled += chunk.bytes;
      read += chunk.bytes;
    }
    return chunks;
  }

  #chunksBack(task: number, row: number, end: number, maxBytes: number): LogChunk[] {
    const chunks: LogChunk[] = [];
    let read = 0;
    let reached = end;
    for (const chunk of this.host.stored.chunksBefore(task, end, LOG_PAGE_POLICY.chunks)) {
      if (chunks.length > 0 && (reached <= row || read >= maxBytes)) break;
      if (chunk.end !== reached) return [];
      chunks.unshift(chunk);
      read += chunk.bytes;
      reached = chunk.start;
    }
    const short = chunks.length < LOG_PAGE_POLICY.chunks && read < maxBytes;
    return short && reached > row ? [] : chunks;
  }

  async #readChunks(
    chunks: readonly LogChunk[],
    page: Page,
    signal: AbortSignal,
  ): Promise<"read" | "aborted" | "unreadable" | "invalid_cursor"> {
    for (const chunk of chunks) {
      const body = await this.#chunkBody(chunk.key, signal);
      if (body === "aborted") return "aborted";
      if (body === null) return "unreadable";
      let expected = chunk.start;
      let bytes = 0;
      try {
        const counted = (n: number) => {
          bytes += n;
          if (bytes > chunk.bytes)
            throw new Error("a stored chunk is longer than its manifest says");
        };
        for await (const line of readLogLines(body, signal, counted)) {
          if (line.i !== expected || line.i >= chunk.end)
            throw new Error("stored log positions do not match the manifest");
          expected++;
          const added = page.add(line);
          if (added === "full") return "read";
          if (added === "invalid_cursor") return added;
        }
        if (expected !== chunk.end) throw new Error("stored log ended before its manifest range");
      } catch {
        return signal.aborted ? "aborted" : "unreadable";
      }
    }
    return "read";
  }

  async #chunkBody(
    key: string,
    signal: AbortSignal,
  ): Promise<ReadableStream<Uint8Array> | null | "aborted"> {
    await logPageHooks.beforeChunkGet?.(key);
    if (signal.aborted) return "aborted";
    this.host.metrics.count("r2.class_b", { bucket: "fyrden-ci", op: "get_log_chunk" });
    const get = this.host.env.CI.get(key).then(async (object) => {
      await logPageHooks.afterChunkGet?.(key);
      return object;
    });
    const aborted = new Promise<"aborted">((resolve) => {
      signal.addEventListener("abort", () => resolve("aborted"), { once: true });
    });
    try {
      const object = await Promise.race([get, aborted]);
      if (object === "aborted") {
        void get.then((late) => late?.body.cancel()).catch(() => undefined);
        return "aborted";
      }
      if (object === null) return null;
      if (!signal.aborted) return object.body;
      await object.body.cancel().catch(() => undefined);
      return "aborted";
    } catch {
      return null;
    }
  }
}

function startOf(
  { from, tail, cursor }: LogPageQuery,
  { task, linesEnd }: JobLog,
): { readonly row: number; readonly offset: number } | null {
  if (cursor) {
    const { row, offset } = cursor;
    if (cursor.task === 0) return row === 0 && offset === 0 ? { row, offset } : null;
    if (cursor.task !== task || row > linesEnd || (row === linesEnd && offset > 0)) return null;
    return { row, offset };
  }
  if (tail !== undefined) return { row: Math.max(0, linesEnd - tail), offset: 0 };
  return { row: Math.min(from ?? 0, linesEnd), offset: 0 };
}

const omitted = (line: ReadLogLine): line is StoredLogOmission => "omitted" in line;

const sizeOf = (line: ReadLogLine) =>
  1 + (omitted(line) ? JSON.stringify(line).length : line.encodedBytes);

function wholeRow(line: ReadLogLine): StoredLogRow | StoredLogOmission {
  return omitted(line) ? line : { i: line.i, t: line.t, c: textOf(line.c, 0, line.c.length) };
}

function textOf(text: DecodedLogText, start: number, end: number): string {
  const parts: string[] = [];
  for (let at = start; at < end; at += CUT_UNITS)
    parts.push(text.slice(at, Math.min(end, at + CUT_UNITS)));
  return parts.join("");
}

class ForwardPage implements Page {
  readonly rows: LogPageRow[] = [];
  #used = 0;

  constructor(
    public row: number,
    public offset: number,
    private readonly maxBytes: number,
  ) {}

  add(line: ReadLogLine): "more" | "full" | "invalid_cursor" {
    if (line.i < this.row) return "more";
    const left = this.maxBytes - this.#used;
    if (this.offset > 0 && (omitted(line) || this.offset >= line.c.length)) return "invalid_cursor";
    if (this.offset === 0 && sizeOf(line) <= left) {
      this.rows.push(wholeRow(line));
      this.#used += sizeOf(line);
      this.row++;
      return "more";
    }
    if (this.rows.length > 0 || omitted(line)) return "full";
    const { i, t, c } = line;
    const cut = cutAfter(c, this.offset, left - PIECE_OVERHEAD);
    const end = cut.at === c.length;
    this.rows.push({ i, t, c: textOf(c, this.offset, cut.at), o: this.offset, end });
    this.#used += cut.bytes + PIECE_OVERHEAD;
    this.row = end ? i + 1 : i;
    this.offset = end ? 0 : cut.at;
    return end ? "more" : "full";
  }
}

// A cut row fills its page, so any row after it drops it.
class TailPage implements Page {
  #rows: { readonly row: LogPageRow; readonly size: number }[] = [];
  #used = 0;

  constructor(
    private readonly from: number,
    private readonly maxBytes: number,
  ) {}

  add(line: ReadLogLine): "more" {
    if (line.i < this.from) return "more";
    const size = sizeOf(line);
    if (size <= this.maxBytes || omitted(line)) {
      this.#push(wholeRow(line), size);
      let drop = 0;
      while (this.#used > this.maxBytes) this.#used -= this.#rows[drop++]?.size ?? 0;
      if (drop > 0) this.#rows.splice(0, drop);
      return "more";
    }
    const { i, t, c } = line;
    const cut = cutBefore(c, this.maxBytes - PIECE_OVERHEAD);
    this.#rows = [];
    this.#used = 0;
    this.#push(
      { i, t, c: textOf(c, cut.at, c.length), o: cut.at, end: true },
      cut.bytes + PIECE_OVERHEAD,
    );
    return "more";
  }

  rows(): LogPageRow[] {
    return this.#rows.map(({ row }) => row);
  }

  #push(row: LogPageRow, size: number): void {
    this.#rows.push({ row, size });
    this.#used += size;
  }
}

const high = (unit: number) => unit >= 0xd800 && unit <= 0xdbff;
const low = (unit: number) => unit >= 0xdc00 && unit <= 0xdfff;

function encodedSize(unit: number, paired: boolean): number {
  if (paired) return 4;
  if (unit === 0x22 || unit === 0x5c) return 2;
  if (unit < 0x20)
    return unit === 8 || unit === 9 || unit === 10 || unit === 12 || unit === 13 ? 2 : 6;
  if (unit < 0x80) return 1;
  if (unit < 0x800) return 2;
  // A lone surrogate is escaped.
  return high(unit) || low(unit) ? 6 : 3;
}

/** The farthest offset after `start` whose text from it encodes in `budget` bytes, never inside a pair. */
export function cutAfter(
  text: DecodedLogText,
  start: number,
  budget: number,
): { readonly at: number; readonly bytes: number } {
  let at = start;
  let bytes = 0;
  while (at < text.length) {
    const part = text.slice(at, Math.min(text.length, at + CUT_UNITS));
    for (let k = 0; k < part.length; ) {
      const unit = part.charCodeAt(k);
      if (high(unit) && k + 1 === part.length && at + part.length < text.length && k > 0) {
        // Its low half may be in the next slice.
        at += k;
        break;
      }
      const paired = high(unit) && k + 1 < part.length && low(part.charCodeAt(k + 1));
      const size = encodedSize(unit, paired);
      if (bytes + size > budget) return { at: at + k, bytes };
      bytes += size;
      k += paired ? 2 : 1;
      if (k >= part.length) {
        at += part.length;
        break;
      }
    }
  }
  return { at, bytes };
}

/** The earliest offset whose text to the end encodes in `budget` bytes, never inside a pair. */
export function cutBefore(
  text: DecodedLogText,
  budget: number,
): { readonly at: number; readonly bytes: number } {
  let at = text.length;
  let bytes = 0;
  let part = "";
  let base = at;
  const unitAt = (i: number): number => {
    if (i < base) {
      base = Math.max(0, i + 1 - CUT_UNITS);
      part = text.slice(base, i + 1);
    }
    return part.charCodeAt(i - base);
  };
  while (at > 0) {
    const unit = unitAt(at - 1);
    const paired = low(unit) && at > 1 && high(text.slice(at - 2, at - 1).charCodeAt(0));
    const size = encodedSize(unit, paired);
    if (bytes + size > budget) break;
    bytes += size;
    at -= paired ? 2 : 1;
  }
  return { at, bytes };
}
