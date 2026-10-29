/*
 * A feed's live sockets, as its object keeps them (call within its
 * transactions; the awaited parts, directory checks and authorization, are
 * the object's): tickets, each socket's protocol state and dependencies, the
 * streams changed since sockets last heard with their causes, and the
 * dependencies revoked.
 *
 * A socket carries only hints: `{"t":"changed","n":<counter>,"streams":[…]}`
 * names repository-and-kind streams of the feed and inbox that changed and
 * that its credential may read now (or `"refresh":true` past 20 of them);
 * the client rereads through the REST APIs, which authorize freshly. What
 * the credential cannot read never enters a socket's frames, window or
 * closes; when frames go, and how many changes one coalesces, may depend
 * on other work in the object (a recorded relaxation).
 */

export const LIVE_POLICY = {
  /** How long a ticket can be redeemed. */
  ticketMs: 30_000,
  /** How long a renewal keeps a socket (never past its absolute expiry). */
  renewMs: 10 * 60_000,
  /** A socket's longest life (its credential's expiry if sooner). */
  lifeMs: 24 * 60 * 60_000,
  /** Frames sent and not acknowledged at most. */
  window: 8,
  /** How long a full window may last before the socket closes. */
  slowMs: 2 * 60_000,
  /** Control messages a minute, and in a socket's life, at most; their size at most. */
  controlsPerMinute: 20,
  controlsLife: 200,
  controlBytes: 1024,
  /** Sockets a credential, and a feed, at most. */
  perCredential: 5,
  perFeed: 20,
  /** Streams a frame names at most (past them it asks for a full reread). */
  streamsPerFrame: 20,
  /** Conversations a dirty stream keeps as causes at most. */
  candidatesPerStream: 20,
  /** How long an access decision stands. */
  decisionMs: 10 * 60_000,
  /** How long a revoked dependency is kept (a socket's longest life). */
  revokedMs: 24 * 60 * 60_000,
  /** Dirty streams one pump unit reads at most (its progress stops at the page's end). */
  dirtyPage: 20,
  /** Rows of each kind one pruning or clearing step deletes at most. */
  pruneRows: 500,
} as const;

/** Close codes: expired (renew or reconnect with a new ticket), resync (reread everything). */
export const CLOSE_EXPIRED = 4401;
export const CLOSE_RESYNC = 4409;
export const CLOSE_REVOKED = 4403;

/** One socket's protocol state. */
export interface LiveSocket {
  readonly socket_id: string;
  readonly credential_id: string;
  readonly phase: "confirming" | "open";
  readonly expires_at: number;
  readonly deadline: number;
  readonly sent: number;
  readonly acked: number;
  readonly refresh_pending: number;
  readonly blocked_since: number | null;
  readonly renew_failures: number;
  readonly controls_used: number;
  readonly minute_start: number;
  readonly minute_count: number;
  readonly delivered_seq: number;
  /** When a run that could not be done for it (an answer missing) may be tried again. */
  readonly retry_at: number;
  readonly scopes: string;
  readonly repo_ids: string | null;
}

/** A change to signal: its stream, and why (an automatic change of a conversation, or the principal's own). */
export type LiveSignal =
  | {
      readonly repoId: string;
      readonly subject: "issue" | "pull";
      readonly conversation: string | null;
      /** Whether a thread unsubscribe lets it through (`DIRECT`). */
      readonly direct: boolean;
    }
  | { readonly repoId: string; readonly subject: "issue" | "pull"; readonly explicit: true };

/** A stream's key. */
export const streamOf = (repoId: string, subject: string) => `${repoId}\n${subject}`;

/** A dirty stream, and the causes a socket at a progress still has to hear of. */
export interface DirtyStream {
  readonly stream: string;
  readonly repo_id: string;
  readonly subject: "issue" | "pull";
  readonly seq: number;
  readonly explicit_seq: number;
  readonly many_seq: number;
}

export interface Candidate {
  readonly stream: string;
  readonly conversation: string;
  readonly direct_seq: number;
  readonly ordinary_seq: number;
}

const toHex = (bytes: Uint8Array) =>
  [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

/** A ticket's stored hash (SHA-256, hex). */
export async function ticketHash(ticket: string): Promise<string> {
  return toHex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ticket))),
  );
}

export class Live {
  constructor(private readonly sql: SqlStorage) {}

