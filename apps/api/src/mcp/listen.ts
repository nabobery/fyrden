import { SERVER_INFO_META_KEY, SUBSCRIPTION_ID_META_KEY } from "@modelcontextprotocol/server";
import { LIVE_POLICY } from "../do/user/live.js";

/*
 * MCP feed push (2026-07-28 `subscriptions/listen`): a listen stream of the
 * caller's feed resource is served by Fyrden itself (once the SDK found the
 * request valid), bridged to one live socket of the feed's object that is
 * opened before the stream is acknowledged, so a client that reads the
 * feed after the acknowledgement misses nothing. Each frame the socket sends
 * (`{"t":"changed",…}`: streams the credential may read now changed) is a
 * hint: `notifications/resources/updated` for the feed's URI, one pending at
 * most (later frames fold into it); what changed is not told.
 *
 * The stream is pulled: a message is made only when the client's side reads,
 * so the Worker holds at most one, of bounded size. A hint taken by the
 * client acknowledges the frames it covers (every half window, within the
 * socket's control budgets), so a client that stops reading fills the
 * socket's window and the object's slow-consumer deadline closes it. The
 * bridge renews the socket before its deadline (again a minute later if
 * unanswered), sends keepalive comments, and ends the stream gracefully
 * (the `subscriptions/listen` result) when the socket closes, before the
 * socket's controls run out, and at the stream's longest life: the client
 * listens again, then reads again. Closing the stream closes the socket.
 */

export const LISTEN_POLICY = {
  /** Keepalive comments while nothing else is sent (the stream spike's 25 s). */
  keepaliveMs: 25_000,
  /** A stream's longest life (then it ends: listen again). */
  lifeMs: 2 * 60 * 60_000,
  /** A listen request id's JSON at most (it is stamped on every message). */
  idBytes: 256,
  /** Frames a hint covers before they are acknowledged (half the socket's window). */
  ackEvery: LIVE_POLICY.window / 2,
  /** Controls kept for renewals: within a minute, and in the socket's life. */
  renewReserveMinute: 2,
  renewReserveLife: 4,
  /** How long an unanswered renewal waits before it is sent again. */
  renewRetryMs: 60_000,
  /** How far past the socket's renewal threshold a renewal is sent (the object's clock leads). */
  renewMarginMs: 30_000,
} as const;

/** The feed's resource template and a principal's feed URI. */
export const FEED_RESOURCE_TEMPLATE = "fyrden://feed/{principal}";
export const feedResourceUri = (principalId: string) => `fyrden://feed/${principalId}`;

export type ListenId = string | number;

/** A `subscriptions/listen` request's id and the resource URIs it asks for, when the body is one. */
export function listenRequest(
  body: unknown,
): { readonly id: ListenId; readonly uris: readonly string[] } | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const message = body as { method?: unknown; id?: unknown; params?: unknown };
  if (message.method !== "subscriptions/listen") return null;
  if (typeof message.id !== "string" && typeof message.id !== "number") return null;
  const notifications = (message.params as { notifications?: unknown } | undefined)?.notifications;
  const uris = (notifications as { resourceSubscriptions?: unknown } | undefined)
    ?.resourceSubscriptions;
  return {
    id: message.id,
    uris: Array.isArray(uris) ? uris.filter((u): u is string => typeof u === "string") : [],
  };
}

/** What a stream needs of the socket: a WebSocket, or a test's stand-in. */
export interface ListenSocket {
  send(message: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "message", handler: (event: { data: unknown }) => void): void;
  addEventListener(type: "close" | "error", handler: () => void): void;
}

/** Time and repetition (the Worker's own; a test's by hand). */
export interface ListenClock {
  now(): number;
  /** Calls `tick` every `ms` until the returned function is called. */
  every(ms: number, tick: () => void): () => void;
}

export const workerClock: ListenClock = {
  now: () => Date.now(),
  every: (ms, tick) => {
    const timer = setInterval(tick, ms);
    return () => clearInterval(timer);
  },
};

export interface ListenStreamOptions {
  readonly id: ListenId;
  readonly serverInfo: { readonly name: string; readonly version: string };
  /** The feed's URI, when the stream serves it with `socket`; none: acknowledged empty, ended. */
  readonly feed?: {
    readonly uri: string;
    readonly socket: ListenSocket;
    /** The socket's renewal deadline when it was opened. */
    readonly deadline: number;
  };
  readonly clock?: ListenClock;
  /** The request's: a client gone before its stream was read lets the socket go. */
  readonly signal?: AbortSignal;
}

