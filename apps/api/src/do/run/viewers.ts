import type { DoMemoryBudget, SliceResult } from "@fyrden/adapters-cloudflare/git";
import type { Logger, Metrics } from "@fyrden/adapters-cloudflare/obs";
import {
  isLogOmission,
  type StoredLogLine,
  type StoredLogOmission,
  type StoredLogRow,
} from "@fyrden/domain/ci";
import { freshlyAllowed, liveCredential } from "../../live/credential.js";
import { findReposById } from "../../repos/directory.js";
import { clock } from "../../services.js";
import { LIVE_POLICY } from "../user/live.js";
import type { RunEngine } from "./engine.js";
import { LOG_READER_POLICY, type ReadLogLine, readLogLines } from "./log-reader.js";

type MemoryReservation = NonNullable<ReturnType<DoMemoryBudget["tryReserve"]>>;

/*
 * Watching a job's log live, inside its run's object: tickets, hibernating
 * WebSockets (tagged by job and credential, all their state in their
 * attachment), and the rows each is sent.
 *
 * A socket has a cursor, `sent` (with `sentPart`, the offset into a row sent
 * in parts), and is only ever sent the row at it, so no row is sent twice or
 * skipped whichever path sends it. Rows come from two sources: the stored
 * chunks the manifest names (read from R2 by the `ci_log_viewers` job, a page
 * at a time) and, in memory, the rows of the latest log request known final
 * (settled rows a hold left unstored, or the rows just stored), which are
 * sent as soon as the request is done to every socket caught up with them.
 * The settled rows are masked exactly as they will be stored (the masker is
 * deterministic), so a row sent live is the stored row byte for byte.
 *
 * Before each frame, read synchronously after any await: the socket's
 * credential and repository access were checked by this object within the
 * last 60 s (else it waits for the job to check them again; a socket opens
 * unchecked, so even its first frame waits for one). Access is decided fresh
 * from the repository's account, never from the repository's cached ACL
 * snapshot. Its life has not ended, and its
 * window of unacknowledged frames has room (else it waits for an ack, and
 * is closed once it has waited 2 minutes).
 */

export const LOG_VIEWER_POLICY = {
  /** Unredeemed tickets a run keeps at most. Proposed. */
  tickets: 20,
  ticketMs: LIVE_POLICY.ticketMs,
  /** Sockets a run, a credential on a run and a principal on a run at most. Proposed. */
  perRun: 20,
  perCredential: LIVE_POLICY.perCredential,
  perPrincipal: 10,
  lifeMs: LIVE_POLICY.lifeMs,
  /** How long a check of a socket's credential and access lets it be sent rows. Proposed. */
  freshMs: 60_000,
  /** What may be sent past a socket's last ack: encoded bytes and frames. Proposed. */
  windowBytes: 1024 * 1024,
  windowFrames: 64,
  /** A frame's encoded size at most; a longer row is sent in parts of `partUnits` code units. */
  frameBytes: 256 * 1024,
  partUnits: 32_768,
  /** How long a full window may last before the socket closes. */
  slowMs: LIVE_POLICY.slowMs,
  controlsPerMinute: LIVE_POLICY.controlsPerMinute,
  controlBytes: LIVE_POLICY.controlBytes,
  /** Memory the settled rows held for live sockets take across the object at most. Proposed. */
  cacheBytes: 4 * 1024 * 1024,
  /** One run of the job: chunks and encoded bytes a socket is sent from storage, chunks read in all. Proposed. */
  pageChunks: 16,
  pageBytes: 2 * 1024 * 1024,
  sliceReads: 16,
  /** Credentials one run of the job checks at most. Proposed. */
  rechecks: 50,
} as const;

/** Close codes. */
export const LOG_CLOSE = {
  done: 1000,
  life: 1001,
  protocol: 1008,
  unavailable: 1011,
  broken: 1011,
  credential: 4401,
  access: 4403,
  erased: 4404,
  slow: 4408,
} as const;
type CloseReason = keyof typeof LOG_CLOSE;

/** The header the Worker's upgrade route tells the object the verified credential in. */
export const LOG_VIEWER_HEADER = "X-Fyrden-Log-Viewer";

/** What the upgrade route verified, as it tells the object. */
export interface ViewerAdmission {
  readonly repoId: string;
  readonly jobId: number;
  /** The ticket's hash (the ticket itself never leaves the Worker). */
  readonly hash: string;
  readonly from: number;
  readonly credentialId: string;
  readonly principalId: string;
  readonly principalType: "user" | "agent";
  readonly dependencies: readonly string[];
}

/**
 * A socket's state, all of it, kept in its attachment: at most 64 frames
 * outstanding keep it well within the 16,384 bytes an attachment holds
 * (verified: https://developers.cloudflare.com/durable-objects/api/websockets/).
 */
