// The runner protocol's pure rules: which runner may take a job, when a log
// request's rows are stored and acked, and a guard for error messages.

/**
 * Whether a runner may take a job: every label the job asks for (its
 * `runs-on`) is among the runner's, compared case-insensitively as GitHub
 * does. The comparison folds ASCII letters only, so it agrees exactly with
 * SQLite's `lower()`, which the dispatch query applies to the same labels.
 * An empty job label list never matches: a job must select an environment,
 * and matching it to every runner would run it anywhere.
 */
export function labelsMatch(
  jobLabels: readonly string[],
  runnerLabels: readonly string[],
): boolean {
  if (jobLabels.length === 0) return false;
  const offered = new Set(runnerLabels.map(foldLabel));
  return jobLabels.every((label) => offered.has(foldLabel(label)));
}

function foldLabel(label: string): string {
  return label.replace(/[A-Z]+/g, (letters) => letters.toLowerCase());
}

/** New rows that make a log request store at once. */
export const LOG_FLUSH_ROWS = 50;
/** UTF-8 bytes of new row content that make a log request store at once. */
export const LOG_FLUSH_BYTES = 512 * 1024;
/** How long the oldest unacked row may wait, from when it was first seen, before it is stored. */
export const LOG_FLUSH_AGE_MS = 15_000;

/** What the log path keeps for a task. */
export interface LogFlushState {
  /** Rows stored contiguously from position 0, durable before it is ever sent as an ack. */
  readonly ackIndex: number;
  /** In memory: when the oldest row still unacked was first seen. Lost on a reset, which only restarts that clock. */
  readonly firstUnackedSeenAt?: number | undefined;
}

/** One log request, already decoded. */
export interface LogFlushRequest {
  /** Position of the first row: the runner's acked offset. */
  readonly index: number;
  readonly rows: readonly { readonly content: string }[];
  readonly noMore: boolean;
  /** False when the body was cut or the decoder stopped early: rows past `rows` were sent but not read. */
  readonly whole: boolean;
  /**
   * Set only by the decoder's positive evidence that the row at `index`
   * cannot be carried by any request the server reads: the body was cut
   * inside that row's own bytes, with only task ids and indexes before it,
   * and even the shortest framing of a request carrying that row from
   * `index` is longer than the body read. `bytes` is the row's encoded size
   * as the runner framed it (declared, not read).
   */
  readonly oversizedFirstRow?: { readonly bytes: number } | undefined;
}

export type LogFlushDecision =
  /** The request starts past the stored rows, which cannot happen unless stored state was lost. */
  | { readonly kind: "ahead" }
  /** Answer the stored ack unchanged and remember `firstUnackedSeenAt` (undefined: no row is waiting). */
  | {
      readonly kind: "hold";
      readonly ackIndex: number;
      readonly firstUnackedSeenAt: number | undefined;
    }
  /**
   * Store `lines` as positions `[start, end)` and then ack `end`. `lines` is
   * shorter than `end - start` only by a final sentinel, which is acked but is
   * not a line. `final`: the log is complete once this commits, unless a row
   * of it was omitted.
   */
  | {
      readonly kind: "flush";
      readonly start: number;
      readonly end: number;
      readonly lines: readonly string[];
      readonly final: boolean;
    }
  /**
   * Store an omission record for position `index` (the stored ack) and then
   * ack `index + 1`: the row there can never be read, so it is recorded as
   * omitted, and the log can never be complete.
   */
  | { readonly kind: "omit"; readonly index: number; readonly bytes: number };

/** Why a stored position holds no row: the row was too large for any request the server reads. */
export const LOG_ROW_TOO_LARGE = "row_too_large";

/** A stored row: its position, its time in Unix milliseconds (null: none sent) and its content. */
export interface StoredLogRow {
  readonly i: number;
  readonly t: number | null;
  readonly c: string;
}

/**
 * A stored position whose row was omitted: no content and no time, only the
 * reason and the row's encoded size as the runner declared it. A log holding
 * one is never complete.
 */
export interface StoredLogOmission {
  readonly i: number;
  readonly omitted: typeof LOG_ROW_TOO_LARGE;
  readonly bytes: number;
}

/**
 * One line of a stored log chunk (NDJSON). Every position below the ack is
 * exactly one of these, except the older runner's final sentinel
 * (`isFinalSentinel`): its position is acked and never stored.
 */
export type StoredLogLine = StoredLogRow | StoredLogOmission;

export function isLogOmission(line: StoredLogLine): line is StoredLogOmission {
  return "omitted" in line;
}