  /** The next sequence of changes. */
  #nextSeq(): number {
    this.sql.exec(
      `INSERT INTO live_meta (id, seq, gen) VALUES (1, 1, 0)
       ON CONFLICT (id) DO UPDATE SET seq = seq + 1`,
    );
    return this.sql.exec<{ seq: number }>("SELECT seq FROM live_meta WHERE id = 1").one().seq;
  }

  /** Stores a ticket (its hash) for `credentialId`, until `expiresAt`. */
  storeTicket(hash: string, credentialId: string, expiresAt: number): void {
    this.sql.exec(
      "INSERT INTO live_tickets (ticket_hash, credential_id, expires_at) VALUES (?, ?, ?)",
      hash,
      credentialId,
      expiresAt,
    );
  }

  /** Redeems a ticket once: its credential, when it is that one's and unexpired. */
  redeemTicket(hash: string, credentialId: string, now: number): boolean {
    const row = this.sql
      .exec<{ credential_id: string; expires_at: number }>(
        "SELECT credential_id, expires_at FROM live_tickets WHERE ticket_hash = ?",
        hash,
      )
      .toArray()[0];
    if (!row || row.credential_id !== credentialId) return false;
    this.sql.exec("DELETE FROM live_tickets WHERE ticket_hash = ?", hash);
    return row.expires_at > now;
  }

  /** How many sockets the feed holds, and the credential. */
  counts(credentialId: string): { feed: number; credential: number } {
    const row = this.sql
      .exec<{ feed: number; credential: number }>(
        `SELECT count(*) AS feed, coalesce(sum(credential_id = ?), 0) AS credential
         FROM live_local`,
        credentialId,
      )
      .one();
    return { feed: row.feed, credential: row.credential };
  }

  /** Whether any of `dependencies` was revoked. */
  anyRevoked(dependencies: readonly string[]): boolean {
    return (
      this.sql
        .exec(
          "SELECT 1 FROM live_revoked WHERE dependency IN (SELECT value FROM json_each(?))",
          JSON.stringify(dependencies),
        )
        .toArray().length > 0
    );
  }

  /**
   * Whether a socket's state predates the budget fence: its object restored
   * (an older epoch) or the ledger's incarnation changed since it was
   * admitted (one admitted before any was learned stays).
   */
  stale(socketId: string): boolean {
    return (
      this.sql
        .exec(
          `SELECT 1 FROM live_local s JOIN live_budget_fence f ON f.id = 1
           WHERE s.socket_id = ? AND (s.budget_epoch < f.epoch
             OR (s.budget_incarnation <> '' AND s.budget_incarnation <> f.incarnation))`,
          socketId,
        )
        .toArray().length > 0
    );
  }

  /** Records a socket being confirmed (not yet seen by the pump). */
  addSocket(
    socket: {
      id: string;
      credentialId: string;
      expiresAt: number;
      scopes: readonly string[];
      repoIds: readonly string[] | null;
    },
    dependencies: readonly string[],
    now: number,
  ): void {
    const progress = this.seq();
    this.sql.exec(
      // Stamped with the budget fence it was admitted under: a restore that moves the fence makes
      // it stale (see `stale`).
      `INSERT INTO live_local (socket_id, credential_id, phase, expires_at, deadline, sent, acked,
         refresh_pending, blocked_since, renew_failures, controls_used, minute_start, minute_count,
         delivered_seq, retry_at, scopes, repo_ids, budget_epoch, budget_incarnation)
       SELECT ?, ?, 'confirming', ?, ?, 0, 0, 0, NULL, 0, 0, ?, 0, ?, 0, ?, ?, epoch, incarnation
       FROM live_budget_fence WHERE id = 1`,
      socket.id,
      socket.credentialId,
      socket.expiresAt,
      Math.min(now + LIVE_POLICY.renewMs, socket.expiresAt),
      now,
      progress,
      JSON.stringify(socket.scopes),
      socket.repoIds ? JSON.stringify(socket.repoIds) : null,
    );
    for (const dependency of new Set(dependencies))
      this.sql.exec(
        "INSERT INTO live_local_deps (socket_id, dependency) VALUES (?, ?)",
        socket.id,
        dependency,
      );
  }

  /** The socket, once confirmed, seen by the pump. */
  open(socketId: string): void {
    this.sql.exec("UPDATE live_local SET phase = 'open' WHERE socket_id = ?", socketId);
  }

  socket(socketId: string): LiveSocket | undefined {
    return this.sql
      .exec("SELECT * FROM live_local WHERE socket_id = ?", socketId)
      .toArray()[0] as unknown as LiveSocket | undefined;
  }

  sockets(): LiveSocket[] {
    return this.sql
      .exec("SELECT * FROM live_local ORDER BY socket_id")
      .toArray() as unknown as LiveSocket[];
  }

  /** The dependencies a socket rests on. */
  depsOf(socketId: string): string[] {
    return this.sql
      .exec<{ dependency: string }>(
        "SELECT dependency FROM live_local_deps WHERE socket_id = ?",
        socketId,
      )
      .toArray()
      .map((r) => r.dependency);
  }

  /** Forgets a socket's local state. */
  forget(socketId: string): void {
    this.sql.exec("DELETE FROM live_local_deps WHERE socket_id = ?", socketId);
    this.sql.exec("DELETE FROM live_local WHERE socket_id = ?", socketId);
  }

  /**
   * Records revoked dependencies (kept a socket's longest life) and the
   * sockets resting on any of them, to close: in any order, again or not.
   */
  revoke(dependencies: readonly string[], now: number): string[] {
    for (const dependency of new Set(dependencies))
      this.sql.exec(
        `INSERT INTO live_revoked (dependency, at) VALUES (?, ?)
         ON CONFLICT (dependency) DO UPDATE SET at = max(at, excluded.at)`,
        dependency,
        now,
      );
    return this.sql
      .exec<{ socket_id: string }>(
        `SELECT DISTINCT socket_id FROM live_local_deps
         WHERE dependency IN (SELECT value FROM json_each(?))`,
        JSON.stringify(dependencies),
      )
      .toArray()
      .map((r) => r.socket_id);
  }

  /** Marks streams changed, with their causes; whether any was marked. */
  mark(signals: readonly LiveSignal[]): boolean {
    if (signals.length === 0) return false;
    for (const signal of signals) {
      const seq = this.#nextSeq();
      const stream = streamOf(signal.repoId, signal.subject);
      const explicit = "explicit" in signal;
      this.sql.exec(
        `INSERT INTO live_dirty (stream, repo_id, subject, seq, explicit_seq, many_seq)
         VALUES (?1, ?2, ?3, ?4, ?5, 0)
         ON CONFLICT (stream) DO UPDATE SET seq = ?4,
           explicit_seq = max(explicit_seq, excluded.explicit_seq)`,
        stream,
        signal.repoId,
        signal.subject,
        seq,
        explicit ? seq : 0,
      );
      if (explicit) continue;
      if (signal.conversation === null) {
        // No conversation to judge an unsubscribe by: only an ignore holds it back.
        this.sql.exec("UPDATE live_dirty SET many_seq = ? WHERE stream = ?", seq, stream);
        continue;
      }
      const known =
        this.sql
          .exec(
            "SELECT 1 FROM live_candidates WHERE stream = ? AND conversation = ?",
            stream,
            signal.conversation,
          )
          .toArray().length > 0;
      const count = this.sql
        .exec<{ n: number }>("SELECT count(*) AS n FROM live_candidates WHERE stream = ?", stream)
        .one().n;
      if (!known && count >= LIVE_POLICY.candidatesPerStream) {
        this.sql.exec("UPDATE live_dirty SET many_seq = ? WHERE stream = ?", seq, stream);
        continue;
      }
      this.sql.exec(
        `INSERT INTO live_candidates (stream, conversation, direct_seq, ordinary_seq)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (stream, conversation) DO UPDATE SET
           direct_seq = max(direct_seq, excluded.direct_seq),
           ordinary_seq = max(ordinary_seq, excluded.ordinary_seq)`,
        stream,
        signal.conversation,
        signal.direct ? seq : 0,
        signal.direct ? 0 : seq,
      );
    }
    return true;
  }

  /** The highest sequence so far (a pump's capture: changes after it are the next run's). */
  seq(): number {
    return (
      this.sql.exec<{ seq: number }>("SELECT seq FROM live_meta WHERE id = 1").toArray()[0]?.seq ??
      0
    );
  }

  /**
   * The dirty streams after `progress`, up to `upTo`, oldest first: a page
   * of them, and how far the page reaches (its last stream's sequence while
   * more may follow, else `upTo`): progress made from it stops there.
   */
  dirtyAfter(progress: number, upTo: number): { streams: DirtyStream[]; reach: number } {
    const streams = this.sql
      .exec(
        "SELECT * FROM live_dirty WHERE seq > ? AND seq <= ? ORDER BY seq LIMIT ?",
        progress,
        upTo,
        LIVE_POLICY.dirtyPage,
      )
      .toArray() as unknown as DirtyStream[];
    const last = streams.at(-1);
    return {
      streams,
      reach: streams.length === LIVE_POLICY.dirtyPage && last ? last.seq : upTo,
    };
  }

  /** A stream's candidate conversations with causes after `progress` (at most a stream's). */
  candidatesAfter(stream: string, progress: number): Candidate[] {
    return this.sql
      .exec(
        `SELECT * FROM live_candidates WHERE stream = ?1
           AND (direct_seq > ?2 OR ordinary_seq > ?2) LIMIT ?3`,
        stream,
        progress,
        LIVE_POLICY.candidatesPerStream,
      )
      .toArray() as unknown as Candidate[];
  }

  /** Updates a socket's protocol state (the fields given). */
  update(socketId: string, fields: Partial<Omit<LiveSocket, "socket_id" | "credential_id">>): void {
    const names = Object.keys(fields);
    if (names.length === 0) return;
    this.sql.exec(
      `UPDATE live_local SET ${names.map((n) => `${n} = ?`).join(", ")} WHERE socket_id = ?`,
      ...names.map((n) => (fields as Record<string, unknown>)[n] as SqlStorageValue),
      socketId,
    );
  }

  /**
   * Deletes what every socket has heard of (dirty rows and causes at or
   * below the lowest progress, a socket being confirmed's included; all of
   * them with no socket), expired tickets, and revocations past a socket's
   * longest life: a page of each kind, each through its index; whether a
   * kind had more. A stream's causes are never newer than its dirty row
   * (each change moves both), so causes whose row a page took go with a
   * later page of their own (through their index), never kept for good.
   */
  prune(now: number): boolean {
    const lowest =
      this.sql.exec<{ p: number | null }>("SELECT min(delivered_seq) AS p FROM live_local").one()
        .p ?? this.seq();
    const page = LIVE_POLICY.pruneRows;
    const deleted = [
      this.sql
        .exec(
          `DELETE FROM live_dirty WHERE stream IN
           (SELECT stream FROM live_dirty INDEXED BY live_dirty_seq WHERE seq <= ? ORDER BY seq LIMIT ?) RETURNING 1`,
          lowest,
          page,
        )
        .toArray().length,
      this.sql
        .exec(
          `DELETE FROM live_candidates WHERE (stream, conversation) IN
           (SELECT stream, conversation FROM live_candidates INDEXED BY live_candidates_last
             WHERE max(direct_seq, ordinary_seq) <= ? LIMIT ?) RETURNING 1`,
          lowest,
          page,
        )
        .toArray().length,
      this.sql
        .exec(
          `DELETE FROM live_tickets WHERE ticket_hash IN
           (SELECT ticket_hash FROM live_tickets INDEXED BY live_tickets_expiry
             WHERE expires_at <= ? LIMIT ?) RETURNING 1`,
          now,
          page,
        )
        .toArray().length,
      this.sql
        .exec(
          `DELETE FROM live_revoked WHERE dependency IN
           (SELECT dependency FROM live_revoked INDEXED BY live_revoked_at WHERE at <= ? LIMIT ?) RETURNING 1`,
          now - LIVE_POLICY.revokedMs,
          page,
        )
        .toArray().length,
    ];
    return deleted.some((n) => n >= page);
  }

  /**
   * When the pump is next due: at once when an open socket with room has a
   * change it has not heard of; else the earliest of open sockets'
   * deadlines, lives and slow-consumer limits and of admissions' confirmation
   * limits (`confirmMs` after they began).
   */
  nextDue(now: number, confirmMs: number): number | null {
    const row = this.sql
      .exec<{ dirty: number; deadline: number | null }>(
        `SELECT EXISTS (SELECT 1 FROM live_local s
             WHERE s.phase = 'open' AND s.sent - s.acked < ?1 AND s.retry_at <= ?4
               AND EXISTS (SELECT 1 FROM live_dirty INDEXED BY live_dirty_seq
                 WHERE seq > s.delivered_seq)) AS dirty,
           (SELECT min(CASE WHEN phase = 'open'
               THEN min(deadline, expires_at, coalesce(blocked_since + ?2, expires_at),
                 CASE WHEN retry_at > ?4 THEN retry_at ELSE expires_at END)
               ELSE minute_start + ?3 END)
             FROM live_local) AS deadline`,
        LIVE_POLICY.window,
        LIVE_POLICY.slowMs,
        confirmMs,
        now,
      )
      .one();
    if (row.dirty) return now;
    return row.deadline;
  }

  /**
   * Forgets a page of everything live (a retired feed), the first table
   * with rows left; whether it deleted any (more may be left).
   */
  clearStep(): boolean {
    for (const [table, key] of [
      ["live_local_deps", "socket_id, dependency"],
      ["live_local", "socket_id"],
      ["live_tickets", "ticket_hash"],
      ["live_dirty", "stream"],
      ["live_candidates", "stream, conversation"],
      ["live_revoked", "dependency"],
    ] as const) {
      const n = this.sql
        .exec(
          `DELETE FROM ${table} WHERE (${key}) IN (SELECT ${key} FROM ${table} LIMIT ?) RETURNING 1`,
          LIVE_POLICY.pruneRows,
        )
        .toArray().length;
      if (n > 0) return true;
    }
    return false;
  }
}
