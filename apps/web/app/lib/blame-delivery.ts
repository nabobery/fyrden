/**
 * The browser's side of blame, apart from React: the ranges of one blamed commit, asked for
 * through the web's ranges route, and the whole text the renderer draws. Its effects come in
 * as `deps`, so a test answers each request and wait itself.
 *
 * Two ways to ask:
 * - **whole**: every settled range from the first, page by page, following the token. A
 *   request walks history only when nothing undelivered is left (the API's rule), so paging
 *   ranges already settled is free.
 * - **window**: the plain view's own lines, asked for again while the blame is partial; each
 *   answer holds every settled range over them, so it replaces the last.
 *
 * A visit makes at most `AUTOMATIC_REQUESTS` requests that may walk on its own, then waits for
 * the viewer to continue; it asks nothing while the tab is hidden.
 */
import { type BlameAnswer, type CommitFacts, decodeBlameBytes, type Range } from "./blame.js";

/** Requests a visit makes on its own that may walk history; Continue allows as many again. */
export const AUTOMATIC_REQUESTS = 8;
/** Ranges asked for in one page: the API's most. */
export const PAGE_RANGES = 5_000;
/** The most text read for the renderer: blame's own file limit. */
export const MAX_TEXT_BYTES = 1024 * 1024;

/** An answer from the ranges route: status 0 when it couldn't be asked at all. */
export interface Answer {
  readonly status: number;
  readonly body: unknown;
  /** The `Retry-After` header, in seconds. */
  readonly retryAfter: number | null;
}

export interface DeliveryDeps {
  ask(query: URLSearchParams, signal: AbortSignal): Promise<Answer>;
  sleep(seconds: number, signal: AbortSignal): Promise<void>;
  visible(): boolean;
  onVisibilityChange(listener: () => void): () => void;
  /** Milliseconds on any steady clock: when an owed wait ends. */
  now(): number;
}

/** The visit's count of requests that may walk, shared by every delivery it starts. */
export class Budget {
  used = 0;
  allowed = AUTOMATIC_REQUESTS;
  get spent(): boolean {
    return this.used >= this.allowed;
  }
  more(): void {
    this.allowed = this.used + AUTOMATIC_REQUESTS;
  }
}

export type DeliveryStatus =
  | "idle"
  | "running"
  /** Waiting the time an answer asked for. */
  | "waiting"
  | "hidden"
  /** The visit's automatic requests are spent: Continue goes on. */
  | "budget"
  | "done"
  /** A request failed: what was delivered stays, and Try again goes on. */
  | "failed"
  /** A refusal (`refusal` names it): final for this commit and path. */
  | "refused";

export interface DeliveryState {
  /** Null until the first answer: until then the server's window is what the page has. */
  readonly ranges: readonly Range[] | null;
  readonly commits: Readonly<Record<string, CommitFacts>>;
  readonly lines: number;
  readonly resolved: number;
  readonly unresolved: number;
  readonly state: BlameAnswer["state"];
  readonly status: DeliveryStatus;
  readonly refusal: string | null;
  /**
   * When a wait a busy answer asked for ends (`deps.now`), still owed because the budget ran
   * out on that answer: Continue waits out what's left of it first.
   */
  readonly owedUntil: number | null;
  /** Requests counted against the visit so far. */
  readonly requests: number;
}

export type DeliveryMode = { kind: "whole" } | { kind: "window"; start: number; end: number };

const REFUSALS = new Set(["file_too_large", "object_limit", "work_limit", "ref_unreadable"]);

export class BlameDelivery {
  readonly #mode: DeliveryMode;
  readonly #budget: Budget;
  readonly #deps: DeliveryDeps;
  readonly #listeners = new Set<() => void>();
  #state: DeliveryState;
  #stop = new AbortController();
  #running = false;
  #unwatch: (() => void) | null = null;
  // Whole-file delivery: the token, and lines delivered since the first range.
  #token: string | null = null;
  #delivered = 0;
  #answered = false;

