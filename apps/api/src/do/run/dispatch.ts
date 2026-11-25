import type { DoMemoryBudget, Job, SliceResult } from "@fyrden/adapters-cloudflare/git";
import type { Logger, Metrics } from "@fyrden/adapters-cloudflare/obs";
import type {
  NeedResult,
  RunnerResult,
  SecretMaskOffer,
  SecretReferences,
} from "@fyrden/domain/ci";
import { SHOWN_HANDLE } from "../../accounts/handles.js";
import { ciSecretKeys } from "../../ci/envelope.js";
import { tookItsTask } from "../../runner/access.js";
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
import { EPHEMERAL_REPORT_MS } from "../../runner/registry.js";
import { tokenStore } from "../../services.js";
import type { AssignAnswer, TaskAnswer, TaskRef } from "../RunDO.js";
import type { InstanceRow, RunEngine, RunRow } from "./engine.js";
import type { SecretMasksAnswer } from "./logs.js";
import {
  deliveryMemory,
  oversizeError,
  type ReadSecrets,
  readSecrets,
  unavailableError,
  unmaskableError,
} from "./secrets.js";

/*
 * The runner protocol inside a run's object: the run's queued jobs published
 * to the directory's dispatch index, tasks assigned under the wire task ids
 * the directory hands out, job tokens minted for them and revoked when their
 * task ends, and the runner's reports decoded and passed to the run.
 *
 * A failed delivery of a job's secrets is recorded here before the directory
 * is asked to end its offer, so that one whose end did not commit, whose
 * answer was lost, or whose object was reset before its job was failed is
 * settled later (`recoverySlice`) by what the directory then says.
 */

/** The error of a job whose secrets are not delivered because its repository changed owner. */
const OWNER_CHANGED_ERROR =
  "owner_changed: the repository moved to another account after this run was created; its jobs are not given that account's secrets";

