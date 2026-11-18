// What a finished job log stores, given how the runner ended it. The API
// stores a line for every position below the final ack (a row, or an
// omission record for a row too large for any request), except the older
// runner's final sentinel: one empty row in a whole final call, acked and
// never stored. Which form a runner ends with depends on timing (v5.4.1's
// `Reporter.Close` adds the sentinel only when its unsent rows have already
// drained, read in `internal/pkg/report/reporter.go` at v5.4.1), so the
// real-runner suite derives what it expects from the final call it recorded.
import { isFinalSentinel, type LogFlushRequest } from "@fyrden/domain/ci";

export interface StoredLogShape {
  /** The positions holding a stored line, in order. */
  readonly positions: readonly number[];
  /** How many of those lines are rows: the rest are the omissions. */
  readonly rows: number;
}

/**
 * The stored positions and row count of a log whose final call was `final`,
 * answered with `ack`, with `omitted` positions recorded as omitted.
 */
export function storedLogShape(
  final: LogFlushRequest,
  ack: number,
  omitted: number,
): StoredLogShape {
  if (!final.noMore || !final.whole) throw new Error("not a whole final call");
  if (ack !== final.index + final.rows.length)
    throw new Error(`the ack ${ack} does not cover the final call from ${final.index}`);
  const sentinel = isFinalSentinel(final) ? final.index : undefined;
  const positions = Array.from({ length: ack }, (_, k) => k).filter((k) => k !== sentinel);
  if (omitted > positions.length)
    throw new Error(`${omitted} omissions in ${positions.length} lines`);
  return { positions, rows: positions.length - omitted };
}
