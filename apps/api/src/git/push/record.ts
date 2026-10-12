import type { RepoGitStorage } from "@fyrden/adapters-cloudflare/git";
import type { Metrics } from "@fyrden/adapters-cloudflare/obs";
import { oidToHex, type PushPlan } from "@fyrden/git-core";
import { BUCKET_NAME, cursorKey } from "./scratch.js";

/*
 * What the push keeps between its requests, in the upload's row:
 *
 * - `commands` (JSON): the push record below, written once the command
 *   section has been read. The ref updates are listed for audit and the
 *   reaper; the early refusals are kept so the commit point applies exactly
 *   the checks indexing was planned for (re-planning against newer refs
 *   could turn on a command whose new tip was never checked).
 * - `cursor` (bytes): a tag byte, then the indexing cursor inline, the
 *   version of the R2 scratch object that holds it (too large for its row),
 *   or, once the push has committed, the response sent to the client.
 *
 * Indexing publishes a cursor only under a fence (the runner still holds
 * the upload's index lock), checked in the same transaction as the row
 * write; a cursor in R2 is written to a new object first, so a runner that
 * lost the lock while its write was under way leaves the published cursor
 * as it was.
 */

/**
 * Where a push body is stored when it is not one request body: a chunked
 * upload or an import, whose command section (`head`, `headBytes` long)
 * and pack (`packBytes`) are separate scratch objects.
 */
export interface SplitBody {
  readonly kind: "parts";
  readonly headBytes: number;
  readonly packBytes: number;
  /** A chunked upload's part length (every part but the last), for its status. */
  readonly partBytes?: number;
}

export interface PushRecord {
  readonly v: 1;
  readonly bodyBytes: number;
  /** Absent for a receive-pack request body (one object). */
  readonly body?: SplitBody;
  /** Set once the command section has been read. */
  readonly planned?: {
    readonly packOffset: number;
    readonly sideband: boolean;
    readonly atomic: boolean;
    /** Whether an indexing job runs (a pack follows and a command is still live). */
    readonly indexing: boolean;
    /** Early refusals by command position (null: none). */
    readonly errors: readonly (string | null)[];
    readonly messages: readonly string[];
    /** The ref updates, for audit: a name that is not UTF-8 is null; ids are hex, null for none. */
    readonly commands: readonly {
      readonly ref: string | null;
      readonly old: string | null;
      readonly new: string | null;
    }[];
  };
}

export function planRecord(
  bodyBytes: number,
  packOffset: number,
  plan: PushPlan,
  body?: SplitBody,
): PushRecord {
  return {
    v: 1,
    bodyBytes,
    ...(body ? { body } : {}),
    planned: {
      packOffset,
      sideband: plan.capabilities.sideband,
      atomic: plan.capabilities.atomic,
      indexing: plan.expectsPack && plan.commands.some((c) => c.error === undefined),
      errors: plan.commands.map((c) => c.error ?? null),
      messages: [...plan.messages],
      commands: plan.commands.map((c) => ({
        ref: c.name ?? null,
        old: c.oldOid && oidToHex(c.oldOid),
        new: c.newOid && oidToHex(c.newOid),
      })),
    },
  };
}

/** The record of a push, or undefined before the body is stored (or for an unknown upload). */
export function readRecord(git: RepoGitStorage, uploadId: string): PushRecord | undefined {
  const value = git.uploads.commandsOf(uploadId) as Partial<PushRecord> | undefined;
  return value && value.v === 1 && typeof value.bodyBytes === "number"
    ? (value as PushRecord)
    : undefined;
}

/**
 * Puts back the early refusals recorded when the push was planned. The
 * plan was made again from the same body, so the commands are the same.
 */
export function restorePlan(plan: PushPlan, planned: NonNullable<PushRecord["planned"]>): void {
  if (plan.commands.length !== planned.errors.length) {
    throw new Error("the stored push body no longer matches its record");
  }
  for (const [i, cmd] of plan.commands.entries()) cmd.error = planned.errors[i] ?? undefined;
  plan.messages.splice(0, plan.messages.length, ...planned.messages);
}

