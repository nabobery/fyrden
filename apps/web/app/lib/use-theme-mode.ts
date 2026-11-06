import { useEffect, useSyncExternalStore } from "react";
import { useRouteLoaderData } from "react-router";
import type { ThemeMode } from "./theme.js";

/**
 * What this tab shows since a pick: `over` is what the server said when it was made.
 * The pick holds while the root's data still says that, as a same-page pick does not read
 * it again; newer data (a navigation, after another tab's pick) wins. Browser state only:
 * nothing here is written while the server renders.
 */
let shown: { readonly mode: ThemeMode; readonly over: ThemeMode } | null = null;
/** The last pick the server kept. */
let kept: ThemeMode | null = null;
/** Picks post one at a time, so the cookie ends up holding the last one made. */
let keeping: Promise<unknown> = Promise.resolve();
let latest = 0;
let pending = 0;
/** What the root's data last said, to catch up with once no pick is being kept. */
let serverSaid: ThemeMode | null = null;
const listeners = new Set<() => void>();

function show(mode: ThemeMode, over: ThemeMode): void {
  shown = { mode, over };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The root's data moved on from what the pick was made over: nothing held here still applies. */
export function noteServerThemeMode(fromServer: ThemeMode): void {
  serverSaid = fromServer;
  if (pending === 0 && shown !== null && shown.over !== fromServer) {
    shown = null;
    kept = null;
  }
}

/** The scheme to show, given what the root's data says. */
export function themeModeShown(fromServer: ThemeMode): ThemeMode {
  return shown?.over === fromServer ? shown.mode : fromServer;
}

/**
 * Shows `mode` at once and keeps it through `post`. If the last pick made cannot be kept,
 * it goes back to the last one that was, or else to what the server said.
 */
export function pickThemeMode(
  mode: ThemeMode,
  fromServer: ThemeMode,
  post: (mode: ThemeMode) => Promise<void>,
): Promise<void> {
  const pick = ++latest;
  pending++;
  show(mode, fromServer);
  const attempt = keeping.then(async () => {
    try {
      await post(mode);
      kept = mode;
    } catch {
      if (pick === latest) show(kept ?? fromServer, fromServer);
    } finally {
      pending--;
      if (serverSaid !== null) noteServerThemeMode(serverSaid);
    }
  });
  keeping = attempt;
  return attempt;
}

/** What the root's data says: System where it is missing (an error page). */
export function useServerThemeMode(): ThemeMode {
  const data = useRouteLoaderData("root") as { theme?: ThemeMode } | undefined;
  return data?.theme ?? "system";
}

/** The visitor's colour scheme. */
export function useThemeMode(): ThemeMode {
  const fromServer = useServerThemeMode();
  useEffect(() => noteServerThemeMode(fromServer), [fromServer]);
  return useSyncExternalStore(
    subscribe,
    () => themeModeShown(fromServer),
    () => fromServer,
  );
}
