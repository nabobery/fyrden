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
class DraftStore {
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

/** Keeps the drafts of the forms under it, for what `scope` names (a pull request). */
export function Drafts({ scope, children }: { scope: string; children: ReactNode }) {
  const [store] = useState(() => new DraftStore());
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
