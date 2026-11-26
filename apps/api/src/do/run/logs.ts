import type { DoMemoryBudget, SliceResult } from "@fyrden/adapters-cloudflare/git";
import { countSubrequests, type Logger, type Metrics } from "@fyrden/adapters-cloudflare/obs";
import { tokenLength } from "@fyrden/domain";
import {
  checkSecretMasks,
  decideLogFlush,
  LOG_ROW_TOO_LARGE,
  type LogMask,
  type LogMaskCarry,
  type LogMaskReach,
  type MaskMatcherCache,
  type MaskMatcherOutcome,
  type MaskRowsResult,
  maskCrossLength,
  maskGapLength,
  maskRows,
  type SecretMaskCheck,
  type SecretMaskOffer,
  type StoredLogLine,
  settleFlush,
} from "@fyrden/domain/ci";
import {
  type CiKeyring,
  ciSecretKeys,
  type MaskAdditionalData,
  openMask,
  sealMask,
} from "../../ci/envelope.js";
import { hex } from "../../crypto/bytes.js";
import { type ConnectCode, UPDATE_LOG_PREFIX_BYTES } from "../../runner/connect.js";
import {
  INVALID_MESSAGE,
  LOG_INDEX_AHEAD,
  TASK_ID_MISMATCH,
  TASK_NOT_FOUND,
} from "../../runner/errors.js";
import {
  type DecodedUpdateLog,
  decodeUpdateLogRequest,
  encodeUpdateLogResponse,
  type Timestamp,
  UPDATE_LOG_MAX_CONTENT_BYTES,
  UPDATE_LOG_MAX_ROWS,
} from "../../runner/proto/messages.js";
import { ProtoError } from "../../runner/proto/wire.js";
import type { TaskAnswer, TaskRef } from "../RunDO.js";
import type { RunEngine } from "./engine.js";
import { type MaskCacheOutcome, MaskMatcherCaches } from "./mask-cache.js";
import { type LogLine, logLine, viewerHooks } from "./viewers.js";

/*
 * A task's log inside its run's object. The runner keeps every row past the
 * ack it was sent and resends all of them on each call, so nothing is
 * buffered here: a request's new rows are either stored as one NDJSON object
 * in R2 (bucket `CI`), named in the manifest, and acked, or not acked at all
 * and sent again. The ack is durable before it is sent, so a reset loses
 * nothing that was acked.
 *
 * Rows are masked before they are stored: the task's job tokens, the
 * secrets delivered to it and the values its rows register with
 * `::add-mask::` become `***`, whole or split across rows. Rows whose masked
 * text a later row could still change are left unacked for the runner to
 * resend (a few, for a while); the partial match in progress at the ack is
 * stored with it, so a resend after a reset masks the same. The values are
 * kept, sealed under the CI master key, until the log closes: when it
 * completes, or `LOG_LATE_MS` after its task ended incomplete, after which its
 * rows are refused. They are opened for each request that masks rows. The
 * matchers built from them (values and their encoded forms) are kept in
 * memory between requests while the log is open (`mask-cache.ts`): never
 * stored, dropped when the log closes, a final store commits, the run is
 * erased or other work needs the memory, and gone with the instance.
 *
 * While a job is watched live, each request's rows that are final as masked
 * (stored now, or settled and left unacked) are published to its sockets:
 * settled rows are masked with what the store will use (the stored masks,
 * the carry at the ack), so they are the rows stored later, byte for byte.
 */

/** How long an incomplete log takes rows after its task ended (a spent runner's report margin). Proposed. */
export const LOG_LATE_MS = 10 * 60_000;
/**
 * Job tokens a task's log is masked with at most: its first and the
 * re-mints of lost answers. Each is kept, so overlapping re-offers that
 * finish in any order all stay masked. Proposed.
 */
export const MAX_JOB_TOKEN_MASKS = 8;
/**
 * The room the caps on `::add-mask::` values keep for a task's job tokens,
 * the same from its first row whether or not any token is stored yet, so a
 * token registered late never changes which values register.
 */
const TOKEN_RESERVE = {
  values: MAX_JOB_TOKEN_MASKS,
  bytes: MAX_JOB_TOKEN_MASKS * tokenLength("job"),
} as const;
/** Closed logs whose masks one pass of the close job deletes. */
const CLOSE_PAGE = 256;
/** Times a mask write prepared outside its transaction is prepared again when the task's masks changed meanwhile. */
const MASK_WRITE_ATTEMPTS = 4;

export type MaskKind = "job_token" | "add_mask" | "secret";

/**
 * The additional data a mask row's value is sealed with: its run, task,
 * random id and kind, and the master key's id. Bound to the id, not the
 * row's `seq`, which is assigned when the row commits.
 */
export function maskAdditionalData(
  runId: string,
  task: number,
  maskId: string,
  kind: MaskKind,
): MaskAdditionalData {
  return (keyId) => `fyrden-ci-mask:v1:${runId}:${task}:${maskId}:${kind}:${keyId}`;
}

interface MaskRow {
  kind: MaskKind;
  from_index: number;
  mask_id: string;
  key_id: string | null;
  value: string;
}

/** A mask value sealed for its row, before the row is written. */
interface SealedMaskRow {
  readonly maskId: string;
  readonly keyId: string;
  /** `nonce.ciphertext`, base64. */
  readonly value: string;
  readonly crossLen: number;
}

/**
 * What `addMask` answers: registered (or there already), the task is out of token masks,
 * there is no current key to seal with, or the task's stored masks do not open while there
 * is one (their key gone from the keyring).
 */
export type AddMaskAnswer = "added" | "full" | "key_unavailable" | "masks_unreadable";

export type SecretMasksAnswer =
  | { readonly ok: true }
  | ({ readonly ok: false; readonly code: "secrets_unmaskable" } & Omit<
      Extract<SecretMaskCheck, { ok: false }>,
      "ok"
    >)
  | { readonly ok: false; readonly code: "ci_key_unavailable" }
  /** The task's secret masks do not open, though a current key exists. */
  | { readonly ok: false; readonly code: "masks_unreadable" }
  /** The task's run is untrusted: it is never given secrets, and its log request reserves for none. */
  | { readonly ok: false; readonly code: "untrusted_run" };

