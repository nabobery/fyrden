import type { Job, SliceResult } from "@fyrden/adapters-cloudflare/git";
import type { Logger, Metrics } from "@fyrden/adapters-cloudflare/obs";
import type { NeedResult, RunnerResult } from "@fyrden/domain/ci";
import { SHOWN_HANDLE } from "../../accounts/handles.js";
import { ciSecretKeys } from "../../ci/envelope.js";
import type { ConnectCode } from "../../runner/connect.js";
import {
  INVALID_MESSAGE,
  TASK_ID_MISMATCH,
  TASK_NOT_FOUND,
  TASK_RESULT_UNKNOWN,
} from "../../runner/errors.js";
import {
  decodeUpdateTaskRequest,
  encodeTask,
  encodeUpdateTaskResponse,
  type JsonObject,
  Result,
  type TaskNeed,
} from "../../runner/proto/messages.js";
import { ProtoError } from "../../runner/proto/wire.js";
import { tokenStore } from "../../services.js";
import type { AssignAnswer, TaskAnswer, TaskRef } from "../RunDO.js";
import type { InstanceRow, RunEngine, RunRow } from "./engine.js";

/*
 * The runner protocol inside a run's object: the run's queued jobs published
 * to the directory's dispatch index, tasks assigned under the wire task ids
 * the directory hands out, job tokens minted for them and revoked when their
 * task ends, and the runner's reports decoded and passed to the run.
 */

/** What `assignTask` answers: the encoded `Task`, or why the run refused it. */
export type AssignTaskAnswer =
  | { readonly task: Uint8Array }
  | {
      /**
       * `wrong_account`: the runner's account no longer owns the run's repository (it moved);
       * `repo_transferring`: the repository is being transferred; `released`: the offer was
       * given up by its poll before the assignment could be recorded; `confirmed`: a report
       * made the stale offer no longer replayable. `tokens_exhausted`: the offer cannot be
       * repeated, but its last token and an in-flight answer remain valid.
       * `ci_key_unavailable`: no CI master key seals the task's masks. Refused before anything
       * is assigned or minted, or, when the key went while the token was masked, with that
       * token revoked; either way the offer stands, to be made again once there is a key.
       * `masks_unreadable`: there is a key, but the task's stored masks do not open (their key
       * gone from the keyring): refused before a token is minted, or, when the keys changed
       * while the token was masked, with that token revoked; the offer and its earlier tokens
       * stand, and the runner may be given other work.
       */
      readonly refused:
        | Extract<AssignAnswer, { ok: false }>["code"]
        | "wrong_account"
        | "repo_transferring"
        | "released"
        | "confirmed"
        | "tokens_exhausted"
        | "ci_key_unavailable"
        | "masks_unreadable";
    };

/** What `reportTask` answers: an encoded UpdateTaskResponse, or a Connect error. */
export type ReportTaskAnswer =
  | { readonly ok: true; readonly response: Uint8Array }
  | {
      readonly ok: false;
      readonly code: Extract<ConnectCode, "not_found" | "invalid_argument">;
      readonly message: string;
    };

/** Pause or fail points for tests. */
export interface DispatchHooks {
  /** Before the dispatch index's D1 batch. */
  beforeDispatchCommit?: () => Promise<void> | void;
  /** After it, before the watermark is recorded. */
  afterDispatchCommit?: () => Promise<void> | void;
  /** Before the task-end handler's D1 work. */
  beforeTaskEnd?: () => Promise<void> | void;
  /** After it, before the watermark is recorded. */
  afterTaskEndCommit?: () => Promise<void> | void;
  /** After the run has recorded an assigned task, before its task number is written to the directory. */
  beforeTaskRecord?: () => Promise<void> | void;
  /** After a job token is minted and mapped to its task, before liveness is checked again. */
  afterMint?: (token: string) => Promise<void> | void;
  beforeTokenRotation?: () => Promise<void> | void;
  /** Before the minted token is registered to be masked in the task's log. */
  beforeTokenMask?: () => Promise<void> | void;
  /** When a report arrives, before anything is decoded or written. */
  beforeReport?: () => Promise<void> | void;
  /** After ownership is checked, before the final liveness check and answer. */
  beforeTaskAnswer?: () => Promise<void> | void;
  /** On every liveness question about a task. */
  onTaskLive?: () => void;
}

