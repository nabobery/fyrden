import type { RepoGitStorage } from "@fyrden/adapters-cloudflare/git";
import type { FeedSubjectKind } from "@fyrden/domain";

/*
 * Digests for watchers past the pushed tier (the first 100 watchers by
 * `(revision, principal)` are told of each event; the rest, at most 5,000
 * in all, once a window). The repository keeps each window's threads per
 * kind as they happen, spending a credit the deployment's daily allowance
 * granted it in advance (so nothing is written that was not admitted), and
 * seals a window a minute after it ends: its members (for each kind, the
 * watchers past the lowest floor of its live threads, who read the
 * repository then) written as pages, and one `repository.digest` event
 * that delivers each an item per kind. What a digest holds is resolved
 * when it is read, against the repository as it is then: a deleted
 * conversation's threads go with it, so it never shows, nor counts toward
 * whether a digest shows (`live`) or who is told of it (the floor).
 *
 * Windows and credit belong to the restore generation they were made in:
 * an older generation's are never sealed, resolved or spent, and go with
 * cleanup.
 */

/** Proposed values. */
export const DIGEST_POLICY = {
  /** A window's length. */
  windowMs: 15 * 60_000,
  /** How long after a window ends it is sealed (events of its last moments in). */
  sealAfterMs: 60_000,
  /** Threads a window keeps of a kind; past it, the kind's bucket is truncated. */
  maxThreads: 5_000,
  /** Members a window's kind tells at most (in the watchers' order). */
  maxMembers: 5_000,
  /** Distinct actor roots a thread keeps; more: `many`. */
  maxActors: 8,
  /** Credit a request asks for, and the balance under which a kind asks again. */
  creditBlock: 200,
  creditLow: 50,
  /**
   * How long granted credit may be spent: an hour, and never past the end
   * of the hour after the one the ledger charged it to (see the allowance).
   */
  creditTtlMs: 60 * 60_000,
  /** Units a new bucket spends (its row, its incomplete and truncated marks, its cleanup) and a thread. */
  bucketUnits: 4,
  threadUnits: 1,
  /** How long a refused or unanswered credit request waits before asking again (doubling). */
  creditRetryMs: 60_000,
  creditRetryMaxMs: 15 * 60_000,
  /** How long a seal waits while the repository cannot publish (doubling). */
  sealRetryMs: 60_000,
  sealRetryMaxMs: 60 * 60_000,
  /** How long members may still be told after a window ends. */
  deliveryMs: 24 * 60 * 60_000,
  /** How long a window's rows are kept after it (every item it made has expired by then). */
  keepMs: 16 * 24 * 60 * 60_000,
  /** Windows one seal slice seals at most, and rows one cleanup slice deletes. */
  sealsPerRun: 4,
  sliceRows: 500,
  /** A deleted conversation's digest rows deleted with it; more go with cleanup. */
  forgetInTransaction: 250,
} as const;

/** A watcher's place in the index's order. */
export interface WatcherKey {
  readonly revision: number;
  readonly principal: string;
}

/** What an event tells a window of its thread. */
export interface DigestEntry {
  readonly subject: FeedSubjectKind;
  readonly conversation: string;
  readonly number: number;
  readonly at: number;
  /** The actor's root identity (the user its agents act for); none for the system. */
  readonly actorRoot: string | null;
  /** The last pushed watcher's key when it happened (the floor). */
  readonly floor: WatcherKey;
}

/** One digest member: a watcher and the kinds it is told of. */
export interface DigestMember {
  readonly principal: string;
  readonly root: string;
  readonly kinds: readonly FeedSubjectKind[];
}

/** A window's threads of one kind. */
export type DigestBucket = {
  readonly win: number;
  readonly epoch_gen: number;
  readonly subject: FeedSubjectKind;
  readonly threads: number;
  readonly live: number;
  readonly truncated: number;
  readonly incomplete: number;
  readonly sealed: number;
};