  constructor({
    mode,
    initial,
    budget,
    deps,
  }: {
    mode: DeliveryMode;
    /**
     * What the page has so far: the loader's counts, and what an earlier delivery of this
     * visit had: its ranges and facts (shown until this one's first answer replaces them), a
     * wait it still owed, and how it ended if it did. A delivery that starts `done` (every
     * range in hand) or `refused` (final for this commit and path) asks nothing.
     */
    initial: Pick<DeliveryState, "lines" | "resolved" | "unresolved" | "state"> &
      Partial<Pick<DeliveryState, "ranges" | "commits" | "owedUntil" | "refusal">> & {
        status?: "done" | "refused";
      };
    budget: Budget;
    deps: DeliveryDeps;
  }) {
    this.#mode = mode;
    this.#budget = budget;
    this.#deps = deps;
    this.#state = {
      lines: initial.lines,
      resolved: initial.resolved,
      unresolved: initial.unresolved,
      state: initial.state,
      ranges: initial.ranges ?? null,
      commits: initial.commits ?? {},
      status: initial.status ?? "idle",
      refusal: initial.status === "refused" ? (initial.refusal ?? null) : null,
      owedUntil: initial.owedUntil ?? null,
      requests: budget.used,
    };
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** The current state: a new object on each change, for `useSyncExternalStore`. */
  snapshot(): DeliveryState {
    return this.#state;
  }

