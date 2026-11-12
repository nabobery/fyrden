/**
 * One file drawn by the renderer (@pierre/diffs), in the browser only, on the session's
 * highlighter (`highlighter.ts`, shared with the diff view). It is laid out unseen over the
 * plain view until it has rows to show, so nothing moves when it takes over; it tells the
 * page where it has got to through `onStatus`.
 */
import type { LineAnnotation, File as RendererFile, VirtualizedFile } from "@pierre/diffs";
import { File, VirtualizerContext, WorkerPoolContextProvider } from "@pierre/diffs/react";
import {
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { type LineRange, rendererFile, withoutFinalEnding } from "../../lib/file-view.js";
import { FJORD_RENDERER_CSS } from "../../lib/fjord.js";
import type { ThemeMode } from "../../lib/theme.js";
import { classifyBytes } from "../../lib/types.js";
import type { LinePosition } from "../../lib/use-line-links.js";
import { useThemeMode } from "../../lib/use-theme-mode.js";
import {
  MAX_TOKENIZED_LINE,
  PoolWatch,
  sessionHighlighter,
  settingsOf,
  THEMES,
} from "./highlighter.js";
import { newPoolWorker } from "./pool-worker.client.js";
import { steadyVirtualizer } from "./steady-virtualizer.client.js";
import { useWindowVirtualizer, WindowVirtualizer } from "./window-virtualizer.js";

const choice = await sessionHighlighter();

export type FileViewStatus = "waiting" | "drawn" | "failed";

/** The room left above a line brought into view, as the plain view's `scroll-margin-top`. */
const SCROLL_MARGIN = 16;

/**
 * A new scheme is only a new attribute on a drawing that holds both schemes' colours: set
 * before the renderer's own component compares its options, which then finds nothing changed,
 * so no row is drawn again. Rendered ahead of `File` for that order.
 */
function FollowScheme<A>({
  instance,
  mode,
}: {
  instance: RefObject<RendererFile<A> | null>;
  mode: ThemeMode;
}) {
  useLayoutEffect(() => {
    instance.current?.setThemeType(mode);
  }, [instance, mode]);
  return null;
}

type WholeText =
  | { readonly state: "reading" }
  | { readonly state: "read"; readonly text: string }
  | { readonly state: "failed" };

/** The whole text, read at its commit so a moving branch can't change it under the view. */
function useWholeText(given: string | null, rawUrl: string | null): WholeText {
  const [read, setRead] = useState<WholeText>(
    given !== null ? { state: "read", text: given } : { state: "reading" },
  );
  useEffect(() => {
    if (given !== null || rawUrl === null) return;
    const stop = new AbortController();
    fetch(rawUrl, { signal: stop.signal })
      .then(async (answer) => {
        if (!answer.ok) throw new Error(`raw: ${answer.status}`);
        const bytes = classifyBytes(new Uint8Array(await answer.arrayBuffer()));
        if (bytes.kind !== "text") throw new Error(`raw: ${bytes.kind}`);
        setRead({ state: "read", text: withoutFinalEnding(bytes.text) });
      })
      .catch(() => {
        if (!stop.signal.aborted) setRead({ state: "failed" });
      });
    return () => stop.abort();
  }, [given, rawUrl]);
  return read;
}

/**
 * The renderer's drawing of one file. Blame draws its own (`blame-view.client.tsx`), with rows
 * between lines (`lineAnnotations`, `renderAnnotation`, both kept stable by the caller so a
 * drawing isn't redone) and its own way of bringing a line into view (`onDrawn` hands it the
 * drawing; it passes a null `position`).
 */
export function Drawn<A = undefined>({
  path,
  contents,
  cacheKey,
  size,
  totalLines,
  selection,
  onSelect,
  position,
  revealed,
  onStatus,
  lineAnnotations,
  renderAnnotation,
  onDrawn,
}: {
  path: string;
  contents: string;
  cacheKey: string;
  size: number;
  totalLines: number;
  selection: LineRange | null;
  onSelect: (range: LineRange | null) => void;
  position: LinePosition | null;
  /** The page has taken the plain view away for this drawing: only now is the layout final. */
  revealed: boolean;
  onStatus: (status: FileViewStatus) => void;
  lineAnnotations?: LineAnnotation<A>[];
  renderAnnotation?: (annotation: LineAnnotation<A>) => ReactNode;
  onDrawn?: (node: HTMLElement, drawn: RendererFile<A>) => void;
}) {
  const highlighter = useSyncExternalStore(choice.subscribe, choice.current, choice.current);
  const engine = highlighter && highlighter.name !== "plain" ? highlighter.name : undefined;
  const step = highlighter?.step ?? null;
  const mode = useThemeMode();
  const instance = useRef<RendererFile<A> | null>(null);
  const host = useRef<HTMLElement | null>(null);
  // The step that has drawn rows: a step down draws from the start, the plain view back up
  // meanwhile. A drawing the renderer failed leaves this file as text, the session unchanged.
  const [drawnOn, setDrawnOn] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const file = useMemo(
    () => rendererFile({ path, contents, cacheKey, size, totalLines }),
    [path, contents, cacheKey, size, totalLines],
  );
  // Only what never changes with the scheme: `FollowScheme` needs the rest to compare equal.
  const stable = useMemo(
    () => ({
      theme: THEMES,
      unsafeCSS: FJORD_RENDERER_CSS,
      // Read only without a pool (which carries its own).
      ...(engine && { preferredHighlighter: engine }),
      disableFileHeader: true,
      overflow: "scroll" as const,
      tokenizeMaxLineLength: MAX_TOKENIZED_LINE,
      enableLineSelection: true,
      onLineSelectionEnd: (range: LineRange | null) => {
        onSelect(
          range && {
            start: Math.min(range.start, range.end),
            end: Math.max(range.start, range.end),
          },
        );
      },
      onPostRender: (node: HTMLElement, drawn: RendererFile<A>) => {
        instance.current = drawn;
        host.current = node;
        onDrawn?.(node, drawn);
        if (node.shadowRoot?.querySelector("[data-error-wrapper]")) setFailed(true);
        else if (node.shadowRoot?.querySelector("[data-line]")) setDrawnOn(step);
      },
    }),
    [engine, onSelect, step, onDrawn],
  );
  const options = useMemo(() => ({ ...stable, themeType: mode }), [stable, mode]);
  const virtualizer = useWindowVirtualizer(steadyVirtualizer);
  const drawn = !failed && step !== null && drawnOn === step;
  const nothingDraws = highlighter !== null && !engine;
  const status: FileViewStatus = failed || nothingDraws ? "failed" : drawn ? "drawn" : "waiting";
  useLayoutEffect(() => onStatus(status), [onStatus, status]);
  useLayoutEffect(() => {
    if (!revealed || position === null) return;
    if ("top" in position) {
      window.scrollTo({ top: position.top });
      return;
    }
    const at = (instance.current as VirtualizedFile<A> | null)?.getLinePosition(position.line);
    if (!at || !host.current) return;
    const top = host.current.getBoundingClientRect().top + window.scrollY + at.top;
    window.scrollTo({ top: top - SCROLL_MARGIN });
  }, [revealed, position]);

  if (!engine || failed || highlighter === null) return null;
  const { pool, highlighter: highlighting } = settingsOf(choice, newPoolWorker, {
    name: engine,
    step: highlighter.step,
  });
  const body = (
    <>
      <FollowScheme instance={instance} mode={mode} />
      <File
        file={file}
        options={options}
        selectedLines={selection}
        {...(lineAnnotations && { lineAnnotations })}
        {...(renderAnnotation && { renderAnnotation })}
      />
    </>
  );
  return (
    <VirtualizerContext.Provider value={virtualizer}>
      <div
        key={highlighter.step}
        className={revealed ? undefined : "file-view-unseen"}
        data-highlighter={highlighter.name}
        data-pool={highlighter.pool ? "workers" : "none"}
      >
        {highlighter.pool ? (
          <WorkerPoolContextProvider poolOptions={pool} highlighterOptions={highlighting}>
            <PoolWatch choice={choice} step={highlighter.step} />
            {body}
          </WorkerPoolContextProvider>
        ) : (
          body
        )}
      </div>
    </VirtualizerContext.Provider>
  );
}

export default function FileView({
  path,
  cacheKey,
  text,
  rawUrl,
  size,
  totalLines,
  selection,
  onSelect,
  position,
  revealed,
  onStatus,
}: {
  path: string;
  cacheKey: string;
  /** The file's text with no final line ending, when the page has all of it. */
  text: string | null;
  rawUrl: string | null;
  size: number;
  totalLines: number;
  selection: LineRange | null;
  onSelect: (range: LineRange | null) => void;
  position: LinePosition | null;
  revealed: boolean;
  onStatus: (status: FileViewStatus) => void;
}) {
  const contents = useWholeText(text, rawUrl);
  const unread = contents.state === "failed";
  useLayoutEffect(() => {
    if (unread) onStatus("failed");
  }, [onStatus, unread]);
  if (contents.state !== "read") return null;
  return (
    <WindowVirtualizer>
      <Drawn
        path={path}
        contents={contents.text}
        cacheKey={cacheKey}
        size={size}
        totalLines={totalLines}
        selection={selection}
        onSelect={onSelect}
        position={position}
        revealed={revealed}
        onStatus={onStatus}
      />
    </WindowVirtualizer>
  );
}