/** What `assignTask` answers: the encoded `Task`, or why the run refused it. */
export type AssignTaskAnswer =
  | { readonly task: Uint8Array }
  | {
      /**
       * `wrong_account`: the runner's account no longer owns the run's repository (it moved);
       * `repo_transferring`: the repository is being transferred; `released`: the offer was
       * given up (by its poll, or by the recovery of its failed delivery) before the assignment
       * could be recorded; `confirmed`: a report
       * made the stale offer no longer replayable. `tokens_exhausted`: the offer cannot be
       * repeated, but its last token and an in-flight answer remain valid.
       * `ci_key_unavailable`: no CI master key seals the task's masks. Refused before anything
       * is assigned or minted, or, when the key went while the token was masked, with that
       * token revoked; either way the offer stands, to be made again once there is a key.
       * `masks_unreadable`: there is a key, but the task's stored masks do not open (their key
       * gone from the keyring): refused before a token is minted, or, when the keys changed
       * while the token was masked, with that token revoked; the offer and its earlier tokens
       * stand, and the runner may be given other work.
       * `secrets_unreachable`: the repository's account object did not answer for the job's
       * secrets, or the run object had no memory to read them now: refused before anything is
       * assigned or minted; the offer stands, to be made again.
       * `secrets_undeliverable`: a re-offer (its task recorded in the directory, or a token minted
       * for it) whose secrets no longer open or no longer fit the job's mask budget: an earlier
       * answer may be running, so the job is not failed; nothing is minted, the offer and its
       * earlier tokens stand, and the runner may be given other work. On a first offer the run
       * ends the offer in the directory, unrecorded, and fails the job instead, and the answer is
       * `task_finished`; when it does not learn whether the offer ended, the answer is this one,
       * and the run settles the job later (`recoverySlice`).
       */
      readonly refused:
        | Extract<AssignAnswer, { ok: false }>["code"]
        | "wrong_account"
        | "repo_transferring"
        | "released"
        | "confirmed"
        | "tokens_exhausted"
        | "ci_key_unavailable"
        | "masks_unreadable"
        | "secrets_unreachable"
        | "secrets_undeliverable";
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
  /** Before a delivery's secrets are registered to be masked, before the task is recorded. */
  beforeSecretMasks?: () => Promise<void> | void;
  /** When a delivery has failed, before the directory ends its offer or answers it was recorded. */
  beforeDeliveryFailure?: () => Promise<void> | void;
  /** When a delivery has failed, after the directory answered, before the job is failed or kept. */
  afterDeliveryFailure?: () => Promise<void> | void;
  /** Before the directory is asked about unsettled failed deliveries. */
  beforeDeliveryRecovery?: () => Promise<void> | void;
  /** After it answered, before their jobs are failed, queued again or kept. */
  afterDeliveryRecovery?: () => Promise<void> | void;
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
  /** Has the unsettled failed deliveries looked at by `runAt`, or earlier. */
  ensureRecovery(runAt: number): void;
  /** Resolves once everything written so far is on disk. */
  durable(): Promise<void>;
  queued(
    limit: number,
    accountId?: string,
  ): { jobId: number; attempt: number; runsOn: string[]; queuedAt: number }[];
  ownedBy(accountId: string): void;
  reservationsWaiting(): boolean;
  assign(jobId: number, assignKey: string, accountId: string): AssignAnswer;
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
  /** Which secrets job `jobId` would be given, and whether its run is trusted; undefined for an unknown job. */
  secretsRequest(jobId: number): { trusted: boolean; refs: SecretReferences } | undefined;
  /** Registers the secrets delivered to the task to be masked in its log, sealed, within its budget. */
  addSecretMasks(task: number, secrets: readonly SecretMaskOffer[]): Promise<SecretMasksAnswer>;
  /**
   * Ends the task's instance as failed with `error`, before any runner was given it, once the run
   * has ended its offer in the directory unrecorded.
   */
  failTask(ref: TaskRef, error: string): boolean;
  /**
   * Puts the task's instance back in the queue: its offer was given up before this assignment
   * was recorded, so no runner was given it.
   */
  requeueTask(ref: TaskRef): boolean;
  /** The object's memory pool: reading a job's secrets reserves from it. */
  readonly memory: DoMemoryBudget;
  /** Gives back the memory the tasks' kept log-mask matchers hold (`RunLogs`). */
  dropMaskCaches(): void;
}

type MemoryReservation = NonNullable<ReturnType<DoMemoryBudget["tryReserve"]>>;

/**
 * Records an offer's task in the directory (?1 the task, ?2 the offer): only on an offer still
 * standing. One given up (superseded: its poll's deadline, a release, a lapsed claim) or ended
 * unrecorded (its secrets could not be delivered, `#deliveryFailed`) is never recorded: those
 * writes and this one exclude each other through `task`. An ephemeral runner's second offer is not
 * recorded either: the directory stamps the runner with the first one recorded (the
 * `ci_tasks_recorded` trigger), so whichever comes first is its one task.
 */
export const RECORD_TASK_SQL = `UPDATE ci_tasks SET task = ?1
  WHERE id = ?2 AND superseded_at IS NULL AND confirmed_at IS NULL AND ended_at IS NULL
    AND (task IS NOT NULL OR NOT EXISTS (SELECT 1 FROM ci_runners r
      WHERE r.id = ci_tasks.runner_id AND ${tookItsTask("r")}))`;

/**
 * After `RECORD_TASK_SQL` in its batch: gives up the offer (?1, at ?2) when
 * its ephemeral runner was assigned another, so no answer of it ever leaves.
 */
export const SUPERSEDE_SECOND_TASK_SQL = `UPDATE ci_tasks SET superseded_at = ?2
  WHERE id = ?1 AND task IS NULL AND superseded_at IS NULL AND ended_at IS NULL
    AND EXISTS (SELECT 1 FROM ci_runners r
      WHERE r.id = ci_tasks.runner_id AND ${tookItsTask("r")})`;

