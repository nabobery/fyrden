import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";

/**
 * Text written into a page's forms and not sent yet, by what it is for. A
 * form that remounts (a review thread moving between the diff and the list,
 * or drawn again as the diff scrolls) finds its text here again.
 */
export class DraftStore {
  readonly #text = new Map<string, string>();
  readonly #listeners = new Set<() => void>();

  get(key: string): string {
    return this.#text.get(key) ?? "";
  }

  set(key: string, text: string): void {
    if (text) this.#text.set(key, text);
    else this.#text.delete(key);
    for (const listener of this.#listeners) listener();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
}

const DraftsContext = createContext<{ scope: string; store: DraftStore } | null>(null);

/** The drafts written by `viewer`. */
export interface ViewerDrafts {
  readonly viewer: string | null;
  readonly store: DraftStore;
}

/**
 * The drafts for `viewer`: `held` while it is theirs, else new ones (the
 * account changed, in another tab: what the other one wrote goes).
 */
export function draftsFor(held: ViewerDrafts | undefined, viewer: string | null): ViewerDrafts {
  return held?.viewer === viewer ? held : { viewer, store: new DraftStore() };
}

/**
 * Keeps the drafts of the forms under it, by `page` (a pull request) and by
 * who writes them: neither a draft nor the answer to sending one is shown
 * to another account signed in later.
 */
export function Drafts({
  viewer,
  page,
  children,
}: {
  viewer: string | null;
  page: string;
  children: ReactNode;
}) {
  const [held, setHeld] = useState(() => draftsFor(undefined, viewer));
  const drafts = draftsFor(held, viewer);
  if (drafts !== held) setHeld(drafts);
  const { store } = drafts;
  // The viewer is in the keys too: the fetchers sending drafts are the router's, not these.
  const scope = `${page}#${viewer ?? ""}`;
  const value = useMemo(() => ({ scope, store }), [scope, store]);
  return <DraftsContext.Provider value={value}>{children}</DraftsContext.Provider>;
}

function useDrafts(): { scope: string; store: DraftStore } {
  const drafts = useContext(DraftsContext);
  if (!drafts) throw new Error("A draft needs a Drafts above it.");
  return drafts;
}

/**
 * `key` within the drafts' scope: for a draft, and for the fetcher sending
 * it (whose answer then also outlives a remount).
 */
export function useScopedKey(key: string): string {
  return `${useDrafts().scope}:${key}`;
}

/** The draft kept under `key`, and a way to change it ("" drops it). */
export function useDraft(key: string): [string, (text: string) => void] {
  const { scope, store } = useDrafts();
  const scoped = `${scope}:${key}`;
  const read = () => store.get(scoped);
  const text = useSyncExternalStore(store.subscribe, read, read);
  const write = useCallback((next: string) => store.set(scoped, next), [store, scoped]);
  return [text, write];
}
