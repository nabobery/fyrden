/**
 * One file's changes drawn by the diff renderer (@pierre/diffs), in the
 * browser only: syntax highlighting runs in a pool of web workers with
 * Shiki's JavaScript RegExp engine (no WebAssembly), grammars loaded per
 * language. Only the lines near the screen are in the page: the renderer's
 * virtualizer follows the window's scroll. Its review threads sit under
 * their lines; a click on a line's gutter, or a selection of lines, picks
 * them for a new comment.
 */
import { Virtualizer } from "@pierre/diffs";
import {
  type DiffLineAnnotation,
  FileDiff,
  VirtualizerContext,
  WorkerPoolContextProvider,
} from "@pierre/diffs/react";
import DiffsWorker from "@pierre/diffs/worker/worker.js?worker";
import { useEffect, useMemo, useState } from "react";
import type { Thread } from "../../lib/pulls.js";
import { fileDiffOf } from "./file-diff.js";
import { apiSide, rendererSide } from "./patch.js";
import { type LinePick, ThreadView } from "./thread.js";

// High-contrast themes: the default ones' token colours fail WCAG AA contrast on the
// changed lines' tints (measured with axe in the end-to-end test; these pass it).
const THEMES = { dark: "github-dark-high-contrast", light: "github-light-high-contrast" } as const;
/** Lines longer than this are neither tokenized nor compared word by word (as the renderer's own limit). */
const MAX_TOKENIZED_LINE = 1000;

const POOL = {
  workerFactory: () => new DiffsWorker(),
  poolSize: Math.max(1, Math.min(4, (globalThis.navigator?.hardwareConcurrency ?? 2) - 1)),
};
const HIGHLIGHTER = {
  preferredHighlighter: "shiki-js" as const,
  theme: THEMES,
  tokenizeMaxLineLength: MAX_TOKENIZED_LINE,
  maxLineDiffLength: MAX_TOKENIZED_LINE,
};

/** The page's one virtualizer (on the window's scroll), shared by every drawn file. */
let shared: { virtualizer: Virtualizer; users: number } | null = null;

/** The shared virtualizer, made on first use and cleaned up when its last file goes. */
function useWindowVirtualizer(): Virtualizer {
  const [virtualizer] = useState(() => {
    if (!shared) {
      const made = new Virtualizer();
      made.setup(document);
      shared = { virtualizer: made, users: 0 };
    }
    return shared.virtualizer;
  });
  useEffect(() => {
    if (shared?.virtualizer !== virtualizer) return;
    shared.users++;
    return () => {
      if (shared?.virtualizer !== virtualizer || --shared.users > 0) return;
      virtualizer.cleanUp();
      shared = null;
    };
  }, [virtualizer]);
  return virtualizer;
}

export default function FileDiffView({
  path,
  previousPath,
  status,
  patch,
  cacheKey,
  diffStyle,
  threads,
  viewer,
  canAct,
  onPick,
}: {
  path: string;
  previousPath?: string | undefined;
  status: string;
  patch: string;
  cacheKey: string;
  diffStyle: "unified" | "split";
  threads: Thread[];
  viewer: string | null;
  canAct: boolean;
  onPick: (pick: LinePick) => void;
}) {
  const fileDiff = useMemo(
    () => fileDiffOf(patch, { path, previousPath, status }, cacheKey),
    [patch, path, previousPath, status, cacheKey],
  );
  const annotations = useMemo(
    () =>
      threads.flatMap((t): DiffLineAnnotation<{ thread: number }>[] =>
        t.line === null
          ? []
          : [{ side: rendererSide(t.side), lineNumber: t.line, metadata: { thread: t.id } }],
      ),
    [threads],
  );
  const options = useMemo(() => {
    const pick = (
      range: {
        start: number;
        end: number;
        side?: "deletions" | "additions";
        endSide?: "deletions" | "additions";
      } | null,
    ) => {
      if (!range) return;
      // A range stays on one side: across sides, the last line alone.
      const side = range.endSide ?? range.side;
      const across =
        range.side !== undefined && range.endSide !== undefined && range.side !== range.endSide;
      const start = across ? range.end : Math.min(range.start, range.end);
      const end = across ? range.end : Math.max(range.start, range.end);
      onPick({ side: apiSide(side), start, end });
    };
    return {
      diffStyle,
      theme: THEMES,
      themeType: "system" as const,
      disableFileHeader: true,
      overflow: "scroll" as const,
      hunkSeparators: "line-info" as const,
      lineDiffType: "word-alt" as const,
      tokenizeMaxLineLength: MAX_TOKENIZED_LINE,
      maxLineDiffLength: MAX_TOKENIZED_LINE,
      enableGutterUtility: canAct,
      onGutterUtilityClick: pick,
      enableLineSelection: canAct,
      onLineSelected: pick,
    };
  }, [diffStyle, canAct, onPick]);
  const virtualizer = useWindowVirtualizer();
  if (!fileDiff) return <p className="error">These changes could not be read.</p>;
  return (
    <VirtualizerContext.Provider value={virtualizer}>
      <WorkerPoolContextProvider poolOptions={POOL} highlighterOptions={HIGHLIGHTER}>
        <FileDiff<{ thread: number }>
          fileDiff={fileDiff}
          options={options}
          lineAnnotations={annotations}
          renderAnnotation={(a) => {
            const thread = threads.find((t) => t.id === a.metadata.thread);
            return thread ? <ThreadView thread={thread} viewer={viewer} canAct={canAct} /> : null;
          }}
        />
      </WorkerPoolContextProvider>
    </VirtualizerContext.Provider>
  );
}