export interface ViewerAttachment {
  readonly v: 1;
  /** The first 16 hex chars of its ticket's hash: how logs and tests name it. */
  readonly id: string;
  readonly jobId: number;
  readonly credentialId: string;
  readonly principalId: string;
  readonly principalType: "user" | "agent";
  /** What the credential rested on at the upgrade: any change closes the socket. */
  readonly dependencies: readonly string[];
  readonly sent: number;
  readonly sentPart: number;
  readonly acked: number;
  readonly ackedPart: number;
  /** Each frame past the ack: the position after it (index, offset) and its encoded bytes, flat. */
  readonly out: readonly number[];
  readonly blockedSince: number | null;
  readonly checkedAt: number;
  readonly until: number;
  /** Counted control messages in the minute that started at `minute`. */
  readonly minute: number;
  readonly controls: number;
}

/** A log line as stored (one NDJSON line) and as sent: the same object, the same key order. */
export type LogLine = StoredLogLine;

export const logLine = (i: number, t: number | null, c: string): StoredLogRow => ({ i, t, c });

/** Pause and count points, for tests. */
export interface ViewerHooks {
  /** Before each frame is checked and sent (synchronous: nothing may come between it and the send). */
  beforeSend?: (socket: string) => void;
  afterSend?: (socket: string, frame: string) => void;
  /** Just before a frame is handed to the socket; what it throws is a failed send. */
  sending?: (socket: string) => void;
  /** After a stored chunk was read for a page, before anything of it is sent. */
  afterChunkGet?: (runId: string, key: string) => Promise<void> | void;
  beforeRecheck?: (runId: string, credentialId: string) => Promise<void> | void;
  afterRecheck?: (runId: string, credentialId: string) => Promise<void> | void;
  /** After a log request's rows are known final, before they are published. */
  beforePublish?: (runId: string) => Promise<void> | void;
  sliceRan?: (runId: string) => void;
  messageHandled?: (runId: string) => void;
}

export const viewerHooks: ViewerHooks = {};

export type StoreTicketAnswer =
  | { readonly ok: true; readonly expiresAt: number }
  | { readonly ok: false; readonly code: "run_not_found" | "job_not_found" | "too_many_tickets" };

/** What the viewers need from their object. */
export interface ViewersHost {
  readonly env: Env;
  readonly engine: RunEngine;
  readonly metrics: Metrics;
  readonly log: Logger;
  readonly memory: DoMemoryBudget;
  now(): number;
  erased(): boolean;
  tx<T>(fn: () => T): T;
  sockets(tag?: string): WebSocket[];
  accept(ws: WebSocket, tags: string[]): void;
  /** Has the `ci_log_viewers` job run now (sooner than any later run it has). */
  ensureSlice(): void;
}

/** A job's log as delivery sees it. */
interface JobLog {
  readonly task: number | null;
  /** Whether the log takes no more rows for viewers: its task ended (complete or incomplete), or the job ended with none. */
  readonly ended: boolean;
  readonly state: "complete" | "incomplete" | null;
  /** The end of the last stored chunk: positions below it are stored lines. */
  readonly linesEnd: number;
}

interface Cache {
  readonly base: number;
  readonly rows: readonly LogLine[];
  readonly bytes: number;
  readonly reservation: MemoryReservation;
}

type Pumped = "done" | "blocked" | "stale" | "closed" | "budget";
type ViewerLine = LogLine | ReadLogLine;

function omitted(line: ViewerLine): line is StoredLogOmission {
  return "omitted" in line;
}

function wireLine(line: ViewerLine): LogLine {
  if (omitted(line)) return line;
  return { i: line.i, t: line.t, c: typeof line.c === "string" ? line.c : line.c.whole() };
}

const OPEN = 1;
const utf8 = new TextEncoder();