/**
 * Room a log request reserves beside its body for its task's masks, opened
 * and sealed: a constant, so masks added while the request runs are covered.
 * A trusted run's tasks may have secrets (up to 256 KiB of value text, about
 * 350 KiB sealed, and its opened copy), an untrusted run's only job tokens
 * and `::add-mask::` values (16 KiB). Proposed.
 */
export const MASK_HEADROOM_BYTES = { trusted: 1024 * 1024, untrusted: 64 * 1024 } as const;

/**
 * More values to mask a task's rows with, fetched again on every request
 * rather than stored here (none yet). They follow the stored masks, so a
 * partial match of one of them is not carried past a request's ack.
 */
export interface MaskSource {
  masksFor(ref: TaskRef): Promise<readonly string[]>;
}

export const NO_MASK_SOURCE: MaskSource = { masksFor: async () => [] };

/** What `appendLog` answers: an encoded UpdateLogResponse, or a Connect error. */
export type AppendLogAnswer =
  | { readonly ok: true; readonly response: Uint8Array }
  | {
      readonly ok: false;
      readonly code: Extract<ConnectCode, "not_found" | "invalid_argument">;
      readonly message: string;
    };

/** Pause or fail points for tests. */
export interface LogHooks {
  /** A request's new rows are to be stored, before their object is written. */
  beforeLogStore?: () => Promise<void> | void;
  /** After a chunk's object (`key`) is written, before the manifest records it. */
  afterLogPut?: (key: string) => Promise<void> | void;
  /** After the manifest and the ack are committed, before the answer. */
  afterLogCommit?: () => Promise<void> | void;
  /** After a log request confirmed its task, before its masks are read. */
  afterLogConfirm?: () => Promise<void> | void;
  /** After a mask write is sealed against the masks it read, before its transaction. */
  beforeMaskCommit?: (kind: MaskKind) => Promise<void> | void;
  /** A log request's masks were read, before they are opened. */
  beforeLogMasksOpen?: () => Promise<void> | void;
  /** A log request masked rows, with what it did with the task's kept matchers. */
  maskMatcher?: (task: number, outcome: MaskCacheOutcome) => void;
}

/** Where a request's final rows go: the job's live sockets (`viewers.ts`). */
export interface LogPublisher {
  /** Yielding pauses new catch-up reservations until release and waits for active readers to release memory. */
  beginUpload(): { yieldMemory(): Promise<void>; release(): void };
  logsExpired(): void;
  watched(jobId: number): boolean;
  /** `rows` from position `base` are final as masked (stored, or settled). */
  publish(jobId: number, task: number, base: number, rows: readonly LogLine[]): void;
  /** Gives back the memory held for sockets. */
  dropCaches(): void;
}

export interface LogsHost {
  readonly env: Env;
  readonly engine: RunEngine;
  readonly hooks: LogHooks;
  readonly metrics: Metrics;
  readonly log: Logger;
  /** Each request reserves before decoding; stored-log catch-up yields first when needed. */
  readonly memory: DoMemoryBudget;
  /** The most the tasks' kept mask matchers may hold, by estimate (`MASK_CACHE_BYTES`). */
  readonly maskCacheBytes: number;
  now(): number;
  erased(): boolean;
  tx<T>(fn: () => T): T;
  /** The task's first report: the directory records it, once. */
  confirm(wireId: number, runnerId: number): Promise<void>;
  updateTask(ref: TaskRef): TaskAnswer<{ cancel: boolean }>;
  markLogComplete(ref: TaskRef): void;
  /** Has the close job run by `runAt` (sooner if it already will). */
  ensureLogClose(runAt: number): void;
  readonly masks: MaskSource;
  readonly viewers: LogPublisher;
}

/**
 * A request reserves this many times its body: the body, the decoded rows,
 * their masked text and the NDJSON written from them. Masking copies only
 * the rows it changes, and `***` for a matched value of at least 2 chars
 * makes a row at most a third longer (a 2-char value between separators),
 * so a fourth share covers it. Proposed.
 */
const MEMORY_PER_BODY_BYTE = 4;
const BUCKET = "fyrden-ci";

interface MapRow {
  job_id: number;
  task: number;
  confirmed_at: number | null;
}

interface LogRow {
  ack_index: number;
  state: "streaming" | "complete" | "incomplete";
  mask_carry: string | null;
  ended_at: number | null;
  omitted_rows: number;
  gap_remaining: number;
  finalized: number;
}

/** What a request stores: lines `[start, end)` (a final sentinel is acked, not a line) and what goes with them. */
interface Store {
  readonly start: number;
  readonly end: number;
  readonly lines: readonly StoredLogLine[];
  readonly rows: number;
  readonly omitted: number;
  readonly gapRemaining: number | ((storedMasks: readonly LogMaskReach[]) => number);
  readonly final: boolean;
  /** `::add-mask::` values the stored rows registered, in order, with their rows. */
  readonly added: readonly { readonly value: string; readonly index: number }[];
  /** The carry at `end`, given the number of stored masks when it commits (null: none). */
  readonly carry: (storedMasks: number) => LogMaskCarry | null;
}

/** What the log work reads of its run: never the whole record (its workflow and contexts are large). */
interface RunFacts {
  readonly run_id: string;
  readonly trust: "trusted" | "untrusted";
}

function closed(log: LogRow | undefined, now: number): boolean {
  if (!log) return false;
  if (log.state === "complete" || log.finalized === 1) return true;
  return log.state === "incomplete" && log.ended_at !== null && log.ended_at + LOG_LATE_MS <= now;
}

export class RunLogs {
  /** Tasks with a request in progress: another request for one is answered at once. */
  readonly #busy = new Set<number>();
  /** When the oldest unacked row of each task was first seen; lost on a reset, which only restarts that clock. */
  readonly #firstSeen = new Map<number, number>();
  /** Each task's mask matchers, kept between requests while its log is open. */
  readonly #matchers: MaskMatcherCaches;

