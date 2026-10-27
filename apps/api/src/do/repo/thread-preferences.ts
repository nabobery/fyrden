import type { RepoGitStorage } from "@fyrden/adapters-cloudflare/git";
import type { FeedPrincipal } from "./feed.js";
import type { SubjectKind } from "./issues.js";

/*
 * Thread subscriptions: each principal's preference for one conversation
 * (an issue or a pull request) of the repository, `subscribed` (told of
 * its activity as a participant is) or `unsubscribed` (kept and reported;
 * what it suppresses is notifying, which comes later with the inbox), the
 * repository the authority and the directory keeping the acknowledged copy
 * (`thread_preferences`), as with watching. A preference names its
 * conversation by identity, not by number: a restore can give a number to
 * a new conversation, and no preference follows the number to it. Each
 * command takes the principal's next version of its conversation's kind
 * (`preference_versions`) in the repository's current restore generation,
 * the order the copy keeps; deleting a preference deletes its row here
 * (the copy keeps the command, as `none`). At most `maxPerKind`
 * preferences of a kind a principal, and `maxPerState` subscribed and as
 * many unsubscribed a conversation, so deleting one deletes a bounded set
 * with it. A restored repository takes them back from the copy, issues
 * and pull requests apart, as it takes its watchers back.
 */

/** Proposed. */
export const THREAD_POLICY = {
  /** Preferences of one kind (issues, pull requests) a principal keeps at most. */
  maxPerKind: 1_000,
  /** Subscribed, and unsubscribed, principals a conversation keeps at most. */
  maxPerState: 1_000,
  /** Rows one step of a recovery clears or imports. */
  recoveryPage: 200,
  /** Rows of a deleted conversation one step of its cleanup deletes (past those its deletion did). */
  forgetPage: 500,
} as const;

export type ThreadState = "subscribed" | "unsubscribed";

/** A conversation as preferences name it. */
export interface ThreadSubject {
  readonly number: number;
  readonly kind: SubjectKind;
  readonly conversation: string;
}

/** A principal's preference for a conversation, and the command that set it (`none`: deleted). */
export interface ThreadRow extends ThreadSubject {
  readonly principal: string;
  readonly root: string;
  readonly state: ThreadState | "none";
  readonly epochGen: number;
  readonly revision: number;
  readonly at: number;
}

export type ThreadCommand =
  | { readonly status: "recovering" }
  /** The principal's preferences of the kind at their cap. */
  | { readonly status: "full"; readonly cap: "kind" }
  /** The conversation's of the state at theirs: those counted, for the caller to find deleted principals among. */
  | { readonly status: "full"; readonly cap: "thread"; readonly principals: readonly string[] }
  | { readonly status: "set"; readonly row: ThreadRow };

const GROUPS = { issue: "issues", pull: "pulls" } as const;
const VERSIONS = { issue: "issues_version", pull: "pulls_version" } as const;
const KINDS = ["issue", "pull"] as const;

/** A conversation's identity: its own, or, made before identities, its number and creation time. */
const IDENTITY = "coalesce(conversation_id, 'legacy:' || number || ':' || created_at)";

type Stored = {
  principal: string;
  conversation: string;
  number: number;
  kind: SubjectKind;
  root: string;
  state: ThreadState;
  epoch_gen: number;
  revision: number;
  at: number;
};

type Recovery = { target_epoch: number; phase: "clear" | "import"; cursor: string | null };

export class RepoThreadPreferences {
  constructor(
    private readonly deps: {
      readonly git: RepoGitStorage;
      /** The repository's current restore generation. */
      readonly epochGen: () => number;
    },
  ) {}