/** UTF-8 length of `text` (lone surrogates as three bytes, as encoding them gives). */
function utf8Length(text: string): number {
  let bytes = 0;
  for (let k = 0; k < text.length; k++) {
    const unit = text.charCodeAt(k);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && k + 1 < text.length) {
      const next = text.charCodeAt(k + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        k++;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

const ROWS_OVERHEAD = utf8Length('{"t":"rows","rows":[]}');
/** Parser buffers, the small-row batch and encoded frame scratch. Proposed. */
const LOG_READER_SCRATCH_BYTES = 7 * 512 * 1024;

export class LogViewers {
  /** Per task, the latest request's rows known final, while a socket watches its job. */
  readonly #caches = new Map<number, Cache>();
  #cacheBytes = 0;
  /** Sockets a page is sending to from storage: a publish leaves them to it. */
  readonly #locked = new Set<string>();
  /** Sockets this object closed (a closed socket may still be listed until its peer answers). */
  readonly #closed = new WeakSet<WebSocket>();

  constructor(private readonly host: ViewersHost) {}

  // ------------------------------------------------------------------ tickets and admission

  /**
   * Stores a ticket's hash for job `jobId`, redeemable by `credentialId`
   * through repository `repoId` for `LOG_VIEWER_POLICY.ticketMs` on this
   * object's clock (the one its redemption is judged by). Expired tickets go first.
   */
  storeTicket(input: {
    hash: string;
    repoId: string;
    jobId: number;
    credentialId: string;
    principalId: string;
  }): StoreTicketAnswer {
    const { host } = this;
    return host.tx((): StoreTicketAnswer => {
      const run = host.engine.run();
      if (host.erased() || !run || run.repo_id !== input.repoId)
        return { ok: false, code: "run_not_found" };
      if (!host.engine.instance(input.jobId)) return { ok: false, code: "job_not_found" };
      const now = host.now();
      host.engine.exec("DELETE FROM ci_log_tickets WHERE expires_at <= ?", now);
      const held =
        host.engine.rows<{ n: number }>("SELECT COUNT(*) AS n FROM ci_log_tickets")[0]?.n ?? 0;
      if (held >= LOG_VIEWER_POLICY.tickets) return { ok: false, code: "too_many_tickets" };
      const expiresAt = now + LOG_VIEWER_POLICY.ticketMs;
      host.engine.exec(
        `INSERT INTO ci_log_tickets (hash, repo_id, job_id, credential_id, principal_id, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        input.hash,
        input.repoId,
        input.jobId,
        input.credentialId,
        input.principalId,
        expiresAt,
      );
      return { ok: true, expiresAt };
    });
  }

  /**
   * The upgrade, as the Worker forwards it with what it verified: the run
   * must be the repository's the Worker authorized, and the ticket this
   * credential's, for this job, unexpired (then it is spent; any other's is
   * left as it was). Within the caps, a socket from `from`.
   */
  redeem(request: Request): Response {
    const { host } = this;
    if (request.headers.get("Upgrade") !== "websocket") return new Response(null, { status: 426 });
    const admission = parseAdmission(request.headers.get(LOG_VIEWER_HEADER));
    if (!admission) return new Response(null, { status: 400 });
    const found = host.tx((): "missing" | "spent" | "ok" => {
      const run = host.engine.run();
      if (host.erased() || !run || run.repo_id !== admission.repoId) return "missing";
      const spent = host.engine.rows(
        `DELETE FROM ci_log_tickets
         WHERE hash = ? AND repo_id = ? AND credential_id = ? AND job_id = ? AND expires_at > ?
         RETURNING hash`,
        admission.hash,
        admission.repoId,
        admission.credentialId,
        admission.jobId,
        host.now(),
      );
      return spent.length > 0 ? "ok" : "spent";
    });
    if (found === "missing") return new Response("No such run.", { status: 404 });
    if (found === "spent")
      return new Response("The ticket is not this credential's, used, or expired.", {
        status: 401,
      });
    const open = this.#open();
    const states = open.map((ws) => stateOf(ws)).filter((s) => s !== null);
    if (
      open.length >= LOG_VIEWER_POLICY.perRun ||
      states.filter((s) => s.credentialId === admission.credentialId).length >=
        LOG_VIEWER_POLICY.perCredential ||
      states.filter((s) => s.principalId === admission.principalId).length >=
        LOG_VIEWER_POLICY.perPrincipal
    )
      return new Response("Too many sockets.", { status: 429, headers: { "Retry-After": "60" } });
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    host.accept(server, [`j${admission.jobId}`, `c${admission.credentialId}`]);
    const now = host.now();
    const state: ViewerAttachment = {
      v: 1,
      id: admission.hash.slice(0, 16),
      jobId: admission.jobId,
      credentialId: admission.credentialId,
      principalId: admission.principalId,
      principalType: admission.principalType,
      dependencies: [...admission.dependencies],
      sent: admission.from,
      sentPart: 0,
      acked: admission.from,
      ackedPart: 0,
      out: [],
      blockedSince: null,
      // Unchecked here: whatever the Worker read may be stale by the time it arrives (a revocation
      // since, a slow hop), so nothing is sent before this object's own check, which the job runs now.
      checkedAt: 0,
      until: now + LOG_VIEWER_POLICY.lifeMs,
      minute: now,
      controls: 0,
    };
    server.serializeAttachment(state);
    host.metrics.count("live.log_socket", { event: "opened", reason: "ticket" });
    host.log.info("log socket opened", {
      runId: this.#runId(),
      jobId: admission.jobId,
      socket: state.id,
    });
    // Backfill and what follows start in the job.
    host.ensureSlice();
    return new Response(null, { status: 101, webSocket: client });
  }

  // ------------------------------------------------------------------ publishing a log request's rows

  /** Whether job `jobId` has a socket open. */
  watched(jobId: number): boolean {
    return this.#open(`j${jobId}`).length > 0;
  }

  /**
   * A log request for job `jobId`'s task `task` is done: `rows` (from
   * position `base`) are final as masked, stored or settled. Sent at once
   * to each socket caught up with them; then kept for the job while it is
   * watched, within the bound, else dropped (which is what a wake does).
   */
  publish(jobId: number, task: number, base: number, rows: readonly LogLine[]): void {
    const sockets = this.#open(`j${jobId}`);
    this.#dropCache(task);
    if (sockets.length === 0) return;
    const get = (i: number) => (i >= base ? rows[i - base] : undefined);
    let behind = false;
    for (const ws of sockets) {
      const state = stateOf(ws);
      if (!state || this.#locked.has(state.id)) {
        behind = true;
        continue;
      }
      if (state.sent < base) {
        behind = true;
        continue;
      }
      const pumped = this.#pump(ws, get);
      if (pumped === "stale" || pumped === "blocked") behind = true;
    }
    // Kept only while a socket still watches: pumping may have closed the last one.
    if (this.watched(jobId)) this.#keep(task, base, rows);
    this.#endCaughtUp(jobId);
    if (behind) this.host.ensureSlice();
  }

  /** A job's instance completed, or its log ended: its sockets are ended by the job. */
  jobEnded(jobId: number): void {
    if (this.watched(jobId)) this.host.ensureSlice();
  }

  /** Releases every cache, as a wake leaves the object (or to make room for a log request). */
  dropCaches(): void {
    for (const task of [...this.#caches.keys()]) this.#dropCache(task);
  }

  /** Bytes the caches hold (for tests and the bound). */
  cacheBytes(): number {
    return this.#cacheBytes;
  }

  /** Every open socket's state (for tests). */
  attachments(): ViewerAttachment[] {
    return this.#open()
      .map((ws) => stateOf(ws))
      .filter((s) => s !== null);
  }

  #keep(task: number, base: number, rows: readonly LogLine[]): void {
    if (rows.length === 0) return;
    let bytes = 0;
    for (const row of rows) bytes += isLogOmission(row) ? 128 : 2 * row.c.length + 64;
    if (this.#cacheBytes + bytes > LOG_VIEWER_POLICY.cacheBytes) return;
    const reservation = this.host.memory.tryReserve(bytes);
    if (!reservation) return;
    this.#caches.set(task, { base, rows, bytes, reservation });
    this.#cacheBytes += bytes;
  }

  #dropCache(task: number): void {
    const cache = this.#caches.get(task);
    if (!cache) return;
    this.#caches.delete(task);
    this.#cacheBytes -= cache.bytes;
    cache.reservation.release();
  }

  #fromCache(task: number | null): (i: number) => LogLine | undefined {
    const cache = task === null ? undefined : this.#caches.get(task);
    return (i) => (cache && i >= cache.base ? cache.rows[i - cache.base] : undefined);
  }

  // ------------------------------------------------------------------ client messages

  /**
   * A client's message. An ack moving forward within what was sent is
   * taken as is; anything else that is an ack counts as a control (past 20
   * a minute: 1008); a message that is no ack, or over 1 KiB, closes 1008.
   */
  message(ws: WebSocket, message: string | ArrayBuffer): void {
    try {
      this.#message(ws, message);
    } finally {
      viewerHooks.messageHandled?.(this.#runId());
    }
  }

  #message(ws: WebSocket, message: string | ArrayBuffer): void {
    const state = stateOf(ws);
    if (!state || this.#closed.has(ws)) return;
    const size = typeof message === "string" ? utf8Length(message) : message.byteLength;
    if (typeof message !== "string" || size > LOG_VIEWER_POLICY.controlBytes) {
      this.#close(ws, "protocol", "message too large or not text");
      return;
    }
    let ack: { i: number; o: number } | null = null;
    try {
      const parsed = JSON.parse(message) as { t?: unknown; i?: unknown; o?: unknown } | null;
      if (parsed === null || typeof parsed !== "object" || parsed.t !== "ack") {
        this.#close(ws, "protocol", "only acks are taken");
        return;
      }
      if (Number.isSafeInteger(parsed.i) && Number.isSafeInteger(parsed.o ?? 0))
        ack = { i: parsed.i as number, o: (parsed.o ?? 0) as number };
    } catch {
      this.#close(ws, "protocol", "only acks are taken");
      return;
    }
    const now = this.host.now();
    if (now >= state.until) {
      this.#close(ws, "life", "life ended: reconnect");
      return;
    }
    if (
      ack !== null &&
      compare(ack.i, ack.o, state.acked, state.ackedPart) > 0 &&
      compare(ack.i, ack.o, state.sent, state.sentPart) <= 0
    ) {
      let k = 0;
      while (
        k < state.out.length &&
        compare(state.out[k] ?? 0, state.out[k + 1] ?? 0, ack.i, ack.o) <= 0
      )
        k += 3;
      const blocked = state.blockedSince !== null;
      write(ws, {
        ...state,
        acked: ack.i,
        ackedPart: ack.o,
        out: state.out.slice(k),
        blockedSince: null,
      });
      if (blocked) this.host.ensureSlice();
      return;
    }
    const fresh = now - state.minute >= 60_000;
    const controls = (fresh ? 0 : state.controls) + 1;
    write(ws, { ...state, minute: fresh ? now : state.minute, controls });
    if (controls > LOG_VIEWER_POLICY.controlsPerMinute)
      this.#close(ws, "protocol", "too many control messages");
  }

  /** A socket the client closed, or that failed. */
  gone(ws: WebSocket): void {
    if (this.#closed.has(ws)) return;
    this.#closed.add(ws);
    this.host.metrics.count("live.log_socket", { event: "closed", reason: "client" });
    this.#unwatched(stateOf(ws)?.jobId);
  }

  /** Releases the cache of job `jobId`'s task once no socket watches it. */
  #unwatched(jobId: number | undefined): void {
    if (jobId === undefined || this.watched(jobId)) return;
    const task = this.host.engine.instance(jobId)?.task;
    if (task !== null && task !== undefined) this.#dropCache(task);
  }

  // ------------------------------------------------------------------ erasure

  /** The run was erased: every socket closes 4404, and nothing is kept. */
  erased(): void {
    for (const ws of this.#open()) this.#close(ws, "erased", "the run was erased");
    this.dropCaches();
  }

  // ------------------------------------------------------------------ the job

  /**
   * One run of `ci_log_viewers`: closes sockets past their life or full for
   * too long, checks again the credentials of sockets with rows waiting
   * that were last checked 60 s ago or more, sends sockets behind a page from
   * storage each and then what the cache holds, and ends sockets whose log
   * ended once they have every stored line. More to do: run again now; only
   * full windows left: when the first of them is due to close.
   */
  async slice(): Promise<SliceResult> {
    const { host } = this;
    const runId = this.#runId();
    viewerHooks.sliceRan?.(runId);
    if (host.erased()) return { done: true };
    let sockets = this.#open();
    if (sockets.length === 0) {
      this.dropCaches();
      return { done: true };
    }
    const now = host.now();
    for (const ws of sockets) {
      const state = stateOf(ws);
      if (!state) continue;
      if (now >= state.until) this.#close(ws, "life", "life ended: reconnect");
      else if (state.blockedSince !== null && now >= state.blockedSince + LOG_VIEWER_POLICY.slowMs)
        this.#close(ws, "slow", "acknowledgements stopped");
    }
    const deferred = await this.#recheck();
    const short = await this.#backfill();
    for (const ws of this.#open()) {
      const state = stateOf(ws);
      if (!state || this.#locked.has(state.id)) continue;
      const log = this.#jobLog(state.jobId);
      this.#pump(ws, this.#fromCache(log.task));
    }
    const ended = new Set<number>();
    for (const ws of this.#open()) {
      const state = stateOf(ws);
      if (state) ended.add(state.jobId);
    }
    for (const jobId of ended) this.#endCaughtUp(jobId);
    sockets = this.#open();
    if (sockets.length === 0) {
      this.dropCaches();
      return { done: true };
    }
    let runnable = false;
    let due: number | null = null;
    const at = host.now();
    for (const ws of sockets) {
      const state = stateOf(ws);
      if (!state) continue;
      const work = this.#work(state, this.#jobLog(state.jobId));
      if (work === "none" && state.checkedAt > 0) continue;
      if (state.blockedSince !== null) {
        const close = state.blockedSince + LOG_VIEWER_POLICY.slowMs;
        due = due === null ? close : Math.min(due, close);
      } else runnable = true;
    }
    if (runnable)
      return { done: false, cursor: null, runAfterMs: deferred ? 5_000 : short ? 1_000 : 0 };
    if (due !== null) return { done: false, cursor: null, runAfterMs: Math.max(1, due - at) };
    return { done: true };
  }

  /** What a socket waits for: rows it can be sent now or once checked, its end, or nothing yet. */
  #work(state: ViewerAttachment, log: JobLog): "rows" | "end" | "none" {
    if (state.sent < log.linesEnd) return "rows";
    if (this.#fromCache(log.task)(state.sent)) return "rows";
    if (log.ended) return "end";
    return "none";
  }

  /**
   * Checks the credentials of sockets never checked here, and of stale ones
   * with work, by credential, at most `rechecks` of them; each socket against
   * the dependencies it was opened on. True when an account could not answer
   * (those sockets stay unchecked).
   */
  async #recheck(): Promise<boolean> {
    const { host } = this;
    const run = host.engine.run();
    if (!run) return false;
    const now = host.now();
    const due = new Set<string>();
    for (const ws of this.#open()) {
      const state = stateOf(ws);
      if (!state || now < state.checkedAt + LOG_VIEWER_POLICY.freshMs) continue;
      // A socket never checked here is checked at once; a stale one only when it has work.
      if (state.checkedAt > 0 && this.#work(state, this.#jobLog(state.jobId)) === "none") continue;
      if (due.size >= LOG_VIEWER_POLICY.rechecks) break;
      due.add(state.credentialId);
    }
    let deferred = false;
    const runId = run.run_id;
    for (const credentialId of due) {
      // The check stands for what holds when it starts.
      const startedAt = host.now();
      await viewerHooks.beforeRecheck?.(runId, credentialId);
      host.metrics.count("d1.query", { db: "directory", op: "live_log_recheck" });
      const credential = await liveCredential(host.env.DIRECTORY, credentialId, clock());
      let access: boolean | "unknown" = false;
      if (credential) {
        const [repo] = await findReposById(host.env, [run.repo_id], host.metrics);
        access =
          repo === undefined
            ? false
            : await freshlyAllowed(host.env, host.metrics, credential, repo, "actions:read");
      }
      // Not decided (the account did not answer): left unchecked, to be tried again shortly.
      if (access === "unknown") deferred = true;
      await viewerHooks.afterRecheck?.(runId, credentialId);
      // Each socket against what it was opened on: one opened since a change rests on the new state.
      for (const ws of this.#open(`c${credentialId}`)) {
        const state = stateOf(ws);
        if (!state) continue;
        if (!credential || !sameDependencies(credential.dependencies, state.dependencies))
          this.#close(ws, "credential", "the credential no longer holds");
        else if (access === false) this.#close(ws, "access", "access to the repository was lost");
        else if (access === true)
          write(ws, { ...state, checkedAt: Math.max(state.checkedAt, startedAt) });
      }
    }
    return deferred;
  }

  /**
   * Pages sockets behind through the stored chunks: a chunk read once for
   * every socket that needs it, at most `sliceReads` reads a run, and at most
   * `pageChunks` chunks or `pageBytes` a socket. True when the memory pool
   * was too short for a read.
   */
  async #backfill(): Promise<boolean> {
    const { host } = this;
    const runId = this.#runId();
    const pages = new Map<string, { chunks: number; bytes: number }>();
    for (let reads = 0; reads < LOG_VIEWER_POLICY.sliceReads; reads++) {
      const now = host.now();
      let wanted: { task: number; start: number; end: number; bytes: number; key: string } | null =
        null;
      const group: WebSocket[] = [];
      for (const ws of this.#open()) {
        const state = stateOf(ws);
        if (!state || this.#locked.has(state.id) || state.blockedSince !== null) continue;
        if (now >= state.checkedAt + LOG_VIEWER_POLICY.freshMs) continue;
        const page = pages.get(state.id);
        if (
          page &&
          (page.chunks >= LOG_VIEWER_POLICY.pageChunks || page.bytes >= LOG_VIEWER_POLICY.pageBytes)
        )
          continue;
        const log = this.#jobLog(state.jobId);
        if (log.task === null || state.sent >= log.linesEnd) continue;
        if (this.#fromCache(log.task)(state.sent)) continue;
        if (wanted === null) {
          wanted = this.#chunkAt(log.task, state.sent);
          if (wanted === null) continue;
        }
        if (log.task === wanted.task && state.sent >= wanted.start && state.sent < wanted.end)
          group.push(ws);
      }
      if (wanted === null || group.length === 0) return false;
      // Decoded segments plus bounded parser, small-row batch and frame scratch.
      const need =
        2 * Math.min(LOG_READER_POLICY.maxDecodedUnits, wanted.bytes) + LOG_READER_SCRATCH_BYTES;
      let reservation = host.memory.tryReserve(need);
      if (!reservation) {
        this.dropCaches();
        reservation = host.memory.tryReserve(need);
      }
      if (!reservation) return true;
      const ids = group.map((ws) => (stateOf(ws) as ViewerAttachment).id);
      for (const id of ids) this.#locked.add(id);
      try {
        host.metrics.count("r2.class_b", { bucket: "fyrden-ci", op: "get_log_chunk" });
        const object = await host.env.CI.get(wanted.key);
        await viewerHooks.afterChunkGet?.(runId, wanted.key);
        if (object === null) {
          host.log.error("a log chunk the manifest names is missing", {
            runId,
            task: wanted.task,
            start: wanted.start,
          });
          for (const ws of group) this.#close(ws, "unavailable", "the log cannot be read");
          continue;
        }
        for (const ws of group) {
          const state = stateOf(ws);
          if (!state) continue;
          const page = pages.get(state.id) ?? { chunks: 0, bytes: 0 };
          page.chunks++;
          pages.set(state.id, page);
        }
        let batch: ViewerLine[] = [];
        let batchBytes = ROWS_OVERHEAD;
        const pump = (lines: readonly ViewerLine[]) => {
          const base = lines[0]?.i;
          if (base === undefined) return;
          const get = (i: number) => (i >= base ? lines[i - base] : undefined);
          for (const ws of group) {
            const state = stateOf(ws);
            if (state) this.#pump(ws, get, pages.get(state.id));
          }
        };
        const flush = () => {
          pump(batch);
          batch = [];
          batchBytes = ROWS_OVERHEAD;
        };
        const pending = () =>
          group.some((ws) => {
            const state = stateOf(ws);
            return (
              state !== null &&
              !this.#closed.has(ws) &&
              state.sent < wanted.end &&
              state.blockedSince === null &&
              host.now() < state.checkedAt + LOG_VIEWER_POLICY.freshMs &&
              (pages.get(state.id)?.bytes ?? 0) < LOG_VIEWER_POLICY.pageBytes
            );
          });
        let expected = wanted.start;
        try {
          for await (const line of readLogLines(object.body)) {
            if (line.i !== expected || line.i >= wanted.end)
              throw new Error("stored log positions do not match the manifest");
            expected++;
            if (rowFits(line)) {
              const whole = wireLine(line);
              const bytes = utf8Length(JSON.stringify(whole));
              if (batchBytes + bytes + (batch.length > 0 ? 1 : 0) > LOG_VIEWER_POLICY.frameBytes)
                flush();
              batchBytes += bytes + (batch.length > 0 ? 1 : 0);
              batch.push(whole);
            } else {
              flush();
              pump([line]);
            }
            if (!pending()) break;
          }
          flush();
          if (pending() && expected !== wanted.end)
            throw new Error("stored log ended before its manifest range");
        } catch {
          host.log.error("a stored log chunk cannot be decoded", {
            runId,
            task: wanted.task,
            start: wanted.start,
          });
          for (const ws of group) this.#close(ws, "unavailable", "the log cannot be read");
        }
      } finally {
        for (const id of ids) this.#locked.delete(id);
        reservation.release();
      }
    }
    return false;
  }

  #chunkAt(
    task: number,
    index: number,
  ): { task: number; start: number; end: number; bytes: number; key: string } | null {
    const chunk = this.host.engine.rows<{
      start_index: number;
      end_index: number;
      bytes: number;
      r2_key: string;
    }>(
      `SELECT start_index, end_index, bytes, r2_key FROM ci_log_chunks
       WHERE task = ? AND start_index <= ? AND end_index > ? LIMIT 1`,
      task,
      index,
      index,
    )[0];
    return chunk
      ? {
          task,
          start: chunk.start_index,
          end: chunk.end_index,
          bytes: chunk.bytes,
          key: chunk.r2_key,
        }
      : null;
  }

  // ------------------------------------------------------------------ sending

  /**
   * Sends `ws` frames from `get` (rows by index) from its cursor on, while
   * it is checked, alive and its window has room; each frame decided on the
   * state read just before it is sent. With `page`, counts the bytes sent
   * and stops at the page's bound.
   */
  #pump(
    ws: WebSocket,
    get: (i: number) => ViewerLine | undefined,
    page?: { bytes: number },
  ): Pumped {
    for (;;) {
      const state = stateOf(ws);
      if (!state || this.#closed.has(ws)) return "closed";
      if (page && page.bytes >= LOG_VIEWER_POLICY.pageBytes) return "budget";
      const frame = nextFrame(state, get);
      if (frame === null) return "done";
      viewerHooks.beforeSend?.(state.id);
      const now = this.host.now();
      if (now >= state.until) {
        this.#close(ws, "life", "life ended: reconnect");
        return "closed";
      }
      if (now >= state.checkedAt + LOG_VIEWER_POLICY.freshMs) return "stale";
      if (!fits(state, frame.bytes)) {
        if (state.blockedSince === null) write(ws, { ...state, blockedSince: now });
        return "blocked";
      }
      if (!this.#send(ws, state, frame.text)) return "closed";
      write(ws, {
        ...state,
        sent: frame.sent,
        sentPart: frame.sentPart,
        out: [...state.out, frame.sent, frame.sentPart, frame.bytes],
        blockedSince: null,
      });
      if (page) page.bytes += frame.bytes;
    }
  }

  #send(ws: WebSocket, state: ViewerAttachment, text: string): boolean {
    try {
      viewerHooks.sending?.(state.id);
      ws.send(text);
    } catch {
      // Its connection is gone: closed and forgotten like any other, its job's cache with it.
      this.#close(ws, "broken", "the socket could not be sent to");
      return false;
    }
    viewerHooks.afterSend?.(state.id, text);
    return true;
  }

  /**
   * Ends the sockets of job `jobId` whose log ended and that hold every
   * stored line: at a row boundary (a row cut mid-part is finished from the
   * cache first, by the pump; one neither stored nor cached is named
   * `unfinished`), within their window and check, then closed 1000.
   */
  #endCaughtUp(jobId: number): void {
    const log = this.#jobLog(jobId);
    if (!log.ended) return;
    const cached = this.#fromCache(log.task);
    for (const ws of this.#open(`j${jobId}`)) {
      const state = stateOf(ws);
      if (!state || this.#locked.has(state.id) || state.sent < log.linesEnd) continue;
      if (state.sentPart > 0 && cached(state.sent)) continue;
      const end: Record<string, unknown> = {
        t: "end",
        log: log.state === "complete" ? "complete" : "incomplete",
        durable: log.linesEnd,
      };
      if (state.sentPart > 0) end.unfinished = state.sent;
      const text = JSON.stringify(end);
      const bytes = utf8Length(text);
      viewerHooks.beforeSend?.(state.id);
      const now = this.host.now();
      if (now >= state.until) {
        this.#close(ws, "life", "life ended: reconnect");
        continue;
      }
      if (now >= state.checkedAt + LOG_VIEWER_POLICY.freshMs) continue;
      if (!fits(state, bytes)) {
        if (state.blockedSince === null) write(ws, { ...state, blockedSince: now });
        continue;
      }
      if (!this.#send(ws, state, text)) continue;
      this.#close(ws, "done", "the log ended");
    }
  }

  #close(ws: WebSocket, reason: CloseReason, message: string): void {
    if (this.#closed.has(ws)) return;
    this.#closed.add(ws);
    const state = stateOf(ws);
    try {
      ws.close(LOG_CLOSE[reason], message);
    } catch {
      // Already closing: nothing more to tell it.
    }
    this.host.metrics.count("live.log_socket", { event: "closed", reason });
    this.host.log.info("log socket closed", {
      runId: this.#runId(),
      jobId: state?.jobId,
      socket: state?.id,
      reason,
    });
    this.#unwatched(state?.jobId);
  }

  /** Open sockets (of `tag`), those this object closed left out. */
  #open(tag?: string): WebSocket[] {
    return this.host.sockets(tag).filter((ws) => !this.#closed.has(ws) && ws.readyState === OPEN);
  }

  #jobLog(jobId: number): JobLog {
    const { engine } = this.host;
    const instance = engine.instance(jobId);
    const task = instance?.task ?? null;
    if (task === null)
      return {
        task: null,
        ended: instance === undefined || instance.status === "completed",
        state: "complete",
        linesEnd: 0,
      };
    const log = engine.rows<{ state: string; finalized: number; lines_end: number | null }>(
      `SELECT l.state, l.finalized, (SELECT MAX(end_index) FROM ci_log_chunks c WHERE c.task = l.task) AS lines_end
       FROM ci_logs l WHERE l.task = ?`,
      task,
    )[0];
    const state = log?.state === "complete" || log?.state === "incomplete" ? log.state : null;
    return {
      task,
      ended: log?.finalized === 1 || state !== null,
      state,
      linesEnd: log?.lines_end ?? 0,
    };
  }

  #runId(): string {
    return this.host.engine.run()?.run_id ?? "";
  }
}

/** Positions compared: index, then offset. */
function compare(i: number, o: number, j: number, p: number): number {
  return i !== j ? i - j : o - p;
}

function stateOf(ws: WebSocket): ViewerAttachment | null {
  const state = ws.deserializeAttachment() as ViewerAttachment | null;
  return state?.v === 1 ? state : null;
}

function write(ws: WebSocket, state: ViewerAttachment): void {
  ws.serializeAttachment(state);
}

/** Whether a frame of `bytes` fits the window past the socket's ack. */
function fits(state: ViewerAttachment, bytes: number): boolean {
  let out = 0;
  for (let k = 2; k < state.out.length; k += 3) out += state.out[k] ?? 0;
  return (
    state.out.length / 3 + 1 <= LOG_VIEWER_POLICY.windowFrames &&
    out + bytes <= LOG_VIEWER_POLICY.windowBytes
  );
}

/**
 * The next frame from the socket's cursor: whole rows while the frame stays
 * within `frameBytes`, or the next part of a row too long for one; null when
 * `get` has nothing at the cursor.
 */
function nextFrame(
  state: ViewerAttachment,
  get: (i: number) => ViewerLine | undefined,
): { text: string; bytes: number; sent: number; sentPart: number } | null {
  const first = get(state.sent);
  if (!first) return null;
  if (!omitted(first) && (state.sentPart > 0 || !rowFits(first))) {
    const o = state.sentPart;
    const piece = first.c.slice(o, o + LOG_VIEWER_POLICY.partUnits);
    const end = o + piece.length >= first.c.length;
    const text = JSON.stringify({
      t: "part",
      i: first.i,
      o,
      c: piece,
      end,
      ...(o === 0 && { ts: first.t }),
    });
    return {
      text,
      bytes: utf8Length(text),
      sent: end ? first.i + 1 : first.i,
      sentPart: end ? 0 : o + piece.length,
    };
  }
  const firstText = JSON.stringify(wireLine(first));
  const texts = [firstText];
  let bytes = ROWS_OVERHEAD + utf8Length(firstText);
  let next = state.sent + 1;
  for (;;) {
    const row = get(next);
    if (!row || !rowFits(row)) break;
    const text = JSON.stringify(wireLine(row));
    const more = utf8Length(text) + 1;
    if (bytes + more > LOG_VIEWER_POLICY.frameBytes) break;
    texts.push(text);
    bytes += more;
    next++;
  }
  const text = `{"t":"rows","rows":[${texts.join(",")}]}`;
  return { text, bytes, sent: next, sentPart: 0 };
}

/** Whether a row goes whole in a frame of its own. */
function rowFits(row: ViewerLine): boolean {
  if (omitted(row)) return true;
  if ("encodedBytes" in row)
    return row.encodedBytes + ROWS_OVERHEAD <= LOG_VIEWER_POLICY.frameBytes;
  // Each code unit is 1 to 6 bytes encoded: decide from the length when it settles it.
  const limit = LOG_VIEWER_POLICY.frameBytes - ROWS_OVERHEAD - 64;
  if (row.c.length > limit) return false;
  if (row.c.length * 6 <= limit) return true;
  return utf8.encode(JSON.stringify(row)).length + ROWS_OVERHEAD <= LOG_VIEWER_POLICY.frameBytes;
}

function sameDependencies(now: readonly string[], then: readonly string[]): boolean {
  const a = [...now].sort();
  const b = [...then].sort();
  return a.length === b.length && a.every((d, k) => d === b[k]);
}

function parseAdmission(text: string | null): ViewerAdmission | null {
  if (text === null) return null;
  try {
    const a = JSON.parse(text) as Partial<ViewerAdmission> | null;
    if (
      !a ||
      typeof a.repoId !== "string" ||
      !Number.isSafeInteger(a.jobId) ||
      typeof a.hash !== "string" ||
      !/^[0-9a-f]{64}$/.test(a.hash) ||
      !Number.isSafeInteger(a.from) ||
      (a.from as number) < 0 ||
      typeof a.credentialId !== "string" ||
      typeof a.principalId !== "string" ||
      (a.principalType !== "user" && a.principalType !== "agent") ||
      !Array.isArray(a.dependencies) ||
      !a.dependencies.every((d) => typeof d === "string")
    )
      return null;
    return a as ViewerAdmission;
  } catch {
    return null;
  }
}