/**
 * One listen stream: its SSE body. Without a feed it is acknowledged with
 * nothing honored and ends at once.
 */
export class ListenStream {
  readonly readable: ReadableStream<Uint8Array>;
  readonly #id: ListenId;
  readonly #serverInfo: ListenStreamOptions["serverInfo"];
  readonly #feed: ListenStreamOptions["feed"];
  readonly #clock: ListenClock;
  readonly #encoder = new TextEncoder();
  readonly #openedAt: number;
  #acknowledged = false;
  /** The latest frame heard, and the latest a hint the client took covered. */
  #heard = 0;
  #taken = 0;
  #acked = 0;
  #keepaliveDue = false;
  /** A renewal answered: a hint to read again, which nothing acknowledges (the object passes
   * over changes whose access it could not decide; readers read again on renewal). */
  #refresh = false;
  #ending = false;
  #done = false;
  #cancelled = false;
  #deadline: number;
  #renewSentAt: number | null = null;
  /** Controls sent: in the socket's life, and their times within the last minute. */
  #controls = 0;
  #recent: number[] = [];
  #stopTicks: (() => void) | null = null;
  #wake: (() => void) | null = null;
  #controller: ReadableStreamDefaultController<Uint8Array> | null = null;

  constructor(options: ListenStreamOptions) {
    this.#id = options.id;
    this.#serverInfo = options.serverInfo;
    this.#feed = options.feed;
    this.#clock = options.clock ?? workerClock;
    this.#openedAt = this.#clock.now();
    this.#deadline = options.feed?.deadline ?? 0;
    if (!this.#feed) this.#ending = true;
    else {
      this.#feed.socket.addEventListener("message", (event) => this.#frame(event.data));
      this.#feed.socket.addEventListener("close", () => this.#end(false));
      this.#feed.socket.addEventListener("error", () => this.#end(false));
    }
    // The request aborted: the body is let go too (a read waiting on it ends).
    options.signal?.addEventListener(
      "abort",
      () => {
        this.#cancel();
        try {
          this.#controller?.close();
        } catch {}
      },
      { once: true },
    );
    this.readable = new ReadableStream<Uint8Array>(
      {
        // Ticks start once the stream is read: a response never sent renews nothing, and its
        // socket closes at its deadline.
        start: (controller) => {
          this.#controller = controller;
        },
        pull: async (controller) => {
          if (this.#cancelled) return;
          if (this.#feed && !this.#stopTicks && !this.#ending)
            this.#stopTicks = this.#clock.every(LISTEN_POLICY.keepaliveMs, () => this.#tick());
          for (;;) {
            if (this.#cancelled) return;
            const message = this.#next();
            if (message !== null) {
              controller.enqueue(this.#encoder.encode(message));
              if (this.#done) {
                controller.close();
                this.#release();
              }
              return;
            }
            await new Promise<void>((resolve) => {
              this.#wake = resolve;
            });
          }
        },
        cancel: () => this.#cancel(),
      },
      // Nothing is made ahead of a read.
      new CountQueuingStrategy({ highWaterMark: 0 }),
    );
  }

  /** The next message to send, in order: the acknowledgement, a hint, the end, a keepalive. */
  #next(): string | null {
    if (!this.#acknowledged) {
      this.#acknowledged = true;
      return this.#event({
        jsonrpc: "2.0",
        method: "notifications/subscriptions/acknowledged",
        params: {
          notifications: this.#feed ? { resourceSubscriptions: [this.#feed.uri] } : {},
          _meta: { [SUBSCRIPTION_ID_META_KEY]: this.#id },
        },
      });
    }
    if (this.#feed && (this.#heard > this.#taken || this.#refresh)) {
      this.#refresh = false;
      if (this.#heard > this.#taken) {
        this.#taken = this.#heard;
        this.#acknowledge();
      }
      return this.#event({
        jsonrpc: "2.0",
        method: "notifications/resources/updated",
        params: { uri: this.#feed.uri, _meta: { [SUBSCRIPTION_ID_META_KEY]: this.#id } },
      });
    }
    if (this.#ending) {
      this.#done = true;
      return this.#event({
        jsonrpc: "2.0",
        id: this.#id,
        result: {
          resultType: "complete",
          _meta: {
            [SUBSCRIPTION_ID_META_KEY]: this.#id,
            [SERVER_INFO_META_KEY]: this.#serverInfo,
          },
        },
      });
    }
    if (this.#keepaliveDue) {
      this.#keepaliveDue = false;
      return ": keepalive\n\n";
    }
    return null;
  }

