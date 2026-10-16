/**
 * Bounded pages of Markdown bodies: a page of the API's listing is shown
 * only up to a budget of source bytes, and the rest of it on the next
 * navigation, so what one response carries stays bounded and nothing is
 * skipped. A continuation names the API page (its cursor, none for the
 * first) and how many of its items were already shown.
 */

export interface Continuation {
  readonly cursor: string | null;
  readonly skip: number;
}

/** A page URL's continuation (the first page when absent or not one). */
export function readContinuation(value: string | null): Continuation {
  const m = value === null ? null : /^([0-9]{1,3}):(.*)$/s.exec(value);
  if (!m) return { cursor: null, skip: 0 };
  return { cursor: m[2] ? (m[2] as string) : null, skip: Number(m[1]) };
}

export function writeContinuation(c: Continuation): string {
  return `${c.skip}:${c.cursor ?? ""}`;
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
 * The items of a page to show from `at`: in order, while their sizes fit
 * `budget` (always one, so every navigation shows something), and where to
 * continue: in this page, at the API's next page, or nowhere.
 */
export function within<T>(
  items: readonly T[],
  at: Continuation,
  size: (item: T) => number,
  budget: number,
  apiNext: string | null,
): { items: T[]; next: Continuation | null } {
  const shown: T[] = [];
  let used = 0;
  let index = Math.min(at.skip, items.length);
  for (; index < items.length; index++) {
    const item = items[index] as T;
    const cost = size(item);
    if (shown.length > 0 && used + cost > budget) break;
    shown.push(item);
    used += cost;
  }
  if (index < items.length) return { items: shown, next: { cursor: at.cursor, skip: index } };
  return { items: shown, next: apiNext ? { cursor: apiNext, skip: 0 } : null };
}
