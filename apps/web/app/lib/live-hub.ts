import type { LiveBudgetPause, LiveStream } from "./live.js";

/**
 * A tab's live hints, kept across its pages: one socket for the tab while
 * a page listens and the tab is shown, so going from page to page spends
 * no new admission (the server allows a principal 60 a day). Pages say
 * which streams they show; a hint for one of them, or a (re)connect, reads
 * the current page again: one read at a time, hint-driven reads at least
 * `readGapMs` apart, none during a navigation or while hidden (held, and
 * read then if the page shown wants them). The socket is let go a while
 * after the last page stops listening, or after the tab is hidden a while.
 * Off, signed out or revoked, it stays stopped; failing, it is tried again
 * after a pause. Refused for today, it opens nothing until the time given,
 * whatever the tab does, then again only if a page shown wants it, spread
 * over a few minutes. What it tells the viewer is its `status()`.
 */

export const LIVE_HUB = {
  /** Hint-driven reads at least this far apart (a connect's read is at once). */
  readGapMs: 10_000,
  /** How long the socket outlasts the last page listening (a navigation's gap). */
  lingerMs: 60_000,
  /** How long a hidden tab keeps its socket. */
  hiddenMs: 5 * 60_000,
  /** After failing for good it is tried again between half this and all of it (when shown or a page listens). */
  failedPauseMs: 10 * 60_000,
  /** How long a tab remembers that the deployment sends no live hints. */
  offForMs: 60 * 60_000,
  /**
   * How far past a daily pause's end it starts again: between half this
   * and all of it, so tabs paused together do not all ask at once.
   */
  resumeSpreadMs: 5 * 60_000,
} as const;

type Stop = "off" | "stop" | "revoked" | "failing";
type Timer = "linger" | "hidden" | "read" | "failed" | "resume";

/** What the viewer is told: nothing, paused until a time, or refused for now and retrying. */
export type LiveStatus =
  | { readonly kind: "live" }
  | { readonly kind: "paused"; readonly retryAt: number }
  | { readonly kind: "temporary" };

const LIVE: LiveStatus = { kind: "live" };
const TEMPORARY: LiveStatus = { kind: "temporary" };

/** What a client tells the hub. */
export interface LiveHubEvents {
  changed(streams: readonly LiveStream[] | "all"): void;
  stopped(why: Stop): void;
  paused(pause: LiveBudgetPause): void;
  temporary(refused: boolean): void;
}

export interface LiveHubDeps {
  /** A client whose hints, stops and refusals come to the hub. */
  client(events: LiveHubEvents): { start(): void; stop(): void };
  hidden(): boolean;
  /** No navigation under way. */
  idle(): boolean;
  /** Reads the current page again. */
  revalidate(): Promise<unknown>;
  /** When the tab was last told live hints are off (0: never), and to record it. */
  offSince(): number;
  markOff(at: number): void;
  /** The viewer's daily pause the tab kept, and to keep it (null: let it go). */
  pausedUntil(): LiveBudgetPause | null;
  markPaused(pause: LiveBudgetPause | null): void;
  now(): number;
  random(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export class LiveHub {
  readonly #deps: LiveHubDeps;
  readonly #client: { start(): void; stop(): void };
  readonly #wants = new Set<{ current: (stream: LiveStream) => boolean }>();
  #running = false;
  /** Stopped for good (off is kept apart, by its time). */
  #halted = false;
  #failedUntil: number | null = null;
  /** When this tab was told live hints are off (beside the tab's storage, which may fail). */
  #offAt = 0;
  /** Refused for today: nothing starts until the "resume" timer clears it. */
  #pause: LiveBudgetPause | null = null;
  #temporary = false;
  #status: LiveStatus = LIVE;
  readonly #watchers = new Set<() => void>();
  /** Hints held for a read: everything, or these streams (checked against the page read). */
  #pendingAll = false;
  #pendingStreams: LiveStream[] = [];
  #reading = false;
  #lastRead = Number.NEGATIVE_INFINITY;
  #disposed = false;
  #timers = new Map<Timer, unknown>();

  constructor(deps: LiveHubDeps) {
    this.#deps = deps;
    this.#client = deps.client({
      changed: (streams) => this.#changed(streams),
      stopped: (why) => this.#stopped(why),
      paused: (pause) => this.#paused(pause),
      temporary: (refused) => {
        this.#temporary = refused;
        this.#tell();
      },
    });
    const kept = deps.pausedUntil();
    if (kept) this.#pauseUntil(kept);
  }

  /** What the viewer is told now (the same object until it changes). */
  status(): LiveStatus {
    return this.#status;
  }

  /** Calls `watcher` whenever the status changes; the returned function stops it. */
  watch(watcher: () => void): () => void {
    this.#watchers.add(watcher);
    return () => {
      this.#watchers.delete(watcher);
    };
  }

