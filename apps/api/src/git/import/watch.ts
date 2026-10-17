import type { FetchPackSink, HttpTransport } from "@fyrden/git-core";

/*
 * How long an import waits on its source. The fetch runs in the repository
 * object, which stays active, and billed for its duration, while it awaits
 * the source (verified: a Durable Object "remains active while ... pending
 * I/O is in flight", developers.cloudflare.com/queues/platform/limits/), so
 * a source that stalls or trickles is stopped long before the overall limit:
 *
 *   discovery  connecting and listing the refs must finish in `discoveryMs`
 *   transfer   the source must send something at least every `idleMs` (any
 *              bytes: git's keepalives while it prepares the pack count) and,
 *              once the transfer's first `GRACE_MS` are over, the pack must
 *              bring at least `minBytesPerSecond` over every `WINDOW_MS`
 *              (pack bytes only, not progress or empty frames): a pack of B
 *              bytes holds the object for about
 *              GRACE_MS + WINDOW_MS + B / minBytesPerSecond at most
 *   overall    the whole fetch must finish in `maxMs`
 *
 * The watch checks every `TICK_MS`. A source too slow has its requests
 * aborted through their signal (as the overall limit always was: `fetch`
 * rejects, and its body stops, once its signal aborts), and its pack stops
 * at the next chunk. Once the fetch is over the signal is aborted too, so no
 * response the client stopped reading (it stops at git's flush, not at the
 * body's end) stays open.
 */

export interface ImportPace {
  readonly maxMs: number;
  readonly discoveryMs: number;
  readonly idleMs: number;
  /** 0 for no floor. */
  readonly minBytesPerSecond: number;
}

/** The watch's time; tests move it by hand. */
export interface WatchClock {
  now(): number;
  /** Calls `tick` every `ms` until the returned function is called. */
  every(ms: number, tick: () => void): () => void;
}

export const systemClock: WatchClock = {
  now: () => Date.now(),
  every: (ms, tick) => {
    const timer = setInterval(tick, ms);
    return () => clearInterval(timer);
  },
};

/** How often the watch checks. Proposed. */
const TICK_MS = 5_000;
/** How long a pack may take to reach the floor (a server may prepare it a while). Proposed. */
const GRACE_MS = 120_000;
/** The span the floor is measured over. Proposed. */
const WINDOW_MS = 60_000;

/** The source was too slow; the message names the limit it broke. */
export class SourceTooSlowError extends Error {
  override name = "SourceTooSlowError";
}

type Phase = "discovery" | "transfer";

export class TransferWatch {
  readonly #controller = new AbortController();
  readonly #started: number;
  readonly #stop: () => void;
  #phase: { readonly kind: Phase; readonly since: number } | undefined;
  /** Pack bytes handed to the sink. */
  #packBytes = 0;
  /** When the source last sent anything. */
  #lastByteAt = 0;
  /** Pack byte counts at each tick of the transfer, the oldest the last one at least a window back. */
  #samples: { readonly at: number; readonly bytes: number }[] = [];

  constructor(
    private readonly pace: ImportPace,
    private readonly clock: WatchClock,
  ) {
    this.#started = clock.now();
    this.#stop = clock.every(TICK_MS, () => this.#tick());
  }

  /**
   * Aborted once the source is too slow, its reason a `SourceTooSlowError`,
   * and once the fetch is over (`stop`).
   */
  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  /** `inner`, noting when its responses last brought bytes, and stopped once the watch trips. */
  transport(inner: HttpTransport): HttpTransport {
    return async (request) => {
      const response = await inner(request);
      const watch = this;
      return {
        ...response,
        body: {
          async *[Symbol.asyncIterator]() {
            for await (const chunk of response.body) {
              watch.signal.throwIfAborted();
              watch.#lastByteAt = watch.clock.now();
              yield chunk;
            }
          },
        },
      };
    };
  }

  /** `inner`, the pack bytes it is given counted. */
  sink(inner: FetchPackSink): FetchPackSink {
    return {
      write: async (chunk) => {
        this.#packBytes += chunk.length;
        await inner.write(chunk);
      },
    };
  }

  /** Runs one phase of the fetch; a failure once the watch has tripped is the trip's. */
  async run<T>(phase: Phase, work: () => Promise<T>): Promise<T> {
    this.signal.throwIfAborted();
    const now = this.clock.now();
    this.#phase = { kind: phase, since: now };
    this.#lastByteAt = now;
    this.#samples = [{ at: now, bytes: this.#packBytes }];
    try {
      return await work();
    } catch (error) {
      throw this.signal.aborted ? this.signal.reason : error;
    } finally {
      this.#phase = undefined;
    }
  }

  /**
   * Stops checking and aborts the signal, which cancels any response still
   * open; call once the fetch is over.
   */
  stop(): void {
    this.#stop();
    this.#controller.abort(new DOMException("the import's fetch is over", "AbortError"));
  }

  #tick(): void {
    const broken = this.#brokenLimit(this.clock.now());
    if (broken === undefined) return;
    this.#stop();
    this.#controller.abort(new SourceTooSlowError(`the source took too long${broken}`));
  }

  /** The limit the source broke by `now`, as the end of the failure's message. */
  #brokenLimit(now: number): string | undefined {
    const { pace } = this;
    if (now - this.#started >= pace.maxMs) return "";
    const phase = this.#phase;
    if (!phase) return undefined;
    if (phase.kind === "discovery")
      return now - phase.since >= pace.discoveryMs
        ? `: it did not list its branches and tags within ${seconds(pace.discoveryMs)} s`
        : undefined;
    if (now - this.#lastByteAt >= pace.idleMs)
      return `: it sent nothing for ${seconds(pace.idleMs)} s`;
    // The floor: the pack bytes since the latest sample at least a window old.
    this.#samples.push({ at: now, bytes: this.#packBytes });
    while ((this.#samples[1]?.at ?? now) <= now - WINDOW_MS) this.#samples.shift();
    const since = this.#samples[0];
    if (
      pace.minBytesPerSecond > 0 &&
      since !== undefined &&
      now - phase.since >= GRACE_MS &&
      since.at <= now - WINDOW_MS &&
      this.#packBytes - since.bytes < (pace.minBytesPerSecond * (now - since.at)) / 1000
    )
      return `: it sent less than ${kib(pace.minBytesPerSecond)} KiB/s for a minute`;
    return undefined;
  }
}

const seconds = (ms: number) => Math.round(ms / 100) / 10;
const kib = (bytes: number) => Math.round(bytes / 102.4) / 10;
