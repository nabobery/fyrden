import type { RepoGitStorage } from "@fyrden/adapters-cloudflare/git";
import type { FeedPrincipal } from "./feed.js";

/*
 * Who watches the repository: each principal's level (`participating`, the
 * default, `watching` or `ignoring`), the repository the authority and the
 * directory keeping the acknowledged copy (`watch_preferences`). Every
 * command takes the principal's next revision in the repository's current
 * restore generation, the order the copy keeps. At most `maxWatchers`
 * principals watch (digests, which carry more, come later). A restored
 * repository takes its watchers back from the copy before anyone watches
 * or changes a level again: its rows cleared, then the copy's imported, a
 * page at a time; meanwhile commands are refused and events tell no
 * watcher. Ignoring is kept and reported; what it suppresses is notifying,
 * which comes later with the inbox.
 */

/** Proposed. */
export const WATCH_POLICY = {
  /** Principals watching at most (the pushed tier). */
  maxWatchers: 100,
  /** Rows one step of a recovery clears or imports. */
  recoveryPage: 200,
} as const;

export const WATCH_LEVELS = ["participating", "watching", "ignoring"] as const;
export type WatchLevel = (typeof WATCH_LEVELS)[number];

/** A principal's level, and the command that set it. */
export interface WatchRow {
  readonly principal: string;
  readonly root: string;
  readonly level: WatchLevel;
  readonly epochGen: number;
  readonly revision: number;
  readonly at: number;
}

export type WatchCommand =
  | { readonly status: "recovering" }
  /** At the cap: the watchers counted, for the caller to find deleted principals among. */
  | { readonly status: "full"; readonly watchers: readonly string[] }
  | { readonly status: "set"; readonly row: WatchRow };

type Stored = {
  principal: string;
  root: string;
  level: WatchLevel;
  epoch_gen: number;
  revision: number;
  at: number;
};

const rowOf = (r: Stored): WatchRow => ({
  principal: r.principal,
  root: r.root,
  level: r.level,
  epochGen: r.epoch_gen,
  revision: r.revision,
  at: r.at,
});

/** The first watchers in the index's order (no sort), at most `n`. */
const WATCHING = `SELECT principal, root FROM watchers INDEXED BY watchers_level
  WHERE level = 'watching' ORDER BY revision, principal LIMIT ?`;

export class RepoWatching {
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

  /** The principal's level; undefined while it participates by default. */
  get(principal: string): WatchRow | undefined {
    const row = this.#sql
      .exec<Stored>("SELECT * FROM watchers WHERE principal = ?", principal)
      .toArray()[0];
    return row && rowOf(row);
  }

  /** Whether the watchers are being taken back from the directory's copy (after a restore). */
  recovering(): boolean {
    return (
      this.#sql.exec("SELECT 1 FROM preference_recovery WHERE grp = 'watches'").toArray().length > 0
    );
  }