/** What the dispatch work needs from its object. */
export interface DispatchHost {
  readonly env: Env;
  readonly engine: RunEngine;
  readonly hooks: DispatchHooks;
  readonly metrics: Metrics;
  readonly log: Logger;
  now(): number;
  erased(): boolean;
  tx<T>(fn: () => T): T;
  /** Writes `fn` only while the run exists and `job`'s slice still holds its claim. */
  guarded(job: Job, fn: () => void): void;
  /** Has the dispatch index synced soon (its job runs now). */
  ensureDispatch(): void;
  queued(limit: number): { jobId: number; attempt: number; runsOn: string[]; queuedAt: number }[];
  assign(jobId: number, assignKey: string): AssignAnswer;
  taskLive(ref: TaskRef): boolean;
  updateTask(ref: TaskRef): TaskAnswer<{ cancel: boolean }>;
  completeTask(
    ref: TaskRef,
    report: { result: RunnerResult; outputs?: Record<string, string>; logComplete: boolean },
  ): TaskAnswer<{ conclusion: string }>;
  /** Whether the task's stored log is complete. */
  logComplete(task: number): boolean;
  /**
   * Registers the task's job token to be masked in its log rows, sealed:
   * `full` when the task has had as many tokens as its log keeps,
   * `key_unavailable` when there is no CI master key to seal it with,
   * `masks_unreadable` when there is one but the task's stored tokens do not open.
   */
  addJobTokenMask(
    task: number,
    token: string,
  ): Promise<"added" | "full" | "key_unavailable" | "masks_unreadable">;
  /** Whether the task has had as many job tokens as its log keeps: no more may be minted. */
  jobTokensFull(task: number): boolean;
  /**
   * Whether the task's stored job tokens open under the deployment's keys (true with none): a
   * new token is masked with them, so none is minted while they do not.
   */
  jobTokenMasksOpen(task: number): Promise<boolean>;
}

/** A job token outlives its job's timeout by this. Proposed. */
const JOB_TOKEN_GRACE_MS = 10 * 60_000;
/** And never lives longer than this (GitHub's ceiling for a self-hosted job's token). */
const JOB_TOKEN_MAX_MS = 24 * 60 * 60_000;
/** A spent ephemeral runner may still report for this long after its task completed. Proposed. */
const EPHEMERAL_REPORT_MS = 10 * 60_000;
/**
 * While the run has jobs in the dispatch index, it checks them again this
 * often, so a change nothing tells it of (its repository moving to another
 * account) is followed within this time. Proposed.
 */
export const DISPATCH_RESYNC_MS = 5 * 60_000;
/** Rows one pass of either handler deals with. */
const PAGE = 256;

const NEED_RESULT: Record<NeedResult, number> = {
  success: Result.SUCCESS,
  failure: Result.FAILURE,
  cancelled: Result.CANCELLED,
  skipped: Result.SKIPPED,
};

const RUNNER_RESULT: Readonly<Record<number, RunnerResult>> = {
  [Result.SUCCESS]: "success",
  [Result.FAILURE]: "failure",
  [Result.CANCELLED]: "cancelled",
  [Result.SKIPPED]: "skipped",
};

interface MapRow {
  wire_id: number;
  job_id: number;
  task: number;
  runner_id: number;
  confirmed_at: number | null;
}

export class RunDispatch {
  constructor(private readonly host: DispatchHost) {}

