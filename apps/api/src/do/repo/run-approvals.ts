import type {
  JobHandler,
  RefActor,
  RepoGitStorage,
  SliceResult,
} from "@fyrden/adapters-cloudflare/git";
import type { Logger } from "@fyrden/adapters-cloudflare/obs";
import { principalTypeOf } from "@fyrden/domain";
import type { ApproveAnswer, RunDO } from "../RunDO.js";
import type { RepoAcl } from "./acl.js";
import type { RepoEvents } from "./events.js";

/*
 * Approvals of fork runs from first-time contributors, the repository's
 * side. `ci_approvals` records each held run's request, its decision and
 * its feed item; the run object (`run_approval`) is the gate. Each side
 * changes its own state in its own transaction and tells the other through
 * a job that retries until it gets an answer: approved and superseded go
 * to the run, cancelled and expired come from it (`settle`).
 *
 * A request is written only in the transaction that records the run's
 * creation, so nothing can approve or supersede a run that does not exist
 * yet. Among the waiting runs of one pull request, trigger kind and
 * workflow, the newest source event (`ci_events.id`, never the run number
 * or id, which a delayed retry can make larger) waits and the others are
 * superseded.
 */

export const CI_APPROVALS_JOB = "ci_approvals";
/** The internal event a change of a pull request's approvals emits (no webhook has it). */
export const APPROVAL_EVENT = "pull_request.approval";

/** Deliveries one slice makes at most. Proposed. */
const DELIVERIES_PER_SLICE = 20;
/** Before a failed delivery is tried again. Proposed. */
const DELIVERY_RETRY_MS = 30_000;

export type ApprovalState = "waiting" | "approved" | "superseded" | "cancelled" | "expired";

type ApprovalRow = {
  run_id: string;
  event_id: number;
  pull_number: number;
  trigger_kind: string;
  workflow_path: string;
  binding: string | null;
  state: ApprovalState;
  decided_by: string | null;
  decided_at: number | null;
  delivered: number;
};

export type ApproveRunAnswer =
  | { readonly ok: true; readonly binding: string; readonly approver: string }
  | {
      readonly ok: false;
      readonly code: "approval_not_pending" | "approver_not_allowed" | "run_not_found";
    };

export type SettleAnswer =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "run_not_found" };

export interface ApprovalRequest {
  readonly runId: string;
  readonly eventId: number;
  readonly pull: number;
  readonly kind: string;
  readonly path: string;
  readonly binding: string;
  /** Who caused the event, for the feed. */
  readonly actor: string;
}

export interface CiApprovalsDeps {
  readonly git: RepoGitStorage;
  readonly events: RepoEvents;
  readonly acl: () => RepoAcl;
  readonly runs: () => DurableObjectNamespace<RunDO>;
  readonly log: () => Logger;
}

export class CiApprovals {
  constructor(private readonly deps: CiApprovalsDeps) {}