  get #sql() {
    return this.deps.git.context.storage.sql;
  }

  /** The conversation numbered `number` now; undefined for none. */
  subjectOf(number: number): ThreadSubject | undefined {
    return this.#sql
      .exec<{ kind: SubjectKind; conversation: string }>(
        `SELECT 'issue' AS kind, ${IDENTITY} AS conversation FROM issues WHERE number = ?1
         UNION ALL SELECT 'pull', ${IDENTITY} FROM pull_requests WHERE number = ?1`,
        number,
      )
      .toArray()
      .map((r) => ({ number, kind: r.kind, conversation: r.conversation }))[0];
  }

  /** The principal's preference for the conversation; undefined for none. */
  get(principal: string, conversation: string): ThreadRow | undefined {
    const row = this.#sql
      .exec<Stored>(
        "SELECT * FROM thread_preferences WHERE principal = ? AND conversation = ?",
        principal,
        conversation,
      )
      .toArray()[0];
    return row && rowOf(row);
  }

  /** Whether a kind's preferences (any, without one) are being taken back from the copy. */
  recovering(kind?: SubjectKind): boolean {
    return (
      this.#sql
        .exec(
          "SELECT 1 FROM preference_recovery WHERE grp IN (SELECT value FROM json_each(?))",
          JSON.stringify(kind ? [GROUPS[kind]] : Object.values(GROUPS)),
        )
        .toArray().length > 0
    );
  }

  /**
   * Sets the principal's preference for `subject` (null: deletes it; call
   * within a transaction), taking its next version of the kind; refused
   * while the kind recovers, and past a cap (of the conversation's: the
   * principals counted are answered, so the caller can clear deleted ones
   * among them and try again).
   */
  set(
    principal: string,
    root: string,
    subject: ThreadSubject,
    state: ThreadState | null,
  ): ThreadCommand {
    if (this.recovering(subject.kind)) return { status: "recovering" };
    const before = this.get(principal, subject.conversation);
    if (state !== null && before?.state !== state) {
      if (!before) {
        const kept = this.#sql
          .exec(
            `SELECT 1 FROM thread_preferences INDEXED BY thread_preferences_kind
             WHERE kind = ? AND principal = ? LIMIT ?`,
            subject.kind,
            principal,
            THREAD_POLICY.maxPerKind,
          )
          .toArray().length;
        if (kept >= THREAD_POLICY.maxPerKind) return { status: "full", cap: "kind" };
      }
      const principals = this.#holders(subject.conversation, state);
      if (principals.length >= THREAD_POLICY.maxPerState)
        return { status: "full", cap: "thread", principals };
    }
    const row: ThreadRow = {
      ...subject,
      principal,
      root,
      state: state ?? "none",
      epochGen: this.deps.epochGen(),
      revision: this.#bump(principal, subject.kind),
      at: this.deps.git.context.now(),
    };
    if (state === null)
      this.#sql.exec(
        "DELETE FROM thread_preferences WHERE principal = ? AND conversation = ?",
        principal,
        subject.conversation,
      );
    else this.#put(row as ThreadRow & { state: ThreadState });
    return { status: "set", row };
  }

  /** Deletes the conversation's preferences of principals deleted for good (they free their places). */
  forget(conversation: string, principals: readonly string[]): number {
    if (principals.length === 0) return 0;
    return this.#sql
      .exec(
        `DELETE FROM thread_preferences WHERE conversation = ?
           AND principal IN (SELECT value FROM json_each(?)) RETURNING 1`,
        conversation,
        JSON.stringify(principals),
      )
      .toArray().length;
  }

  /**
   * The subscribers an event of conversation `number` may tell, at most
   * `maxPerState` in the index's order (more, after a restore, wait their
   * turn: `overflow`); none while its kind recovers.
   */
  subscribers(number: number): {
    readonly subscribers: readonly FeedPrincipal[];
    readonly overflow: boolean;
  } {
    const subject = this.subjectOf(number);
    if (!subject || this.recovering(subject.kind)) return { subscribers: [], overflow: false };
    const rows = this.#sql
      .exec<{ principal: string; root: string }>(
        `SELECT principal, root FROM thread_preferences INDEXED BY thread_preferences_thread
         WHERE conversation = ? AND state = 'subscribed' ORDER BY revision, principal LIMIT ?`,
        subject.conversation,
        THREAD_POLICY.maxPerState + 1,
      )
      .toArray();
    return {
      subscribers: rows
        .slice(0, THREAD_POLICY.maxPerState)
        .map((r) => ({ id: r.principal, root: r.root })),
      overflow: rows.length > THREAD_POLICY.maxPerState,
    };
  }

  /**
   * In a conversation's deletion (its transaction, before its row goes):
   * deletes its preferences, as many as its caps allow (both states'),
   * bumping their principals' versions of the kind. More, which only a
   * restore brings back, are left for `forgetStep`: returns whether any are
   * (no event reads them meanwhile: their conversation is gone).
   */
  forgetConversation(number: number): boolean {
    const subject = this.subjectOf(number);
    if (!subject) return false;
    const { conversation, kind } = subject;
    if (this.#forget(conversation, kind, 2 * THREAD_POLICY.maxPerState) === 0) return false;
    this.#sql.exec(
      "INSERT INTO thread_forgets (conversation, kind) VALUES (?, ?) ON CONFLICT DO NOTHING",
      conversation,
      kind,
    );
    return true;
  }

  /**
   * One step of deleting what conversations' deletions left: a page of the
   * first's preferences. Returns whether any are left.
   */
  forgetStep(): boolean {
    const [next] = this.#sql
      .exec<{ conversation: string; kind: SubjectKind }>(
        "SELECT conversation, kind FROM thread_forgets LIMIT 1",
      )
      .toArray();
    if (!next) return false;
    if (this.#forget(next.conversation, next.kind, THREAD_POLICY.forgetPage) === 0)
      this.#sql.exec("DELETE FROM thread_forgets WHERE conversation = ?", next.conversation);
    return this.#sql.exec("SELECT 1 FROM thread_forgets LIMIT 1").toArray().length > 0;
  }

  /**
   * Deletes up to `limit` of the conversation's preferences, bumping their
   * principals' versions; how many it has left (0, or at least 1).
   */
  #forget(conversation: string, kind: SubjectKind, limit: number): number {
    const principals = this.#sql
      .exec<{ principal: string }>(
        `DELETE FROM thread_preferences WHERE (principal, conversation) IN
           (SELECT principal, conversation FROM thread_preferences
              INDEXED BY thread_preferences_thread
            WHERE conversation = ? LIMIT ?)
         RETURNING principal`,
        conversation,
        limit,
      )
      .toArray()
      .map((r) => r.principal);
    this.#bumpAll(principals, kind);
    if (principals.length < limit) return 0;
    return this.#sql
      .exec("SELECT 1 FROM thread_preferences WHERE conversation = ? LIMIT 1", conversation)
      .toArray().length;
  }

  /** After a restore (in its transaction): both kinds taken back from the copy, from the start. */
  restored(epochGen: number): void {
    for (const grp of Object.values(GROUPS))
      this.#sql.exec(
        `INSERT INTO preference_recovery (grp, target_epoch, phase, cursor) VALUES (?, ?, 'clear', NULL)
         ON CONFLICT (grp) DO UPDATE SET target_epoch = excluded.target_epoch, phase = 'clear',
           cursor = NULL`,
        grp,
        epochGen,
      );
  }

  /**
   * One step of a recovery, of the first kind recovering: clears a page of
   * its rows, or imports a page of the copy's (`read`: its rows of the kind
   * after a `(principal, conversation)` cursor, in that order, each saying
   * whether its principal is still there), taking back only those of
   * conversations here now, written only when the recovery is still the
   * one the step started in (a restore meanwhile starts it again). Returns
   * whether a full page was worked through.
   */
  async recoverStep(
    read: (
      kind: SubjectKind,
      after: readonly [string, string] | null,
      limit: number,
    ) => Promise<readonly (ThreadRow & { readonly active: boolean })[]>,
  ): Promise<boolean> {
    const kind = KINDS.find((k) => this.recovering(k));
    if (!kind) return false;
    const grp = GROUPS[kind];
    let state = this.#state(grp) as Recovery;
    const page = THREAD_POLICY.recoveryPage;
    if (state.phase === "clear") {
      const cleared = this.deps.git.context.storage.transactionSync(() => {
        const principals = this.#sql
          .exec<{ principal: string }>(
            `DELETE FROM thread_preferences WHERE (principal, conversation) IN
               (SELECT principal, conversation FROM thread_preferences
                  INDEXED BY thread_preferences_kind
                WHERE kind = ? ORDER BY principal, conversation LIMIT ?)
             RETURNING principal`,
            kind,
            page,
          )
          .toArray()
          .map((r) => r.principal);
        this.#bumpAll(principals, kind);
        if (principals.length < page)
          this.#sql.exec(
            "UPDATE preference_recovery SET phase = 'import', cursor = NULL WHERE grp = ?",
            grp,
          );
        return principals.length;
      });
      // A full page cleared: more may be left, for another step.
      if (cleared >= page) return true;
      // The last of it: the import starts in this same step.
      state = { ...state, phase: "import", cursor: null };
    }
    const after = state.cursor === null ? null : (JSON.parse(state.cursor) as [string, string]);
    const rows = await read(kind, after, page);
    const now = this.#state(grp);
    // Another restore, or another step, since the read: this page is not the recovery's now.
    if (
      !now ||
      now.target_epoch !== state.target_epoch ||
      now.phase !== "import" ||
      now.cursor !== state.cursor
    )
      return true;
    this.deps.git.context.storage.transactionSync(() => {
      const taken: string[] = [];
      for (const row of rows) {
        // A deletion's command, a principal deleted since (it frees its place; a suspended one
        // keeps its preferences), a conversation not here now: nothing to take back.
        if (row.state === "none" || !row.active) continue;
        const subject = this.subjectOf(row.number);
        if (subject?.kind !== kind || subject.conversation !== row.conversation) continue;
        this.#put(row as ThreadRow & { state: ThreadState });
        taken.push(row.principal);
      }
      this.#bumpAll(taken, kind);
      const last = rows.at(-1);
      if (rows.length < page || !last)
        this.#sql.exec("DELETE FROM preference_recovery WHERE grp = ?", grp);
      else
        this.#sql.exec(
          "UPDATE preference_recovery SET cursor = ? WHERE grp = ?",
          JSON.stringify([last.principal, last.conversation]),
          grp,
        );
    });
    return rows.length >= page;
  }

  #put(row: ThreadRow & { state: ThreadState }): void {
    this.#sql.exec(
      `INSERT INTO thread_preferences
         (principal, conversation, number, kind, root, state, epoch_gen, revision, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (principal, conversation) DO UPDATE SET number = excluded.number,
         kind = excluded.kind, root = excluded.root, state = excluded.state,
         epoch_gen = excluded.epoch_gen, revision = excluded.revision, at = excluded.at`,
      row.principal,
      row.conversation,
      row.number,
      row.kind,
      row.root,
      row.state,
      row.epochGen,
      row.revision,
      row.at,
    );
  }

  /** The conversation's principals of `state`, in the index's order, at most the cap and one. */
  #holders(conversation: string, state: ThreadState): string[] {
    return this.#sql
      .exec<{ principal: string }>(
        `SELECT principal FROM thread_preferences INDEXED BY thread_preferences_thread
         WHERE conversation = ? AND state = ? ORDER BY revision, principal LIMIT ?`,
        conversation,
        state,
        THREAD_POLICY.maxPerState + 1,
      )
      .toArray()
      .map((r) => r.principal);
  }

  /** The principal's next version of the kind: its command's revision. */
  #bump(principal: string, kind: SubjectKind): number {
    const column = VERSIONS[kind];
    return this.#sql
      .exec<{ version: number }>(
        `INSERT INTO preference_versions (principal, ${column}) VALUES (?, 1)
         ON CONFLICT (principal) DO UPDATE SET ${column} = ${column} + 1
         RETURNING ${column} AS version`,
        principal,
      )
      .one().version;
  }

  /** Each of `principals`' versions of the kind bumped once: their preferences changed. */
  #bumpAll(principals: readonly string[], kind: SubjectKind): void {
    if (principals.length === 0) return;
    const column = VERSIONS[kind];
    this.#sql.exec(
      `INSERT INTO preference_versions (principal, ${column})
       SELECT DISTINCT value, 1 FROM json_each(?) WHERE true
       ON CONFLICT (principal) DO UPDATE SET ${column} = ${column} + 1`,
      JSON.stringify(principals),
    );
  }

  #state(grp: string): Recovery | undefined {
    return this.#sql
      .exec<Recovery>(
        "SELECT target_epoch, phase, cursor FROM preference_recovery WHERE grp = ?",
        grp,
      )
      .toArray()[0];
  }
}

const rowOf = (r: Stored): ThreadRow => ({
  principal: r.principal,
  root: r.root,
  conversation: r.conversation,
  number: r.number,
  kind: r.kind,
  state: r.state,
  epochGen: r.epoch_gen,
  revision: r.revision,
  at: r.at,
});

/** In a watch command's transaction: the principal's ignore version bumped (ignoring set or left). */
export function bumpIgnoreVersion(sql: SqlStorage, principal: string): void {
  sql.exec(
    `INSERT INTO preference_versions (principal, ignore_version) VALUES (?, 1)
     ON CONFLICT (principal) DO UPDATE SET ignore_version = ignore_version + 1`,
    principal,
  );
}
