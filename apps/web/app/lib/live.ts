/**
 * The browser's side of live hints: a socket that says which of the
 * viewer's feed and inbox streams changed, so a page reads them again. It
 * renders nothing from a hint. One `LiveClient` keeps one socket: it asks
 * for a ticket, opens the socket, refreshes once on every (re)connect,
 * acknowledges frames cumulatively, renews before the deadline, and
 * reconnects with back-off, within the server's control allowance (20 a
 * minute, 200 a socket's life, renewals kept room for). Everything it
 * needs from the browser is passed in, so it runs under test as it does
 * in a page.
 */

/** A stream that changed: a repository's issues or pull requests. */
export interface LiveStream {
  readonly repo: string;
  readonly kind: "issue" | "pull";
}

/** What asking for a ticket answered. */
export type LiveTicket =
  | { readonly kind: "ticket"; readonly url: string }
  /** The deployment sends no live hints. */
  | { readonly kind: "off" }
  /** Not signed in, or not allowed: no point asking again. */
  | { readonly kind: "stop" }
  /** Refused for now (a limit, an outage): ask again later. */
  | { readonly kind: "retry" };

/** The socket as the client drives it (a browser `WebSocket` adapts to it). */
export interface LiveSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface LiveSocketEvents {
  open(): void;
  message(data: string): void;
  close(code: number): void;
}