/**
 * The older supported runner release ends a log with nothing left to send by
 * sending one row with empty content at the next position: a final, whole
 * request whose only row is empty. An empty row among others is a real line.
 */
export function isFinalSentinel(request: LogFlushRequest): boolean {
  return (
    request.noMore && request.whole && request.rows.length === 1 && request.rows[0]?.content === ""
  );
}

/**
 * Decides whether a log request's new rows are stored now or left for the
 * runner to resend. The runner keeps every row past its acked offset and
 * resends all of them on each call, so holding costs nothing durable: rows
 * below `ackIndex` are a resend and dropped, and a held request is answered
 * with the stored ack.
 *
 * - A whole `noMore` request is final: everything it carried is stored and
 *   acked, with any number of new rows, zero included (the caller then has
 *   nothing to write and only marks the log complete).
 * - A `noMore` request that is not whole stores the new rows it carried, so
 *   the runner, in its terminal flush, resends only the rest; it is never
 *   final, since rows it did not carry may follow. Any other request that is
 *   not whole stores its new rows at once too: waiting cannot make a cut
 *   body whole, and each resend of it costs a full prefix read.
 * - Any other request stores its new rows once there are at least
 *   `LOG_FLUSH_ROWS` of them, or `LOG_FLUSH_BYTES` of content, or the oldest
 *   unacked row was first seen `LOG_FLUSH_AGE_MS` ago. Storing every batch of
 *   50 at once keeps the server from making rows pile up to the runner's
 *   100-row batch size, past which the runner calls once per new row.
 * - A cut request at the ack with no decoded row and the decoder's evidence
 *   that its first row cannot fit (`oversizedFirstRow`) omits that row:
 *   waiting cannot help, since every resend is cut at the same row. Zero
 *   rows from a cut body without that evidence are held like any other.
 */
export function decideLogFlush(
  state: LogFlushState,
  request: LogFlushRequest,
  now: number,
): LogFlushDecision {
  const { ackIndex } = state;
  if (request.index > ackIndex) return { kind: "ahead" };
  if (
    request.oversizedFirstRow !== undefined &&
    !request.whole &&
    request.rows.length === 0 &&
    request.index === ackIndex
  ) {
    return { kind: "omit", index: ackIndex, bytes: request.oversizedFirstRow.bytes };
  }
  const fresh = request.rows.slice(ackIndex - request.index);
  const end = ackIndex + fresh.length;
  if (request.noMore && request.whole) {
    const lines = isFinalSentinel(request) ? [] : fresh.map((row) => row.content);
    return { kind: "flush", start: ackIndex, end, lines, final: true };
  }
  if (fresh.length === 0) return { kind: "hold", ackIndex, firstUnackedSeenAt: undefined };
  const seen = state.firstUnackedSeenAt;
  if (
    request.noMore ||
    !request.whole ||
    fresh.length >= LOG_FLUSH_ROWS ||
    (seen !== undefined && now - seen >= LOG_FLUSH_AGE_MS) ||
    reachesBytes(fresh, LOG_FLUSH_BYTES)
  ) {
    return {
      kind: "flush",
      start: ackIndex,
      end,
      lines: fresh.map((row) => row.content),
      final: false,
    };
  }
  return { kind: "hold", ackIndex, firstUnackedSeenAt: seen ?? now };
}

/** Whether the rows' content is at least `limit` UTF-8 bytes, stopping once it is. */
function reachesBytes(rows: readonly { readonly content: string }[], limit: number): boolean {
  let bytes = 0;
  for (const { content } of rows) {
    for (let i = 0; i < content.length; i++) {
      const unit = content.charCodeAt(i);
      if (unit < 0x80) bytes += 1;
      else if (unit < 0x800) bytes += 2;
      else if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < content.length) {
        const next = content.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          bytes += 4;
          i++;
        } else bytes += 3;
      } else bytes += 3;
    }
    if (bytes >= limit) return true;
  }
  return false;
}

/**
 * Whether an error message would make the runner stop for good: it treats
 * any error whose message ends in "unregistered runner" as its registration
 * being rejected. Broader than the runner's own test (any case, trailing
 * whitespace and punctuation ignored) so a message that merely looks like it
 * is caught too.
 */
export function endsLikeUnregisteredRunner(message: string): boolean {
  let end = 0;
  let position = 0;
  for (const character of message) {
    position += character.length;
    if (!/[\s\p{P}]/u.test(character)) end = position;
  }
  return message.slice(0, end).toLowerCase().endsWith("unregistered runner");
}
