import type { JobHandler, RepoGitStorage, SliceResult } from "@fyrden/adapters-cloudflare/git";
import type { Logger } from "@fyrden/adapters-cloudflare/obs";
import { cronNext, nextTick, parseCron } from "@fyrden/domain/ci";

/*
 * Scheduled workflows on the repository's own alarm. `ci_schedules` holds
 * the cron entries of the default branch's workflows, refreshed by the
 * trigger slice from `schedule_refresh` events. A default-branch push or a
 * change of the default branch records one with the tip it left, and they
 * apply in their order whatever becomes of the push's runs. An entry whose
 * file did not change keeps its next tick, last fire and actor; a new or
 * changed cron starts from now; the actor is whoever made the change that
 * last changed the workflow's file. The
 * `ci_schedule` job wakes at the earliest tick and records a `schedule`
 * event per due entry, which the trigger slice runs on the default tip.
 * One workflow fires at most every 5 minutes, across its entries; missed
 * ticks coalesce into one. Nothing is armed or fired while CI is off, and
 * no tick from before the deployment's CI cutoff fires (see `since`).
 */

export const CI_SCHEDULE_JOB = "ci_schedule";

/** Schedule entries one repository keeps. Proposed. */
export const MAX_SCHEDULES = 20;
/** A repository with no push for this long fires no schedules (GitHub's rule for public ones). */
const INACTIVE_MS = 60 * 24 * 60 * 60_000;
/**
 * When an entry the cutoff moved has no occurrence within the search from
 * then, it stays enabled and looks again this much later. Proposed.
 */
const UNREACHED_RETRY_MS = 24 * 60 * 60_000;
/** Before due entries are tried again when the ACL cannot be read. Proposed. */
const ACL_RETRY_MS = 60_000;

type Disabled = "inactive" | "actor_lost" | "unreachable";

type Row = {
  workflow_path: string;
  cron: string;
  idx: number;
  workflow_blob: string;
  actor_id: string;
  next_at: number;
  last_fired_at: number | null;
  disabled: Disabled | null;
};

/** One workflow file's schedule, as the default tip has it. */
export interface ScheduledFile {
  readonly path: string;
  readonly blob: string;
  readonly crons: readonly string[];
}

/**
 * Whether a due tick fires. A seam for a later budget of schedule runs:
 * every tick fires today.
 */
export interface ScheduleAdmission {
  allowTick(repoId: string, path: string): "fire" | "skip";
}

export const ADMIT_ALL: ScheduleAdmission = { allowTick: () => "fire" };

export interface CiSchedulesDeps {
  readonly git: RepoGitStorage;
  readonly enabled: () => boolean;
  /**
   * The deployment's CI cutoff (when CI was last switched on), or null.
   * An object asleep while CI was off and on again never saw it off: no
   * tick before the cutoff fires, and entries start again from it.
   */
  readonly since: () => number | null;
  readonly repoId: () => string;
  /** Pulls the ACL unless one within the write window is stored; whether one can be read now. */
  readonly aclKnown: () => Promise<boolean>;
  /**
   * Whether `principal` may write now (its effective role, an agent's
   * owner's included) and is active (neither it nor an agent's owner
   * suspended or disabled).
   */
  readonly mayWrite: (principal: string) => Promise<boolean>;
  /** In the caller's transaction: records a `schedule` event in the trigger inbox. */
  readonly record: (key: string, actor: string, facts: object) => void;
  readonly admission: () => ScheduleAdmission;
  readonly log: () => Logger;
}

export class CiSchedules {
  /** For tests: around the check of a due entry's actor. */
  hooks: {
    beforeRoleCheck?: (path: string) => Promise<void> | void;
    afterRoleCheck?: (path: string) => Promise<void> | void;
  } = {};

  constructor(private readonly deps: CiSchedulesDeps) {}

