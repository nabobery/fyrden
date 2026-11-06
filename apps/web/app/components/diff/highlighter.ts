/**
 * Which highlighter the renderers use, kept for the page's life (a
 * session: every file and diff drawn, across the pages it moves between). It starts
 * on Highlights (WebAssembly lexers) in the worker pool when the browser
 * compiles WebAssembly with SIMD and the package loads, else on Shiki's
 * JavaScript engine in the pool. Each failure steps down once: Highlights'
 * pool to Shiki's, Shiki's pool to Shiki on the page's own thread (no
 * workers), and that to plain text. A step suspends drawing first
 * (`current()` is null), so no file draws while the old pool and
 * highlighter are torn down, then draws every file again with the next. A
 * teardown that does not end in time leaves the old highlighter possibly
 * still held, so the session goes plain rather than start another beside
 * it; a step whose preparation fails or does not end in time is passed
 * over to plain too.
 */

import {
  canUseWASM,
  DiffHunksRenderer,
  disposeHighlighter,
  FileRenderer,
  getHighlighterOptions,
  getSharedHighlighter,
} from "@pierre/diffs";
import {
  useWorkerPool,
  type WorkerInitializationRenderOptions,
  type WorkerPoolOptions,
} from "@pierre/diffs/react";
import { terminateWorkerPoolSingleton } from "@pierre/diffs/worker";
import { useEffect } from "react";
import { FJORD_THEME_NAMES } from "../../lib/fjord.js";
import { registerFjordThemes } from "./fjord-themes.client.js";

/** The renderer's highlighters this uses. */
export type Engine = "highlights" | "shiki-js";

export interface Highlighter {
  readonly name: Engine | "plain";
  /** Whether it runs in the worker pool (else on the page's own thread, or not at all). */
  readonly pool: boolean;
  /** Its place in the order of steps (0 first). */
  readonly step: number;
}

const STEPS: readonly Highlighter[] = [
  { name: "highlights", pool: true, step: 0 },
  { name: "shiki-js", pool: true, step: 1 },
  { name: "shiki-js", pool: false, step: 2 },
  { name: "plain", pool: false, step: 3 },
];
const PLAIN = STEPS[3] as Highlighter;

/** How long a teardown, a preparation or the first import may take. */
export const STEP_TIMEOUT_MS = 10_000;

/** Whether `work` succeeds within `ms` (false when it fails or is still running). */
export function within(work: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((done) => {
    const timer = setTimeout(() => done(false), ms);
    work.then(
      () => {
        clearTimeout(timer);
        done(true);
      },
      () => {
        clearTimeout(timer);
        done(false);
      },
    );
  });
}

export interface HighlighterChoice {
  /** The highlighter to draw with; null while one is being chosen or replaced. */
  current(): Highlighter | null;
  subscribe(listener: () => void): () => void;
  /** Sets the first one: Highlights if it can run here, else Shiki. Once. */
  choose(highlights: boolean): void;
  /**
   * Steps down from `step`, which failed: ignored once another step is
   * current (a failure reported twice, or a torn-down pool's), and on the
   * last one.
   */
  fail(step: number): Promise<void>;
}

export function highlighterChoice({
  teardown,
  prepare,
  timeoutMs = STEP_TIMEOUT_MS,
}: {
  /** Ends the failed step's pool and highlighter while nothing draws. */
  teardown: () => Promise<void>;
  /** Readies the next step before anything draws with it. */
  prepare: (next: Highlighter) => Promise<void>;
  timeoutMs?: number;
}): HighlighterChoice {
  let current: Highlighter | null = null;
  let chosen = false;
  const listeners = new Set<() => void>();
  const set = (next: Highlighter | null) => {
    current = next;
    for (const listener of listeners) listener();
  };
  return {
    current: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    choose(highlights) {
      if (chosen) return;
      chosen = true;
      set(STEPS[highlights ? 0 : 1] ?? null);
    },
    async fail(step) {
      const next = STEPS[step + 1];
      if (current?.step !== step || !next) return;
      set(null);
      if (!(await within(teardown(), timeoutMs))) {
        set(PLAIN);
        return;
      }
      set((await within(prepare(next), timeoutMs)) ? next : PLAIN);
    },
  };
}

export const THEMES = { dark: FJORD_THEME_NAMES.dark, light: FJORD_THEME_NAMES.light } as const;
/** Lines longer than this are neither tokenized nor compared word by word (as the renderer's own limit). */
export const MAX_TOKENIZED_LINE = 1000;
/**
 * How long a pool may take to start: its themes and highlighter loaded and its workers
 * started (the pool's own limit, 10 s, covers its workers alone).
 */
const POOL_START_MS = 20_000;

/** What the renderers have in common: where a highlighting failure ends up. */
interface HighlightingRenderer {
  prototype: { cleanUp(): void; onHighlightError(error: unknown): void };
}

/**
 * A file's highlighting that fails in a renderer (a request the worker answers with an
 * error, the page's highlighter failing to load a language) is only logged by it: each
 * such failure steps `choice` down too. Cancellations and disposals never reach it. A
 * renderer gone from the page (its file scrolled away, another page shown, a step's
 * remount) may still see a load it started fail: that is not the current step's failure.
 */
export function stepDownOnFailure(renderer: HighlightingRenderer, choice: HighlighterChoice): void {
  const { prototype } = renderer;
  const gone = new WeakSet<object>();
  const { cleanUp, onHighlightError } = prototype;
  prototype.cleanUp = function (this: object) {
    gone.add(this);
    cleanUp.call(this);
  };
  prototype.onHighlightError = function (this: object, error) {
    onHighlightError.call(this, error);
    const now = choice.current();
    if (now && !gone.has(this)) void choice.fail(now.step);
  };
}

async function startSession(): Promise<HighlighterChoice> {
  registerFjordThemes();
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
  stepDownOnFailure(DiffHunksRenderer as unknown as HighlightingRenderer, choice);
  stepDownOnFailure(FileRenderer as unknown as HighlightingRenderer, choice);
  return choice;
}

let session: Promise<HighlighterChoice> | undefined;
/** The session's one highlighter choice, whichever renderer asks first. Browser only. */
export function sessionHighlighter(): Promise<HighlighterChoice> {
  session ??= startSession();
  return session;
}

/** Each step's pool settings, made once (the pool is built from the first it is given). */
const settings = new Map<
  number,
  { pool: WorkerPoolOptions; highlighter: WorkerInitializationRenderOptions }
>();
export function settingsOf(
  choice: HighlighterChoice,
  workerFactory: () => Worker,
  { name, step }: { name: Engine; step: number },
) {
  let made = settings.get(step);
  if (!made) {
    made = {
      pool: {
        workerFactory,
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
export function PoolWatch({ choice, step }: { choice: HighlighterChoice; step: number }) {
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
  }, [choice, pool, step]);
  return null;
}
