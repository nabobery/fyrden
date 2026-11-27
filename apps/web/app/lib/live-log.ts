import type { IncomingRow, LogStore } from "./log-store.js";

export interface LiveSocket {
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  onerror: (() => void) | null;
  send(text: string): void;
  close(): void;
}

export type LiveState = "idle" | "connecting" | "live" | "ended" | "stopped" | "refused" | "gone";

export type Ticket = { readonly url: string } | { readonly refused: string };

/** The socket's acknowledgement cadence (`actions.runs.jobs.live_ticket`). */
const ACK_FRAMES = 16;
const ACK_BYTES = 256 * 1024;
const RETRIES = 3;
const RETRY_WINDOW_MS = 10 * 60_000;

function utf8Length(text: string): number {
  let n = 0;
  for (let k = 0; k < text.length; k++) {
    const c = text.charCodeAt(k);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      k++;
    } else n += 3;
  }
  return n;
}

const isIndex = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

function rowOf(value: unknown): IncomingRow | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  if (!isIndex(row.i)) return null;
  if (typeof row.omitted === "string" && isIndex(row.bytes))
    return { i: row.i, omitted: row.omitted, bytes: row.bytes };
  if (typeof row.c !== "string") return null;
  const t = typeof row.t === "number" ? row.t : null;
  return { i: row.i, t, c: row.c };
}

/**
 * A running job's log over the live socket, into `store`: frames
 * acknowledged at the API's cadence; a budget end, a spent credential or the
 * socket's 24 hours reconnect from the next whole row (at most three times
 * in ten minutes); a socket refused before it opened, closed for any other
 * reason, or whose ticket or socket could not be had, stops until `resume`.
 */
export class LiveLog {
  state: LiveState = "idle";
  reason: string | null = null;
  readonly #store: LogStore;
  readonly #ticket: (from: number) => Promise<Ticket>;
  readonly #connect: (url: string) => LiveSocket;
  readonly #now: () => number;
  readonly #changed: () => void;
  #socket: LiveSocket | null = null;
  #pending: Promise<void> = Promise.resolve();
  #nextWhole = 0;
  #position = { i: 0, o: 0 };
  #frames = 0;
  #bytes = 0;
  #budgetFrom: number | null = null;
  #retries: number[] = [];
  #brokenRetried = false;
  #stopped = false;
  #attempt = 0;

  constructor(options: {
    store: LogStore;
    ticket: (from: number) => Promise<Ticket>;
    connect: (url: string) => LiveSocket;
    now?: () => number;
    onChange?: () => void;
  }) {
    this.#store = options.store;
    this.#ticket = options.ticket;
    this.#connect = options.connect;
    this.#now = options.now ?? Date.now;
    this.#changed = options.onChange ?? (() => undefined);
  }

  start(from: number): Promise<void> {
    this.#nextWhole = from;
    this.#pending = this.#open(from);
    return this.#pending;
  }

  resume(): Promise<void> {
    this.#stopped = false;
    this.#retries = [];
    this.#pending = this.#open(this.#nextWhole);
    return this.#pending;
  }

  /** Resolves once a reconnect under way has its socket (or its refusal). */
  settled(): Promise<void> {
    return this.#pending;
  }

  stop(): void {
    this.#stopped = true;
    this.#attempt += 1;
    this.#socket?.close();
  }

  #set(state: LiveState, reason: string | null = null): void {
    this.state = state;
    this.reason = reason;
    this.#changed();
  }

  async #open(from: number): Promise<void> {
    const attempt = ++this.#attempt;
    const current = () => attempt === this.#attempt;
    this.#set("connecting");
    this.#store.dropUnfinishedFrom(from);
    this.#position = { i: from, o: 0 };
    this.#frames = 0;
    this.#bytes = 0;
    this.#budgetFrom = null;
    let ticket: Ticket;
    try {
      ticket = await this.#ticket(from);
    } catch {
      if (current()) this.#set("stopped", "ticket_failed");
      return;
    }
    if (!current()) return;
    if ("refused" in ticket) {
      this.#set("refused", ticket.refused);
      return;
    }
    let socket: LiveSocket;
    try {
      socket = this.#connect(ticket.url);
    } catch {
      this.#set("stopped", "connect_failed");
      return;
    }
    this.#socket = socket;
    let opened = false;
    socket.onopen = () => {
      opened = true;
      if (current()) this.#set("live");
    };
    socket.onmessage = (event) => {
      if (current() && typeof event.data === "string") this.#frame(socket, event.data);
    };
    socket.onerror = () => undefined;
    socket.onclose = (event) => {
      if (this.#socket === socket) this.#socket = null;
      if (!current()) return;
      this.#closed(event.code, opened);
    };
  }

  #frame(socket: LiveSocket, data: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (typeof parsed !== "object" || parsed === null) return;
    const frame = parsed as Record<string, unknown>;
    if (frame.t === "rows" && Array.isArray(frame.rows)) {
      const rows = frame.rows.map(rowOf).filter((r): r is IncomingRow => r !== null);
      const last = rows.at(-1);
      if (!last) return;
      this.#store.applyLive(rows);
      this.#nextWhole = last.i + 1;
      this.#position = { i: last.i + 1, o: 0 };
    } else if (frame.t === "part") {
      const { i, o, c, end } = frame;
      if (!isIndex(i) || !isIndex(o) || typeof c !== "string" || typeof end !== "boolean") return;
      const t = o === 0 && typeof frame.ts === "number" ? frame.ts : null;
      this.#store.applyLive([{ i, t, c, o, end }]);
      this.#position = end ? { i: i + 1, o: 0 } : { i, o: o + c.length };
      if (end) this.#nextWhole = i + 1;
    } else if (frame.t === "end") {
      if (frame.reason === "budget") {
        this.#budgetFrom = isIndex(frame.unfinished) ? frame.unfinished : null;
        return;
      }
      if ((frame.log === "complete" || frame.log === "incomplete") && isIndex(frame.durable)) {
        if (isIndex(frame.unfinished)) this.#store.dropUnfinishedFrom(frame.unfinished);
        this.#store.applyTerminal(frame.durable, frame.log);
        this.#set("ended");
      }
      return;
    } else return;
    this.#frames += 1;
    this.#bytes += utf8Length(data);
    if (this.#frames >= ACK_FRAMES || this.#bytes >= ACK_BYTES) {
      socket.send(JSON.stringify({ t: "ack", i: this.#position.i, o: this.#position.o }));
      this.#frames = 0;
      this.#bytes = 0;
    }
    this.#changed();
  }

  #closed(code: number, opened: boolean): void {
    if (this.#stopped || this.state === "ended") return;
    if (!opened) {
      this.#set("refused", "not_opened");
      return;
    }
    if (code === 4403 || code === 4404) {
      this.#set("gone", code === 4404 ? "run_erased" : "access_lost");
      return;
    }
    const retryable = code === 4429 || code === 4401 || code === 1001;
    const broken = code === 1011 && !this.#brokenRetried;
    if (!retryable && !broken) {
      this.#set("stopped", String(code));
      return;
    }
    const now = this.#now();
    this.#retries = this.#retries.filter((at) => now - at < RETRY_WINDOW_MS);
    if (this.#retries.length >= RETRIES) {
      this.#set("stopped", String(code));
      return;
    }
    this.#retries.push(now);
    if (broken) this.#brokenRetried = true;
    this.#pending = this.#open(this.#budgetFrom ?? this.#nextWhole);
  }
}