  /**
   * In one transaction: the default tip's schedules as read for inbox event
   * `eventId` by `actor`. Skipped when a newer event's refresh was applied
   * already. Rows of removed entries are deleted; an unchanged file keeps
   * its rows as they are, an overdue tick included (it fires at the next
   * fire, coalesced); a changed file takes `actor`; disabled rows are
   * enabled again, from now. Past {@link MAX_SCHEDULES} entries, the first ones are kept and
   * `too_many_schedules` is answered.
   */
  apply(
    eventId: number,
    files: readonly ScheduledFile[],
    actor: string,
    /** A change of the default branch: every row is the changer's, a lost actor's enabled again. */
    headChange = false,
  ): string | null {
    return this.deps.git.context.storage.transactionSync(() => {
      this.#resumeIfOffSeen();
      const [state] = this.#sql()
        .exec<{ refreshed_event: number }>(
          "SELECT refreshed_event FROM ci_schedule_state WHERE id = 1",
        )
        .toArray();
      if (state && state.refreshed_event > eventId) return null;
      const all = files.flatMap((f) =>
        [...new Set(f.crons)].map((cron, idx) => ({ path: f.path, blob: f.blob, cron, idx })),
      );
      const rows = this.#rows();
      // Nothing scheduled, before or now: nothing written, no alarm; but an older event still
      // pending must not apply its refresh after this newer one.
      if (all.length === 0 && rows.length === 0) {
        this.#markIfOlderPending(eventId);
        return null;
      }
      const entries = all.slice(0, MAX_SCHEDULES);
      const now = this.#now();
      const keep = new Set(entries.map((e) => `${e.path}\n${e.cron}`));
      for (const row of rows)
        if (!keep.has(`${row.workflow_path}\n${row.cron}`))
          this.#sql().exec(
            "DELETE FROM ci_schedules WHERE workflow_path = ? AND cron = ?",
            row.workflow_path,
            row.cron,
          );
      const known = new Map(rows.map((r) => [`${r.workflow_path}\n${r.cron}`, r]));
      for (const entry of entries) {
        const row = known.get(`${entry.path}\n${entry.cron}`);
        const changed = headChange || !row || row.workflow_blob !== entry.blob;
        const enabled =
          !row?.disabled ||
          row.disabled === "inactive" ||
          (row.disabled === "actor_lost" && changed);
        const keepTick = row && !row.disabled;
        const start = keepTick ? null : this.#start(entry.path, entry.cron, now);
        const next = keepTick ? row.next_at : start?.next_at;
        this.#sql().exec(
          `INSERT INTO ci_schedules (workflow_path, cron, idx, workflow_blob, actor_id, next_at,
             last_fired_at, disabled, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (workflow_path, cron) DO UPDATE SET idx = excluded.idx,
             workflow_blob = excluded.workflow_blob, actor_id = excluded.actor_id,
             next_at = excluded.next_at, disabled = excluded.disabled,
             updated_at = excluded.updated_at`,
          entry.path,
          entry.cron,
          entry.idx,
          entry.blob,
          changed ? actor : (row?.actor_id ?? actor),
          next ?? now,
          row?.last_fired_at ?? null,
          start?.unreachable ? "unreachable" : enabled ? null : (row?.disabled ?? null),
          now,
        );
      }
      this.#sql().exec(
        `INSERT INTO ci_schedule_state (id, refreshed_event) VALUES (1, ?)
         ON CONFLICT (id) DO UPDATE SET refreshed_event = excluded.refreshed_event`,
        eventId,
      );
      this.#arm();
      return all.length > MAX_SCHEDULES ? "too_many_schedules" : null;
    });
  }

  /**
   * An event's refresh could not be read (its listing refused): nothing
   * changes, but an older pending event must not apply its refresh after it.
   */
  skip(eventId: number): void {
    this.deps.git.context.storage.transactionSync(() => this.#markIfOlderPending(eventId));
  }

  /** Records `eventId` as the last refresh when an older refresh event is still pending. */
  #markIfOlderPending(eventId: number): void {
    const older = this.#sql()
      .exec(
        `SELECT 1 FROM ci_events WHERE state = 'pending' AND id < ?
           AND kind = 'schedule_refresh' LIMIT 1`,
        eventId,
      )
      .toArray().length;
    if (older === 0) return;
    this.#sql().exec(
      `INSERT INTO ci_schedule_state (id, refreshed_event) VALUES (1, ?)
       ON CONFLICT (id) DO UPDATE SET refreshed_event = max(refreshed_event, excluded.refreshed_event)`,
      eventId,
    );
  }

  /**
   * CI is off now: noted once, so the first schedule step with it on again
   * starts every entry from then, replaying no tick that fell while off.
   */
  noteOff(): void {
    const [state] = this.#sql()
      .exec<{ off_seen: number }>("SELECT off_seen FROM ci_schedule_state WHERE id = 1")
      .toArray();
    if (state?.off_seen === 1) return;
    if (!state && this.#rows().length === 0) return;
    this.#sql().exec(
      `INSERT INTO ci_schedule_state (id, off_seen) VALUES (1, 1)
       ON CONFLICT (id) DO UPDATE SET off_seen = 1`,
    );
  }

  /** CI on, after it was seen off: every entry from now, and the job armed again. */
  resume(): void {
    this.deps.git.context.storage.transactionSync(() => this.#resumeIfOffSeen());
  }

  #resumeIfOffSeen(): void {
    const [state] = this.#sql()
      .exec<{ off_seen: number }>("SELECT off_seen FROM ci_schedule_state WHERE id = 1")
      .toArray();
    if (state?.off_seen !== 1) return;
    const now = this.#now();
    for (const row of this.#rows().filter((r) => !r.disabled)) {
      const start = this.#start(row.workflow_path, row.cron, now);
      this.#sql().exec(
        `UPDATE ci_schedules SET next_at = ?, disabled = ?, updated_at = ?
         WHERE workflow_path = ? AND cron = ?`,
        start.next_at,
        start.unreachable ? "unreachable" : null,
        now,
        row.workflow_path,
        row.cron,
      );
    }
    this.#sql().exec("UPDATE ci_schedule_state SET off_seen = 0 WHERE id = 1");
    this.#arm();
  }

  handler(): JobHandler {
    return { runSlice: () => this.fire(this.#now()) };
  }

  /**
   * Fires the entries due at `at`: each records one `schedule` event for
   * its latest occurrence, then every entry of its workflow takes its next
   * tick at least 5 minutes after that one. A repository without a push in
   * 60 days disables its entries (`inactive`); an actor who may no longer
   * write disables theirs (`actor_lost`); while the ACL cannot be read,
   * nothing fires or is disabled. Off: nothing fires.
   */
  async fire(at: number): Promise<SliceResult> {
    if (!this.deps.enabled()) {
      this.deps.git.context.storage.transactionSync(() => this.noteOff());
      return { done: true };
    }
    this.resume();
    this.#rebaseBeforeCutoff();
    const due = this.#rows().filter((r) => !r.disabled && r.next_at <= at);
    if (due.length > 0) {
      if (!(await this.deps.aclKnown()))
        return { done: false, cursor: null, runAfterMs: ACL_RETRY_MS };
      const pushed = this.#pushedAt();
      for (const row of due) {
        let disable: Disabled | null = null;
        if (pushed === null || at - pushed > INACTIVE_MS) disable = "inactive";
        else {
          let writes: boolean;
          try {
            await this.hooks.beforeRoleCheck?.(row.workflow_path);
            writes = await this.deps.mayWrite(row.actor_id);
            await this.hooks.afterRoleCheck?.(row.workflow_path);
          } catch (error) {
            // The directory or the account unreachable: neither fired nor disabled, retried.
            this.deps.log().warn("checking a schedule's actor failed", { error });
            return { done: false, cursor: null, runAfterMs: ACL_RETRY_MS };
          }
          // A denial is believed only from an ACL that could be read (it may have lapsed since).
          if (!writes && !(await this.deps.aclKnown()))
            return { done: false, cursor: null, runAfterMs: ACL_RETRY_MS };
          if (!writes) disable = "actor_lost";
        }
        const admitted =
          disable === null &&
          this.deps.admission().allowTick(this.deps.repoId(), row.workflow_path) === "fire";
        this.deps.git.context.storage.transactionSync(() => {
          // Read again with no await before the write: another fire (the alarm and the test
          // hook) or a refresh may have moved the entry since.
          const [now] = this.#sql()
            .exec<Row>(
              "SELECT * FROM ci_schedules WHERE workflow_path = ? AND cron = ?",
              row.workflow_path,
              row.cron,
            )
            .toArray();
          // Its actor or file changed while the old actor was checked: the new one never was,
          // so nothing fires now (the next slice checks the entry as it stands).
          if (
            !now ||
            now.disabled ||
            now.next_at !== row.next_at ||
            now.actor_id !== row.actor_id ||
            now.workflow_blob !== row.workflow_blob
          )
            return;
          if (disable) {
            this.#sql().exec(
              "UPDATE ci_schedules SET disabled = ?, updated_at = ? WHERE workflow_path = ? AND cron = ?",
              disable,
              this.#now(),
              row.workflow_path,
              row.cron,
            );
            return;
          }
          const tick = latestOccurrence(row.cron, row.next_at, at);
          if (tick === null) {
            // No occurrence since its tick, which only a cutoff sets where none falls: the next
            // one from `at`, or none within the search yet, looked for again later; never
            // disabled, a cutoff being no reason to stop a schedule.
            const next = this.#nextFor(row.workflow_path, row.cron, at);
            this.#sql().exec(
              `UPDATE ci_schedules SET next_at = ?, updated_at = ?
               WHERE workflow_path = ? AND cron = ?`,
              next ?? at + UNREACHED_RETRY_MS,
              this.#now(),
              row.workflow_path,
              row.cron,
            );
            return;
          }
          if (admitted)
            this.deps.record(`schedule:${row.workflow_path}:${row.cron}:${tick}`, row.actor_id, {
              path: row.workflow_path,
              cron: row.cron,
              tick,
            });
          this.#sql().exec(
            "UPDATE ci_schedules SET last_fired_at = ? WHERE workflow_path = ? AND cron = ?",
            tick,
            row.workflow_path,
            row.cron,
          );
          // The workflow's own last fire, which spaces any entry it has later (a replaced cron).
          this.#sql().exec(
            `INSERT INTO ci_schedule_fires (workflow_path, last_fired_at) VALUES (?, ?)
             ON CONFLICT (workflow_path) DO UPDATE
               SET last_fired_at = max(last_fired_at, excluded.last_fired_at)`,
            row.workflow_path,
            tick,
          );
          for (const sibling of this.#rows().filter((r) => r.workflow_path === row.workflow_path)) {
            const next = this.#nextFor(sibling.workflow_path, sibling.cron, at);
            this.#sql().exec(
              `UPDATE ci_schedules SET next_at = ?, disabled = coalesce(disabled, ?), updated_at = ?
               WHERE workflow_path = ? AND cron = ?`,
              next ?? at,
              next === null ? "unreachable" : null,
              this.#now(),
              sibling.workflow_path,
              sibling.cron,
            );
          }
        });
      }
    }
    const next = this.#earliest();
    return next === null
      ? { done: true }
      : { done: false, cursor: null, runAfterMs: Math.max(0, next - this.#now()) };
  }

  /**
   * Enabled entries whose tick falls before the cutoff (CI was off then,
   * unseen by this object) start again from their first tick at or after
   * it, with no event and no fire recorded.
   */
  #rebaseBeforeCutoff(): void {
    const since = this.deps.since();
    if (since === null) return;
    this.deps.git.context.storage.transactionSync(() => {
      const stale = this.#rows().filter((r) => !r.disabled && r.next_at < since);
      for (const row of stale) {
        // None within the search after the cutoff: the cutoff itself, still enabled, so the
        // fire then looks again from its own time (no cutoff disables an entry).
        const next = this.#nextFor(row.workflow_path, row.cron, since - 1);
        this.#sql().exec(
          `UPDATE ci_schedules SET next_at = ?, updated_at = ?
           WHERE workflow_path = ? AND cron = ?`,
          next ?? since,
          this.#now(),
          row.workflow_path,
          row.cron,
        );
      }
      if (stale.length > 0) this.#arm();
    });
  }

  /**
   * Where an entry starts at `now`: its first tick after then, no earlier
   * than the cutoff. None within the search: `unreachable` from `now`
   * alone; from a cutoff ahead of `now`, enabled at the cutoff, so the fire
   * then looks again (a cutoff disables nothing).
   */
  #start(path: string, cron: string, now: number): { next_at: number; unreachable: boolean } {
    const since = this.deps.since();
    // `nextTick` answers occurrences strictly after its time: one at the cutoff itself counts.
    const from = since === null ? now : Math.max(now, since - 1);
    const next = this.#nextFor(path, cron, from);
    if (next !== null) return { next_at: next, unreachable: false };
    if (since !== null && from > now) return { next_at: since, unreachable: false };
    return { next_at: now, unreachable: true };
  }

  /** The entry's next tick after `now`, at least 5 minutes after its workflow's last fire. */
  #nextFor(path: string, cron: string, now: number): number | null {
    const parsed = parseCron(cron);
    if (!parsed.ok) return null;
    const [last] = this.#sql()
      .exec<{ last: number | null }>(
        // SQLite's scalar max() is null when any argument is: each side defaults to -1.
        `SELECT nullif(max(
           coalesce((SELECT max(last_fired_at) FROM ci_schedules WHERE workflow_path = ?1), -1),
           coalesce((SELECT last_fired_at FROM ci_schedule_fires WHERE workflow_path = ?1), -1)),
           -1) AS last`,
        path,
      )
      .toArray();
    return nextTick(parsed.cron, now, last?.last ?? null);
  }

  /** Keeps the job at the earliest enabled tick; none without one. */
  #arm(): void {
    const next = this.#earliest();
    if (next !== null) this.deps.git.jobs.ensure(CI_SCHEDULE_JOB, CI_SCHEDULE_JOB, { runAt: next });
  }

  #earliest(): number | null {
    return (
      this.#sql()
        .exec<{ at: number | null }>(
          "SELECT min(next_at) AS at FROM ci_schedules WHERE disabled IS NULL",
        )
        .one().at ?? null
    );
  }

  #pushedAt(): number | null {
    return (
      this.#sql()
        .exec<{ pushed_at: number | null }>("SELECT pushed_at FROM repo_meta WHERE id = 1")
        .toArray()[0]?.pushed_at ?? null
    );
  }

  #rows(): Row[] {
    return this.#sql()
      .exec<Row>("SELECT * FROM ci_schedules ORDER BY workflow_path, idx")
      .toArray()
      .map((r) => ({ ...r }));
  }

  #sql() {
    return this.deps.git.context.storage.sql;
  }

  #now(): number {
    return this.deps.git.context.now();
  }
}

