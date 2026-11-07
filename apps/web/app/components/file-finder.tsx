import {
  type KeyboardEvent,
  type MouseEvent,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { Link, useNavigate } from "react-router";
import {
  countLine,
  isComposingKey,
  listNotice,
  PathLoader,
  type PathQuery,
  readPathReply,
  waitFor,
} from "../lib/path-pages.js";
import { FINDER_SHOWN } from "../lib/path-search.js";
import { encodePath } from "../lib/types.js";

/** Where the choice to use the `t` shortcut is kept: this browser only. */
const SHORTCUT_KEY = "fyrden.finder.shortcut";

function shortcutStored(): boolean {
  try {
    return localStorage.getItem(SHORTCUT_KEY) !== "off";
  } catch {
    return true;
  }
}

function storeShortcut(on: boolean): void {
  try {
    if (on) localStorage.removeItem(SHORTCUT_KEY);
    else localStorage.setItem(SHORTCUT_KEY, "off");
  } catch {
    // Stays as it is for this page only.
  }
}

/** Whether typing in `target` means typing: the real target, inside a shadow root too. */
function isEditable(target: EventTarget | undefined): boolean {
  return (
    target instanceof Element &&
    target.closest(
      'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]',
    ) !== null
  );
}

/**
 * "Go to file": a link to the ref's folders without scripts, a search over the ref's
 * paths with them. The input is an ARIA combobox and its results a listbox, with DOM
 * focus staying in the input (the ARIA practices' list autocomplete). The first match
 * is active as soon as something is typed, so Enter goes straight to it.
 */
export function FileFinder({
  owner,
  repo,
  gitRef,
}: {
  owner: string;
  repo: string;
  gitRef: string;
}) {
  const base = `/${owner}/${repo}`;
  const at = encodeURIComponent(gitRef);
  const treeHref = `${base}/tree/${at}/`;
  const navigate = useNavigate();
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [loader, setLoader] = useState<PathLoader | null>(null);
  const [version, changed] = useReducer((n: number) => n + 1, 0);
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<string | null>(null);
  const [shortcut, setShortcut] = useState(true);
  const stop = useRef<AbortController | null>(null);

  // Another ref or repository is another list, which opening the dialog again starts.
  // biome-ignore lint/correctness/useExhaustiveDependencies: these name the list being dropped
  useEffect(() => {
    return () => {
      stop.current?.abort();
      stop.current = null;
      setLoader(null);
      dialog.current?.close();
    };
  }, [owner, repo, gitRef]);

  useEffect(() => setShortcut(shortcutStored()), []);

  function open(): void {
    const box = dialog.current;
    if (!box || box.open) return;
    setQuery("");
    setChosen(null);
    box.showModal();
    input.current?.focus();
    if (loader) {
      void loader.resume();
      return;
    }
    const controller = new AbortController();
    stop.current = controller;
    const { signal } = controller;
    const next: PathLoader = new PathLoader({
      ref: gitRef,
      signal,
      fetchPage: async (asked: PathQuery, stopping: AbortSignal) => {
        const params = new URLSearchParams();
        if (asked.ref !== undefined) params.set("ref", asked.ref);
        if (asked.cursor !== undefined) params.set("cursor", asked.cursor);
        params.set("per_page", String(asked.per_page));
        const url = `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/paths?${params}`;
        return readPathReply(await fetch(url, { signal: stopping }));
      },
      wait: waitFor,
      onChange: changed,
    });
    setLoader(next);
    void next.run();
  }

  useEffect(() => {
    if (!shortcut) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "t" || event.repeat || event.isComposing || event.defaultPrevented) return;
      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      if (isEditable(event.composedPath()[0])) return;
      if (document.querySelector("dialog[open]")) return;
      event.preventDefault();
      open();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` says the list grew
  const { shown, total } = useMemo(
    () => (loader ? loader.index.search(query, FINDER_SHOWN) : { shown: [], total: 0 }),
    [loader, query, version],
  );
  const kept = chosen === null ? -1 : shown.indexOf(chosen);
  const active = kept >= 0 ? kept : query.trim() !== "" && shown.length > 0 ? 0 : -1;
  const optionId = (i: number) => `file-finder-option-${i}`;

  // biome-ignore lint/correctness/useExhaustiveDependencies: the option to show is `active`'s
  useEffect(() => {
    if (active >= 0)
      document.getElementById(optionId(active))?.scrollIntoView({ block: "nearest" });
  }, [active, shown]);

  function go(path: string): void {
    dialog.current?.close();
    void navigate(`${base}/blob/${at}/${encodePath(path)}`);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (isComposingKey(event.nativeEvent)) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (shown.length === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      const from = active < 0 && step < 0 ? 0 : active;
      setChosen(shown[(from + step + shown.length) % shown.length] ?? null);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const path = shown[active];
      if (path !== undefined) go(path);
    } else if (event.key === "Escape" && query !== "") {
      // Left to the browser, the dialog closes: that is for the second Escape.
      event.preventDefault();
      setQuery("");
      setChosen(null);
    }
  }

  function onOpenerClick(event: MouseEvent<HTMLAnchorElement>): void {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return;
    event.preventDefault();
    open();
  }

  const notice = loader && listNotice(loader);
  return (
    <>
      <a
        className="button"
        href={treeHref}
        onClick={onOpenerClick}
        aria-haspopup="dialog"
        aria-keyshortcuts={shortcut ? "t" : undefined}
      >
        Go to file
      </a>
      <dialog
        ref={dialog}
        className="file-finder"
        aria-labelledby="file-finder-title"
        onClose={() => {
          // The event comes later: by then the dialog may have opened again.
          if (!dialog.current?.open) loader?.pause();
        }}
      >
        <div className="file-finder-head">
          <h2 id="file-finder-title">Go to file</h2>
          <button type="button" onClick={() => dialog.current?.close()}>
            Close
          </button>
        </div>
        <label htmlFor="file-finder-input" className="muted">
          File path at <code>{gitRef}</code>
        </label>
        <input
          ref={input}
          id="file-finder-input"
          type="text"
          role="combobox"
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          aria-autocomplete="list"
          aria-expanded={shown.length > 0}
          aria-controls="file-finder-list"
          aria-activedescendant={active >= 0 ? optionId(active) : undefined}
          value={query}
          onChange={(event) => {
            setQuery(event.currentTarget.value);
            setChosen(null);
          }}
          onKeyDown={onKeyDown}
        />
        <p role="status" className="muted file-finder-count">
          {loader ? countLine({ status: loader.status, query, shown: shown.length, total }) : ""}
        </p>
        <p role="status" className="file-finder-notice">
          {notice?.text}
          {notice?.browse && (
            <>
              {" "}
              <Link to={treeHref} onClick={() => dialog.current?.close()}>
                Browse folders
              </Link>
            </>
          )}
        </p>
        {notice?.retry && (
          <p>
            <button type="button" onClick={() => void loader?.retry()}>
              {notice.continues ? "Continue loading" : "Retry"}
            </button>
          </p>
        )}
        {shown.length > 0 && (
          <div id="file-finder-list" role="listbox" aria-label="Matching files">
            {shown.map((path, i) => (
              // The input keeps focus and takes the keys: a click only chooses.
              // biome-ignore lint/a11y/useKeyWithClickEvents: the combobox's input takes the keys
              // biome-ignore lint/a11y/useFocusableInteractive: focus stays in the input, by `aria-activedescendant`
              <div
                key={path}
                id={optionId(i)}
                role="option"
                aria-selected={i === active}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => go(path)}
              >
                {path}
              </div>
            ))}
          </div>
        )}
        <label className="file-finder-shortcut">
          <input
            type="checkbox"
            checked={shortcut}
            onChange={(event) => {
              setShortcut(event.currentTarget.checked);
              storeShortcut(event.currentTarget.checked);
            }}
          />{" "}
          Use the <kbd>t</kbd> shortcut
        </label>
      </dialog>
    </>
  );
}