export interface LiveDeps {
  ticket(): Promise<LiveTicket>;
  open(url: string, events: LiveSocketEvents): LiveSocket;
  /** Streams changed (`"all"`: read everything again: a connect, or too many to name). */
  changed(streams: readonly LiveStream[] | "all"): void;
  /** The client stopped for good (off, signed out, revoked, or failing). */
  stopped?(why: "off" | "stop" | "revoked" | "failing"): void;
  now(): number;
  random(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export const LIVE_CLIENT = {
  /** Acknowledge once this many frames are unacknowledged (the server holds 8). */
  ackFrames: 4,
  /**
   * Or this long after the first unacknowledged one: the server holds frames
   * only once 8 are unacknowledged, and each acknowledgement spends one of
   * the socket's 200 controls (past them a new socket, a new admission).
   */
  ackAfterMs: 60_000,
  /** The server's renewal period, and how long before its deadline to renew. */
  renewMs: 10 * 60_000,
  renewBeforeMs: 90_000,
  /** How long to wait for `renewed` before asking again. */
  renewRetryMs: 30_000,
  /** The server's control allowance: a minute's, and a socket's life's. */
  controlsPerMinute: 20,
  controlsLife: 200,
  /**
   * Kept below a minute's allowance: for renewals, and one for the server's
   * window starting where this one does not.
   */
  renewReserveMinute: 2,
  minuteMargin: 1,
  /** Kept of the life's allowance for renewals (a new socket comes before it). */
  renewReserveLife: 20,
  /** How long a socket stays open before its close no longer counts as a failure. */
  stableMs: 60_000,
  /** Back-off between failed connections, and how many in a row before giving up. */
  backoffBaseMs: 1_000,
  backoffMaxMs: 60_000,
  maxFailures: 5,
  /**
   * A socket refused once its ticket was issued (never opened): each such
   * attempt was admitted, one of the principal's 60 a day, and may be
   * refused again (5 sockets a credential), so they are fewer and slower.
   */
  refusedBackoffMs: 30_000,
  maxRefused: 2,
} as const;

/** The server's close codes. */
const EXPIRED = 4401;
const REVOKED = 4403;
const RESYNC = 4409;

type Frame =
  | { t: "changed"; n: number; streams?: LiveStream[]; refresh?: boolean }
  | { t: "renewed"; until: number };

export class LiveClient {
  readonly #deps: LiveDeps;
  #socket: LiveSocket | null = null;
  #running = false;
  #connecting = false;
  /** Connections in a row that failed, or closed before they were stable; of them, never opened. */
  #failures = 0;
  #refused = 0;
  /** This socket's: highest frame received and acknowledged, controls sent, when it opened. */
  #received = 0;
  #acked = 0;
  #controls = 0;
  #openedAt: number | null = null;
  /** When each control of the last minute went, whatever socket took it. */
  #recent: number[] = [];
  #deadline = 0;
  #renewing = false;
  #timers = new Map<"ack" | "renew" | "reconnect", unknown>();

  constructor(deps: LiveDeps) {
    this.#deps = deps;
  }

  /** Connects, unless already running. */
  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#failures = 0;
    this.#refused = 0;
    void this.#connect();
  }

  /** Closes the socket and stops (no page listens, a tab hidden long). */
  stop(): void {
    this.#running = false;
    this.#drop(1000, "done");
    for (const name of [...this.#timers.keys()]) this.#clear(name);
  }

  async #connect(): Promise<void> {
    if (!this.#running || this.#connecting || this.#socket) return;
    this.#connecting = true;
    let ticket: LiveTicket;
    try {
      ticket = await this.#deps.ticket();
    } catch {
      ticket = { kind: "retry" };
    } finally {
      this.#connecting = false;
    }
    if (!this.#running || this.#socket) return;
    if (ticket.kind === "off" || ticket.kind === "stop") {
      this.#halt(ticket.kind);
      return;
    }
    if (ticket.kind === "retry") {
      this.#failed();
      return;
    }
    this.#received = 0;
    this.#acked = 0;
    this.#controls = 0;
    this.#openedAt = null;
    this.#renewing = false;
    let socket: LiveSocket;
    try {
      socket = this.#deps.open(ticket.url, {
        open: () => {
          if (this.#socket !== socket) return;
          this.#openedAt = this.#deps.now();
          this.#deadline = this.#openedAt + LIVE_CLIENT.renewMs;
          this.#scheduleRenew();
          // What changed before the socket listened is read now.
          this.#deps.changed("all");
        },
        message: (data) => {
          if (this.#socket === socket) this.#message(data);
        },
        close: (code) => {
          if (this.#socket !== socket) return;
          this.#socket = null;
          this.#clear("ack");
          this.#clear("renew");
          this.#closed(code);
        },
      });
    } catch {
      this.#failed();
      return;
    }
    this.#socket = socket;
  }

  #closed(code: number): void {
    if (!this.#running) return;
    if (code === REVOKED) {
      this.#halt("revoked");
      return;
    }
    const opened = this.#openedAt;
    if (opened === null) {
      this.#refused += 1;
      this.#failed();
      return;
    }
    // Closed before it was stable: a failure, backed off whatever the code.
    if (this.#deps.now() - opened < LIVE_CLIENT.stableMs) {
      this.#failed();
      return;
    }
    this.#failures = 0;
    this.#refused = 0;
    // Its deadline or life passed, or it fell behind: a new socket at once (it refreshes).
    if (code === EXPIRED || code === RESYNC) void this.#connect();
    else this.#retryLater();
  }

  #failed(): void {
    this.#failures += 1;
    this.#retryLater();
  }

  /** Connects again after a back-off growing with the failures in a row; past them, stops. */
  #retryLater(): void {
    if (this.#failures >= LIVE_CLIENT.maxFailures || this.#refused >= LIVE_CLIENT.maxRefused) {
      this.#halt("failing");
      return;
    }
    const ceiling = Math.min(
      LIVE_CLIENT.backoffMaxMs,
      Math.max(
        this.#refused > 0 ? LIVE_CLIENT.refusedBackoffMs : 0,
        LIVE_CLIENT.backoffBaseMs * 2 ** Math.max(0, this.#failures - 1),
      ),
    );
    const delay = Math.round(ceiling * (0.5 + this.#deps.random() / 2));
    this.#set("reconnect", delay, () => void this.#connect());
  }

  #halt(why: "off" | "stop" | "revoked" | "failing"): void {
    this.stop();
    this.#deps.stopped?.(why);
  }

  #message(data: string): void {
    let frame: Frame;
    try {
      frame = JSON.parse(data) as Frame;
    } catch {
      return;
    }
    if (frame.t === "renewed" && Number.isSafeInteger(frame.until)) {
      // Timed by this clock, not the server's (they may disagree by minutes): the server
      // renews for its period, and closes the socket itself at its end of life.
      this.#renewing = false;
      this.#deadline = this.#deps.now() + LIVE_CLIENT.renewMs;
      this.#scheduleRenew();
      return;
    }
    if (frame.t !== "changed" || !Number.isSafeInteger(frame.n) || frame.n <= this.#received)
      return;
    this.#received = frame.n;
    this.#deps.changed(frame.refresh || !Array.isArray(frame.streams) ? "all" : frame.streams);
    if (this.#received - this.#acked >= LIVE_CLIENT.ackFrames) this.#ack();
    else if (!this.#timers.has("ack")) this.#set("ack", LIVE_CLIENT.ackAfterMs, () => this.#ack());
  }

  /** Acknowledges the highest frame received, when the allowance has room; else soon. */
  #ack(): void {
    this.#clear("ack");
    if (this.#received <= this.#acked || !this.#socket) return;
    // Near the life's allowance: a new socket rather than one refused (it refreshes).
    if (this.#controls >= LIVE_CLIENT.controlsLife - LIVE_CLIENT.renewReserveLife) {
      this.#rotate();
      return;
    }
    if (!this.#control(LIVE_CLIENT.renewReserveMinute)) {
      this.#set("ack", this.#minuteLeft(), () => this.#ack());
      return;
    }
    this.#acked = this.#received;
    this.#socket.send(JSON.stringify({ t: "ack", n: this.#acked }));
  }

  #scheduleRenew(): void {
    const at = this.#deadline - LIVE_CLIENT.renewBeforeMs;
    this.#set("renew", Math.max(0, at - this.#deps.now()), () => this.#renew());
  }

  #renew(): void {
    this.#clear("renew");
    if (!this.#socket) return;
    if (this.#controls >= LIVE_CLIENT.controlsLife) {
      this.#rotate();
      return;
    }
    if (!this.#control(0)) {
      this.#set("renew", this.#minuteLeft(), () => this.#renew());
      return;
    }
    this.#renewing = true;
    this.#socket.send(JSON.stringify({ t: "renew" }));
    // Unanswered (its check failed): asked again every so often, while the deadline allows.
    this.#set("renew", LIVE_CLIENT.renewRetryMs, () => {
      if (this.#renewing && this.#deps.now() < this.#deadline) this.#renew();
    });
  }

  /**
   * Counts one control message against the allowance, keeping `reserve` of
   * a minute's: counted over the last 60 seconds, wherever the server's
   * window starts, and across sockets.
   */
  #control(reserve: number): boolean {
    const now = this.#deps.now();
    this.#recent = this.#recent.filter((at) => now - at < 60_000);
    const room = LIVE_CLIENT.controlsPerMinute - LIVE_CLIENT.minuteMargin - reserve;
    if (this.#recent.length >= room) return false;
    this.#recent.push(now);
    this.#controls += 1;
    return true;
  }

  /** When the oldest control of the last minute leaves it. */
  #minuteLeft(): number {
    const oldest = this.#recent[0] ?? this.#deps.now();
    return Math.max(1, oldest + 60_000 - this.#deps.now());
  }

  /** A new socket in place of this one. */
  #rotate(): void {
    this.#drop(1000, "rotating");
    void this.#connect();
  }

  #drop(code: number, reason: string): void {
    const socket = this.#socket;
    this.#socket = null;
    this.#clear("ack");
    this.#clear("renew");
    socket?.close(code, reason);
  }

  #set(name: "ack" | "renew" | "reconnect", ms: number, fn: () => void): void {
    this.#clear(name);
    this.#timers.set(
      name,
      this.#deps.setTimer(() => {
        this.#timers.delete(name);
        fn();
      }, ms),
    );
  }

  #clear(name: "ack" | "renew" | "reconnect"): void {
    const handle = this.#timers.get(name);
    if (handle === undefined) return;
    this.#timers.delete(name);
    this.#deps.clearTimer(handle);
  }
}