/**
 * The audit row of an assignment that delivers secrets (?1 the offer, ?2 the task, ?3 when, ?4
 * the account, ?5 the details), in the batch after `RECORD_TASK_SQL`: written exactly when the
 * record is, under the same predicate, so no answer carrying secrets leaves without it.
 */
export const DELIVERY_AUDIT_SQL = `INSERT INTO audit_log (at, actor_id, act_chain, action, target_id, details, request_id)
  SELECT ?3, NULL, NULL, 'ci.secrets.deliver', ?4, ?5, NULL
  WHERE EXISTS (SELECT 1 FROM ci_tasks WHERE id = ?1 AND task = ?2 AND superseded_at IS NULL
    AND confirmed_at IS NULL AND ended_at IS NULL)`;

/**
 * Gives up, at ?1, the offers (?2, a JSON array of ids) no answer of which ever left: neither
 * recorded (no task, no token) nor ended. `RECORD_TASK_SQL` never records one after.
 */
export const GIVE_UP_OFFERS_SQL = `UPDATE ci_tasks SET superseded_at = ?1
  WHERE id IN (SELECT value FROM json_each(?2)) AND task IS NULL AND ended_at IS NULL
    AND superseded_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM ci_job_tokens WHERE task_id = ci_tasks.id)`;

/** Where the offers ?1 (a JSON array of ids) stand. */
export const OFFERS_SQL = `SELECT id, task, ended_at, superseded_at,
    EXISTS (SELECT 1 FROM ci_job_tokens j WHERE j.task_id = ci_tasks.id) AS minted
  FROM ci_tasks WHERE id IN (SELECT value FROM json_each(?1))`;

/**
 * A failed delivery not settled by its own attempt is settled this long after it was last
 * recorded: by then its offer, unrecorded, is no longer made again (its claim's lease is as long),
 * though an attempt already running may still settle it. Proposed.
 */
export const DELIVERY_RECOVERY_MS = 30_000;
/** Failed deliveries one pass settles. Proposed. */
const RECOVERY_PAGE = 100;

/** A job token outlives its job's timeout by this. Proposed. */
const JOB_TOKEN_GRACE_MS = 10 * 60_000;
/** And never lives longer than this (GitHub's ceiling for a self-hosted job's token). */
const JOB_TOKEN_MAX_MS = 24 * 60 * 60_000;
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

interface DeliveryFailureRow {
  wire_id: number;
  job_id: number;
  task: number;
}