  constructor(private readonly host: LogsHost) {
    this.#matchers = new MaskMatcherCaches(host.memory, () => host.maskCacheBytes);
  }

  /** The run was erased: no task's masks remain. */
  erased(): void {
    this.#matchers.dropAll();
  }

  /** Gives back the memory the tasks' kept mask matchers hold, for work that needs the room. */
  dropMaskCaches(): void {
    this.#matchers.dropAll();
  }

  /** The estimates of the kept mask matchers, in bytes (for tests). */
  maskCacheBytes(): number {
    return this.#matchers.bytes();
  }

  /** The rows of task `task` stored contiguously from position 0. */
  ackOf(task: number): number {
    return (
      this.host.engine.rows<{ ack_index: number }>(
        "SELECT ack_index FROM ci_logs WHERE task = ?",
        task,
      )[0]?.ack_index ?? 0
    );
  }

  /** Whether a whole final request committed with no omitted row. */
  complete(task: number): boolean {
    return (
      this.host.engine.rows<{ state: string }>("SELECT state FROM ci_logs WHERE task = ?", task)[0]
        ?.state === "complete"
    );
  }

  /**
   * Task `task`'s instance completed at `endedAt`: a log not complete by then
   * ends incomplete, and takes rows for `LOG_LATE_MS` more (a whole final
   * request in that time still completes it); then its masks are deleted.
   * The first end counts. Call in the completion's transaction.
   */
  taskEnded(task: number, endedAt: number): void {
    const { engine } = this.host;
    engine.exec(
      `INSERT INTO ci_logs (task, state, ended_at, updated_at) VALUES (?, 'incomplete', ?, ?)
       ON CONFLICT (task) DO UPDATE SET
         state = CASE WHEN state = 'streaming' THEN 'incomplete' ELSE state END,
         ended_at = COALESCE(ended_at, excluded.ended_at),
         updated_at = excluded.updated_at`,
      task,
      endedAt,
      this.host.now(),
    );
    this.#closeLater(task);
  }

  /**
   * Registers job token `value` to be masked in every row of task `task`,
   * unless the task has it already. Every token minted for a task is kept
   * (masks only ever append, so a stored carry's position never moves), at
   * most `MAX_JOB_TOKEN_MASKS` of them, room the caps on `::add-mask::`
   * values keep free. A finalized log takes no more rows, so it gets none.
   * `full` when the task has its last token already, `key_unavailable`
   * when there is no CI master key to seal it with, and `masks_unreadable`
   * when there is one but the task's stored tokens do not open: either way
   * that token must not be handed out.
   */
  async addMask(task: number, value: string): Promise<AddMaskAnswer> {
    const { host } = this;
    const taken = () => host.erased() || this.#log(task)?.finalized === 1;
    let sealed: SealedMaskRow | undefined;
    let runId: string | undefined;
    for (let attempt = 1; ; attempt++) {
      if (taken()) return "added";
      runId ??= this.#runFacts().run_id;
      const tokens = this.#maskRows(task, "job_token");
      const keys = await ciSecretKeys(host.env);
      const values = await this.#open(keys, runId, task, tokens);
      if (!values) return keys.current ? "masks_unreadable" : "key_unavailable";
      if (values.includes(value)) return "added";
      if (tokens.length >= MAX_JOB_TOKEN_MASKS) return "full";
      sealed ??= await this.#seal(keys, runId, task, "job_token", value);
      if (!sealed) return "key_unavailable";
      const row = sealed;
      const hook = host.hooks.beforeMaskCommit;
      if (hook) await hook("job_token");
      const outcome = host.tx((): AddMaskAnswer | "changed" => {
        if (taken()) return "added";
        // Sealed outside: committed only over the tokens it was checked against.
        if (this.#maskCount(task, "job_token") !== tokens.length) return "changed";
        this.#insertMask(task, "job_token", 0, row);
        // A task that ended meanwhile still has its masks deleted.
        this.#closeLater(task);
        return "added";
      });
      if (outcome !== "changed") return outcome;
      if (attempt === MASK_WRITE_ATTEMPTS) throw new Error("the task's job tokens kept changing");
    }
  }

  /**
   * Registers the secrets delivered to task `task` to be masked in every
   * row, in one transaction, within the task's secret budget over every
   * secret it has had (`checkSecretMasks`): a value it has already adds
   * nothing. Over the budget nothing is added and the answer names the
   * offered secrets and their sizes, never their values; without a CI master
   * key nothing is added (`ci_key_unavailable`), nor when the task's secret
   * masks do not open though there is one (`masks_unreadable`). A task of an
   * untrusted run gets none (`untrusted_run`), whatever its log's state: its
   * log requests reserve room for job tokens and `::add-mask::` values only.
   * A finalized log takes no more rows, so it gets none.
   */
  async addSecretMasks(
    task: number,
    offered: readonly SecretMaskOffer[],
  ): Promise<SecretMasksAnswer> {
    const { host } = this;
    const sealed = new Map<string, SealedMaskRow>();
    let run: RunFacts | undefined;
    for (let attempt = 1; ; attempt++) {
      // An erased run may have no record left to read its trust from.
      if (host.erased()) return { ok: true };
      run ??= this.#runFacts();
      if (run.trust !== "trusted") return { ok: false, code: "untrusted_run" };
      if (this.#log(task)?.finalized === 1) return { ok: true };
      const stored = this.#maskRows(task, "secret");
      const keys = await ciSecretKeys(host.env);
      const values = await this.#open(keys, run.run_id, task, stored);
      if (!values)
        return { ok: false, code: keys.current ? "masks_unreadable" : "ci_key_unavailable" };
      const check = checkSecretMasks(values, offered);
      if (!check.ok)
        return {
          ok: false,
          code: "secrets_unmaskable",
          limit: check.limit,
          secrets: check.secrets,
        };
      for (const value of check.added) {
        if (sealed.has(value)) continue;
        const row = await this.#seal(keys, run.run_id, task, "secret", value);
        if (!row) return { ok: false, code: "ci_key_unavailable" };
        sealed.set(value, row);
      }
      const hook = host.hooks.beforeMaskCommit;
      if (hook) await hook("secret");
      const outcome = host.tx((): "added" | "changed" => {
        if (host.erased() || this.#log(task)?.finalized === 1) return "added";
        if (this.#maskCount(task, "secret") !== stored.length) return "changed";
        for (const value of check.added)
          this.#insertMask(task, "secret", 0, sealed.get(value) as SealedMaskRow);
        this.#closeLater(task);
        return "added";
      });
      if (outcome === "added") return { ok: true };
      if (attempt === MASK_WRITE_ATTEMPTS) throw new Error("the task's secret masks kept changing");
    }
  }

  /** The task's mask rows (of `kind` only, when given), in the order they were added. */
  #maskRows(task: number, kind?: MaskKind): MaskRow[] {
    return this.host.engine.rows<MaskRow>(
      `SELECT kind, from_index, mask_id, key_id, value FROM ci_log_masks
       WHERE task = ?1 AND (?2 IS NULL OR kind = ?2) ORDER BY seq`,
      task,
      kind ?? null,
    );
  }

  #maskCount(task: number, kind: MaskKind): number {
    return (
      this.host.engine.rows<{ n: number }>(
        "SELECT COUNT(*) AS n FROM ci_log_masks WHERE task = ? AND kind = ?",
        task,
        kind,
      )[0]?.n ?? 0
    );
  }

  /** Appends a sealed mask row; call in a transaction. */
  #insertMask(task: number, kind: MaskKind, fromIndex: number, row: SealedMaskRow): void {
    this.host.engine.exec(
      `INSERT INTO ci_log_masks (task, seq, kind, from_index, mask_id, cross_len, key_id, value)
       VALUES (?1, COALESCE((SELECT MAX(seq) + 1 FROM ci_log_masks WHERE task = ?1), 0),
         ?2, ?3, ?4, ?5, ?6, ?7)`,
      task,
      kind,
      fromIndex,
      row.maskId,
      row.crossLen,
      row.keyId,
      row.value,
    );
  }

  /** The run's id and trust, read alone; once per operation. */
  #readRun(): RunFacts | undefined {
    return this.host.engine.rows<RunFacts>("SELECT run_id, trust FROM runs WHERE id = 1")[0];
  }

