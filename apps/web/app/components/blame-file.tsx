/**
 * A blamed file on the page. The server draws one window as a plain table, which is all there
 * is with no script. Once hydrated:
 * - a file with no lone carriage return is drawn by the renderer, whole, with one annotation
 *   row per group, from every range delivered at the commit (`BlameDelivery`, whole); the
 *   server's window stays until the first answer, and the table stays until the drawing is
 *   ready, or for good if it fails or the text can't be read;
 * - a file with a lone CR, or one whose groups pass `ANNOTATION_CUTOFF`, keeps the table,
 *   which goes on asking for its own window (`BlameDelivery`, window).
 * Either way the visit walks history at most `AUTOMATIC_REQUESTS` times on its own, then waits
 * for Continue, and asks nothing while the tab is hidden.
 */
import type { LineAnnotation } from "@pierre/diffs";
import {
  Component,
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  ANNOTATION_CUTOFF,
  type BlameView,
  blameBlocks,
  blamePath,
  displayGroups,
  drawnLines,
  historyPath,
  refusalSentence,
} from "../lib/blame.js";
import {
  BlameDelivery,
  Budget,
  type DeliveryDeps,
  type DeliveryState,
  readBlameText,
  type WholeText,
} from "../lib/blame-delivery.js";
import { blockHolding, rawBytesUrl, withoutFinalEnding } from "../lib/file-view.js";
import { topVisibleLine } from "../lib/scroll-target.js";
import { encodePath } from "../lib/types.js";
import { forgetLineEntry, type LinePosition, useLineLinks } from "../lib/use-line-links.js";
import { BlameTable, count } from "./blame-table.js";
import type { Note } from "./diff/blame-view.client.js";
import type { FileViewStatus } from "./diff/file-view.client.js";

// The renderer is loaded in the browser only, once the page is hydrated.
const BlameDrawing = lazy(() => import("./diff/blame-view.client.js"));

/** Leaves the table up when the renderer's module won't load or its drawing throws. */
class Fallback extends Component<{ onFail: () => void; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch() {
    this.props.onFail();
  }
  override render() {
    return this.state.failed ? null : this.props.children;
  }
}

/** The ranges route at the commit: its URL ends in a slash, for a path ending in `.data`. */
function rangesUrl(view: BlameView): string {
  return `/${view.owner}/${view.repo}/blame-ranges/${encodeURIComponent(view.commit)}/${encodePath(view.path)}/`;
}

function browserDeps(url: string): DeliveryDeps {
  return {
    async ask(query, signal) {
      try {
        const res = await fetch(`${url}?${query}`, {
          signal,
          headers: { Accept: "application/json" },
        });
        const body: unknown = await res.json().catch(() => null);
        const wait = Number(res.headers.get("Retry-After"));
        return {
          status: res.status,
          body,
          retryAfter: Number.isFinite(wait) && wait > 0 ? wait : null,
        };
      } catch {
        return { status: 0, body: null, retryAfter: null };
      }
    },
    // The API's own wait (`retry_after`), not a guess: a production timer, cancelled with the page.
    sleep: (seconds, signal) =>
      new Promise((done) => {
        const timer = setTimeout(done, Math.max(0, seconds) * 1000);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            done();
          },
          { once: true },
        );
      }),
    visible: () => document.visibilityState === "visible",
    now: () => performance.now(),
    onVisibilityChange(listener) {
      document.addEventListener("visibilitychange", listener);
      return () => document.removeEventListener("visibilitychange", listener);
    },
  };
}

const NO_STATE = () => () => {};

/** One delivery while `key` holds, started once hydrated and stopped when the key changes. */
function useDelivery(
  view: BlameView,
  budget: Budget,
  mode: { kind: "whole" } | { kind: "window"; start: number; end: number } | null,
): { delivery: BlameDelivery | null; state: DeliveryState | null } {
  const key = mode === null ? null : mode.kind === "whole" ? "whole" : `${mode.start}-${mode.end}`;
  const [delivery, setDelivery] = useState<BlameDelivery | null>(null);
  // The last delivery's state: the next one starts from it, so a switch loses nothing shown.
  const last = useRef<DeliveryState | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new delivery only for a new key
  useEffect(() => {
    if (mode === null) return;
    const prior = last.current;
    const kept =
      prior?.ranges == null
        ? undefined
        : mode.kind === "whole"
          ? prior.ranges
          : prior.ranges.filter(
              (r) => r.start_line <= mode.end && r.start_line + r.line_count - 1 >= mode.start,
            );
    const started = new BlameDelivery({
      mode,
      initial: prior
        ? {
            lines: prior.lines,
            resolved: prior.resolved,
            unresolved: prior.unresolved,
            state: prior.state,
            ...(kept && { ranges: kept, commits: prior.commits }),
            // A wait still owed is still owed; a refusal is final, and every range delivered
            // covers any window: neither asks again.
            owedUntil: prior.owedUntil,
            ...(prior.status === "refused" && {
              status: "refused" as const,
              refusal: prior.refusal,
            }),
            ...(prior.status === "done" && kept && { status: "done" as const }),
          }
        : {
            lines: view.blame.lines,
            resolved: view.blame.resolved,
            unresolved: view.blame.unresolved,
            state: view.blame.state,
          },
      budget,
      deps: browserDeps(rangesUrl(view)),
    });
    setDelivery(started);
    started.start();
    return () => started.stop();
  }, [key, budget]);
  const subscribe = useMemo(
    () => (delivery ? (listener: () => void) => delivery.subscribe(listener) : NO_STATE),
    [delivery],
  );
  const state = useSyncExternalStore(
    subscribe,
    () => delivery?.snapshot() ?? null,
    () => null,
  );
  useEffect(() => {
    if (state !== null) last.current = state;
  }, [state]);
  return { delivery, state };
}