interface OfferRow {
  id: number;
  task: number | null;
  ended_at: number | null;
  superseded_at: number | null;
  minted: number;
}

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
    // The memory reserved for the job's secrets is held until the answer is made, whatever it is.
    const held: { reservation?: MemoryReservation | undefined } = {};
    try {
      return await this.#assignTask(wireId, jobId, runnerId, accountId, held);
    } finally {
      held.reservation?.release();
    }
  }

  async #assignTask(
    wireId: number,
    jobId: number,
    runnerId: number,
    accountId: string,
    held: { reservation?: MemoryReservation | undefined },
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
    const keys = await ciSecretKeys(host.env);
    if (!keys.current) {
      host.log.warn("task withheld: there is no CI master key to seal its masks", {
        taskId: wireId,
        jobId,
      });
      return { refused: "ci_key_unavailable" };
    }
    // A trusted run's job that names secrets has them read and opened before anything is assigned
    // or minted: an account object that does not answer leaves the job as it was. An untrusted
    // run's job gets none, and its account object is never asked.
    const request = run ? host.secretsRequest(jobId) : undefined;
    let delivery: ReadSecrets | undefined;
    // A run gets secrets only from the account it is bound to: after a transfer the new owner's
    // are never read for it, and its jobs that read secrets fail. A run bound to no owner (made
    // before runs were bound, or from an allocation stored without its owner) gets none either.
    const readsSecrets =
      request?.trusted === true && (request.refs.kind === "all" || request.refs.names.length > 0);
    const ownerChanged = readsSecrets && run?.owner_id !== accountId;
    if (run && request && readsSecrets && !ownerChanged) {
      // Bounded before the account is asked: the answer and the opened values fit what is
      // reserved, so jobs of one run assigned at once cannot together outgrow the object.
      const bytes = deliveryMemory(request.refs);
      held.reservation = host.memory.tryReserve(bytes);
      if (!held.reservation) {
        // Kept matchers only save rebuilding: they give way to an assignment.
        host.dropMaskCaches();
        held.reservation = host.memory.tryReserve(bytes);
      }
      if (!held.reservation) {
        host.log.warn("task withheld: the run has no memory free to read its secrets", {
          taskId: wireId,
          jobId,
        });
        return { refused: "secrets_unreachable" };
      }
      delivery = await readSecrets(
        host.env,
        keys,
        accountId,
        run.repo_id,
        request.refs,
        host.metrics,
      );
      if (!delivery.ok && delivery.code === "unreachable") {
        host.log.warn("task withheld: its repository's account did not answer for its secrets", {
          taskId: wireId,
          jobId,
          reason: delivery.reason,
        });
        return { refused: "secrets_unreachable" };
      }
    }
    const assigned = host.assign(jobId, `t${wireId}`, accountId);
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
    // Secrets that do not open, or that could not all be masked, are never handed out: the job
    // never runs with a secret missing or unmasked. Decided before anything of this assignment
    // reaches the directory and before any token is minted. A first offer fails the job; a
    // re-offer (an answer of it may have left) is only refused.
    const secrets = delivery?.ok ? delivery.secrets : [];
    const undeliverable = (code: string, error: string, names: readonly string[]) =>
      this.#deliveryFailed(wireId, ref, code, error, names);
    if (ownerChanged) return undeliverable("owner_changed", OWNER_CHANGED_ERROR, []);
    if (delivery && !delivery.ok && delivery.code === "secrets_unavailable")
      return undeliverable("secrets_unavailable", unavailableError(delivery.names), delivery.names);
    if (delivery && !delivery.ok && delivery.code === "secrets_oversize")
      return undeliverable(
        "secrets_unmaskable",
        oversizeError(delivery.secrets),
        delivery.secrets.map((s) => s.name),
      );
    if (secrets.length > 0) {
      await host.hooks.beforeSecretMasks?.();
      const masked = await host.addSecretMasks(ref.task, secrets);
      if (!masked.ok) {
        if (masked.code === "secrets_unmaskable")
          return undeliverable(
            "secrets_unmaskable",
            unmaskableError(masked),
            masked.secrets.map((s) => s.name),
          );
        if (masked.code === "ci_key_unavailable") {
          host.log.warn("task withheld: no CI master key seals its secrets' masks", {
            taskId: wireId,
            task: ref.task,
          });
          return { refused: "ci_key_unavailable" };
        }
        if (masked.code === "masks_unreadable") {
          host.log.warn("task withheld: its stored masks do not open", {
            taskId: wireId,
            task: ref.task,
          });
          return { refused: "masks_unreadable" };
        }
        // `untrusted_run`: a run's trust never changes, so this is not reached.
        throw new Error("secrets were read for an untrusted run");
      }
    }
    // Checked last before the record: a task that ended (a failing attempt of the same offer ended
    // it) is not recorded. The directory decides between this record and a failing attempt's end
    // of the offer (`RECORD_TASK_SQL`, `#deliveryFailed`).
    if (!host.taskLive(ref)) return { refused: "task_finished" };
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
    const record = [
      db.prepare(RECORD_TASK_SQL).bind(ref.task, wireId),
      db.prepare("SELECT token_id FROM ci_job_tokens WHERE task_id = ?").bind(wireId),
      db
        .prepare("SELECT confirmed_at, task, ended_at, superseded_at FROM ci_tasks WHERE id = ?")
        .bind(wireId),
    ];
    // After them, so the results above keep their places; all still run after the record.
    record.push(db.prepare(SUPERSEDE_SECOND_TASK_SQL).bind(wireId, host.now()));
    if (secrets.length > 0)
      record.push(
        db.prepare(DELIVERY_AUDIT_SQL).bind(
          wireId,
          ref.task,
          host.now(),
          accountId,
          JSON.stringify({
            repo_id: run?.repo_id ?? null,
            run_id: run?.run_id ?? null,
            job_id: ref.jobId,
            task_id: wireId,
            secrets: secrets
              .map((s) => ({ scope: s.scope, name: s.name, generation: s.generation }))
              .sort((a, b) =>
                a.scope === b.scope ? (a.name < b.name ? -1 : 1) : a.scope < b.scope ? -1 : 1,
              ),
          }),
        ),
      );
    this.#count("ci_task_assigned", record.length);
    const [recorded, earlier, offer] = await db.batch(record);
    if ((recorded?.meta.changes ?? 0) === 0) {
      const row = offer?.results[0] as
        | {
            confirmed_at: number | null;
            task: number | null;
            ended_at: number | null;
            superseded_at: number | null;
          }
        | undefined;
      if (row && row.confirmed_at !== null) return { refused: "confirmed" };
      if (row && row.task === null) {
        // Ended unrecorded: the failing attempt that ended it, or its recovery, ends the instance.
        if (row.ended_at !== null && row.superseded_at === null)
          return { refused: "task_finished" };
        // Given up unrecorded (superseded; or the second offer of an ephemeral runner, superseded
        // after this read): no answer of this offer ever left, and none can, so the instance
        // assigned for it waits in the queue again for another offer. Ended too, by an attempt
        // whose task was queued again before, it is not the task that attempt fails.
        if (host.requeueTask(ref))
          host.log.info("task never recorded: its job is queued again", {
            taskId: wireId,
            task: ref.task,
          });
      }
      return { refused: "released" };
    }
    const previous = ((earlier?.results ?? []) as { token_id: string }[]).map((r) => r.token_id);
    // The task may have ended while it was recorded: no token is minted for it.
    if (!host.taskLive(ref)) return { refused: "task_finished" };

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
        // Never empty: the pinned runner writes into this map (measured). The job token entries
        // come last, so a secret of either name never replaces the token.
        secrets: new Map([
          ...secrets.map((s): [string, string] => [s.name, s.value]),
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
        vars: new Map(Object.entries(assigned.vars)),
      }),
    };
  }

  /**
   * Answers an assignment whose secrets cannot be delivered. The directory decides, in one batch
   * that ends the offer only while it was never recorded (no task, no token): a re-offer, for
   * which an answer may already have left (its task recorded or a token minted for it), is
   * refused retryably: an earlier answer may be running the job, so it is not failed, nothing is
   * minted, and the offer and its earlier tokens stand. A first offer is ended there, so no
   * attempt can record it after (`RECORD_TASK_SQL`), and its job fails: nothing was recorded or
   * handed out, and no runner's credential is spent. An end whose outcome is not known is refused
   * retryably too. The failure is on disk before the directory is asked, so what this attempt
   * does not settle (an end refused or unanswered, a reset before the job is failed) the run
   * settles later (`recoverySlice`).
   */
  async #deliveryFailed(
    wireId: number,
    ref: TaskRef,
    code: string,
    error: string,
    names: readonly string[],
  ): Promise<{ readonly refused: "task_finished" | "secrets_undeliverable" }> {
    const { host } = this;
    const db = host.env.DIRECTORY;
    const withheld = (reason: string) => {
      host.log.warn("task withheld: its secrets cannot be delivered", {
        taskId: wireId,
        task: ref.task,
        code,
        reason,
        secrets: names.slice(0, 10),
      });
      return { refused: "secrets_undeliverable" } as const;
    };
    const scheduled = host.tx(() => {
      if (!host.taskLive(ref)) return false;
      const at = host.now();
      host.engine.exec(
        `INSERT INTO ci_delivery_failures (wire_id, job_id, task, error, recorded_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (wire_id) DO UPDATE SET job_id = excluded.job_id, task = excluded.task,
           error = excluded.error, recorded_at = excluded.recorded_at`,
        wireId,
        ref.jobId,
        ref.task,
        error,
        at,
      );
      host.ensureRecovery(at + DELIVERY_RECOVERY_MS);
      return true;
    });
    if (scheduled) {
      await host.durable();
      this.#recovery("scheduled", wireId, ref);
    }
    this.#count("ci_task_undeliverable", 3);
    let offer: { task: number | null } | undefined;
    let tokens: number;
    try {
      await host.hooks.beforeDeliveryFailure?.();
      const [, read, minted] = await db.batch([
        db
          .prepare(
            `UPDATE ci_tasks SET ended_at = ?1 WHERE id = ?2 AND task IS NULL AND ended_at IS NULL
               AND NOT EXISTS (SELECT 1 FROM ci_job_tokens WHERE task_id = ?2)`,
          )
          .bind(host.now(), wireId),
        db.prepare("SELECT task FROM ci_tasks WHERE id = ?").bind(wireId),
        db.prepare("SELECT 1 FROM ci_job_tokens WHERE task_id = ? LIMIT 1").bind(wireId),
      ]);
      offer = read?.results[0] as { task: number | null } | undefined;
      tokens = minted?.results.length ?? 0;
    } catch {
      return withheld("offer_not_ended");
    }
    await host.hooks.afterDeliveryFailure?.();
    // Recorded, or a token minted: an answer may have left.
    if ((offer?.task ?? null) !== null || tokens > 0) {
      host.tx(() => this.#settled(wireId, ref));
      return withheld("answered_before");
    }
    // Ended unrecorded, by this attempt or an earlier one: no answer of it ever leaves.
    const failed = host.tx(() => {
      const ended = host.failTask(ref, error);
      this.#settled(wireId, ref);
      return ended;
    });
    host.log.warn("job failed: its secrets cannot be delivered", {
      taskId: wireId,
      task: ref.task,
      code,
      secrets: names.slice(0, 10),
      failed,
    });
    return { refused: "task_finished" };
  }

  /** Forgets task `ref`'s failed delivery; another task's, under the same offer, is kept. */
  #settled(wireId: number, ref: TaskRef): void {
    this.host.engine.exec(
      "DELETE FROM ci_delivery_failures WHERE wire_id = ? AND task = ?",
      wireId,
      ref.task,
    );
  }

  #recovery(outcome: string, wireId: number, ref: TaskRef): void {
    this.host.log.info("failed delivery", {
      taskId: wireId,
      jobId: ref.jobId,
      task: ref.task,
      outcome,
    });
  }

  /**
   * Settles the failed deliveries their own attempts did not, once they are due, by what the
   * directory says of their offers. One neither recorded nor ended is given up there first, so no
   * attempt still running can record it, and its job is queued again: its next offer reads the
   * secrets again. One ended unrecorded fails its job with the error its delivery had. One
   * recorded, or with a token minted, may have been answered: its job is kept. Nothing is recorded,
   * minted or read of any secret here. An outcome the directory did not answer changes nothing
   * here, and is asked again.
   */
  async recoverySlice(job: Job): Promise<SliceResult> {
    const { host } = this;
    const due = host.engine.rows<DeliveryFailureRow>(
      `SELECT wire_id, job_id, task FROM ci_delivery_failures WHERE recorded_at <= ?
       ORDER BY recorded_at, wire_id LIMIT ?`,
      host.now() - DELIVERY_RECOVERY_MS,
      RECOVERY_PAGE,
    );
    const refOf = (row: DeliveryFailureRow): TaskRef => ({ jobId: row.job_id, task: row.task });
    const live = due.filter((row) => host.taskLive(refOf(row)));
    // Its instance ended another way (cancelled, timed out): a task that ended never lives again.
    const ended = due.filter((row) => !live.includes(row));
    if (ended.length > 0)
      host.guarded(job, () => {
        for (const row of ended) {
          this.#settled(row.wire_id, refOf(row));
          this.#recovery("discarded_not_live", row.wire_id, refOf(row));
        }
      });
    if (live.length > 0) {
      await host.hooks.beforeDeliveryRecovery?.();
      const db = host.env.DIRECTORY;
      const ids = JSON.stringify(live.map((row) => row.wire_id));
      this.#count("ci_delivery_recover", 2);
      const [, read] = await db.batch([
        db.prepare(GIVE_UP_OFFERS_SQL).bind(host.now(), ids),
        db.prepare(OFFERS_SQL).bind(ids),
      ]);
      const offers = new Map(((read?.results ?? []) as OfferRow[]).map((o) => [o.id, o]));
      await host.hooks.afterDeliveryRecovery?.();
      for (const row of live) this.#recover(job, row, offers.get(row.wire_id));
    }
    const [next] = host.engine.rows<{ at: number | null }>(
      "SELECT min(recorded_at) AS at FROM ci_delivery_failures",
    );
    return next === undefined || next.at === null
      ? { done: true }
      : {
          done: false,
          cursor: null,
          runAfterMs: Math.max(0, next.at + DELIVERY_RECOVERY_MS - host.now()),
        };
  }

  /** Settles one failed delivery, unless its own attempt did, or its slice was taken over. */
  #recover(job: Job, row: DeliveryFailureRow, offer: OfferRow | undefined): void {
    const { host } = this;
    const ref: TaskRef = { jobId: row.job_id, task: row.task };
    let outcome: string | undefined;
    host.guarded(job, () => {
      const [failure] = host.engine.rows<{ error: string }>(
        "SELECT error FROM ci_delivery_failures WHERE wire_id = ? AND task = ?",
        row.wire_id,
        row.task,
      );
      if (!failure) return;
      let acted = true;
      if (offer && (offer.task !== null || offer.minted !== 0)) outcome = "kept_recorded";
      else if (!offer || offer.ended_at !== null) {
        outcome = "failed_ended";
        acted = host.failTask(ref, failure.error);
      } else if (offer.superseded_at !== null) {
        outcome = "requeued";
        acted = host.requeueTask(ref);
      } else throw new Error("a failed delivery's offer was not given up");
      if (!acted) outcome = "discarded_not_live";
      this.#settled(row.wire_id, ref);
    });
    if (outcome !== undefined) this.#recovery(outcome, row.wire_id, ref);
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
    // The queued set and its revision, read together after D1 answered. A repository no longer in
    // the directory runs nothing more: everything is withdrawn.
    const { rev, queued } = host.tx(() => {
      if (accountId !== undefined) host.ownedBy(accountId);
      return {
        rev: (host.engine.run() as RunRow).queue_rev,
        queued: accountId === undefined ? [] : host.queued(PAGE, accountId),
      };
    });
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
              // The repository and fork flag decide which runners may claim it (the claim reads
              // both, with the runner's access).
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
        rev,
      ),
    );
    const after = host.engine.run();
    if (after && after.queue_synced_rev < after.queue_rev)
      return { done: false, cursor: null, runAfterMs: 0 };
    // Caught up. While anything is published, or a queued job waits unpublished, look again later:
    // nothing tells the run when its repository moves or changes visibility. The watermark, not
    // this job, is what the run counts as owed, and a change to the queue moves this later run
    // earlier.
    return want.size > 0 || host.reservationsWaiting()
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
              // Only for an offer the directory recorded, or minted a token for: one never
              // recorded was never answered, so the runner was given nothing.
              `UPDATE ci_runners SET expires_at = COALESCE(expires_at, ?1) WHERE id = ?2 AND ephemeral = 1
                 AND (EXISTS (SELECT 1 FROM ci_tasks WHERE id = ?3 AND task IS NOT NULL)
                   OR EXISTS (SELECT 1 FROM ci_job_tokens WHERE task_id = ?3))`,
            )
            .bind(
              (completedAt.get(t.task) ?? host.now()) + EPHEMERAL_REPORT_MS,
              t.runner_id,
              t.wire_id,
            ),
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