/** A credit request to make of the ledger. */
export interface CreditAsk {
  readonly subject: FeedSubjectKind;
  readonly request: string;
  readonly epoch: number;
}

type Credit = {
  subject: string;
  epoch_gen: number;
  units: number;
  expires_at: number;
  wanted: number;
  pending: string | null;
  retry_at: number;
  refusals: number;
};

export interface DigestDeps {
  readonly git: RepoGitStorage;
  /** The repository's current restore generation. */
  readonly epochGen: () => number;
  /** Whether watch audiences are on (the deployment's switch). */
  readonly audiences: () => boolean;
  /** Whether credit is spent at all (false: nothing capped, as on Paid without an allowance). */
  readonly capped: () => boolean;
  /** Asks for the credit job to run (a kind's credit is wanted: see `creditAsks`). */
  readonly wantCredit: () => void;
}

/** The window a time falls in. */
export const windowOf = (at: number) => Math.floor(at / DIGEST_POLICY.windowMs);

const before = (a: WatcherKey, b: WatcherKey) =>
  a.revision < b.revision || (a.revision === b.revision && a.principal < b.principal);

export class RepoDigests {
  constructor(private readonly deps: DigestDeps) {}

  get #sql() {
    return this.deps.git.context.storage.sql;
  }

  #now() {
    return this.deps.git.context.now();
  }

  /**
   * Records an event's thread in its window (call within the event's
   * transaction), spending the kind's credit: a new bucket its units, each
   * thread written one. Nothing is written without credit; a bucket that
   * runs out is marked incomplete (prepaid with it). The thread keeps the
   * lowest floor of its events. Returns whether it was recorded.
   */
  record(entry: DigestEntry): boolean {
    const epoch = this.deps.epochGen();
    const window = windowOf(entry.at);
    const bucket = this.#bucket(window, epoch, entry.subject);
    if (bucket?.sealed) return false;
    const thread = this.#sql
      .exec<{ actors: string; many: number; floor_revision: number; floor_principal: string }>(
        `SELECT actors, many, floor_revision, floor_principal FROM digest_threads
         WHERE win = ? AND epoch_gen = ? AND subject = ? AND conversation = ?`,
        window,
        epoch,
        entry.subject,
        entry.conversation,
      )
      .toArray()[0];
    if (bucket && !thread && bucket.threads >= DIGEST_POLICY.maxThreads) {
      if (!bucket.truncated) this.#mark(bucket, "truncated");
      return false;
    }
    const units = bucket ? DIGEST_POLICY.threadUnits : DIGEST_POLICY.bucketUnits;
    if (!this.#spend(entry.subject, epoch, units)) {
      if (bucket && !bucket.incomplete) this.#mark(bucket, "incomplete");
      return false;
    }
    if (!bucket)
      this.#sql.exec(
        `INSERT INTO digest_windows (win, epoch_gen, subject, threads, live, truncated,
           incomplete, sealed)
         VALUES (?, ?, ?, 1, 1, 0, 0, 0)`,
        window,
        epoch,
        entry.subject,
      );
    else if (!thread)
      this.#sql.exec(
        `UPDATE digest_windows SET threads = threads + 1, live = live + 1
         WHERE win = ? AND epoch_gen = ? AND subject = ?`,
        window,
        epoch,
        entry.subject,
      );
    const actors = thread ? (JSON.parse(thread.actors) as string[]) : [];
    let many = thread?.many ?? 0;
    if (entry.actorRoot !== null && !actors.includes(entry.actorRoot)) {
      if (actors.length < DIGEST_POLICY.maxActors) actors.push(entry.actorRoot);
      else many = 1;
    }
    const floor =
      thread &&
      !before(entry.floor, {
        revision: thread.floor_revision,
        principal: thread.floor_principal,
      })
        ? { revision: thread.floor_revision, principal: thread.floor_principal }
        : entry.floor;
    this.#sql.exec(
      `INSERT INTO digest_threads (win, epoch_gen, subject, conversation, number, last_at,
         actors, many, floor_revision, floor_principal)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (win, epoch_gen, subject, conversation) DO UPDATE SET
         last_at = max(last_at, excluded.last_at), actors = excluded.actors, many = excluded.many,
         floor_revision = excluded.floor_revision, floor_principal = excluded.floor_principal`,
      window,
      epoch,
      entry.subject,
      entry.conversation,
      entry.number,
      entry.at,
      JSON.stringify(actors),
      many,
      floor.revision,
      floor.principal,
    );
    return true;
  }

  #bucket(window: number, epoch: number, subject: string): DigestBucket | undefined {
    return this.#sql
      .exec<DigestBucket>(
        "SELECT * FROM digest_windows WHERE win = ? AND epoch_gen = ? AND subject = ?",
        window,
        epoch,
        subject,
      )
      .toArray()[0];
  }

  #mark(bucket: DigestBucket, flag: "truncated" | "incomplete"): void {
    this.#sql.exec(
      `UPDATE digest_windows SET ${flag} = 1 WHERE win = ? AND epoch_gen = ? AND subject = ?`,
      bucket.win,
      bucket.epoch_gen,
      bucket.subject,
    );
  }

  /**
   * Spends `units` of the kind's credit of the current generation, unspent
   * and unexpired; whether there was enough. A balance falling low (or none
   * at all) is marked wanted, once until a grant (the credit job reads it).
   */
  #spend(subject: FeedSubjectKind, epoch: number, units: number): boolean {
    if (!this.deps.capped()) return true;
    const credit = this.#credit(subject);
    const usable = this.#usable(credit, epoch);
    if (usable - units < DIGEST_POLICY.creditLow && !credit?.wanted) {
      this.#sql.exec(
        `INSERT INTO digest_credit (subject, epoch_gen, units, expires_at, wanted, pending,
           retry_at, refusals)
         VALUES (?, ?, 0, 0, 1, NULL, 0, 0)
         ON CONFLICT (subject) DO UPDATE SET wanted = 1`,
        subject,
        epoch,
      );
      this.deps.wantCredit();
    }
    if (usable < units) return false;
    this.#sql.exec("UPDATE digest_credit SET units = units - ? WHERE subject = ?", units, subject);
    return true;
  }

  #usable(credit: Credit | undefined, epoch: number): number {
    return credit !== undefined && credit.epoch_gen === epoch && credit.expires_at > this.#now()
      ? credit.units
      : 0;
  }

  #credit(subject: string): Credit | undefined {
    return this.#sql
      .exec<Credit>("SELECT * FROM digest_credit WHERE subject = ?", subject)
      .toArray()[0];
  }

  /**
   * The credit requests due now (call within a transaction): each kind
   * wanted whose last request was answered (refused) or unanswered and its
   * wait is over, or that never asked. An unanswered request is asked again
   * by its own id (only an answer installs or clears it); otherwise a new
   * id is made. None while credit is not capped or audiences are off.
   */
  creditAsks(): CreditAsk[] {
    if (!this.deps.capped() || !this.deps.audiences()) return [];
    const now = this.#now();
    const epoch = this.deps.epochGen();
    return this.#sql
      .exec<Credit>("SELECT * FROM digest_credit WHERE wanted = 1 AND retry_at <= ?", now)
      .toArray()
      .map((credit) => {
        const request = credit.pending ?? crypto.randomUUID();
        // Asked: unanswered until an answer says otherwise (a lost call waits as a refusal does).
        this.#sql.exec(
          "UPDATE digest_credit SET pending = ?, retry_at = ? WHERE subject = ?",
          request,
          now + this.#wait(credit.refusals),
          credit.subject,
        );
        return { subject: credit.subject as FeedSubjectKind, request, epoch };
      });
  }

  #wait(refusals: number): number {
    return Math.min(DIGEST_POLICY.creditRetryMs * 2 ** refusals, DIGEST_POLICY.creditRetryMaxMs);
  }

  /**
   * Installs a granted request's credit (call within a transaction, with no
   * await since the generation was read), spendable until `expiresAt`: only
   * while it is still the kind's pending request and of the current
   * generation; whether it was.
   */
  grant(ask: CreditAsk, units: number, expiresAt: number): boolean {
    const credit = this.#credit(ask.subject);
    if (credit?.pending !== ask.request || ask.epoch !== this.deps.epochGen()) return false;
    this.#sql.exec(
      `UPDATE digest_credit SET epoch_gen = ?, units = ?, expires_at = ?, wanted = 0,
         pending = NULL, retry_at = 0, refusals = 0
       WHERE subject = ?`,
      ask.epoch,
      units,
      expiresAt,
      ask.subject,
    );
    return true;
  }

  /**
   * A request answered and refused: the kind asks again with a new one
   * later, the wait doubling with each refusal in a row to its ceiling.
   */
  refused(ask: CreditAsk): void {
    this.#sql.exec(
      `UPDATE digest_credit SET pending = NULL, retry_at = ?, refusals = refusals + 1
       WHERE subject = ? AND pending = ?`,
      this.#now() + this.#wait(this.#credit(ask.subject)?.refusals ?? 0),
      ask.subject,
      ask.request,
    );
  }

  /** A request whose answer was lost: asked again by its id later, the wait doubling. */
  unanswered(ask: CreditAsk): void {
    this.#sql.exec(
      "UPDATE digest_credit SET retry_at = ?, refusals = refusals + 1 WHERE subject = ? AND pending = ?",
      this.#now() + this.#wait(this.#credit(ask.subject)?.refusals ?? 0),
      ask.subject,
      ask.request,
    );
  }

  /** When the credit job is next due: the earliest wanted kind's retry; null for none. */
  nextCreditDue(): number | null {
    if (!this.deps.capped() || !this.deps.audiences()) return null;
    return this.#sql
      .exec<{ at: number | null }>("SELECT min(retry_at) AS at FROM digest_credit WHERE wanted = 1")
      .one().at;
  }

  /** Drops unused credit and requests (the audiences turned off, or nothing capped). */
  dropCredit(): void {
    this.#sql.exec("DELETE FROM digest_credit");
  }

  /**
   * The windows due to seal now, of the current generation, oldest first:
   * at most `sealsPerRun`.
   */
  dueWindows(): number[] {
    const due = windowOf(this.#now() - DIGEST_POLICY.sealAfterMs);
    return this.#sql
      .exec<{ win: number }>(
        `SELECT DISTINCT win FROM digest_windows INDEXED BY digest_windows_due
         WHERE sealed = 0 AND epoch_gen = ? AND win < ? ORDER BY win LIMIT ?`,
        this.deps.epochGen(),
        due,
        DIGEST_POLICY.sealsPerRun,
      )
      .toArray()
      .map((r) => r.win);
  }

  /**
   * A window's buckets of the current generation, unsealed, that hold live
   * threads: counting none of a deleted conversation whose rows are still
   * being deleted (its threads read until the first other one: with none
   * pending, one).
   */
  liveBuckets(window: number): DigestBucket[] {
    return this.#sql
      .exec<DigestBucket>(
        `SELECT * FROM digest_windows b WHERE win = ?1 AND epoch_gen = ?2 AND sealed = 0
           AND live > 0 AND EXISTS (SELECT 1 FROM digest_threads t
             WHERE t.win = b.win AND t.epoch_gen = b.epoch_gen AND t.subject = b.subject
               AND t.conversation NOT IN (SELECT conversation FROM digest_forgets))`,
        window,
        this.deps.epochGen(),
      )
      .toArray();
  }

  /** Marks a window's buckets sealed (published, or with nothing to publish); call within a transaction. */
  sealed(window: number): void {
    this.#sql.exec(
      "UPDATE digest_windows SET sealed = 1 WHERE win = ? AND epoch_gen = ? AND sealed = 0",
      window,
      this.deps.epochGen(),
    );
  }

  /**
   * The lowest floor of a bucket's threads (those the repository still
   * has: none of a deleted conversation whose rows are still being deleted).
   */
  #floor(bucket: DigestBucket): WatcherKey | undefined {
    return this.#sql
      .exec<{ revision: number; principal: string }>(
        `SELECT floor_revision AS revision, floor_principal AS principal
         FROM digest_threads INDEXED BY digest_threads_floor
         WHERE win = ? AND epoch_gen = ? AND subject = ?
           AND conversation NOT IN (SELECT conversation FROM digest_forgets)
         ORDER BY floor_revision, floor_principal LIMIT 1`,
        bucket.win,
        bucket.epoch_gen,
        bucket.subject,
      )
      .toArray()[0];
  }

  /**
   * The members of a window's buckets: for each kind on its own, the
   * watchers past the lowest floor of its threads (index order, at most
   * `maxMembers`) who read the repository now (`reads`), merged with the
   * kinds each is told of. One kind's activity never decides another's
   * members.
   */
  members(
    buckets: readonly DigestBucket[],
    watchersAfter: (
      floor: WatcherKey,
      limit: number,
    ) => readonly { principal: string; root: string }[],
    reads: (principal: string) => boolean,
  ): DigestMember[] {
    const members = new Map<
      string,
      { principal: string; root: string; kinds: FeedSubjectKind[] }
    >();
    for (const bucket of buckets) {
      const floor = this.#floor(bucket);
      if (!floor) continue;
      for (const watcher of watchersAfter(floor, DIGEST_POLICY.maxMembers)) {
        if (!reads(watcher.principal)) continue;
        const member = members.get(watcher.principal) ?? { ...watcher, kinds: [] };
        member.kinds.push(bucket.subject);
        members.set(watcher.principal, member);
      }
    }
    return [...members.values()];
  }

  /**
   * Removes a deleted conversation's digest rows (call within its
   * deletion's transaction), lowering their buckets' live counts: at most
   * `forgetInTransaction`; whether more are left (for cleanup to finish).
   */
  forgetConversation(conversation: string, subject: FeedSubjectKind): boolean {
    const more = this.#forget(conversation, DIGEST_POLICY.forgetInTransaction);
    if (more)
      this.#sql.exec(
        "INSERT INTO digest_forgets (conversation, subject) VALUES (?, ?) ON CONFLICT DO NOTHING",
        conversation,
        subject,
      );
    return more;
  }

  /** Deletes up to `limit` of a conversation's rows; whether that many were (more may be left). */
  #forget(conversation: string, limit: number): boolean {
    const gone = this.#sql
      .exec<{ win: number; epoch_gen: number; subject: string }>(
        `DELETE FROM digest_threads WHERE (win, epoch_gen, subject, conversation) IN
           (SELECT win, epoch_gen, subject, conversation FROM digest_threads
            INDEXED BY digest_threads_conversation WHERE conversation = ? LIMIT ?)
         RETURNING win, epoch_gen, subject`,
        conversation,
        limit,
      )
      .toArray();
    for (const row of gone)
      this.#sql.exec(
        `UPDATE digest_windows SET live = max(live - 1, 0)
         WHERE win = ? AND epoch_gen = ? AND subject = ?`,
        row.win,
        row.epoch_gen,
        row.subject,
      );
    return gone.length >= limit;
  }

  /**
   * A bucket to clean up: expired, of an older generation, or discarded
   * while audiences were off (each found by an index, reading one row).
   */
  #stale(): Pick<DigestBucket, "win" | "epoch_gen" | "subject"> | undefined {
    const expired = windowOf(this.#now() - DIGEST_POLICY.keepMs);
    return this.#sql
      .exec<Pick<DigestBucket, "win" | "epoch_gen" | "subject">>(
        `SELECT * FROM (SELECT win, epoch_gen, subject FROM digest_windows
           WHERE win < ?1 LIMIT 1)
         UNION ALL SELECT * FROM (SELECT win, epoch_gen, subject FROM digest_windows
           INDEXED BY digest_windows_generation WHERE epoch_gen < ?2 LIMIT 1)
         UNION ALL SELECT * FROM (SELECT win, epoch_gen, subject FROM digest_windows
           INDEXED BY digest_windows_due WHERE sealed = 2 LIMIT 1)
         LIMIT 1`,
        expired,
        this.deps.epochGen(),
      )
      .toArray()[0];
  }

  /** Whether a deleted conversation's rows are still left. */
  forgetting(): boolean {
    return this.#sql.exec("SELECT 1 FROM digest_forgets LIMIT 1").toArray().length > 0;
  }

  /**
   * One cleanup slice: a deleted conversation's rows left over, else a
   * stale bucket's threads, then the bucket (at most `sliceRows` rows and
   * one bucket). Returns whether it deleted anything (more may be left).
   */
  cleanupStep(): boolean {
    const slice = DIGEST_POLICY.sliceRows;
    const pending = this.#sql
      .exec<{ conversation: string }>("SELECT conversation FROM digest_forgets LIMIT 1")
      .toArray()[0];
    if (pending) {
      if (!this.#forget(pending.conversation, slice))
        this.#sql.exec("DELETE FROM digest_forgets WHERE conversation = ?", pending.conversation);
      return true;
    }
    const stale = this.#stale();
    if (!stale) return false;
    const threads = this.#sql
      .exec(
        `DELETE FROM digest_threads WHERE (win, epoch_gen, subject, conversation) IN
           (SELECT win, epoch_gen, subject, conversation FROM digest_threads
            WHERE win = ? AND epoch_gen = ? AND subject = ? LIMIT ?)
         RETURNING 1`,
        stale.win,
        stale.epoch_gen,
        stale.subject,
        slice,
      )
      .toArray().length;
    if (threads < slice)
      this.#sql.exec(
        "DELETE FROM digest_windows WHERE win = ? AND epoch_gen = ? AND subject = ?",
        stale.win,
        stale.epoch_gen,
        stale.subject,
      );
    return true;
  }

  /**
   * Marks a window's unsealed buckets discarded (audiences off at its
   * seal): never published, their rows left to cleanup.
   */
  discard(window: number): void {
    this.#sql.exec(
      "UPDATE digest_windows SET sealed = 2 WHERE win = ? AND epoch_gen = ? AND sealed = 0",
      window,
      this.deps.epochGen(),
    );
  }

  /**
   * When the seal job is next due: now while cleanup is left, else the
   * next window to seal or to expire; null for nothing.
   */
  nextDue(): number | null {
    const now = this.#now();
    if (this.forgetting() || this.#stale()) return now;
    const { unsealed, oldest } = this.#sql
      .exec<{ unsealed: number | null; oldest: number | null }>(
        `SELECT
           (SELECT min(win) FROM digest_windows INDEXED BY digest_windows_due
            WHERE sealed = 0 AND epoch_gen = ?) AS unsealed,
           (SELECT min(win) FROM digest_windows) AS oldest`,
        this.deps.epochGen(),
      )
      .one();
    const times: number[] = [];
    if (unsealed !== null)
      times.push((unsealed + 1) * DIGEST_POLICY.windowMs + DIGEST_POLICY.sealAfterMs);
    if (oldest !== null) times.push((oldest + 1) * DIGEST_POLICY.windowMs + DIGEST_POLICY.keepMs);
    return times.length === 0 ? null : Math.max(now, Math.min(...times));
  }
}
