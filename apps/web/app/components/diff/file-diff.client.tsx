/**
 * One file's changes drawn by the diff renderer (@pierre/diffs), in the
 * browser only: syntax highlighting runs in a pool of web workers, on the
 * highlighter chosen for the session (`highlighter.ts`: Highlights'
 * WebAssembly lexers where they run, else Shiki's JavaScript RegExp
 * engine; Shiki on the page's own thread once workers fail; the patch as
 * text once nothing highlights). Only the
 * lines near the screen are in the page: the renderer's virtualizer
 * follows the window's scroll. Its review threads sit under their lines;
 * a click on a line's gutter, or a selection of lines, picks them for a
 * new comment.
 */
import {
  canUseWASM,
  DiffHunksRenderer,
  disposeHighlighter,
  getHighlighterOptions,
  getSharedHighlighter,
  Virtualizer,
} from "@pierre/diffs";
import {
  type DiffLineAnnotation,
  FileDiff,
  useWorkerPool,
  VirtualizerContext,
  type WorkerInitializationRenderOptions,
  WorkerPoolContextProvider,
  type WorkerPoolOptions,
} from "@pierre/diffs/react";
import { terminateWorkerPoolSingleton } from "@pierre/diffs/worker";
import DiffsWorker from "@pierre/diffs/worker/worker.js?worker";
import {
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import type { Thread } from "../../lib/pulls.js";
import { fileDiffOf } from "./file-diff.js";
import { type Engine, highlighterChoice, STEP_TIMEOUT_MS, within } from "./highlighter.js";
import { apiSide, rendererSide } from "./patch.js";
import { type LinePick, ThreadView } from "./thread.js";
import { type VirtualizerOwner, VirtualizerOwnerContext } from "./window-virtualizer.js";

// High-contrast themes: the default ones' token colours fail WCAG AA contrast on the
// changed lines' tints (measured with axe in the end-to-end test; these pass it, on
// either highlighter).
const THEMES = { dark: "github-dark-high-contrast", light: "github-light-high-contrast" } as const;
/** Lines longer than this are neither tokenized nor compared word by word (as the renderer's own limit). */
const MAX_TOKENIZED_LINE = 1000;
/**
 * How long a pool may take to start: its themes and highlighter loaded and its workers
 * started (the pool's own limit, 10 s, covers its workers alone).
 */
const POOL_START_MS = 20_000;

const choice = highlighterChoice({
  async teardown() {
    // Drawing is suspended: let the files' renderers leave the page first.
    await new Promise((resolve) => setTimeout(resolve, 0));
    terminateWorkerPoolSingleton();
    await disposeHighlighter();
  },
  async prepare({ name, pool }) {
    // Without a pool, every file waits on the page's own highlighter: load it first, so
    // one that cannot load (or never does) leaves the session plain, not undrawn.
    if (name !== "plain" && !pool) {
      await getSharedHighlighter(
        getHighlighterOptions("text", { theme: THEMES, preferredHighlighter: name }),
      );
    }
  },
});
// Chosen before any pool is built. The import is the one the renderer makes (one chunk).
choice.choose(canUseWASM() && (await within(import("@pierre/highlights"), STEP_TIMEOUT_MS)));

// A file's highlighting that fails in the renderer (a request the worker answers with an
// error, the page's highlighter failing to load a language) is only logged by it: each
// such failure steps the session down too. Cancellations and disposals never reach it. A
// renderer gone from the page (its file scrolled away, another page shown, a step's
// remount) may still see a load it started fail: that is not the current step's failure.
const gone = new WeakSet<object>();
const cleanUp = DiffHunksRenderer.prototype.cleanUp;
DiffHunksRenderer.prototype.cleanUp = function (this: DiffHunksRenderer) {
  gone.add(this);
  cleanUp.call(this);
};
const logHighlightError = DiffHunksRenderer.prototype.onHighlightError;
DiffHunksRenderer.prototype.onHighlightError = function (this: DiffHunksRenderer, error) {
  logHighlightError.call(this, error);
  const now = choice.current();
  if (now && !gone.has(this)) void choice.fail(now.step);
};

/** Each step's pool settings, made once (the pool is built from the first it is given). */
const settings = new Map<
  number,
  { pool: WorkerPoolOptions; highlighter: WorkerInitializationRenderOptions }
>();
function settingsOf({ name, step }: { name: Engine; step: number }) {
  let made = settings.get(step);
  if (!made) {
    made = {
      pool: {
        workerFactory: () => new DiffsWorker(),
        poolSize: Math.max(1, Math.min(4, (globalThis.navigator?.hardwareConcurrency ?? 2) - 1)),
        // A worker failing (blocked, crashed) steps the session down.
        onWorkerError: () => void choice.fail(step),
      },
      highlighter: {
        preferredHighlighter: name,
        theme: THEMES,
        tokenizeMaxLineLength: MAX_TOKENIZED_LINE,
        maxLineDiffLength: MAX_TOKENIZED_LINE,
      },
    };
    settings.set(step, made);
  }
  return made;
}

/**
 * Steps the session down when the pool fails to start (a worker that never answers, say),
 * or is still starting `POOL_START_MS` after it began.
 */
function PoolWatch({ step }: { step: number }) {
  const pool = useWorkerPool();
  useEffect(() => {
    if (!pool) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const leave = pool.subscribeToStatChanges((stats) => {
      if (stats.workersFailed) void choice.fail(step);
      else if (stats.managerState === "initializing") {
        timer ??= setTimeout(() => {
          // Checked when it fires: the pool's own reports pause in a hidden tab.
          if (!pool.isInitialized()) void choice.fail(step);
        }, POOL_START_MS);
      }
    });
    return () => {
      clearTimeout(timer);
      leave();
    };
  }, [pool, step]);
  return null;
}

/**
 * The page's virtualizer (from the page's `WindowVirtualizer`), set up once
 * this file's own parts have connected to it in their effects.
 */
function useWindowVirtualizer(): Virtualizer {
  const owner = useContext(VirtualizerOwnerContext) as VirtualizerOwner<Virtualizer> | null;
  if (!owner) throw new Error("A drawn file needs a WindowVirtualizer above it.");
  const [virtualizer] = useState(() => owner.instance(() => new Virtualizer()));
  useLayoutEffect(() => owner.ready(), [owner]);
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
  const highlighter = useSyncExternalStore(choice.subscribe, choice.current, choice.current);
  const engine = highlighter && highlighter.name !== "plain" ? highlighter.name : undefined;
  const fileDiff = useMemo(
    () => fileDiffOf(patch, { path, previousPath, status }, cacheKey),
    [patch, path, previousPath, status, cacheKey],
  );
  // The drawing the renderer failed (it shows its own error in its place, and draws none
  // of the file's threads): that file is shown as text instead, the session unchanged.
  const [failedOn, setFailedOn] = useState<object | null>(null);
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
      // Read only without a pool (which carries its own).
      ...(engine && { preferredHighlighter: engine }),
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
      onPostRender: (node: HTMLElement) => {
        if (node.shadowRoot?.querySelector("[data-error-wrapper]")) setFailedOn(fileDiff ?? null);
      },
    };
  }, [diffStyle, canAct, onPick, engine, fileDiff]);
  const virtualizer = useWindowVirtualizer();
  if (!fileDiff) return <p className="error">These changes could not be read.</p>;
  if (!highlighter) return <p className="muted">Drawing changes…</p>;
  const failed = failedOn !== null && failedOn === fileDiff;
  if (!engine || failed) {
    // Nothing highlights in this session, or this file failed to draw: the patch as text,
    // its threads after it.
    return (
      <div
        data-highlighter={highlighter.name}
        data-pool={highlighter.pool ? "workers" : "none"}
        data-drawn="text"
      >
        {failed && (
          <p className="error">These changes could not be drawn; here they are as text.</p>
        )}
        <pre className="patch-text">{patch}</pre>
        {threads.length > 0 && (
          <div className="threads">
            <h4>Comments on its lines</h4>
            {threads.map((t) => (
              <ThreadView key={t.id} thread={t} viewer={viewer} canAct={canAct} />
            ))}
          </div>
        )}
      </div>
    );
  }
  const drawn = (
    <FileDiff<{ thread: number }>
      fileDiff={fileDiff}
      options={options}
      lineAnnotations={annotations}
      renderAnnotation={(a) => {
        const thread = threads.find((t) => t.id === a.metadata.thread);
        return thread ? <ThreadView thread={thread} viewer={viewer} canAct={canAct} /> : null;
      }}
    />
  );
  const { pool, highlighter: highlighting } = settingsOf({ name: engine, step: highlighter.step });
  return (
    <VirtualizerContext.Provider value={virtualizer}>
      <div
        key={highlighter.step}
        data-highlighter={highlighter.name}
        data-pool={highlighter.pool ? "workers" : "none"}
      >
        {highlighter.pool ? (
          <WorkerPoolContextProvider poolOptions={pool} highlighterOptions={highlighting}>
            <PoolWatch step={highlighter.step} />
            {drawn}
          </WorkerPoolContextProvider>
        ) : (
          drawn
        )}
      </div>
    </VirtualizerContext.Provider>
  );
}