/**
 * How far back one bisection of {@link latestOccurrence} reaches: within
 * `cronNext`'s five-year search (of 366-day years), so from any time in it
 * the search reaches its end, and whether an occurrence falls before that
 * end never turns from yes to no as the time grows.
 */
const OCCURRENCE_SPAN_MS = 5 * 365 * 24 * 60 * 60_000;

/**
 * The latest occurrence of `cron` at or before `at` and at or after
 * `nextAt` (a due entry's tick), or null when none: in the last span of
 * {@link OCCURRENCE_SPAN_MS} before `at` (or since `nextAt`), the
 * occurrence after the largest time `p` whose next occurrence is at or
 * before the span's end, found by bisection; a span with none moves the
 * search a span back. About 40 occurrence lookups per span searched.
 */
export function latestOccurrence(cron: string, nextAt: number, at: number): number | null {
  const parsed = parseCron(cron);
  if (!parsed.ok) return null;
  for (let end = at; ; ) {
    const fits = (p: number) => {
      const next = cronNext(parsed.cron, p);
      return next !== null && next <= end;
    };
    let lo = Math.max(nextAt - 1, end - OCCURRENCE_SPAN_MS);
    if (fits(lo)) {
      // fits(lo), and not fits(hi): the next occurrence after `end` is later than it.
      let hi = end;
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (fits(mid)) lo = mid;
        else hi = mid;
      }
      return cronNext(parsed.cron, lo);
    }
    // None after `lo` up to `end`: the latest is at or before `lo`, if any.
    if (lo === nextAt - 1) return null;
    end = lo;
  }
}