  start(): void {
    this.#unwatch ??= this.#deps.onVisibilityChange(() => {
      if (this.#state.status === "hidden" && this.#deps.visible()) this.#run();
    });
    this.#run();
  }

  /** Continue after the automatic requests, or Try again after a failure. */
  resume(): void {
    if (this.#state.status === "budget") this.#budget.more();
    if (this.#state.status === "budget" || this.#state.status === "failed") this.#run();
  }

  stop(): void {
    this.#stop.abort();
    this.#unwatch?.();
    this.#unwatch = null;
  }

  #set(change: Partial<DeliveryState>): void {
    this.#state = { ...this.#state, ...change, requests: this.#budget.used };
    for (const listener of this.#listeners) listener();
  }

  /**
   * Whether the next request may walk. A window request always may. A whole-file one walks
   * only when nothing undelivered is left, which is known only when fewer lines have been
   * delivered than the API last said were settled, or when the blame is complete. The first
   * request, with no token, may start a run.
   */
  #walks(): boolean {
    if (this.#mode.kind === "window") return true;
    if (this.#token === null || !this.#answered) return true;
    if (this.#state.state === "complete") return false;
    return this.#delivered >= this.#state.resolved + this.#state.unresolved;
  }

  #query(): URLSearchParams {
    if (this.#mode.kind === "window")
      return new URLSearchParams({
        line_start: String(this.#mode.start),
        line_end: String(this.#mode.end),
      });
    const query = new URLSearchParams({ per_page: String(PAGE_RANGES) });
    if (this.#token !== null) query.set("continuation", this.#token);
    return query;
  }

  /** One loop at a time: a resume or a shown tab while it runs is the same loop. */
  #run(): void {
    if (this.#running || this.#stop.signal.aborted) return;
    if (this.#state.status === "done" || this.#state.status === "refused") return;
    this.#running = true;
    void this.#loop().finally(() => {
      this.#running = false;
    });
  }

  async #loop(): Promise<void> {
    const signal = this.#stop.signal;
    for (;;) {
      if (signal.aborted) return;
      if (!this.#deps.visible()) return this.#set({ status: "hidden" });
      const walks = this.#walks();
      if (walks && this.#budget.spent) return this.#set({ status: "budget" });
      // A wait still owed comes before the request it was owed for, once the budget allows one.
      // It stays owed until waited out, so a delivery replacing this one mid-wait owes it too.
      if (this.#state.owedUntil !== null) {
        const left = this.#state.owedUntil - this.#deps.now();
        if (left > 0) await this.#wait(left / 1000, signal);
        if (signal.aborted) return;
        this.#set({ owedUntil: null });
        continue;
      }
      if (walks) this.#budget.used++;
      this.#set({ status: "running" });
      let answer: Answer;
      try {
        answer = await this.#deps.ask(this.#query(), signal);
      } catch {
        answer = { status: 0, body: null, retryAfter: null };
      }
      if (signal.aborted) return;
      const problem = (answer.body ?? {}) as { code?: string; retry_after?: number };
      if (answer.status === 200) {
        // Anything but a blame (a body that didn't parse, another shape) is a failure.
        if (!isBlame(answer.body)) return this.#set({ status: "failed" });
        const wait = this.#take(answer.body);
        if (this.#state.status === "done") return;
        if (wait !== undefined) await this.#wait(wait, signal);
        continue;
      }
      if (answer.status === 503 && problem.code === "blame_busy") {
        // A busy answer counts, even to a request that would only have paged; once the
        // budget is spent on it, the wait it asked for is owed to whoever continues.
        if (!walks) this.#budget.used++;
        const wait = problem.retry_after ?? answer.retryAfter ?? 1;
        if (this.#budget.spent)
          return this.#set({ status: "budget", owedUntil: this.#deps.now() + wait * 1000 });
        await this.#wait(wait, signal);
        continue;
      }
      if (answer.status === 409 && problem.code === "blame_restarted") {
        this.#token = null;
        this.#delivered = 0;
        this.#answered = false;
        this.#set({ ranges: [], commits: {} });
        continue;
      }
      if (answer.status === 422 && problem.code !== undefined && REFUSALS.has(problem.code))
        return this.#set({ status: "refused", refusal: problem.code });
      return this.#set({ status: "failed" });
    }
  }

  /** Takes an answer in; the seconds to wait before the next request, if it asks for any. */
  #take(body: BlameAnswer): number | undefined {
    const counts = {
      lines: body.lines,
      resolved: body.resolved_lines,
      unresolved: body.unresolved_lines,
      state: body.state,
      commits: { ...this.#state.commits, ...body.commits },
    };
    this.#answered = true;
    if (this.#mode.kind === "window") {
      this.#set({
        ...counts,
        ranges: body.ranges,
        status: body.state === "complete" ? "done" : "running",
      });
    } else {
      this.#token = body.next_continuation;
      for (const range of body.ranges) this.#delivered += range.line_count;
      this.#set({
        ...counts,
        ranges: [...(this.#state.ranges ?? []), ...body.ranges],
        status: body.next_continuation === null ? "done" : "running",
      });
    }
    return body.retry_after_seconds;
  }

  async #wait(seconds: number, signal: AbortSignal): Promise<void> {
    this.#set({ status: "waiting" });
    await this.#deps.sleep(seconds, signal);
  }
}

/** Whether a 200's body has the shape of a blame answer: what the delivery reads of it. */
function isBlame(body: unknown): body is BlameAnswer {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  return (
    Array.isArray(b.ranges) &&
    typeof b.lines === "number" &&
    typeof b.resolved_lines === "number" &&
    typeof b.unresolved_lines === "number" &&
    (b.state === "complete" || b.state === "partial") &&
    typeof b.commits === "object" &&
    b.commits !== null &&
    (b.next_continuation === null || typeof b.next_continuation === "string")
  );
}

export type WholeText =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "binary" | "undecodable" | "too-large" | "failed" };

/**
 * A raw answer's bytes as blame's text, read only up to blame's 1 MiB: an answer that says
 * it's larger isn't read at all, and one that turns out larger is cancelled as it passes.
 */
export async function readBlameText(response: Response, signal: AbortSignal): Promise<WholeText> {
  if (!response.ok) {
    await response.body?.cancel();
    return { kind: "failed" };
  }
  if (Number(response.headers.get("Content-Length")) > MAX_TEXT_BYTES) {
    await response.body?.cancel();
    return { kind: "too-large" };
  }
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    if (signal.aborted) {
      await reader?.cancel();
      return { kind: "failed" };
    }
    const next = await reader?.read();
    if (!next || next.done) break;
    size += next.value.length;
    if (size > MAX_TEXT_BYTES) {
      await reader?.cancel();
      return { kind: "too-large" };
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return decodeBlameBytes(bytes);
}