  /**
   * In the transaction that records a held run's creation: its request.
   * Repeated (a retry, or the run settled before the trigger recorded it):
   * nothing, and no feed item. A newer event's run already waiting
   * supersedes this one at once; else this one supersedes the older
   * waiting runs of the same pull request, trigger kind and workflow.
   */
  request(input: ApprovalRequest): void {
    const now = this.#now();
    const inserted = this.#sql()
      .exec(
        `INSERT INTO ci_approvals (run_id, event_id, pull_number, trigger_kind, workflow_path,
           binding, state, delivered, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'waiting', 1, ?, ?) ON CONFLICT (run_id) DO NOTHING RETURNING run_id`,
        input.runId,
        input.eventId,
        input.pull,
        input.kind,
        input.path,
        input.binding,
        now,
        now,
      )
      .toArray().length;
    if (inserted === 0) return;
    const same = [input.pull, input.kind, input.path] as const;
    // Any run of a newer event for the same pull request, kind and workflow, whatever became
    // of it (approved, cancelled, expired, or needing no approval at all), makes this one stale.
    const newer =
      this.#sql()
        .exec(
          `SELECT 1 FROM ci_event_runs r JOIN ci_events e ON e.id = r.event_id
           WHERE r.trigger_kind = ? AND r.workflow_path = ? AND r.event_id > ?
             AND e.kind = 'pull_request' AND json_extract(e.facts, '$.number') = ? LIMIT 1`,
          input.kind,
          input.path,
          input.eventId,
          input.pull,
        )
        .toArray().length > 0;
    if (newer) {
      this.#supersede("run_id = ?", input.runId);
      return;
    }
    this.#supersede(
      `state = 'waiting' AND pull_number = ? AND trigger_kind = ? AND workflow_path = ?
         AND event_id < ?`,
      ...same,
      input.eventId,
    );
    this.#told(input.pull, input.runId, input.actor);
  }

  /**
   * In the transaction recording the creation of a run that waits for no
   * approval (its author is trusted now, or its workflow failed to plan):
   * it is newer than the waiting runs of older events of the same pull
   * request, trigger kind and workflow, which are superseded.
   */
  supersedeOlder(input: Omit<ApprovalRequest, "binding">): void {
    const changed = this.#supersede(
      `state = 'waiting' AND pull_number = ? AND trigger_kind = ? AND workflow_path = ?
         AND event_id < ?`,
      input.pull,
      input.kind,
      input.path,
      input.eventId,
    );
    if (changed > 0) this.#told(input.pull, input.runId, input.actor);
  }

  /**
   * A maintainer's approval of a waiting run: a user with `write` now (the
   * write-window ACL snapshot). Approved already: the same answer. Ended,
   * or never held: `approval_not_pending`; a run this repository never
   * allocated: `run_not_found`. The run object is told by the job (and the
   * caller may tell it at once).
   */
  async approve(runId: string, approver: string): Promise<ApproveRunAnswer> {
    if (principalTypeOf(approver) !== "user") return { ok: false, code: "approver_not_allowed" };
    await this.deps.acl().roleOf(approver, "write");
    return this.deps.git.context.storage.transactionSync((): ApproveRunAnswer => {
      if (!this.deps.acl().allows(approver, "write"))
        return { ok: false, code: "approver_not_allowed" };
      const row = this.#row(runId);
      if (!row)
        return this.#allocated(runId)
          ? { ok: false, code: "approval_not_pending" }
          : { ok: false, code: "run_not_found" };
      // A decision already taken answers with its own approver, whoever asks again.
      if (row.state === "approved" && row.binding)
        return { ok: true, binding: row.binding, approver: row.decided_by ?? approver };
      if (row.state !== "waiting" || !row.binding)
        return { ok: false, code: "approval_not_pending" };
      const now = this.#now();
      this.#sql().exec(
        `UPDATE ci_approvals SET state = 'approved', decided_by = ?, decided_at = ?, delivered = 0,
           updated_at = ? WHERE run_id = ?`,
        approver,
        now,
        now,
        runId,
      );
      this.#ensure();
      this.#told(row.pull_number, runId, approver);
      return { ok: true, binding: row.binding, approver };
    });
  }

  /**
   * The run object ended a waiting run (a user cancelled it, it expired),
   * which corrects an approval recorded here that the run never took.
   * Before the trigger recorded the run's creation (a reset between the
   * two), the row is written already ended, so the trigger's later request
   * opens no item. A run this repository never allocated: `run_not_found`.
   */
  settle(runId: string, outcome: "cancelled" | "expired"): SettleAnswer {
    return this.deps.git.context.storage.transactionSync((): SettleAnswer => {
      const now = this.#now();
      const row = this.#row(runId);
      if (row) {
        // The run ended unapproved: a waiting row ends so, and so does an approval recorded
        // here that the run never took (it was cancelled first).
        if (row.state !== "waiting" && row.state !== "approved") return { ok: true };
        this.#sql().exec(
          `UPDATE ci_approvals SET state = ?, decided_at = ?, delivered = 1, updated_at = ?
           WHERE run_id = ?`,
          outcome,
          now,
          now,
          runId,
        );
        this.#told(row.pull_number, runId, null);
        return { ok: true };
      }
      const [run] = this.#sql()
        .exec<{ event_id: number; trigger_kind: string; workflow_path: string; facts: string }>(
          `SELECT r.event_id, r.trigger_kind, r.workflow_path, e.facts FROM ci_event_runs r
           JOIN ci_events e ON e.id = r.event_id WHERE r.run_id = ?`,
          runId,
        )
        .toArray();
      if (!run) return { ok: false, code: "run_not_found" };
      const pull = (JSON.parse(run.facts) as { number?: number }).number ?? 0;
      this.#sql().exec(
        `INSERT INTO ci_approvals (run_id, event_id, pull_number, trigger_kind, workflow_path,
           binding, state, decided_at, delivered, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 1, ?, ?) ON CONFLICT (run_id) DO NOTHING`,
        runId,
        run.event_id,
        pull,
        run.trigger_kind,
        run.workflow_path,
        outcome,
        now,
        now,
        now,
      );
      return { ok: true };
    });
  }

  /** Whether a run of pull request `number` waits for approval (its writers' item is open). */
  waiting(number: number): boolean {
    return (
      this.#sql()
        .exec(
          "SELECT 1 FROM ci_approvals WHERE state = 'waiting' AND pull_number = ? LIMIT 1",
          number,
        )
        .toArray().length > 0
    );
  }

  /**
   * Delivers decisions to run objects: approved ones with their binding,
   * superseded ones as a cancel. A definite answer (done, or refused as
   * not waiting, stale or gone) is final; a failed call is tried again
   * later, however long that takes.
   */
  handler(): JobHandler {
    return {
      runSlice: async (): Promise<SliceResult> => {
        const due = this.#sql()
          .exec<ApprovalRow>(
            `SELECT * FROM ci_approvals WHERE delivered = 0 AND state IN ('approved', 'superseded')
             ORDER BY updated_at, run_id LIMIT ?`,
            DELIVERIES_PER_SLICE,
          )
          .toArray();
        let failed = false;
        for (const row of due) {
          let answer: ApproveAnswer;
          try {
            const run = this.deps.runs().getByName(row.run_id);
            this.deps.git.context.metrics.count("do.request", {
              class: "RunDO",
              method: row.state === "approved" ? "approve" : "supersede",
            });
            answer = (await (row.state === "approved" && row.binding
              ? run.approve(row.binding, row.decided_by ?? "")
              : run.supersede())) as unknown as ApproveAnswer;
          } catch (error) {
            this.deps.log().warn("delivering an approval decision failed", {
              error,
              runId: row.run_id,
            });
            failed = true;
            continue;
          }
          if (!answer.ok && answer.code !== "run_not_found")
            this.deps.log().info("a run refused an approval decision", {
              runId: row.run_id,
              code: answer.code,
            });
          this.#sql().exec(
            "UPDATE ci_approvals SET delivered = 1 WHERE run_id = ? AND state = ?",
            row.run_id,
            row.state,
          );
        }
        let told: "done" | "later";
        try {
          told = await this.#tellDeferred();
        } catch (error) {
          this.deps.log().warn("telling approval items failed", { error });
          told = "later";
        }
        if (failed || told === "later")
          return { done: false, cursor: null, runAfterMs: DELIVERY_RETRY_MS };
        const left = this.#sql()
          .exec(
            "SELECT 1 FROM ci_approvals WHERE delivered = 0 AND state IN ('approved', 'superseded') LIMIT 1",
          )
          .toArray();
        return left.length > 0 ? { done: false, cursor: null, runAfterMs: 0 } : { done: true };
      },
    };
  }

  /** Supersedes the waiting rows `where` names; the run objects are told by the job. How many. */
  #supersede(where: string, ...bindings: unknown[]): number {
    const now = this.#now();
    const changed = this.#sql().exec(
      `UPDATE ci_approvals SET state = 'superseded', decided_at = ?, delivered = 0, updated_at = ?
       WHERE ${where}`,
      now,
      now,
      ...bindings,
    ).rowsWritten;
    if (changed > 0) this.#ensure();
    return changed;
  }

  /**
   * The pull request's approvals changed: its writers' item is open while one
   * waits. Told now when the ACL can be read (a snapshot within the write
   * window); otherwise left to the job, which tells it once it can: an
   * audience read from no ACL would open the item for too few, or resolve
   * it for holders who still have it.
   */
  #told(pull: number, runId: string, actor: string | null): void {
    if (this.deps.acl().basis() === "unknown") {
      this.#sql().exec(
        `INSERT INTO ci_approval_feed (pull_number, run_id, actor) VALUES (?, ?, ?)
         ON CONFLICT (pull_number) DO UPDATE SET run_id = excluded.run_id, actor = excluded.actor`,
        pull,
        runId,
        actor,
      );
      this.#ensure();
      return;
    }
    this.#sql().exec("DELETE FROM ci_approval_feed WHERE pull_number = ?", pull);
    const who: RefActor | null = actor === null ? null : { principal: actor, via: "api" };
    this.deps.events.emitActivity(APPROVAL_EVENT, who, { number: pull, run_id: runId });
  }

  /**
   * Tells the approval items left untold while the ACL could not be read:
   * pulls it, and tells them only once a snapshot is usable. Whether any is
   * left.
   */
  async #tellDeferred(): Promise<"done" | "later"> {
    const owed = this.#sql()
      .exec<{ pull_number: number; run_id: string; actor: string | null }>(
        "SELECT pull_number, run_id, actor FROM ci_approval_feed ORDER BY pull_number LIMIT ?",
        DELIVERIES_PER_SLICE,
      )
      .toArray();
    if (owed.length === 0) return "done";
    await this.deps.acl().pullForWrite();
    if (this.deps.acl().basis() === "unknown") return "later";
    this.deps.git.context.storage.transactionSync(() => {
      for (const row of owed) this.#told(row.pull_number, row.run_id, row.actor);
    });
    return this.#sql().exec("SELECT 1 FROM ci_approval_feed LIMIT 1").toArray().length > 0
      ? "later"
      : "done";
  }

  /**
   * In an approval event's transaction: who its item goes to. While a run
   * waits, the writers now hold it open, and anyone who held it but is no
   * longer a writer has theirs resolved; once none waits, everyone who held
   * it (and every writer) has it resolved, and no one holds it any more.
   * The holders are kept per pull request, so a resolution reaches exactly
   * those told of the opening, bounded by the approvers' cap.
   */
  audience(
    pull: number,
    writers: readonly string[],
  ): { open: boolean; holding: string[]; released: string[] } {
    const open = this.waiting(pull);
    const held = this.#sql()
      .exec<{ principal: string }>(
        "SELECT principal FROM ci_approval_holders WHERE pull_number = ?",
        pull,
      )
      .toArray()
      .map((r) => r.principal);
    if (!open) {
      this.#sql().exec("DELETE FROM ci_approval_holders WHERE pull_number = ?", pull);
      return { open, holding: [], released: [...new Set([...held, ...writers])].sort() };
    }
    const writing = new Set(writers);
    const released = held.filter((id) => !writing.has(id));
    for (const id of released)
      this.#sql().exec(
        "DELETE FROM ci_approval_holders WHERE pull_number = ? AND principal = ?",
        pull,
        id,
      );
    for (const id of writers)
      this.#sql().exec(
        "INSERT OR IGNORE INTO ci_approval_holders (pull_number, principal) VALUES (?, ?)",
        pull,
        id,
      );
    return { open, holding: [...writers], released };
  }

  #allocated(runId: string): boolean {
    return (
      this.#sql().exec("SELECT 1 FROM ci_event_runs WHERE run_id = ?", runId).toArray().length > 0
    );
  }

  #row(runId: string): ApprovalRow | undefined {
    return this.#sql()
      .exec<ApprovalRow>("SELECT * FROM ci_approvals WHERE run_id = ?", runId)
      .toArray()[0];
  }

  #ensure(): void {
    this.deps.git.jobs.ensure(CI_APPROVALS_JOB, CI_APPROVALS_JOB);
  }

  #sql() {
    return this.deps.git.context.storage.sql;
  }

  #now(): number {
    return this.deps.git.context.now();
  }
}
