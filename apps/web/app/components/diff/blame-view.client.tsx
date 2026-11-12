/**
 * A blamed file drawn by the renderer, in the browser only: the file view's drawing with one
 * annotation row above each group of lines, and a line brought into view by measuring it
 * (`ScrollTarget`), since the renderer's own position misses once annotation rows are drawn.
 * The line stays held there as the rest of the blame arrives, until the viewer scrolls.
 */
import type { LineAnnotation, File as RendererFile, VirtualizedFile } from "@pierre/diffs";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { CommitFacts, Group } from "../../lib/blame.js";
import type { LineRange } from "../../lib/file-view.js";
import { ScrollTarget } from "../../lib/scroll-target.js";
import type { LinePosition } from "../../lib/use-line-links.js";
import { GroupLabel } from "../blame-table.js";
import { Drawn, type FileViewStatus } from "./file-view.client.js";
import { WindowVirtualizer } from "./window-virtualizer.js";

/** What an annotation row says: its group, and the commit's facts when it names one. */
export interface Note {
  readonly group: Group;
  readonly facts: CommitFacts | undefined;
  readonly history: string | null;
}

/** The room left above a line brought into view, as the plain view's `scroll-margin-top`. */
const SCROLL_MARGIN = 16;

/** Keys that scroll the page: the viewer has taken over. */
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

/** One stable function for every row, reading only the row's own data. */
function renderNote(annotation: LineAnnotation<Note>): ReactNode {
  const { group, facts, history } = annotation.metadata;
  return (
    <div className="blame-note">
      <GroupLabel group={group} facts={facts} history={history ?? ""} />
    </div>
  );
}

export default function BlameView({
  path,
  cacheKey,
  text,
  size,
  totalLines,
  annotations,
  selection,
  onSelect,
  position,
  revealed,
  onStatus,
  above,
}: {
  path: string;
  cacheKey: string;
  /** The whole text, with no final line ending. */
  text: string;
  size: number;
  totalLines: number;
  /** Kept stable by the caller: a new array draws every row again. */
  annotations: LineAnnotation<Note>[];
  selection: LineRange | null;
  onSelect: (range: LineRange | null) => void;
  position: LinePosition | null;
  revealed: boolean;
  onStatus: (status: FileViewStatus) => void;
  /** Changes whenever what the page shows above the drawing may have changed height. */
  above: unknown;
}) {
  const host = useRef<HTMLElement | null>(null);
  const instance = useRef<RendererFile<Note> | null>(null);
  const [reached, setReached] = useState<number | null>(null);
  const [target] = useState(
    () =>
      new ScrollTarget({
        frame: (callback) => requestAnimationFrame(callback),
        cancelFrame: (id) => cancelAnimationFrame(id),
        offset: (line) => {
          const node = host.current;
          if (!node) return null;
          const row = node.shadowRoot?.querySelector(`[data-line="${line}"]`);
          if (row) return row.getBoundingClientRect().top - SCROLL_MARGIN;
          const at = (instance.current as VirtualizedFile<Note> | null)?.getLinePosition(line);
          return at ? node.getBoundingClientRect().top + at.top - SCROLL_MARGIN : null;
        },
        // Instant, whatever the page's CSS: the target reads where it left the page at once.
        scrollBy: (dy) => window.scrollBy({ top: dy, behavior: "instant" }),
        scrollY: () => window.scrollY,
        onReached: setReached,
      }),
  );
  const onDrawn = useCallback((node: HTMLElement, drawn: RendererFile<Note>) => {
    host.current = node;
    instance.current = drawn;
  }, []);
  const select = useCallback(
    (range: LineRange | null) => {
      target.cancel();
      onSelect(range);
    },
    [onSelect, target],
  );

  // The viewer scrolling stops any line still being brought into view.
  useEffect(() => {
    const stop = () => target.cancel();
    const key = (event: KeyboardEvent) => {
      if (SCROLL_KEYS.has(event.key)) target.cancel();
    };
    window.addEventListener("wheel", stop, { passive: true });
    window.addEventListener("touchstart", stop, { passive: true });
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("wheel", stop);
      window.removeEventListener("touchstart", stop);
      window.removeEventListener("keydown", key);
      target.cancel();
    };
  }, [target]);
  useLayoutEffect(() => {
    if (!revealed || position === null) return;
    setReached(null);
    if ("top" in position) {
      target.cancel();
      window.scrollTo({ top: position.top });
      return;
    }
    target.go(position.line);
  }, [revealed, position, target]);
  // New rows above the line, or a progress line of another height: the line goes back.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `annotations` and `above` say the layout above may have moved
  useLayoutEffect(() => {
    if (target.hold()) setReached(null);
  }, [annotations, above, target]);

  const file = useMemo(() => ({ text, cacheKey }), [text, cacheKey]);
  return (
    <WindowVirtualizer>
      <div className="blame-view" data-position-line={reached ?? undefined}>
        <Drawn<Note>
          path={path}
          contents={file.text}
          cacheKey={file.cacheKey}
          size={size}
          totalLines={totalLines}
          selection={selection}
          onSelect={select}
          position={null}
          revealed={revealed}
          onStatus={onStatus}
          lineAnnotations={annotations}
          renderAnnotation={renderNote}
          onDrawn={onDrawn}
        />
      </div>
    </WindowVirtualizer>
  );
}