  #event(message: unknown): string {
    return `event: message\ndata: ${JSON.stringify(message)}\n\n`;
  }

  #frame(data: unknown): void {
    if (this.#ending || typeof data !== "string") return;
    let frame: { t?: unknown; n?: unknown; until?: unknown };
    try {
      frame = JSON.parse(data) as typeof frame;
    } catch {
      return;
    }
    if (frame.t === "changed" && typeof frame.n === "number" && frame.n > this.#heard) {
      this.#heard = frame.n;
      this.#poke();
    } else if (frame.t === "renewed" && typeof frame.until === "number") {
      this.#deadline = frame.until;
      this.#renewSentAt = null;
      this.#refresh = true;
      this.#poke();
    }
  }

  /** Acknowledges what the client took, every half window, while the minute's controls allow. */
  #acknowledge(): void {
    if (this.#taken - this.#acked < LISTEN_POLICY.ackEvery) return;
    if (!this.#control(LISTEN_POLICY.renewReserveMinute, LISTEN_POLICY.renewReserveLife)) return;
    this.#acked = this.#taken;
    this.#send({ t: "ack", n: this.#acked });
  }

  #tick(): void {
    if (this.#ending) return;
    const now = this.#clock.now();
    // At its longest life, or its controls nearly spent (before the object closes it for them).
    if (
      now - this.#openedAt >= LISTEN_POLICY.lifeMs ||
      this.#controls >= LIVE_POLICY.controlsLife - LISTEN_POLICY.renewReserveLife
    ) {
      this.#end(true);
      return;
    }
    this.#acknowledge();
    const due = now >= this.#deadline - LIVE_POLICY.renewMs / 2 + LISTEN_POLICY.renewMarginMs;
    const waiting =
      this.#renewSentAt !== null && now - this.#renewSentAt < LISTEN_POLICY.renewRetryMs;
    if (due && !waiting && this.#control(0, 0)) {
      this.#renewSentAt = now;
      this.#send({ t: "renew" });
    }
    this.#keepaliveDue = true;
    this.#poke();
  }

  /** Whether a control may be sent now, keeping `minute` and `life` of the budgets; counts it. */
  #control(minute: number, life: number): boolean {
    const now = this.#clock.now();
    this.#recent = this.#recent.filter((at) => now - at < 60_000);
    if (this.#recent.length >= LIVE_POLICY.controlsPerMinute - minute) return false;
    if (this.#controls >= LIVE_POLICY.controlsLife - life) return false;
    this.#recent.push(now);
    this.#controls++;
    return true;
  }

  #send(message: unknown): void {
    if (this.#done) return;
    try {
      this.#feed?.socket.send(JSON.stringify(message));
    } catch {
      this.#end(false);
    }
  }

  /** The stream ends (gracefully, after a pending hint); `closeSocket`: the bridge closes it. */
  #end(closeSocket: boolean): void {
    if (this.#ending) return;
    this.#ending = true;
    this.#stopTicking();
    if (closeSocket) this.#closeSocket();
    this.#poke();
  }

  /** The client is gone: nothing more is made, the socket closed. */
  #cancel(): void {
    this.#cancelled = true;
    this.#done = true;
    this.#release();
  }

  #stopTicking(): void {
    this.#stopTicks?.();
    this.#stopTicks = null;
  }

  #poke(): void {
    const wake = this.#wake;
    this.#wake = null;
    wake?.();
  }

  #closeSocket(): void {
    try {
      this.#feed?.socket.close(1000, "done");
    } catch {}
  }

  /** Done (ended and read, or cancelled): ticks stopped, the socket closed. */
  #release(): void {
    this.#stopTicking();
    this.#closeSocket();
    this.#poke();
  }
}