  /**
   * Sets the principal's level (call within a transaction), taking its next
   * revision; refused while recovering, and when it would watch past the
   * cap (the watchers counted are answered, so the caller can clear deleted
   * principals among them and try again).
   */
  set(principal: string, root: string, level: WatchLevel): WatchCommand {
    if (this.recovering()) return { status: "recovering" };
    const before = this.get(principal);
    if (level === "watching" && before?.level !== "watching") {
      const watchers = this.#sql
        .exec<{ principal: string }>(WATCHING, WATCH_POLICY.maxWatchers + 1)
        .toArray()
        .map((r) => r.principal);
      if (watchers.length >= WATCH_POLICY.maxWatchers) return { status: "full", watchers };
    }
    const row: WatchRow = {
      principal,
      root,
      level,
      epochGen: this.deps.epochGen(),
      revision: (before?.revision ?? 0) + 1,
      at: this.deps.git.context.now(),
    };
    this.#sql.exec(
      `INSERT INTO watchers (principal, root, level, epoch_gen, revision, at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (principal) DO UPDATE SET root = excluded.root, level = excluded.level,
         epoch_gen = excluded.epoch_gen, revision = excluded.revision, at = excluded.at`,
      row.principal,
      row.root,
      row.level,
      row.epochGen,
      row.revision,
      row.at,
    );
    return { status: "set", row };
  }

  /** Deletes the rows of principals deleted for good (they free their places). */
  forget(principals: readonly string[]): number {
    if (principals.length === 0) return 0;
    return this.#sql
      .exec(
        "DELETE FROM watchers WHERE principal IN (SELECT value FROM json_each(?)) RETURNING 1",
        JSON.stringify(principals),
      )
      .toArray().length;
  }

  /**
   * The watchers an event may tell, at most `maxWatchers` in the index's
   * order (more, after a restore, wait their turn: `overflow`); none while
   * recovering.
   */
  candidates(): { readonly watchers: readonly FeedPrincipal[]; readonly overflow: boolean } {
    if (this.recovering()) return { watchers: [], overflow: false };
    const rows = this.#sql
      .exec<{ principal: string; root: string }>(WATCHING, WATCH_POLICY.maxWatchers + 1)
      .toArray();
    return {
      watchers: rows
        .slice(0, WATCH_POLICY.maxWatchers)
        .map((r) => ({ id: r.principal, root: r.root })),
      overflow: rows.length > WATCH_POLICY.maxWatchers,
    };
  }

  /** After a restore (in its transaction): the watchers are taken back from the copy, from the start. */
  restored(epochGen: number): void {
    this.#sql.exec(
      `INSERT INTO preference_recovery (grp, target_epoch, phase, cursor) VALUES ('watches', ?, 'clear', NULL)
       ON CONFLICT (grp) DO UPDATE SET target_epoch = excluded.target_epoch, phase = 'clear',
         cursor = NULL`,
      epochGen,
    );
  }

  /**
   * One step of a recovery: clears a page of the rows, or imports a page of
   * the copy's (`read`: its rows of principals after a cursor, in order,
   * each saying whether its principal is still there),
   * written only when the recovery is still the one the step started in
   * (a restore meanwhile starts it again). Returns whether more is left.
   */
  async recoverStep(
    read: (
      after: string | null,
      limit: number,
    ) => Promise<readonly (WatchRow & { readonly active: boolean })[]>,
  ): Promise<boolean> {
    let state = this.#state();
    if (!state) return false;
    const page = WATCH_POLICY.recoveryPage;
    if (state.phase === "clear") {
      const cleared = this.#sql
        .exec(
          `DELETE FROM watchers WHERE principal IN
             (SELECT principal FROM watchers ORDER BY principal LIMIT ?) RETURNING 1`,
          page,
        )
        .toArray().length;
      // A full page cleared: more may be left, for another step.
      if (cleared >= page) return true;
      // The last of it: the import starts in this same step (a repository with little to take
      // back is done in one).
      this.#sql.exec(
        "UPDATE preference_recovery SET phase = 'import', cursor = NULL WHERE grp = 'watches'",
      );
      state = { ...state, phase: "import", cursor: null };
    }
    const rows = await read(state.cursor, page);
    const now = this.#state();
    // Another restore, or another step, since the read: this page is not the recovery's now.
    if (
      !now ||
      now.target_epoch !== state.target_epoch ||
      now.phase !== "import" ||
      now.cursor !== state.cursor
    )
      return true;
    this.deps.git.context.storage.transactionSync(() => {
      // A principal deleted since its command is not taken back (it frees its place); a
      // suspended one keeps its preferences.
      for (const row of rows.filter((r) => r.active))
        this.#sql.exec(
          `INSERT INTO watchers (principal, root, level, epoch_gen, revision, at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (principal) DO UPDATE SET root = excluded.root, level = excluded.level,
             epoch_gen = excluded.epoch_gen, revision = excluded.revision, at = excluded.at`,
          row.principal,
          row.root,
          row.level,
          row.epochGen,
          row.revision,
          row.at,
        );
      if (rows.length < page)
        this.#sql.exec("DELETE FROM preference_recovery WHERE grp = 'watches'");
      else
        this.#sql.exec(
          "UPDATE preference_recovery SET cursor = ? WHERE grp = 'watches'",
          rows.at(-1)?.principal ?? null,
        );
    });
    return rows.length >= page;
  }

  #state(): { target_epoch: number; phase: "clear" | "import"; cursor: string | null } | undefined {
    return this.#sql
      .exec<{ target_epoch: number; phase: "clear" | "import"; cursor: string | null }>(
        "SELECT target_epoch, phase, cursor FROM preference_recovery WHERE grp = 'watches'",
      )
      .toArray()[0];
  }
}

/**
 * Whether watching and subscriptions add to events' audiences:
 * `FYRDEN_WATCH_AUDIENCES` set to `on` (off otherwise). Set at deploy, so the
 * version running reads it with no cache; turned on only once every reader
 * of P2 entries runs everywhere (see limits.md, Activity feed).
 */
export function watchAudiencesOn(env: object): boolean {
  return (env as { FYRDEN_WATCH_AUDIENCES?: unknown }).FYRDEN_WATCH_AUDIENCES === "on";
}
