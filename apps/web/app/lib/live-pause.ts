import { LIVE_PAUSE_MAX_MS, type LiveBudgetPause } from "./live.js";

/**
 * A tab's daily pause of live hints, kept for one viewer of one origin: in
 * the tab's `sessionStorage` (so a reload keeps it) and in this page's
 * memory (so it holds while the storage fails, until a reload). Each
 * viewer's is its own: another viewer signed in starts with none. What is
 * read is checked: a malformed, past or too distant pause is let go.
 */

/** Where pauses are kept: the browser's, or a test's. */
export interface PauseEnv {
  readonly origin: string;
  /** The tab's storage (it may throw: blocked, or full). */
  storage(): Pick<Storage, "getItem" | "setItem" | "removeItem">;
}

const browser = (): PauseEnv => ({
  origin: location.origin,
  storage: () => sessionStorage,
});

/** What is kept, versioned. */
interface Kept {
  readonly v: 1;
  readonly kind: "budget";
  readonly retryAt: number;
}

/** Kept for each origin and viewer when the storage fails. */
const memory = new Map<string, Kept>();

const keyOf = (env: PauseEnv, viewer: string) =>
  `fyrden.live.pause:${JSON.stringify([env.origin, viewer])}`;

function valid(value: unknown, now: number): LiveBudgetPause | null {
  if (typeof value !== "object" || value === null) return null;
  const kept = value as Partial<Kept>;
  const at = kept.retryAt;
  if (kept.v !== 1 || kept.kind !== "budget" || typeof at !== "number") return null;
  if (!Number.isSafeInteger(at) || at <= now || at > now + LIVE_PAUSE_MAX_MS) return null;
  return { kind: "budget", retryAt: at };
}

/** `viewer`'s pause still to come, if any (one that is not is let go). */
export function readPause(
  viewer: string,
  now: number,
  env: PauseEnv = browser(),
): LiveBudgetPause | null {
  const key = keyOf(env, viewer);
  let raw: string | null = null;
  try {
    raw = env.storage().getItem(key);
  } catch {
    // Unreadable: the memory's.
  }
  let stored: LiveBudgetPause | null = null;
  if (raw !== null) {
    try {
      stored = valid(JSON.parse(raw), now);
    } catch {}
    if (!stored)
      try {
        env.storage().removeItem(key);
      } catch {}
  }
  const remembered = valid(memory.get(key), now);
  if (!remembered) memory.delete(key);
  return stored ?? remembered;
}

/** Keeps `viewer`'s pause, or (null) lets it go. */
export function writePause(
  viewer: string,
  pause: LiveBudgetPause | null,
  env: PauseEnv = browser(),
): void {
  const key = keyOf(env, viewer);
  try {
    if (pause) env.storage().setItem(key, JSON.stringify({ v: 1, ...pause } satisfies Kept));
    else env.storage().removeItem(key);
  } catch {
    // Kept in memory alone: until the page is loaded again.
  }
  if (pause) memory.set(key, { v: 1, kind: "budget", retryAt: pause.retryAt });
  else memory.delete(key);
}