/** The whole text for the renderer: the window's own when it is the whole file, else read raw. */
function useWholeText(view: BlameView, wanted: boolean): WholeText | null {
  const given = useMemo(
    () =>
      view.whole && !view.loneCr ? view.window.lines.map((line) => line.text).join("\n") : null,
    [view],
  );
  const [read, setRead] = useState<WholeText | null>(null);
  useEffect(() => {
    if (!wanted || given !== null) return;
    const stop = new AbortController();
    fetch(rawBytesUrl(view.owner, view.repo, view.commit, view.path), { signal: stop.signal })
      .then((answer) => readBlameText(answer, stop.signal))
      .then(setRead, () => {
        if (!stop.signal.aborted) setRead({ kind: "failed" });
      });
    return () => stop.abort();
  }, [wanted, given, view]);
  if (given !== null) return { kind: "text", text: given };
  return read && read.kind === "text"
    ? { kind: "text", text: withoutFinalEnding(read.text) }
    : read;
}

/**
 * What the visit is doing, and the one button that moves it on. What the delivery is doing
 * comes first: a blame the API has finished can still have ranges to bring in.
 */
export function Progress({ state, onResume }: { state: DeliveryState; onResume: () => void }) {
  const settled = state.resolved + state.unresolved;
  const sofar = `${count(settled)} of ${count(state.lines)} lines worked out so far.`;
  if (state.status === "refused")
    return (
      <p role="status">{refusalSentence(state.refusal ?? "") ?? "Blame refused this file."}</p>
    );
  if (state.status === "failed")
    return (
      <p className="row">
        <span role="status">Blame couldn't be read just now.</span>
        <button type="button" onClick={onResume}>
          Try again
        </button>
      </p>
    );
  if (state.status === "done" && state.state === "complete")
    return state.unresolved > 0 ? (
      <p className="notice" role="status">
        {`${count(state.unresolved)} of ${count(state.lines)} lines couldn't be attributed: their rows say why.`}
      </p>
    ) : (
      <p className="visually-hidden" role="status">
        Every line is attributed.
      </p>
    );
  if (state.status === "budget")
    return (
      <p className="row">
        <span role="status">{`${sofar} Paused after ${count(state.requests)} requests.`}</span>
        <button type="button" onClick={onResume}>
          Continue
        </button>
      </p>
    );
  if (state.status === "hidden")
    return <p role="status">{`${sofar} Paused while this tab is hidden.`}</p>;
  return <p role="status">{sofar}</p>;
}

