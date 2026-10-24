import { MAX_PAGE_BYTES } from "@fyrden/api-contract";

const encoder = new TextEncoder();

/**
 * The items an answer carries of `items` (read as a page and one more):
 * at most `perPage`, as `output` shows them, and only as many as fit in
 * `maxBytes` of JSON (always the first), so a page of large bodies ends
 * early. `last` is the last item carried; `more`, whether any read are
 * left (the cursor goes on after `last`).
 */
export function pageOf<T, O>(
  items: readonly T[],
  perPage: number,
  output: (item: T) => O,
  maxBytes = MAX_PAGE_BYTES,
): { readonly shown: O[]; readonly last: T | undefined; readonly more: boolean } {
  const shown: O[] = [];
  // The array's brackets, then each item and the comma before all but the first.
  let bytes = 2;
  let last: T | undefined;
  for (const item of items.slice(0, perPage)) {
    const out = output(item);
    bytes += encoder.encode(JSON.stringify(out)).length + (shown.length > 0 ? 1 : 0);
    if (shown.length > 0 && bytes > maxBytes) break;
    shown.push(out);
    last = item;
  }
  return { shown, last, more: items.length > shown.length };
}
