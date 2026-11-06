import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { UNSAFE_DataRouterStateContext, useLocation } from "react-router";
import { type LineRange, lineLink, readLineLocation } from "./file-view.js";

/**
 * Where to bring the view: a line, or the place the router restored on a history traversal
 * (put back once the renderer takes over, whose layout may be longer than the plain view's).
 * A new object each time, so going to one line twice goes twice.
 */
export type LinePosition = { readonly line: number } | { readonly top: number };

/** Names a history entry once its URL has moved the view: coming back to it is no new request. */
const ENTRY_READ = "fyrdenLinesRead";

function readEntry(): string | null {
  const id = (window.history.state as Record<string, unknown> | null)?.[ENTRY_READ];
  return typeof id === "string" ? id : null;
}

/** Router's state stays, and nothing renders: no route's data depends on this. */
function writeEntry(id: string | null, link?: string): void {
  window.history.replaceState(
    { ...window.history.state, [ENTRY_READ]: id },
    "",
    link === undefined ? window.location.href : `${window.location.pathname}${link}`,
  );
}

/** The next load of this entry goes to its line, as if it had never been seen. */
export function forgetLineEntry(): void {
  writeEntry(null);
}

/**
 * The URL's lines, read once the page is hydrated and on each `hashchange`: the server has
 * marked what the query says, and only this can see a fragment. What it selects is kept
 * apart from where it opens (`?from=2001&line=1999-2002` opens at 2001). A selection made on
 * the page writes the canonical link in place. A history entry moves the view the first time it
 * is seen; coming back to it selects its lines and leaves the place the router restored.
 */
/**
 * An id for a history entry: it only tells entries apart, so any unique-enough value will do.
 * `crypto.randomUUID` exists only in secure contexts, and a self-hosted page may be plain HTTP.
 */
function newEntryId(): string {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

export function useLineLinks({
  total,
  plain,
  selected,
}: {
  total: number;
  plain: boolean;
  selected: LineRange | null;
}): {
  selection: LineRange | null;
  position: LinePosition | null;
  select: (range: LineRange | null) => void;
  /** How many times the router has moved the view: on the page, what a test waits for. */
  routerCommits: number;
} {
  const [selection, setSelection] = useState(selected);
  const [position, setPosition] = useState<LinePosition | null>(null);
  const [routerCommits, setRouterCommits] = useState(0);
  // The entry this page last read, whether it had been read before, and the line it asked for
  // since the router last moved the view.
  const entry = useRef<string | null>(null);
  const returned = useRef(false);
  const asked = useRef<LinePosition | null>(null);
  /**
   * Selects what the URL names. One navigation reaches this up to three times, in an order that
   * varies (`popstate`, `hashchange`, the router's commit), and only the first for an entry
   * does more: an entry never read asks for a position, one read before is a return to it.
   */
  const arrive = useCallback(() => {
    const { selection, position, canonical } = readLineLocation({
      search: window.location.search,
      hash: window.location.hash,
      total,
    });
    setSelection(selection);
    const read = readEntry();
    if (read === null) {
      entry.current = newEntryId();
      writeEntry(entry.current, canonical ?? undefined);
      returned.current = false;
      asked.current = position === null ? null : { line: position };
      setPosition(asked.current);
      return;
    }
    if (canonical !== null) writeEntry(read, canonical);
    if (read !== entry.current) {
      entry.current = read;
      returned.current = true;
      asked.current = null;
    }
  }, [total]);
  // A same-URL navigation fires only `popstate`, a fragment set elsewhere perhaps only `hashchange`.
  useEffect(() => {
    window.addEventListener("popstate", arrive);
    window.addEventListener("hashchange", arrive);
    return () => {
      window.removeEventListener("popstate", arrive);
      window.removeEventListener("hashchange", arrive);
    };
  }, [arrive]);
  // A navigation also moves the view: `ScrollRestoration` restores a saved place, or goes to the
  // top of the page, in a layout effect (no element has the id a drawn line would). This runs in
  // a passive effect, which comes after it, on just what that effect runs for. A location
  // holding the same URL and key is the same object, and `replaceState` leaves the router's
  // location behind, so neither `hash` nor `key` would do. A line asked for before the router
  // got here is the same request, gone to again; a return keeps what the router restored.
  const location = useLocation();
  const routerState = useContext(UNSAFE_DataRouterStateContext);
  const restoring = routerState?.restoreScrollPosition;
  const notResetting = routerState?.preventScrollReset;
  // biome-ignore lint/correctness/useExhaustiveDependencies: what `ScrollRestoration` runs for
  useEffect(() => {
    arrive();
    if (returned.current) {
      if (typeof restoring === "number") setPosition({ top: restoring });
    } else if (asked.current !== null) {
      setPosition({ ...asked.current });
      asked.current = null;
    }
    setRouterCommits((seen) => seen + 1);
  }, [arrive, location, restoring, notResetting]);
  const select = useCallback(
    (range: LineRange | null) => {
      setSelection(range);
      writeEntry(readEntry(), lineLink(range, plain));
    },
    [plain],
  );
  return { selection, position, select, routerCommits };
}