export function BlameFile({ view }: { view: BlameView }) {
  const at = blamePath(view.owner, view.repo, view.commit, view.path);
  const { selection, position, select, routerCommits } = useLineLinks({
    total: view.blame.lines,
    plain: false,
    selected: view.selected,
  });
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  const [budget] = useState(() => new Budget());
  // Set when the groups pass the cutoff: the table, at the line the reader had reached.
  const [shown, setShown] = useState<{ window: BlameView["window"]; top: number } | null>(null);
  const drawable = !view.loneCr && shown === null;
  const [status, setStatus] = useState<FileViewStatus>(drawable ? "waiting" : "failed");
  const onFail = useCallback(() => setStatus("failed"), []);
  const text = useWholeText(view, hydrated && drawable && status !== "failed");
  const textFailed = text !== null && text.kind !== "text";
  const region = shown?.window ?? view.window;
  const mode = !hydrated
    ? null
    : drawable && status !== "failed"
      ? ({ kind: "whole" } as const)
      : ({ kind: "window", start: region.firstLine, end: region.lastLine } as const);
  const { delivery, state } = useDelivery(view, budget, mode);

  // The ranges and counts the page shows: the server's window until the first answer.
  const ranges = state?.ranges ?? view.blame.ranges;
  const commits = state && state.ranges !== null ? state.commits : view.blame.commits;
  const live: BlameView = useMemo(
    () => ({
      ...view,
      window: region,
      blame: {
        state: state?.state ?? view.blame.state,
        lines: view.blame.lines,
        resolved: state?.resolved ?? view.blame.resolved,
        unresolved: state?.unresolved ?? view.blame.unresolved,
        ranges,
        commits,
      },
    }),
    [view, region, state, ranges, commits],
  );
  // Every group of the file, for the renderer: past the cutoff, the table takes over.
  const groups = useMemo(
    () => displayGroups(ranges, 1, view.blame.lines),
    [ranges, view.blame.lines],
  );
  const over = groups.length > ANNOTATION_CUTOFF;
  // Past the cutoff the drawing keeps the rows it had until the table takes over, so the line
  // the reader had reached can be read from it.
  const drawnRows = useRef<LineAnnotation<Note>[]>([]);
  const computed = useMemo<LineAnnotation<Note>[] | null>(
    () =>
      over
        ? null
        : groups.map((group) => ({
            lineNumber: group.startLine - 1,
            metadata: {
              group,
              facts: group.kind === "commit" ? commits[group.commit] : undefined,
              history:
                group.kind === "commit"
                  ? historyPath(view.owner, view.repo, group.commit, view.path)
                  : null,
            },
          })),
    [over, groups, commits, view],
  );
  useEffect(() => {
    if (computed !== null) drawnRows.current = computed;
  }, [computed]);
  const annotations = computed ?? drawnRows.current;
  useEffect(() => {
    if (textFailed) setStatus("failed");
  }, [textFailed]);
  // Past the cutoff: the table of the block holding the line at the top of the window, read
  // from the drawing while it is still there (before paint), and built from the text in hand;
  // with no text yet, the server's own window.
  const container = useRef<HTMLDivElement | null>(null);
  // The line asked for before the table took over: already gone to, not to be gone to again.
  const taken = useRef<LinePosition | null>(null);
  useLayoutEffect(() => {
    if (!over || !drawable) return;
    taken.current = position;
    const top =
      (container.current && topVisibleLine(container.current)) ??
      (position !== null && "line" in position ? position.line : view.window.firstLine);
    if (text?.kind !== "text") {
      setShown({
        window: view.window,
        top: Math.min(Math.max(top, view.window.firstLine), view.window.lastLine),
      });
    } else {
      const { blocks } = blameBlocks(text.text);
      const block = blockHolding(blocks, top);
      const index = blocks.indexOf(block);
      setShown({
        window: {
          firstLine: block.firstLine,
          lastLine: block.firstLine + block.lineCount - 1,
          cut: block.cut,
          previous: blocks[index - 1]?.firstLine ?? null,
          next: blocks[index + 1]?.firstLine ?? null,
          lines: drawnLines(text.text, block),
        },
        top,
      });
    }
    setStatus("failed");
  }, [over, drawable, text, view, position]);
  // The table has taken over: back to the line the reader had reached.
  useLayoutEffect(() => {
    if (shown !== null) document.getElementById(`L${shown.top}`)?.scrollIntoView();
  }, [shown]);

  // The table is what is on the page: an anchor for a line a fragment alone can't scroll to.
  useLayoutEffect(() => {
    if (status === "drawn" || position === null || "top" in position) return;
    if (position === taken.current) return;
    document.getElementById(`L${position.line}`)?.scrollIntoView();
  }, [position, status]);
  // Left with the table and a line outside its window: the server picks the window holding it.
  useEffect(() => {
    if (status !== "failed" || shown !== null || position === null || "top" in position) return;
    if (document.getElementById(`L${position.line}`) !== null) return;
    forgetLineEntry();
    globalThis.location.reload();
  }, [position, status, shown]);

  const onResume = useCallback(() => delivery?.resume(), [delivery]);
  const drawn = status === "drawn";
  return (
    <div
      ref={container}
      className="blame-file"
      data-router-commits={routerCommits}
      data-drawn={drawn ? "file" : status === "failed" ? "text" : "waiting"}
      data-blame-status={state?.status ?? "server"}
      data-blame-requests={state?.requests ?? 0}
    >
      <BlameTable
        view={live}
        at={at}
        rows={!drawn}
        selection={selection}
        {...(state !== null && { progress: <Progress state={state} onResume={onResume} /> })}
      />
      {hydrated && drawable && status !== "failed" && text?.kind === "text" && (
        <Fallback onFail={onFail}>
          <Suspense fallback={null}>
            <BlameDrawing
              path={view.path}
              cacheKey={`${view.commit}/${view.path}`}
              text={text.text}
              size={view.size}
              totalLines={view.blame.lines}
              annotations={annotations}
              selection={selection}
              onSelect={select}
              position={position}
              revealed={drawn}
              onStatus={setStatus}
            />
          </Suspense>
        </Fallback>
      )}
    </div>
  );
}