  #count(op: string, statements = 1): void {
    this.host.metrics.count("d1.query", { db: "directory", op }, statements);
  }

  #store() {
    return tokenStore(this.host.env, { metrics: this.host.metrics });
  }

  // ---------------------------------------------------------------- assignment

  /**
   * Assigns a job and returns its encoded task. Replaying an unconfirmed
   * offer rotates its job token. A confirmed offer is refused without
   * changing the active token. A token minted after confirmation or task
   * completion is revoked before the answer.
   */
  async assignTask(
    wireId: number,
    jobId: number,
    runnerId: number,
    accountId: string,
  ): Promise<AssignTaskAnswer> {
    const { host } = this;
    // Runners serve their own account's repositories. The index can lag a transfer, so the
    // repository's owner decides, read before the assignment and again before the answer.
    const run = host.engine.run();
    if (run) {
      const refused = await this.#notOwnedBy(run.repo_id, accountId);
      if (refused) {
        if (refused === "wrong_account") host.ensureDispatch();
        host.log.info("task refused for its repository's account", {
          taskId: wireId,
          runnerId,
          code: refused,
        });
        return { refused };
      }
    }
    // Without a CI master key no mask can be sealed: refused before the job is assigned or a
    // token minted, so the job stays queued and an earlier answer's token stays valid.
    if (!(await ciSecretKeys(host.env)).current) {
      host.log.warn("task withheld: there is no CI master key to seal its masks", {
        taskId: wireId,
        jobId,
      });
      return { refused: "ci_key_unavailable" };
    }
    const assigned = host.assign(jobId, `t${wireId}`);
    if (!assigned.ok) return { refused: assigned.code };
    const ref = assigned.task;
    // A task out of token masks is never given another: refused before anything is written or
    // minted. Overlapping re-offers can both pass this; registering the token decides.
    if (host.jobTokensFull(ref.task)) return this.#tokensFull(wireId, ref);
    // A re-offer whose stored tokens do not open could not mask a new one: refused before anything
    // is written or minted, so its earlier token stays valid. Registering the token checks again,
    // for keys that change in between.
    if (assigned.tokenScopes.length > 0 && !(await host.jobTokenMasksOpen(ref.task))) {
      host.log.warn("task withheld: its stored masks do not open", {
        taskId: wireId,
        task: ref.task,
      });
      return { refused: "masks_unreadable" };
    }
    host.tx(() =>
      host.engine.exec(
        `INSERT INTO ci_tasks (wire_id, job_id, task, runner_id) VALUES (?, ?, ?, ?)
         ON CONFLICT (wire_id) DO NOTHING`,
        wireId,
        ref.jobId,
        ref.task,
        runnerId,
      ),
    );
    await host.hooks.beforeTaskRecord?.();
    const db = host.env.DIRECTORY;
    this.#count("ci_task_assigned", 3);
    const [recorded, earlier, offer] = await db.batch([
      // Only on an offer still standing: one given up at its poll's deadline is not assigned
      // (that release and this write exclude each other through `superseded_at` and `task`).
      db
        .prepare(
          "UPDATE ci_tasks SET task = ? WHERE id = ? AND superseded_at IS NULL AND confirmed_at IS NULL",
        )
        .bind(ref.task, wireId),
      db.prepare("SELECT token_id FROM ci_job_tokens WHERE task_id = ?").bind(wireId),
      db.prepare("SELECT confirmed_at FROM ci_tasks WHERE id = ?").bind(wireId),
    ]);
    if ((recorded?.meta.changes ?? 0) === 0) {
      const row = offer?.results[0] as { confirmed_at: number | null } | undefined;
      return { refused: row && row.confirmed_at !== null ? "confirmed" : "released" };
    }
    const previous = ((earlier?.results ?? []) as { token_id: string }[]).map((r) => r.token_id);

    const store = this.#store();
    const minted =
      assigned.tokenScopes.length === 0
        ? undefined
        : await store.mint({
            principalId: assigned.actorId,
            type: "job",
            scopes: [...assigned.tokenScopes],
            repoIds: [assigned.repoId],
            ttlMs: Math.min(
              assigned.timeoutMinutes * 60_000 + JOB_TOKEN_GRACE_MS,
              JOB_TOKEN_MAX_MS,
            ),
            audit: { actorId: null },
          });
    // Failed assignments retry revocation before propagating the error. Confirmed tasks are
    // excluded from token rotation.
    let ownRevoked = false;
    const revokeOwn = async () => {
      if (!minted) return;
      const at = host.now();
      this.#count("ci_job_token_revoke", 2);
      await db.batch([
        db
          .prepare(
            `INSERT INTO audit_log (at, actor_id, act_chain, action, target_id, details, request_id)
             SELECT ?1, NULL, NULL, 'token.revoke', id, NULL, NULL FROM tokens
             WHERE id = ?2 AND revoked_at IS NULL`,
          )
          .bind(at, minted.id),
        db
          .prepare("UPDATE tokens SET revoked_at = ?1 WHERE id = ?2 AND revoked_at IS NULL")
          .bind(at, minted.id),
      ]);
      ownRevoked = true;
    };
    const github = jsonObject(assigned.github);
    let triggeringActor: string;
    try {
      if (minted) {
        this.#count("ci_job_token_map");
        await db
          .prepare("INSERT INTO ci_job_tokens (token_id, task_id, created_at) VALUES (?, ?, ?)")
          .bind(minted.id, wireId, host.now())
          .run();
        await host.hooks.afterMint?.(minted.token);
        await host.hooks.beforeTokenMask?.();
        const masked = await host.addJobTokenMask(ref.task, minted.token);
        if (masked === "full") {
          await revokeOwn();
          return this.#tokensFull(wireId, ref, minted.id);
        }
        // A token that cannot be masked is never handed out. The key went after the check above;
        // the earlier tokens are not rotated, so an answer in flight stays valid.
        if (masked === "key_unavailable") {
          await revokeOwn();
          host.log.warn("job token withheld: no CI master key seals the task's masks", {
            taskId: wireId,
            task: ref.task,
            tokenId: minted.id,
          });
          return { refused: "ci_key_unavailable" };
        }
        // The task's stored tokens do not open under any key there is: this token could not be
        // masked with them, so it is revoked; the earlier tokens and the offer are kept.
        if (masked === "masks_unreadable") {
          await revokeOwn();
          host.log.warn("job token withheld: the task's stored masks do not open", {
            taskId: wireId,
            task: ref.task,
            tokenId: minted.id,
          });
          return { refused: "masks_unreadable" };
        }
      }
      triggeringActor = await this.#triggeringActor(assigned, github);
      await host.hooks.beforeTokenRotation?.();
      const eligible = `id IN (SELECT value FROM json_each(?1)) AND revoked_at IS NULL
        AND EXISTS (SELECT 1 FROM ci_tasks WHERE id = ?2 AND confirmed_at IS NULL)`;
      const at = host.now();
      this.#count("ci_job_token_rotate", 3);
      const [, , rotated] = await db.batch([
        db
          .prepare(
            `INSERT INTO audit_log (at, actor_id, act_chain, action, target_id, details, request_id)
           SELECT ?3, NULL, NULL, 'token.revoke', id, NULL, NULL FROM tokens WHERE ${eligible}`,
          )
          .bind(JSON.stringify(previous), wireId, at),
        db
          .prepare(`UPDATE tokens SET revoked_at = ?3 WHERE ${eligible}`)
          .bind(JSON.stringify(previous), wireId, at),
        db.prepare("SELECT confirmed_at FROM ci_tasks WHERE id = ?").bind(wireId),
      ]);
      const state = rotated?.results[0] as { confirmed_at: number | null } | undefined;
      if (!state || state.confirmed_at !== null) {
        await revokeOwn();
        return { refused: state ? "confirmed" : "released" };
      }
      // The task may have ended while the token was minted: such a token is never handed out.
      if (!host.taskLive(ref)) {
        await revokeOwn();
        return { refused: "task_finished" };
      }
      // Read again before the answer. A transfer that began after the first read and before this
      // one makes this assignment lose: no task is handed out, its token is revoked, and the
      // instance, assigned but run by nobody, is ended by run-state's heartbeat deadline. A
      // transfer that begins after this read meets an assignment made while the runner's account
      // owned the repository, like any task already running, which keeps reporting.
      if (run) {
        const refused = await this.#notOwnedBy(run.repo_id, accountId);
        if (refused) {
          await revokeOwn();
          host.log.info("task withheld: its repository changed hands", {
            taskId: wireId,
            task: ref.task,
            code: refused,
          });
          return { refused };
        }
      }
      await host.hooks.beforeTaskAnswer?.();
      // Asked again after the last await, right before the answer: a task that ended meanwhile is
      // never handed out.
      if (!host.taskLive(ref)) {
        await revokeOwn();
        return { refused: "task_finished" };
      }
    } catch (error) {
      if (!ownRevoked) {
        try {
          await revokeOwn();
        } catch (revocation) {
          host.log.warn("job token of a failed assignment not revoked", {
            taskId: wireId,
            task: ref.task,
            tokenId: minted?.id,
            error: revocation instanceof Error ? revocation.message : String(revocation),
          });
        }
      }
      throw error;
    }
    if (minted)
      host.log.info("job token minted", { taskId: wireId, task: ref.task, tokenId: minted.id });
    else host.log.info("task assigned without a job token", { taskId: wireId, task: ref.task });
    const token = minted?.token ?? "";
    return {
      task: encodeTask({
        id: wireId,
        workflowPayload: assigned.payload,
        context: {
          ...github,
          // The attempt's own: a re-run reuses the run's context, whose `actor` stays the
          // original trigger's.
          run_attempt: String(assigned.attempt),
          triggering_actor: triggeringActor,
          token,
          // Where the runner resolves short-form `uses:` actions: GitHub, as Gitea's default (a
          // runner's own `github_mirror` replaces it). Left empty, the runner resolves them against
          // this forge, which hosts none (runner `run/runner.go` getDefaultActionsURL, v6.0.0 and
          // v5.4.1; measured with a real runner).
          gitea_default_actions_url: DEFAULT_ACTIONS_URL,
        },
        // Never empty: the pinned runner writes into this map (measured).
        secrets: new Map([
          ["GITHUB_TOKEN", token],
          ["GITEA_TOKEN", token],
        ]),
        machine: "",
        needs: new Map(
          Object.entries(assigned.needs).map(([name, need]): [string, TaskNeed] => [
            name,
            { result: NEED_RESULT[need.result], outputs: new Map(Object.entries(need.outputs)) },
          ]),
        ),
        vars: new Map(),
      }),
    };
  }

  /** Keeps the last offered token valid while the Worker searches for other work. */
  #tokensFull(
    wireId: number,
    ref: TaskRef,
    tokenId?: string,
  ): { readonly refused: "tokens_exhausted" } {
    this.host.log.warn("job token withheld: the task's log masks no more tokens", {
      taskId: wireId,
      task: ref.task,
      ...(tokenId !== undefined && { tokenId }),
    });
    return { refused: "tokens_exhausted" };
  }

  /**
   * The handle of who started the attempt: the context's `actor` when that
   * is the run's original trigger, else read from the directory (a re-run
   * by someone else); empty when it cannot be read.
   */
  async #triggeringActor(
    assigned: Extract<AssignAnswer, { ok: true }>,
    github: Record<string, unknown>,
  ): Promise<string> {
    if (assigned.triggeringActorId === assigned.actorId && typeof github.actor === "string")
      return github.actor;
    this.#count("ci_triggering_actor");
    try {
      const row = await this.host.env.DIRECTORY.prepare(
        `SELECT ${SHOWN_HANDLE} AS handle FROM principals p WHERE p.id = ?`,
      )
        .bind(assigned.triggeringActorId)
        .first<{ handle: string | null }>();
      return row?.handle ?? "";
    } catch {
      return "";
    }
  }

  /**
   * Why account `accountId` may not be given work of repository `repoId` now:
   * another account owns it, or a transfer is under way (it begins before the
   * owner changes); undefined when it may. One read of the primary.
   */
  async #notOwnedBy(
    repoId: string,
    accountId: string,
  ): Promise<"wrong_account" | "repo_transferring" | undefined> {
    this.#count("ci_repo_owner");
    const row = await this.host.env.DIRECTORY.withSession("first-primary")
      .prepare(
        `SELECT owner_id, EXISTS (SELECT 1 FROM repo_transfers
           WHERE repo_id = ?1 AND step NOT IN ('done', 'failed')) AS transferring
         FROM repos WHERE id = ?1`,
      )
      .bind(repoId)
      .first<{ owner_id: string; transferring: number }>();
    if (row?.owner_id !== accountId) return "wrong_account";
    return row.transferring === 1 ? "repo_transferring" : undefined;
  }

  // ---------------------------------------------------------------- reports

  /**
   * An UpdateTask for wire task `wireId`: decoded here, the task confirmed
   * once, then a heartbeat (no result) or the completion (a result), and the
   * answer the runner acts on: CANCELLED stops it.
   */
  async reportTask(wireId: number, body: Uint8Array, runnerId: number): Promise<ReportTaskAnswer> {
    const { host } = this;
    await host.hooks.beforeReport?.();
    let request: ReturnType<typeof decodeUpdateTaskRequest>;
    try {
      request = decodeUpdateTaskRequest(body);
    } catch (error) {
      if (error instanceof ProtoError)
        return { ok: false, code: "invalid_argument", message: INVALID_MESSAGE };
      throw error;
    }
    if (request.state?.id !== wireId)
      return { ok: false, code: "invalid_argument", message: TASK_ID_MISMATCH };
    const result = request.state.result;
    if (result !== Result.UNSPECIFIED && RUNNER_RESULT[result] === undefined)
      return { ok: false, code: "invalid_argument", message: TASK_RESULT_UNKNOWN };
    const answer = (resultCode: number, sent: readonly string[] = []): ReportTaskAnswer => ({
      ok: true,
      response: encodeUpdateTaskResponse({
        state: { id: wireId, result: resultCode, steps: [], reportedSteps: [] },
        sentOutputs: [...sent],
      }),
    });
    // An erased run's runner is told to stop.
    if (host.erased()) return answer(Result.CANCELLED);
    const map = host.engine.rows<MapRow>("SELECT * FROM ci_tasks WHERE wire_id = ?", wireId)[0];
    if (!map) return { ok: false, code: "not_found", message: TASK_NOT_FOUND };
    const ref: TaskRef = { jobId: map.job_id, task: map.task };
    if (map.confirmed_at === null) await this.confirm(wireId, runnerId);

    if (result === Result.UNSPECIFIED) {
      const beat = host.updateTask(ref);
      if (beat.ok) return answer(beat.cancel ? Result.CANCELLED : Result.UNSPECIFIED);
      if (beat.code === "unknown_task")
        return { ok: false, code: "not_found", message: TASK_NOT_FOUND };
      return answer(Result.CANCELLED);
    }
    const outputs = Object.fromEntries(request.outputs);
    // The log as stored now: one still streaming ends incomplete (the run ends it with the
    // instance), never waited for. A whole final UpdateLog that lands later still completes it.
    const done = host.tx(() =>
      host.completeTask(ref, {
        result: RUNNER_RESULT[result] as RunnerResult,
        ...(request.outputs.size > 0 && { outputs }),
        logComplete: host.logComplete(ref.task),
      }),
    );
    if (done.ok) {
      const stored = host.engine.instance(ref.jobId)?.outputs ?? null;
      return answer(result, stored === null ? [] : Object.keys(outputs));
    }
    if (done.code === "unknown_task")
      return { ok: false, code: "not_found", message: TASK_NOT_FOUND };
    // Finished already (or the run was erased): nothing it sends changes it, so it need not resend.
    return answer(Result.CANCELLED, [...request.outputs.keys()]);
  }

  /** The first report of a task (UpdateTask or UpdateLog): its row, and an ephemeral runner's, record it. */
  async confirm(wireId: number, runnerId: number): Promise<void> {
    const { host } = this;
    const now = host.now();
    const db = host.env.DIRECTORY;
    this.#count("ci_task_confirm", 2);
    await db.batch([
      // Only a task the directory recorded as assigned is confirmed (and only then counts
      // against an ephemeral runner's one task); changes() is the first update's.
      db
        .prepare(
          "UPDATE ci_tasks SET confirmed_at = COALESCE(confirmed_at, ?) WHERE id = ? AND task IS NOT NULL",
        )
        .bind(now, wireId),
      db
        .prepare(
          "UPDATE ci_runners SET task_confirmed_at = COALESCE(task_confirmed_at, ?) WHERE id = ? AND ephemeral = 1 AND changes() > 0",
        )
        .bind(now, runnerId),
    ]);
    host.tx(() =>
      host.engine.exec(
        "UPDATE ci_tasks SET confirmed_at = ? WHERE wire_id = ? AND confirmed_at IS NULL",
        now,
        wireId,
      ),
    );
  }

  // ---------------------------------------------------------------- background work

  /**
   * Reconciles the directory's pending rows of this run with its queued
   * instances: what D1 holds is read back each time, so a reset between the
   * D1 commit and the watermark leaves nothing a later pass misses. Done only
   * once the watermark reaches the queue revision the pass synced.
   */
  async dispatchSlice(job: Job): Promise<SliceResult> {
    const { host } = this;
    const run = host.engine.run();
    if (!run) return { done: true };
    const db = host.env.DIRECTORY.withSession("first-primary");
    this.#count("ci_dispatch_read", 2);
    const [owner, published] = await db.batch([
      db.prepare("SELECT owner_id FROM repos WHERE id = ?").bind(run.repo_id),
      db
        .prepare("SELECT job_id, account_id FROM ci_pending_jobs WHERE run_id = ?")
        .bind(run.run_id),
    ]);
    const accountId = (owner?.results[0] as { owner_id: string } | undefined)?.owner_id;
    // The queued set and its revision, read together after D1 answered.
    const snapshot = host.tx(() => ({
      rev: (host.engine.run() as RunRow).queue_rev,
      queued: host.queued(PAGE),
    }));
    // A repository no longer in the directory runs nothing more: withdraw everything.
    const queued = accountId === undefined ? [] : snapshot.queued;
    const have = new Map(
      ((published?.results ?? []) as { job_id: number; account_id: string }[]).map((r) => [
        r.job_id,
        r.account_id,
      ]),
    );
    const want = new Set(queued.map((q) => q.jobId));
    const inserts = queued.filter((q) => !have.has(q.jobId));
    // Published under an account that no longer owns the repository: moved to the one that does.
    const moves = queued.filter((q) => have.has(q.jobId) && have.get(q.jobId) !== accountId);
    const deletes = [...have.keys()].filter((id) => !want.has(id));
    const toPublish = inserts.length + moves.length;
    if (toPublish > 0 || deletes.length > 0) {
      await host.hooks.beforeDispatchCommit?.();
      const writes: D1PreparedStatement[] = [];
      const raw = host.env.DIRECTORY;
      if (deletes.length > 0)
        writes.push(
          raw
            .prepare(
              "DELETE FROM ci_pending_jobs WHERE run_id = ? AND job_id IN (SELECT value FROM json_each(?))",
            )
            .bind(run.run_id, JSON.stringify(deletes)),
        );
      if (moves.length > 0 && accountId !== undefined)
        writes.push(
          raw
            .prepare(
              `UPDATE ci_pending_jobs SET account_id = ?, claimed_by = NULL, claim_until = NULL,
                 claim_nonce = NULL
               WHERE run_id = ? AND job_id IN (SELECT value FROM json_each(?))`,
            )
            .bind(accountId, run.run_id, JSON.stringify(moves.map((q) => q.jobId))),
        );
      if (inserts.length > 0 && accountId !== undefined)
        writes.push(
          raw
            .prepare(
              // The repository and fork flag decide which runner may claim it (none, for a fork job
              // or a public repository's: the claim reads both).
              `INSERT OR IGNORE INTO ci_pending_jobs
                 (account_id, run_id, job_id, attempt, labels, queued_at, repo_id, fork)
               SELECT ?, ?, json_extract(value, '$.jobId'), json_extract(value, '$.attempt'),
                      json_extract(value, '$.labels'), json_extract(value, '$.queuedAt'), ?, ?
               FROM json_each(?)`,
            )
            .bind(
              accountId,
              run.run_id,
              run.repo_id,
              run.fork === 0 ? 0 : 1,
              JSON.stringify(
                inserts.map((q) => ({
                  jobId: q.jobId,
                  attempt: q.attempt,
                  labels: q.runsOn,
                  queuedAt: q.queuedAt,
                })),
              ),
            ),
        );
      if (toPublish > 0 && accountId !== undefined)
        writes.push(
          // Runners search again once their version is behind.
          raw
            .prepare(
              `INSERT INTO ci_dispatch (account_id, tasks_version) VALUES (?, 1)
               ON CONFLICT (account_id) DO UPDATE SET tasks_version = tasks_version + 1`,
            )
            .bind(accountId),
        );
      this.#count("ci_dispatch_write", writes.length);
      await raw.batch(writes);
      host.log.info("dispatch index synced", {
        runId: run.run_id,
        published: inserts.length,
        moved: moves.length,
        withdrawn: deletes.length,
      });
      await host.hooks.afterDispatchCommit?.();
    }
    host.guarded(job, () =>
      host.engine.exec(
        "UPDATE runs SET queue_synced_rev = max(queue_synced_rev, ?) WHERE id = 1",
        snapshot.rev,
      ),
    );
    const after = host.engine.run();
    if (after && after.queue_synced_rev < after.queue_rev)
      return { done: false, cursor: null, runAfterMs: 0 };
    // Caught up. While anything is published, look again later: nothing tells the run when its
    // repository moves. The watermark, not this job, is what the run counts as owed, and a
    // change to the queue moves this later run earlier.
    return want.size > 0
      ? { done: false, cursor: null, runAfterMs: DISPATCH_RESYNC_MS }
      : { done: true };
  }

  /**
   * Deals with tasks whose instance completed, in task-end order: their
   * directory rows end, their job tokens are revoked, and an ephemeral
   * runner's credential is spent from its task's completion plus
   * `EPHEMERAL_REPORT_MS` (written once: a repeated pass keeps it). Done once
   * the watermark reaches the last task end.
   */
  async taskEndSlice(job: Job): Promise<SliceResult> {
    const { host } = this;
    const run = host.engine.run();
    if (!run) return { done: true };
    const ended = host.engine.rows<Pick<InstanceRow, "task" | "task_end_seq" | "completed_at">>(
      `SELECT task, task_end_seq, completed_at FROM run_instances
       WHERE task_end_seq > ? ORDER BY task_end_seq LIMIT ?`,
      run.task_end_acked,
      PAGE,
    );
    const last = ended.at(-1)?.task_end_seq;
    if (last === undefined || last === null) return { done: true };
    await host.hooks.beforeTaskEnd?.();
    const completedAt = new Map(ended.map((e) => [e.task as number, e.completed_at as number]));
    const tasks = host.engine.rows<MapRow>(
      "SELECT * FROM ci_tasks WHERE task IN (SELECT value FROM json_each(?))",
      JSON.stringify([...completedAt.keys()]),
    );
    if (tasks.length > 0) {
      const db = host.env.DIRECTORY;
      const wireIds = JSON.stringify(tasks.map((t) => t.wire_id));
      this.#count("ci_job_tokens_live");
      const { results } = await db
        .withSession("first-primary")
        .prepare(
          `SELECT j.token_id FROM ci_job_tokens j JOIN tokens t ON t.id = j.token_id
           WHERE j.task_id IN (SELECT value FROM json_each(?)) AND t.revoked_at IS NULL`,
        )
        .bind(wireIds)
        .all<{ token_id: string }>();
      const store = this.#store();
      for (const { token_id } of results) await store.revoke(token_id, { actorId: null });
      const writes = [
        db
          .prepare(
            "UPDATE ci_tasks SET ended_at = COALESCE(ended_at, ?) WHERE id IN (SELECT value FROM json_each(?))",
          )
          .bind(host.now(), wireIds),
        ...tasks.map((t) =>
          db
            .prepare(
              "UPDATE ci_runners SET expires_at = COALESCE(expires_at, ?) WHERE id = ? AND ephemeral = 1",
            )
            .bind((completedAt.get(t.task) ?? host.now()) + EPHEMERAL_REPORT_MS, t.runner_id),
        ),
      ];
      this.#count("ci_task_end", writes.length);
      await db.batch(writes);
      host.log.info("tasks ended", {
        runId: run.run_id,
        tasks: tasks.map((t) => t.task),
        revoked: results.length,
      });
    }
    await host.hooks.afterTaskEndCommit?.();
    host.guarded(job, () =>
      host.engine.exec(
        "UPDATE runs SET task_end_acked = max(task_end_acked, ?) WHERE id = 1",
        last,
      ),
    );
    const after = host.engine.run();
    return after && after.task_end_acked < after.task_end_seq
      ? { done: false, cursor: null, runAfterMs: 0 }
      : { done: true };
  }
}

/** The actions instance the runner fetches `uses:` actions from. */
const DEFAULT_ACTIONS_URL = "https://github.com";

/** The `github` context as a JSON object (none: an empty one). */
function jsonObject(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}
