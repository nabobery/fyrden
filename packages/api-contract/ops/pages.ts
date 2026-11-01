import { z } from "zod";

/** Encoded bytes of a list's items one answer carries at most (Fyrden's). */
export const MAX_PAGE_BYTES = 1024 * 1024;

/**
 * The page size of the lists whose items can be large (bodies,
 * descriptions): a page also ends once its items pass `MAX_PAGE_BYTES` of
 * JSON, always carrying one.
 */
export const BoundedPerPage = z.coerce
  .number()
  .int()
  .min(1)
  .max(100)
  .default(30)
  .describe(
    "Page size, 1-100. Fyrden: a page also ends once its items pass 1 MiB of JSON (always one item at least), with `next_cursor` to go on.",
  );

/** Fyrden's `after`: a stream ordered by id resumed after a given item, in place of a cursor. */
export const AfterId = z.coerce
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER)
  .optional()
  .describe("Fyrden: only items whose id is greater than this (not with `cursor`).");
