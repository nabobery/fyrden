/**
 * Bounded pages of Markdown bodies: a page of the API's listing is shown
 * only up to a budget of source bytes, and the rest of it on the next
 * navigation, so what one response carries stays bounded and nothing is
 * skipped. A continuation names the API page (its cursor, none for the
 * first) and the id of the last item already gone through: the listings
 * are in id order, so an item deleted, or added, meanwhile moves nothing
 * else (an offset into the page would skip one).
 */

export interface Continuation {
  readonly cursor: string | null;
  /** The last item gone through (shown, or passed over); null for none. */
  readonly after: number | null;
}

/** A page URL's continuation (the first page when absent or not one). */
export function readContinuation(value: string | null): Continuation {
  const m = value === null ? null : /^([0-9]{0,16}):(.*)$/s.exec(value);
  if (!m) return { cursor: null, after: null };
  const after = m[1] ? Number(m[1]) : null;
  return {
    cursor: m[2] ? (m[2] as string) : null,
    after: after !== null && Number.isSafeInteger(after) ? after : null,
  };
}

export function writeContinuation(c: Continuation): string {
  return `${c.after ?? ""}:${c.cursor ?? ""}`;
}

/** A string's length in UTF-8 bytes, without encoding it. */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * The items of a page (in id order) to show from `at`: those after its last
 * item, while their sizes fit `budget` (always one, so every navigation
 * moves on), and where to continue: after the last one gone through in
 * this page, at the API's next page, or nowhere.
 */
export function within<T extends { id: number }>(
  items: readonly T[],
  at: Continuation,
  size: (item: T) => number,
  budget: number,
  apiNext: string | null,
): { items: T[]; next: Continuation | null } {
  const shown: T[] = [];
  let used = 0;
  let last: number | null = at.after;
  const left = at.after === null ? items : items.filter((item) => item.id > (at.after as number));
  for (const item of left) {
    const cost = size(item);
    // Something costly already shown, and this would pass the budget: continue from here.
    if (used > 0 && used + cost > budget)
      return { items: shown, next: { cursor: at.cursor, after: last } };
    shown.push(item);
    used += cost;
    last = item.id;
  }
  return { items: shown, next: apiNext ? { cursor: apiNext, after: null } : null };
}