  /** A page's interest, kept current through `wants.current`; the returned function ends it. */
  listen(wants: { current: (stream: LiveStream) => boolean }): () => void {
    this.#wants.add(wants);
    this.#clear("linger");
    this.#update();
    return () => {
      this.#wants.delete(wants);
      if (this.#wants.size > 0) return;
      // Nothing listens: what was held is no page's (the next reads itself on arriving).
      this.#forget();
      this.#set("linger", LIVE_HUB.lingerMs, () => this.#update());
    };
  }

  /** The tab was shown or hidden. */
  visibility(): void {
    this.#clear("hidden");
    if (this.#deps.hidden()) {
      this.#set("hidden", LIVE_HUB.hiddenMs, () => this.#update());
      return;
    }
    this.#update();
    this.#read();
  }

  /** A navigation finished: a read held for it goes now. */
  settled(): void {
    this.#read();
  }

  dispose(): void {
    this.#disposed = true;
    this.#watchers.clear();
    for (const name of [...this.#timers.keys()]) this.#clear(name);
    this.#stopClient();
  }

  /** Starts or stops the socket for what the tab is doing now. */
  #update(): void {
    if (this.#disposed) return;
    const now = this.#deps.now();
    const off = Math.max(this.#offAt, this.#deps.offSince());
    const wanted =
      (this.#wants.size > 0 || this.#timers.has("linger")) &&
      (!this.#deps.hidden() || this.#timers.has("hidden")) &&
      !this.#halted &&
      this.#pause === null &&
      (off === 0 || now - off >= LIVE_HUB.offForMs) &&
      (this.#failedUntil === null || now >= this.#failedUntil);
    if (wanted && !this.#running) {
      this.#running = true;
      this.#failedUntil = null;
      this.#client.start();
    } else if (!wanted && this.#running) this.#stopClient();
  }

  #stopClient(): void {
    this.#running = false;
    this.#client.stop();
  }

  #stopped(why: Stop): void {
    this.#running = false;
    const now = this.#deps.now();
    if (why === "off") {
      this.#offAt = now;
      this.#deps.markOff(now);
    } else if (why === "failing") {
      const pause = Math.round(LIVE_HUB.failedPauseMs * (0.5 + this.#deps.random() / 2));
      this.#failedUntil = now + pause;
      // Tried again after the pause, whether or not anything happens in the tab.
      this.#set("failed", pause, () => this.#update());
    } else this.#halted = true;
    // Failing, it is tried again: a refusal for now still holds.
    if (why !== "failing") this.#temporary = false;
    this.#tell();
  }

  #paused(pause: LiveBudgetPause): void {
    this.#running = false;
    this.#deps.markPaused(pause);
    this.#pauseUntil(pause);
  }

  /** Nothing starts until `pause` ends (a failure's retry neither), then only if wanted. */
  #pauseUntil(pause: LiveBudgetPause): void {
    this.#pause = pause;
    this.#temporary = false;
    this.#failedUntil = null;
    this.#clear("failed");
    const late = Math.round(LIVE_HUB.resumeSpreadMs * (0.5 + this.#deps.random() / 2));
    this.#set("resume", Math.max(0, pause.retryAt - this.#deps.now()) + late, () => {
      this.#pause = null;
      this.#deps.markPaused(null);
      this.#tell();
      // Only for a page shown that listens (not for a hidden tab's or a navigation's grace).
      if (!this.#deps.hidden() && this.#wants.size > 0) this.#update();
    });
    this.#tell();
  }

  /** The status for what holds now, its watchers called when it changed. */
  #tell(): void {
    const pause = this.#pause;
    const status: LiveStatus = pause
      ? this.#status.kind === "paused" && this.#status.retryAt === pause.retryAt
        ? this.#status
        : { kind: "paused", retryAt: pause.retryAt }
      : this.#temporary
        ? TEMPORARY
        : LIVE;
    if (status === this.#status) return;
    this.#status = status;
    for (const watcher of [...this.#watchers]) watcher();
  }

  #changed(streams: readonly LiveStream[] | "all"): void {
    if (this.#wants.size === 0) return;
    if (streams === "all") this.#pendingAll = true;
    else if (this.#pendingStreams.length + streams.length > 100) this.#pendingAll = true;
    else this.#pendingStreams.push(...streams);
    this.#read();
  }

  #forget(): void {
    this.#pendingAll = false;
    this.#pendingStreams = [];
    this.#clear("read");
  }

  #read(): void {
    if (this.#disposed || this.#reading) return;
    if (this.#deps.hidden() || !this.#deps.idle()) return;
    // Checked against the page shown now: a hint held through a navigation may be another's.
    const wanted =
      this.#pendingAll ||
      this.#pendingStreams.some((s) => [...this.#wants].some((w) => w.current(s)));
    if (!wanted) {
      this.#forget();
      return;
    }
    const wait = this.#pendingAll ? 0 : this.#lastRead + LIVE_HUB.readGapMs - this.#deps.now();
    if (wait > 0) {
      if (!this.#timers.has("read")) this.#set("read", wait, () => this.#read());
      return;
    }
    this.#forget();
    this.#reading = true;
    this.#lastRead = this.#deps.now();
    void this.#deps
      .revalidate()
      .catch(() => undefined)
      .finally(() => {
        this.#reading = false;
        this.#read();
      });
  }

  #set(name: Timer, ms: number, fn: () => void): void {
    this.#clear(name);
    this.#timers.set(
      name,
      this.#deps.setTimer(() => {
        this.#timers.delete(name);
        fn();
      }, ms),
    );
  }

  #clear(name: Timer): void {
    const handle = this.#timers.get(name);
    if (handle === undefined) return;
    this.#timers.delete(name);
    this.#deps.clearTimer(handle);
  }
}
