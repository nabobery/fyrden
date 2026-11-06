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
import { InteractionManager, Virtualizer } from "@pierre/diffs";
import {
  type DiffLineAnnotation,
  FileDiff,
  VirtualizerContext,
  WorkerPoolContextProvider,
} from "@pierre/diffs/react";
import { useMemo, useState, useSyncExternalStore } from "react";
import { FJORD_RENDERER_CSS } from "../../lib/fjord.js";
import type { Thread } from "../../lib/pulls.js";
import { useThemeMode } from "../../lib/use-theme-mode.js";
import { fileDiffOf } from "./file-diff.js";
import {
  MAX_TOKENIZED_LINE,
  PoolWatch,
  sessionHighlighter,
  settingsOf,
  THEMES,
} from "./highlighter.js";
import { apiSide, rendererSide } from "./patch.js";
import { newPoolWorker } from "./pool-worker.client.js";
import { type LinePick, ThreadView } from "./thread.js";
import { useWindowVirtualizer } from "./window-virtualizer.js";

const choice = await sessionHighlighter();

// The renderer's gutter button has no name and no option to give it one. A button of our
// own (`renderGutterUtility`) can't take `onGutterUtilityClick`, which the renderer refuses
// alongside it, and that is what picks lines and ranges from the button. So the renderer's
// button is named where it is made. Both members are private: brackets keep them type-checked.
const ensureGutterUtility = InteractionManager.prototype["ensureGutterUtilityNode"];
InteractionManager.prototype["ensureGutterUtilityNode"] = function (
  this: InteractionManager<"diff">,
  ...args: unknown[]
) {
  ensureGutterUtility.apply(this, args);
  const button = this["gutterUtilityButton"];
  // It picks the lines already selected if there are any, so "this line" alone would be untrue.
  button?.setAttribute("aria-label", "Comment on this line or selection");
  // It answers the pointer only: from the keyboard, lines are picked with the page's own form.
  button?.setAttribute("tabindex", "-1");
};

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
  const mode = useThemeMode();
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
      unsafeCSS: FJORD_RENDERER_CSS,
      // Read only without a pool (which carries its own).
      ...(engine && { preferredHighlighter: engine }),
      themeType: mode,
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
  }, [diffStyle, canAct, onPick, engine, fileDiff, mode]);
  const virtualizer = useWindowVirtualizer(() => new Virtualizer());
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
  const { pool, highlighter: highlighting } = settingsOf(choice, newPoolWorker, {
    name: engine,
    step: highlighter.step,
  });
  return (
    <VirtualizerContext.Provider value={virtualizer}>
      <div
        key={highlighter.step}
        data-highlighter={highlighter.name}
        data-pool={highlighter.pool ? "workers" : "none"}
      >
        {highlighter.pool ? (
          <WorkerPoolContextProvider poolOptions={pool} highlighterOptions={highlighting}>
            <PoolWatch choice={choice} step={highlighter.step} />
            {drawn}
          </WorkerPoolContextProvider>
        ) : (
          drawn
        )}
      </div>
    </VirtualizerContext.Provider>
  );
}
