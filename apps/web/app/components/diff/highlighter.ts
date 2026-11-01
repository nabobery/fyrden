/**
 * Which highlighter the diff renderer uses, kept for the page's life (a
 * session: every file drawn, across the pages it moves between). It starts
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