/**
 * Largest cursor kept in its row; a larger one goes to R2 scratch.
 * Proposed 512 KiB, under the 2 MB row limit (verified 2026-10-11:
 * https://developers.cloudflare.com/durable-objects/platform/limits/#sql-storage-limits).
 */
export const INLINE_CURSOR_BYTES = 512 * 1024;

const TAG_INLINE = 0;
const TAG_IN_R2 = 1;
const TAG_RESPONSE = 2;

export class PushCursorStore {
  constructor(
    private readonly git: RepoGitStorage,
    private readonly metrics: Metrics,
    /** Largest cursor kept in its row (tests lower it). */
    private readonly inlineBytes = INLINE_CURSOR_BYTES,
  ) {}

  /**
   * Saves the indexing cursor, publishing it only if `fence` still holds
   * when the row is written (checked in that write's transaction). False
   * when the fence refused it; nothing it wrote is left published then.
   */
  async save(
    uploadId: string,
    cursor: Uint8Array,
    fence: () => boolean = () => true,
  ): Promise<boolean> {
    let stored: Uint8Array;
    let written: string | undefined;
    if (cursor.length <= this.inlineBytes) {
      stored = tagged(TAG_INLINE, cursor);
    } else {
      const version = crypto.randomUUID();
      written = cursorKey(this.git.networkId(), uploadId, version);
      this.metrics.count("r2.class_a", { bucket: BUCKET_NAME, op: "put_cursor" });
      await this.git.bucket.put(written, cursor);
      stored = tagged(TAG_IN_R2, ENCODER.encode(version));
    }
    let replaced: string | undefined;
    const published = this.git.context.storage.transactionSync(() => {
      if (!fence()) return false;
      replaced = this.objectKey(uploadId);
      this.git.uploads.saveCursor(uploadId, stored);
      return true;
    });
    // The object no longer published, or never published, goes; the reaper takes what fails.
    const stale = published ? replaced : written;
    if (stale !== undefined) await this.#delete(stale);
    return published;
  }

  /** The indexing cursor; throws when there is none. */
  async load(uploadId: string): Promise<Uint8Array> {
    const stored = this.git.uploads.cursorOf(uploadId);
    if (stored?.[0] === TAG_INLINE) return stored.subarray(1);
    const key = this.objectKey(uploadId);
    if (key !== undefined) {
      this.metrics.count("r2.class_b", { bucket: BUCKET_NAME, op: "get_cursor" });
      const object = await this.git.bucket.get(key);
      if (object) return new Uint8Array(await object.arrayBuffer());
    }
    throw new Error(`push ${uploadId} has no indexing cursor`);
  }

  /** The R2 key of the published cursor, when it is in R2. */
  objectKey(uploadId: string): string | undefined {
    const stored = this.git.uploads.cursorOf(uploadId);
    if (stored?.[0] !== TAG_IN_R2) return undefined;
    const version = stored.length > 1 ? DECODER.decode(stored.subarray(1)) : undefined;
    return cursorKey(this.git.networkId(), uploadId, version);
  }

  async #delete(key: string): Promise<void> {
    await this.git.bucket.delete(key).catch(() => {});
  }

  /** Keeps the response of a committed push, for a Worker that lost the commit call's answer. */
  saveResponse(uploadId: string, response: Uint8Array): void {
    this.git.uploads.saveCursor(uploadId, tagged(TAG_RESPONSE, response));
  }

  response(uploadId: string): Uint8Array | undefined {
    const stored = this.git.uploads.cursorOf(uploadId);
    return stored?.[0] === TAG_RESPONSE ? stored.subarray(1) : undefined;
  }
}

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

function tagged(tag: number, bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length + 1);
  out[0] = tag;
  out.set(bytes, 1);
  return out;
}