  #runFacts(): RunFacts {
    const run = this.#readRun();
    if (!run) throw new Error("the task's run is gone");
    return run;
  }

  /** `value` sealed for a new row of task `task` of run `runId` under the current master key; undefined without one. */
  async #seal(
    keys: CiKeyring,
    runId: string,
    task: number,
    kind: MaskKind,
    value: string,
  ): Promise<SealedMaskRow | undefined> {
    const maskId = hex(crypto.getRandomValues(new Uint8Array(16)));
    const sealed = await sealMask(keys, maskAdditionalData(runId, task, maskId, kind), value);
    if (!sealed) return undefined;
    return {
      maskId,
      keyId: sealed.masterKeyId,
      value: `${sealed.nonce}.${sealed.ciphertext}`,
      crossLen: maskCrossLength(value),
    };
  }

  /** The rows' values, opened (a row with no key id is plain); undefined when one does not open. */
  async #open(
    keys: CiKeyring | undefined,
    runId: string,
    task: number,
    rows: readonly MaskRow[],
  ): Promise<string[] | undefined> {
    if (rows.every((row) => row.key_id === null)) return rows.map((row) => row.value);
    const ring = keys ?? (await ciSecretKeys(this.host.env));
    const values = await Promise.all(
      rows.map(async (row) => {
        if (row.key_id === null) return row.value;
        const dot = row.value.indexOf(".");
        if (dot === -1) return undefined;
        return openMask(ring, maskAdditionalData(runId, task, row.mask_id, row.kind), {
          masterKeyId: row.key_id,
          nonce: row.value.slice(0, dot),
          ciphertext: row.value.slice(dot + 1),
        });
      }),
    );
    return values.every((value) => value !== undefined) ? values : undefined;
  }

  /**
   * Whether task `task`'s stored job tokens open under the deployment's keys, as `addMask` opens
   * them: true with none sealed, and for a task whose log takes no more masks.
   */
  async jobTokensOpen(task: number): Promise<boolean> {
    if (this.host.erased() || this.#log(task)?.finalized === 1) return true;
    const tokens = this.#maskRows(task, "job_token");
    if (tokens.every((row) => row.key_id === null)) return true;
    return (await this.#open(undefined, this.#runFacts().run_id, task, tokens)) !== undefined;
  }

  /** Whether task `task` holds `MAX_JOB_TOKEN_MASKS` job tokens already. */
  jobTokensFull(task: number): boolean {
    return (
      (this.host.engine.rows<{ n: number }>(
        "SELECT COUNT(*) AS n FROM ci_log_masks WHERE task = ? AND kind = 'job_token'",
        task,
      )[0]?.n ?? 0) >= MAX_JOB_TOKEN_MASKS
    );
  }

  /** Has the close job visit an ended, incomplete log once its late window ends. */
  #closeLater(task: number): void {
    const log = this.#log(task);
    if (log?.state === "incomplete" && log.finalized === 0 && log.ended_at !== null)
      this.host.ensureLogClose(log.ended_at + LOG_LATE_MS);
  }

  /**
   * One pass of the close job: deletes the masks and carries of logs that
   * closed (complete, or incomplete past the late window), a page at a time,
   * then waits for the next window to end while any remains.
   */
  closeSlice(): SliceResult {
    const { host } = this;
    host.viewers.logsExpired();
    return host.tx((): SliceResult => {
      if (host.erased()) return { done: true };
      const now = host.now();
      const due = now - LOG_LATE_MS;
      const tasks = host.engine.rows<{ task: number }>(
        `SELECT task FROM ci_logs
         WHERE (finalized = 1 OR state = 'complete' OR (state = 'incomplete' AND ended_at <= ?))
           AND (gap_remaining > 0 OR mask_carry IS NOT NULL OR EXISTS (SELECT 1 FROM ci_log_masks m WHERE m.task = ci_logs.task))
         LIMIT ?`,
        due,
        CLOSE_PAGE,
      );
      // Kept matchers go once their log closes, whether or not it has masks left to delete.
      for (const task of this.#matchers.tasks())
        if (closed(this.#log(task), now)) this.#matchers.drop(task);
      for (const { task } of tasks) {
        this.#matchers.drop(task);
        host.engine.exec("DELETE FROM ci_log_masks WHERE task = ?", task);
        host.engine.exec(
          "UPDATE ci_logs SET mask_carry = NULL, gap_remaining = 0 WHERE task = ?",
          task,
        );
      }
      if (tasks.length === CLOSE_PAGE) return { done: false, cursor: null, runAfterMs: 0 };
      const next = host.engine.rows<{ ended_at: number | null }>(
        `SELECT MIN(ended_at) AS ended_at FROM ci_logs
         WHERE state = 'incomplete' AND finalized = 0 AND ended_at > ?`,
        due,
      )[0]?.ended_at;
      return next === null || next === undefined
        ? { done: true }
        : { done: false, cursor: null, runAfterMs: Math.max(0, next + LOG_LATE_MS - now) };
    });
  }

  #log(task: number): LogRow | undefined {
    return this.host.engine.rows<LogRow>(
      "SELECT ack_index, state, mask_carry, ended_at, omitted_rows, gap_remaining, finalized FROM ci_logs WHERE task = ?",
      task,
    )[0];
  }

  /**
   * The task's masks, opened, in the order they were added; its job tokens
   * count inside `TOKEN_RESERVE`, its secrets in their own budget. Undefined
   * when one does not open (its master key is gone): nothing can be masked.
   */
  async #masks(runId: string, task: number): Promise<LogMask[] | undefined> {
    const rows = this.#maskRows(task);
    await this.host.hooks.beforeLogMasksOpen?.();
    const values = await this.#open(undefined, runId, task, rows);
    if (!values) {
      this.host.log.error("log masks do not open: the task's rows are not stored", { task });
      return undefined;
    }
    return rows.map((m, k) => ({
      value: values[k] as string,
      fromIndex: m.from_index,
      reserved: m.kind === "job_token",
      secret: m.kind === "secret",
    }));
  }

  /**
   * An UpdateLog for wire task `wireId` (`truncated`: `body` is a prefix of
   * a longer one). A request for a task that already has one in progress,
   * or that the memory pool cannot take now, is answered with the stored ack
   * before it is decoded: the runner keeps the rows and sends them again.
   * A request reserves its body's work and `MASK_HEADROOM_BYTES` for the
   * task's masks.
   */
  async append(
    wireId: number,
    body: Uint8Array,
    truncated: boolean,
    runnerId: number,
  ): Promise<AppendLogAnswer> {
    const { host } = this;
    if (host.erased()) return notFound();
    const map = host.engine.rows<MapRow>(
      "SELECT job_id, task, confirmed_at FROM ci_tasks WHERE wire_id = ?",
      wireId,
    )[0];
    if (!map) return notFound();
    const run = this.#readRun();
    if (!run) return notFound();
    const ref: TaskRef = { jobId: map.job_id, task: map.task };
    if (this.#busy.has(ref.task)) {
      host.log.debug("log request answered while another is in progress", {
        taskId: wireId,
        task: ref.task,
      });
      return acked(this.ackOf(ref.task));
    }
    this.#busy.add(ref.task);
    const priority = host.viewers.beginUpload();
    let reservation: ReturnType<DoMemoryBudget["tryReserve"]>;
    try {
      // One reservation for the body's work and its task's masks, before anything is decoded or
      // opened: no request holds part of one while waiting for the rest.
      const headroom =
        run.trust === "trusted" ? MASK_HEADROOM_BYTES.trusted : MASK_HEADROOM_BYTES.untrusted;
      const bytes = MEMORY_PER_BODY_BYTE * body.byteLength + headroom;
      const fits = bytes <= host.memory.stats().totalBytes;
      reservation = fits ? host.memory.tryReserve(bytes) : undefined;
      if (!reservation && fits) {
        host.viewers.dropCaches();
        this.#matchers.dropAll();
        reservation = host.memory.tryReserve(bytes);
      }
      if (!reservation && fits) {
        await priority.yieldMemory();
        if (host.erased()) return notFound();
        // Another task's request may have kept its matchers during the wait.
        this.#matchers.dropAll();
        reservation = host.memory.tryReserve(bytes);
      }
      if (!reservation) {
        host.log.warn("log request not admitted: the memory pool is taken", {
          taskId: wireId,
          task: ref.task,
          bytes,
        });
        return acked(this.ackOf(ref.task));
      }
      return await this.#append(
        wireId,
        { ...ref, runId: run.run_id },
        map.confirmed_at === null,
        body,
        truncated,
        runnerId,
      );
    } finally {
      this.#busy.delete(ref.task);
      reservation?.release();
      priority.release();
    }
  }

  async #append(
    wireId: number,
    ref: LogRef,
    unconfirmed: boolean,
    body: Uint8Array,
    truncated: boolean,
    runnerId: number,
  ): Promise<AppendLogAnswer> {
    const { host } = this;
    let request: DecodedUpdateLog;
    try {
      request = decodeUpdateLogRequest(body, {
        truncated,
        maxRows: UPDATE_LOG_MAX_ROWS,
        maxContentBytes: UPDATE_LOG_MAX_CONTENT_BYTES,
      });
    } catch (error) {
      if (error instanceof ProtoError) return invalid(INVALID_MESSAGE);
      throw error;
    }
    if (request.taskId !== wireId) return invalid(TASK_ID_MISMATCH);
    if (request.oversizedFirstRow && !(truncated && body.byteLength >= UPDATE_LOG_PREFIX_BYTES))
      delete request.oversizedFirstRow;
    if (unconfirmed) {
      await host.confirm(wireId, runnerId);
      const hook = host.hooks.afterLogConfirm;
      if (hook) await hook();
    }
    // A heartbeat too. Rows for a finished task are still taken: a cancelled job's last rows,
    // or a final call that lands after the runner reported its result.
    const beat = host.updateTask(ref);
    if (!beat.ok && beat.code !== "task_finished") return notFound();

    const now = host.now();
    const log = this.#log(ref.task);
    const ackIndex = log?.ack_index ?? 0;
    // A complete log answers its final ack and stores nothing more; an incomplete one past its
    // late window has no masks left, so nothing can be stored safely: the runner gives up.
    if (log?.state === "complete" || log?.finalized === 1) return acked(ackIndex);
    if (closed(log, now)) return notFound();
    const state = { ackIndex, firstUnackedSeenAt: this.#firstSeen.get(ref.task) };
    const decision = decideLogFlush(state, request, now);
    if (decision.kind === "ahead") {
      // The ack is durable before it is sent, so only lost state lets a runner start past it.
      host.log.error("log index ahead of stored rows: an invariant is broken", {
        taskId: wireId,
        task: ref.task,
        index: request.index,
        ackIndex,
      });
      return invalid(LOG_INDEX_AHEAD);
    }
    const timeOf = (index: number) => unixMs(request.rows[index - request.index]?.time);
    const lineAt = (start: number) => (content: string, k: number) =>
      logLine(start + k, timeOf(start + k), content);
    if (decision.kind === "hold") {
      if (decision.firstUnackedSeenAt === undefined) this.#firstSeen.delete(ref.task);
      else this.#firstSeen.set(ref.task, decision.firstUnackedSeenAt);
      // Watched: its settled rows go live, masked as they will be stored; nothing is kept.
      const fresh = request.rows.slice(ackIndex - request.index).map((row) => row.content);
      if (fresh.length > 0 && host.viewers.watched(ref.jobId)) {
        const settled = await this.#settled(ref, log, ackIndex, fresh);
        // Masks that do not open publish nothing: an empty batch would drop the job's cache.
        if (settled) await this.#publish(ref, ackIndex, settled.map(lineAt(ackIndex)));
      }
      return acked(decision.ackIndex);
    }
    const fetched = await host.masks.masksFor(ref);
    const fetchedMasks = fetched.map((value) => ({ value, fromIndex: 0 }));
    if (decision.kind === "omit") {
      host.log.warn("log row omitted: too large for any request", {
        taskId: wireId,
        task: ref.task,
        index: decision.index,
        bytes: decision.bytes,
      });
      if (!this.#firstSeen.has(ref.task)) this.#firstSeen.set(ref.task, now);
      await host.hooks.beforeLogStore?.();
      const ack = await this.#store(wireId, ref, {
        start: decision.index,
        end: decision.index + 1,
        lines: [{ i: decision.index, omitted: LOG_ROW_TOO_LARGE, bytes: decision.bytes }],
        rows: 0,
        omitted: 1,
        final: false,
        added: [],
        carry: () => null,
        // From the masks present at the commit, by their stored crossing lengths: no value is
        // opened, and one added while the chunk was written counts too.
        gapRemaining: (current) => maskGapLength([...current, ...fetchedMasks], decision.index),
      });
      if (ack === "erased" || ack === "closed") return notFound();
      if (ack === "unsealed") return acked(this.ackOf(ref.task));
      this.#firstSeen.delete(ref.task);
      await host.hooks.afterLogCommit?.();
      return acked(ack);
    }
    const stored = await this.#masks(ref.runId, ref.task);
    // Rows that cannot be masked are not stored: the runner sends them again.
    if (!stored) return acked(ackIndex);
    const masks = [...stored, ...fetchedMasks];
    const carry = parseCarry(log?.mask_carry ?? null);
    const cache = this.#matchers.take(ref.task);
    const mask = (force: boolean): MaskRowsResult =>
      maskRows(masks, carry, decision.lines, {
        start: decision.start,
        final: decision.final,
        force,
        reserve: TOKEN_RESERVE,
        gapRemaining: log?.gap_remaining ?? 0,
        cache,
      });
    const first = mask(false);
    // The first pass's: a forced second pass over the same matchers is always a hit.
    const outcome = cache.outcome;
    const settle = settleFlush(decision, first.settled, state, now);
    const masked = settle.kind === "store" && settle.force ? mask(true) : first;
    this.#keepMatchers(ref.task, cache, outcome);
    if (settle.kind === "hold") {
      this.#firstSeen.set(ref.task, settle.firstUnackedSeenAt);
      if (host.viewers.watched(ref.jobId))
        await this.#publish(
          ref,
          decision.start,
          first.lines.slice(0, first.settled).map(lineAt(decision.start)),
        );
      return acked(settle.ackIndex);
    }
    const count = Math.min(settle.end - settle.start, decision.lines.length);
    const boundary = settle.final ? null : masked.carryAt(count);
    if (!this.#firstSeen.has(ref.task)) this.#firstSeen.set(ref.task, now);
    await host.hooks.beforeLogStore?.();
    const from = settle.start - request.index;
    const ack = await this.#store(wireId, ref, {
      start: settle.start,
      end: settle.end,
      lines: masked.lines.slice(0, count).map((content, k) => ({
        i: settle.start + k,
        t: unixMs(request.rows[from + k]?.time),
        c: content,
      })),
      rows: count,
      omitted: 0,
      gapRemaining: masked.gapRemainingAt(count),
      final: settle.final,
      added: masked.added.filter((a) => a.index < settle.end),
      carry: (storedMasks) => storedCarry(boundary, stored.length, fetched.length, storedMasks),
    });
    if (ack === "erased" || ack === "closed") return notFound();
    if (ack === "unsealed") return acked(this.ackOf(ref.task));
    if (ack === settle.end) {
      if (settle.firstUnackedSeenAt === undefined) this.#firstSeen.delete(ref.task);
      else this.#firstSeen.set(ref.task, settle.firstUnackedSeenAt);
      this.#dropped(wireId, ref, masked, settle.end);
    }
    await host.hooks.afterLogCommit?.();
    return acked(ack);
  }

  /**
   * The masked text of the leading rows of `fresh` (from `start`, the ack)
   * that no later row can change, exactly as a store would mask them: the
   * stored masks and those fetched, the carry stored with the ack, unforced.
   * Nothing is committed: values the rows register count within these rows
   * only, and none is reported dropped (their store reports them). Undefined
   * when the task's masks do not open: nothing can be published.
   */
  async #settled(
    ref: LogRef,
    log: LogRow | undefined,
    start: number,
    fresh: readonly string[],
  ): Promise<readonly string[] | undefined> {
    const stored = await this.#masks(ref.runId, ref.task);
    if (!stored) return undefined;
    const fetched = await this.host.masks.masksFor(ref);
    const cache = this.#matchers.take(ref.task);
    const masked = maskRows(
      [...stored, ...fetched.map((value) => ({ value, fromIndex: 0 }))],
      parseCarry(log?.mask_carry ?? null),
      fresh,
      {
        start,
        final: false,
        force: false,
        reserve: TOKEN_RESERVE,
        gapRemaining: log?.gap_remaining ?? 0,
        cache,
      },
    );
    this.#keepMatchers(ref.task, cache, cache.outcome);
    return masked.lines.slice(0, masked.settled);
  }

  /**
   * Keeps the task's matchers after its masking calls, with no await since
   * its masks were read: only while the run stands and the log still takes
   * rows, so matchers holding mask values never outlive the masks (an
   * erasure or a close may have run while the masks were opened).
   */
  #keepMatchers(
    task: number,
    cache: MaskMatcherCache,
    outcome: MaskMatcherOutcome | undefined,
  ): void {
    const open = !this.host.erased() && !closed(this.#log(task), this.host.now());
    const kept = open && this.#matchers.keep(task, cache);
    this.host.hooks.maskMatcher?.(task, kept ? (outcome ?? "uncached") : "uncached");
  }

  async #publish(ref: LogRef, base: number, rows: readonly LogLine[]): Promise<void> {
    const hook = viewerHooks.beforePublish;
    if (hook) await hook(ref.runId);
    if (this.host.erased()) return;
    this.host.viewers.publish(ref.jobId, ref.task, base, rows);
  }

  #dropped(wireId: number, ref: LogRef, masked: MaskRowsResult, end: number): void {
    const { runId } = ref;
    for (const { index, reason } of masked.dropped) {
      if (index >= end) continue;
      this.host.log.warn("mask value not registered", {
        runId,
        taskId: wireId,
        task: ref.task,
        index,
        reason,
      });
      this.host.metrics.count("ci.mask_dropped", { run: runId, task: String(ref.task), reason });
    }
  }

  /**
   * Writes the masked lines as a new object, then records it in the
   * manifest, advances the ack from `start` to `end`, registers the values
   * the stored rows added and stores the carry at `end` in one transaction,
   * only if the ack is still `start`, the log still takes rows and the run
   * was not erased meanwhile. A final store seals ingestion and deletes its
   * masks and carry; omissions keep the sealed log incomplete. A store that loses, or whose run or log closed, deletes
   * its own object (its key is its alone). The added values are sealed
   * first, outside the transaction (their `seq` is still assigned in it);
   * with no master key to seal them nothing is written (`unsealed`). The
   * stored ack, `erased`, `closed` or `unsealed`.
   */
  async #store(
    wireId: number,
    ref: LogRef,
    flush: Store,
  ): Promise<number | "erased" | "closed" | "unsealed"> {
    const { host } = this;
    const { start, end, lines, final } = flush;
    // A final store deletes the task's masks: what its rows added is never written.
    const added: { readonly index: number; readonly row: SealedMaskRow }[] = [];
    if (!final && flush.added.length > 0) {
      const keys = await ciSecretKeys(host.env);
      for (const { value, index } of flush.added) {
        const row = await this.#seal(keys, ref.runId, ref.task, "add_mask", value);
        if (!row) {
          host.log.warn("log rows not stored: no CI master key seals their masks", {
            taskId: wireId,
            task: ref.task,
            start,
            end,
          });
          return "unsealed";
        }
        added.push({ index, row });
      }
    }
    // Erased while the request waited or sealed: its instance is gone, so there is no key to write.
    if (host.erased()) return "erased";
    let chunk: { key: string; bytes: number } | undefined;
    if (lines.length > 0) {
      const text = lines.map((line) => JSON.stringify(line)).join("\n");
      const encoded = new TextEncoder().encode(`${text}\n`);
      const key = this.#key(ref, start, end);
      host.metrics.count("r2.class_a", { bucket: BUCKET, op: "put_log_chunk" });
      await host.env.CI.put(key, encoded, {
        httpMetadata: { contentType: "application/x-ndjson" },
      });
      chunk = { key, bytes: encoded.byteLength };
      await host.hooks.afterLogPut?.(key);
    }
    const outcome = host.tx((): "complete" | "won" | "lost" | "erased" | "closed" => {
      // Erasure removes every log row: nothing may be written after it.
      if (host.erased()) return "erased";
      const now = host.now();
      host.engine.exec(
        "INSERT INTO ci_logs (task, updated_at) VALUES (?, ?) ON CONFLICT (task) DO NOTHING",
        ref.task,
        now,
      );
      const log = this.#log(ref.task) as LogRow;
      if (log.finalized === 1 || log.state === "complete" || log.ack_index !== start) return "lost";
      // Its masks may be gone already: nothing is stored without them.
      if (closed(log, now)) return "closed";
      if (chunk)
        host.engine.exec(
          `INSERT INTO ci_log_chunks (task, start_index, end_index, bytes, r2_key, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          ref.task,
          start,
          end,
          chunk.bytes,
          chunk.key,
          now,
        );
      let carry: LogMaskCarry | null = null;
      if (final) host.engine.exec("DELETE FROM ci_log_masks WHERE task = ?", ref.task);
      else {
        const count =
          host.engine.rows<{ n: number }>(
            "SELECT COUNT(*) AS n FROM ci_log_masks WHERE task = ?",
            ref.task,
          )[0]?.n ?? 0;
        // Added values take the positions after the masks stored now, in order.
        carry = flush.carry(count);
        for (const { index, row } of added) this.#insertMask(ref.task, "add_mask", index, row);
      }
      const gapRemaining = final
        ? 0
        : typeof flush.gapRemaining === "number"
          ? flush.gapRemaining
          : flush.gapRemaining(
              host.engine
                .rows<{ from_index: number; cross_len: number }>(
                  "SELECT from_index, cross_len FROM ci_log_masks WHERE task = ?",
                  ref.task,
                )
                .map((m) => ({ fromIndex: m.from_index, crossLen: m.cross_len })),
            );
      host.engine.exec(
        `UPDATE ci_logs SET ack_index = ?1, rows = rows + ?2, bytes = bytes + ?3,
           omitted_rows = omitted_rows + ?4,
           state = CASE WHEN NOT ?5 THEN state
             WHEN omitted_rows + ?4 = 0 THEN 'complete' ELSE 'incomplete' END,
           finalized = CASE WHEN ?5 THEN 1 ELSE finalized END,
           mask_carry = ?6, gap_remaining = ?7, updated_at = ?8
         WHERE task = ?9 AND ack_index = ?10`,
        end,
        flush.rows,
        chunk?.bytes ?? 0,
        flush.omitted,
        final ? 1 : 0,
        carry === null ? null : JSON.stringify(carry),
        gapRemaining,
        now,
        ref.task,
        start,
      );
      return final && this.complete(ref.task) ? "complete" : "won";
    });
    // A committed final store deleted the task's masks, complete or only finalized.
    if (final && (outcome === "won" || outcome === "complete")) this.#matchers.drop(ref.task);
    if (outcome !== "won" && outcome !== "complete") {
      host.log.info(
        outcome === "erased"
          ? "log chunk not recorded: the run was erased"
          : outcome === "closed"
            ? "log chunk not recorded: the log closed"
            : "log chunk lost to another flush of its rows",
        { taskId: wireId, task: ref.task, start, end },
      );
      if (chunk) await this.#deleteOwn(wireId, ref, chunk.key);
      if (outcome === "lost") {
        const ack = this.ackOf(ref.task);
        await this.#publish(ref, ack, []);
        return ack;
      }
      return outcome;
    }
    // The run may have completed the task first, with its log incomplete: now it is complete.
    if (outcome === "complete" && host.engine.instance(ref.jobId)?.status === "completed")
      host.markLogComplete(ref);
    await this.#publish(ref, start, lines);
    return end;
  }

  /** Deletes an object this request wrote and nothing names; best effort. */
  async #deleteOwn(wireId: number, ref: TaskRef, key: string): Promise<void> {
    // R2 deletes are free (not Class A: https://developers.cloudflare.com/r2/pricing/#free-operations),
    // but each is still a call against the invocation's internal budget.
    countSubrequests("internal");
    try {
      await this.host.env.CI.delete(key);
    } catch (error) {
      this.host.log.warn("log chunk not deleted", {
        taskId: wireId,
        task: ref.task,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** `runs/<run>/<attempt>/<job>/<task>/<start>-<end>-<write id>.ndjson`: a key no other flush uses. */
  #key(ref: LogRef, start: number, end: number): string {
    const instance = this.host.engine.instance(ref.jobId);
    if (!instance) throw new Error("the task's instance is gone");
    const writeId = [...crypto.getRandomValues(new Uint8Array(16))]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const range = `${pad(start)}-${pad(end)}`;
    return `runs/${ref.runId}/${instance.attempt}/${ref.jobId}/${ref.task}/${range}-${writeId}.ndjson`;
  }
}

const pad = (n: number) => String(n).padStart(10, "0");

/** A task a log request is for, with its run's id, read once at the request's admission. */
type LogRef = TaskRef & { readonly runId: string };

/** A stored carry, or null when it is missing or not one (a partial match is then only lost). */
function parseCarry(text: string | null): LogMaskCarry | null {
  if (text === null) return null;
  try {
    const value = JSON.parse(text) as Partial<LogMaskCarry> | null;
    const { mask, variant, length, starts } = value ?? {};
    if (typeof mask !== "number" || typeof variant !== "number" || typeof length !== "number")
      return null;
    if (starts === undefined) return { mask, variant, length };
    if (
      !Array.isArray(starts) ||
      !starts.every(
        (start: unknown) =>
          start !== null &&
          typeof start === "object" &&
          "index" in start &&
          typeof start.index === "number" &&
          Number.isSafeInteger(start.index) &&
          start.index >= 0 &&
          "offset" in start &&
          typeof start.offset === "number" &&
          Number.isSafeInteger(start.offset) &&
          start.offset > -length &&
          start.offset <= 0,
      )
    )
      return null;
    return { mask, variant, length, starts };
  } catch {
    return null;
  }
}

/**
 * The carry as stored, by mask positions among the stored masks. The masker
 * numbered masks as given: `loaded` stored ones, then `fetched` from the
 * mask source, then the values the rows added. Added values are stored after
 * the `storedMasks` there are when the store commits (a job token re-minted
 * meanwhile included), so they move along; a fetched mask's partial match is
 * not carried, as its position is not stable.
 */
function storedCarry(
  carry: LogMaskCarry | null,
  loaded: number,
  fetched: number,
  storedMasks: number,
): LogMaskCarry | null {
  if (carry === null || carry.mask < loaded) return carry;
  if (carry.mask < loaded + fetched) return null;
  return { ...carry, mask: storedMasks + (carry.mask - loaded - fetched) };
}

function unixMs(time: Timestamp | undefined): number | null {
  return time ? time.seconds * 1000 + Math.floor(time.nanos / 1_000_000) : null;
}

const acked = (ackIndex: number): AppendLogAnswer => ({
  ok: true,
  response: encodeUpdateLogResponse({ ackIndex }),
});
const notFound = (): AppendLogAnswer => ({
  ok: false,
  code: "not_found",
  message: TASK_NOT_FOUND,
});
const invalid = (message: string): AppendLogAnswer => ({
  ok: false,
  code: "invalid_argument",
  message,
});
