import type { RepoGitStorage, UploadRecord } from "@fyrden/adapters-cloudflare/git";
import type { Logger, Metrics } from "@fyrden/adapters-cloudflare/obs";
import { readRecord, type SplitBody } from "../push/record.js";
import type { PushProgress, RepoPush } from "../push/repo-push.js";
import { BUCKET_NAME, headKey, packKey } from "../push/scratch.js";
import { buildCommandHead, type RefOutcome, type RefUpdateSpec, readPushReport } from "./head.js";
import { MAX_PARTS } from "./tuning.js";

/*
 * The Durable Object side of a chunked upload (the Worker side is
 * ./operations.ts and ./parts-route.ts):
 *
 *   begin      the upload, its command section in scratch (`head`), and
 *              an R2 multipart upload for the pack at scratch `pack`, its
 *              id recorded before any part is stored
 *   part       checks a part and reserves it before the Worker streams it
 *              into R2 (one request body is one multipart part), then
 *              records its etag under that reservation; each reservation
 *              writes its own R2 part number (see `PartReservation`)
 *   complete   assembles the parts and hands the upload to the push path,
 *              which indexes, checks and commits it as a push
 *   abort      aborts the multipart upload and discards the upload
 *
 * Expired sessions are the orphan reaper's: it aborts the multipart upload
 * by the recorded id and key and deletes the scratch objects.
 */

export type ChunkedFailure = {
  readonly ok: false;
  readonly status: 404 | 409 | 422;
  readonly code: string;
  readonly error: string;
};

export type ChunkedState = "receiving" | "indexing" | "committed" | "rejected" | "expired";

export interface ChunkedView {
  readonly uploadId: string;
  readonly state: ChunkedState;
  readonly size: number;
  readonly partBytes: number;
  readonly partCount: number;
  readonly partsReceived: number[];
  readonly expiresAt: number;
  readonly refs?: RefOutcome[];
  readonly error?: string;
}

export interface BeginChunked {
  readonly principal: string;
  readonly tokenId: string;
  /** The delegation grant the write is made under (an agent acting for `principal`); null for none. */
  readonly grantId?: string | null;
  readonly size: number;
  readonly partBytes: number;
  readonly updates: readonly RefUpdateSpec[];
}

/**
 * A part being uploaded: one request at a time stores and records a part.
 *
 * Each reservation writes its own R2 part number, one of the part's
 * `stride` numbers (`r2PartNumber`), never one whose etag is recorded or
 * that an earlier request may still be writing. R2 keeps whichever upload
 * of a part number lands last, so a request that outlived its reservation
 * could otherwise overwrite the bytes of the request that took the part
 * over, after that one recorded its etag, and the assembly would fail.
 * Its late bytes now land on a number the assembly does not list.
 */
interface PartReservation {
  /** The fencing token: only its holder records the part's etag. */
  readonly token: string;
  /** After this another request may take the part over. */
  readonly until: number;
  /** Which of the part's R2 part numbers this request writes, from 0. */
  readonly attempt: number;
}

/** The upload's record while its parts arrive (the push record plus the session). */
interface SessionRecord {
  readonly v: 1;
  readonly bodyBytes: number;
  readonly body: SplitBody;
  readonly session: {
    /** Per part: the recorded etag. */
    readonly parts: Record<string, string>;
    /** Per part: the attempt (R2 part number) the recorded etag is for; absent means 0. */
    readonly recorded?: Record<string, number>;
    /** Per part: attempts handed out so far; the next reservation takes the next one. */
    readonly attempts?: Record<string, number>;
    /** R2 part numbers per part (absent: 1, as sessions began before it existed). */
    readonly stride?: number;
    readonly reserved?: Record<string, PartReservation>;
    /** Set once assembly starts: no part is taken from then on. */
    readonly completing?: true;
  };
}

/** How long `complete` holds the assembly lock. Proposed: R2's complete is one call. */
const COMPLETE_LOCK_MS = 60_000;

/**
 * How long a part stays reserved for the request uploading it. Proposed:
 * room for a 16 MiB part at about 250 kbit/s. A request that fails releases
 * its reservation at once; only a request that dies with its Worker holds
 * the part this long.
 */
export const PART_RESERVATION_MS = 10 * 60 * 1000;

const notFound: ChunkedFailure = {
  ok: false,
  status: 404,
  code: "upload_not_found",
  error: "No such upload session.",
};

function fail(status: 404 | 409 | 422, code: string, error: string): ChunkedFailure {
  return { ok: false, status, code, error };
}

/** The part count and the length part `n` must have. */
export function partLayout(size: number, partBytes: number) {
  const partCount = Math.max(1, Math.ceil(size / partBytes));
  return {
    partCount,
    lengthOf: (n: number) => (n < partCount ? partBytes : size - (partCount - 1) * partBytes),
  };
}

/**
 * The R2 part number of attempt `attempt` at part `part`: each part has
 * `stride` consecutive numbers, in the parts' order, so the numbers the
 * assembly lists ascend with the parts (R2 joins parts in number order and
 * takes gaps between numbers: measured on the local runtime; deployed R2
 * unverified).
 */
export function r2PartNumber(part: number, attempt: number, stride: number): number {
  return (part - 1) * stride + 1 + attempt;
}

export class ChunkedUploads {
  constructor(
    private readonly git: RepoGitStorage,
    private readonly push: RepoPush,
    private readonly metrics: Metrics,
    private readonly log: Logger,
  ) {}

  async begin(input: BeginChunked): Promise<{ ok: true; view: ChunkedView } | ChunkedFailure> {
    const { size, partBytes } = input;
    if (
      !Number.isSafeInteger(size) ||
      size < 32 ||
      !Number.isSafeInteger(partBytes) ||
      partBytes < 1
    )
      return fail(422, "invalid_size", "The size must be a whole number of bytes, at least 32.");
    if (partLayout(size, partBytes).partCount > MAX_PARTS)
      return fail(
        422,
        "too_many_parts",
        `A pack of ${size} bytes needs more than ${MAX_PARTS} parts.`,
      );
    let head: Uint8Array;
    try {
      head = buildCommandHead(input.updates);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      return fail(422, "invalid_ref_update", error.message);
    }

    const begun = this.push.begin({
      principal: input.principal,
      tokenId: input.tokenId,
      grantId: input.grantId ?? null,
    });
    if (!begun.ok) return fail(409, "upload_refused", begun.error);
    const { uploadId } = begun;
    const networkId = this.git.networkId();
    try {
      this.#count("put_head");
      await this.git.bucket.put(headKey(networkId, uploadId), head);
      const key = packKey(networkId, uploadId);
      this.#count("create_multipart");
      const multipart = await this.git.bucket.createMultipartUpload(key);
      // Recorded before any part: the binding cannot list incomplete uploads.
      if (!this.git.uploads.recordMultipart(uploadId, multipart.uploadId, key))
        throw new Error("the upload closed while it was being set up");
      const record: SessionRecord = {
        v: 1,
        bodyBytes: head.length + size,
        body: { kind: "parts", headBytes: head.length, packBytes: size, partBytes },
        // R2 takes part numbers up to MAX_PARTS: the rest are spare attempts.
        session: {
          parts: {},
          stride: Math.floor(MAX_PARTS / partLayout(size, partBytes).partCount),
        },
      };
      this.git.uploads.recordCommands(uploadId, record);
    } catch (error) {
      await this.push.abort(uploadId);
      throw error;
    }
    return { ok: true, view: this.#view(this.git.uploads.get(uploadId) as UploadRecord) };
  }

  /**
   * Checks that part `part` of `bytes` bytes may be stored now and returns
   * where: the multipart upload's key and id.
   */
  partTarget(
    uploadId: string,
    principal: string,
    part: number,
    bytes: number,
  ):
    | { ok: true; key: string; multipartId: string; partNumber: number; token: string }
    | ChunkedFailure {
    const open = this.#open(uploadId, principal);
    if (!open.ok) return open;
    const { body, session } = open.record;
    const layout = partLayout(body.packBytes, body.partBytes ?? body.packBytes);
    if (!Number.isSafeInteger(part) || part < 1 || part > layout.partCount)
      return fail(422, "invalid_part", `Parts are numbered 1 to ${layout.partCount}.`);
    const expected = layout.lengthOf(part);
    if (bytes !== expected)
      return fail(
        422,
        "wrong_part_size",
        `Part ${part} must be exactly ${expected} bytes, not ${bytes}.`,
      );
    const multipart = this.git.uploads.multipartOf(uploadId);
    if (!multipart || session.completing)
      return fail(409, "upload_closed", "The upload is no longer receiving parts.");
    const now = this.git.context.now();
    const held = session.reserved?.[String(part)];
    if (held && held.until > now)
      return fail(
        409,
        "part_in_progress",
        `Part ${part} is being uploaded by another request; send it again once that one ends.`,
      );
    // A reservation released after a failed upload hands its attempt back:
    // nothing else writes that number any more.
    const key = String(part);
    const stride = session.stride ?? 1;
    const attempt = session.attempts?.[key] ?? 0;
    if (attempt >= stride)
      return fail(
        409,
        "part_retries_exhausted",
        `Part ${part} was sent too many times; start a new upload.`,
      );
    const token = crypto.randomUUID();
    this.#save(uploadId, open.record, {
      attempts: { ...session.attempts, [key]: attempt + 1 },
      reserved: {
        ...session.reserved,
        [key]: { token, until: now + PART_RESERVATION_MS, attempt },
      },
    });
    return { ok: true, ...multipart, partNumber: r2PartNumber(part, attempt, stride), token };
  }

  /**
   * Records a stored part's etag under the reservation `token` (a part
   * uploaded again replaces the earlier one). A request that lost its
   * reservation (it expired and another request took the part, or the
   * assembly began) is refused; its bytes went to its own R2 part number,
   * which the assembly does not list, so the part recorded stays valid.
   */
  recordPart(
    uploadId: string,
    principal: string,
    part: number,
    etag: string,
    token: string,
  ): { ok: true; view: ChunkedView } | ChunkedFailure {
    const open = this.#open(uploadId, principal);
    if (!open.ok) return open;
    const { session } = open.record;
    if (session.completing)
      return fail(409, "upload_closed", "The upload is no longer receiving parts.");
    const key = String(part);
    const held = session.reserved?.[key];
    if (!held || held.token !== token)
      return fail(
        409,
        "part_superseded",
        `Part ${part} was uploaded again by another request meanwhile; send it again.`,
      );
    const { [key]: _held, ...otherReserved } = session.reserved ?? {};
    this.#save(uploadId, open.record, {
      parts: { ...session.parts, [key]: etag },
      recorded: { ...session.recorded, [key]: held.attempt },
      reserved: otherReserved,
    });
    return { ok: true, view: this.#view(open.upload) };
  }

  /** Ends a reservation whose upload failed (nothing was stored), so the part can be sent again at once. */
  releasePart(uploadId: string, principal: string, part: number, token: string): void {
    const open = this.#open(uploadId, principal);
    if (!open.ok) return;
    const { session } = open.record;
    const key = String(part);
    const held = session.reserved?.[key];
    if (held?.token !== token) return;
    const { [key]: _held, ...rest } = session.reserved ?? {};
    // The failed upload stored nothing that is recorded: its number can be written again.
    const attempts =
      session.attempts?.[key] === held.attempt + 1
        ? { ...session.attempts, [key]: held.attempt }
        : session.attempts;
    this.#save(uploadId, open.record, { reserved: rest, ...(attempts ? { attempts } : {}) });
  }

  #save(uploadId: string, record: SessionRecord, change: Partial<SessionRecord["session"]>): void {
    const next: SessionRecord = { ...record, session: { ...record.session, ...change } };
    this.git.uploads.recordCommands(uploadId, next);
  }

  /**
   * Assembles the parts (once) and continues as a push: indexing runs for
   * up to `budgetMs` here, then in the alarm. Only the token that started
   * the session may complete it, since the commit re-authorizes that token.
   */
  async complete(
    uploadId: string,
    principal: string,
    tokenId: string,
    budgetMs: number,
  ): Promise<{ ok: true; progress: PushProgress } | ChunkedFailure> {
    const upload = this.#chunkedUpload(uploadId, principal);
    if (!upload) return notFound;
    if (upload.tokenId !== tokenId)
      return fail(409, "wrong_token", "Complete the upload with the token that started it.");
    if (upload.state === "open") {
      const lock = this.git.locks.tryAcquire(
        `chunked-complete:${uploadId}`,
        "complete",
        COMPLETE_LOCK_MS,
      );
      if (!lock) return { ok: true, progress: { state: "indexing", sideband: false } };
      try {
        const assembled = await this.#assemble(upload);
        if (!assembled.ok) return assembled;
      } finally {
        this.git.locks.release(lock);
      }
    }
    return { ok: true, progress: await this.push.status(uploadId, budgetMs) };
  }

  async abort(
    uploadId: string,
    principal: string,
  ): Promise<{ ok: true; view: ChunkedView } | ChunkedFailure> {
    const upload = this.#chunkedUpload(uploadId, principal);
    if (!upload) return notFound;
    if (upload.state === "committed")
      return fail(409, "upload_committed", "The upload has already been committed.");
    await this.#abortMultipart(uploadId);
    await this.push.abort(uploadId);
    return { ok: true, view: this.#view(this.git.uploads.get(uploadId) as UploadRecord) };
  }

  async view(
    uploadId: string,
    principal: string,
  ): Promise<{ ok: true; view: ChunkedView } | ChunkedFailure> {
    const upload = this.#chunkedUpload(uploadId, principal);
    if (!upload) return notFound;
    let refs: RefOutcome[] | undefined;
    if (upload.state === "committed") {
      const progress = await this.push.status(uploadId, 0);
      if (progress.state === "done") refs = readPushReport(progress.response).refs;
    }
    return { ok: true, view: this.#view(upload, refs) };
  }

  /** Completes the multipart upload and stores the body; a bad assembly ends the upload. */
  async #assemble(upload: UploadRecord): Promise<{ ok: true } | ChunkedFailure> {
    const { uploadId } = upload;
    const record = sessionRecord(this.git, uploadId);
    const multipart = this.git.uploads.multipartOf(uploadId);
    if (!record || !multipart) return notFound;
    if (upload.expiresAt <= this.git.context.now())
      return fail(409, "upload_expired", "The upload session has expired.");
    const { partCount } = partLayout(
      record.body.packBytes,
      record.body.partBytes ?? record.body.packBytes,
    );
    const parts = [];
    const missing: number[] = [];
    const stride = record.session.stride ?? 1;
    for (let n = 1; n <= partCount; n++) {
      const etag = record.session.parts[String(n)];
      const attempt = record.session.recorded?.[String(n)] ?? 0;
      if (etag === undefined) missing.push(n);
      else parts.push({ partNumber: r2PartNumber(n, attempt, stride), etag });
    }
    const now = this.git.context.now();
    const inFlight = Object.entries(record.session.reserved ?? {})
      .filter(([, held]) => held.until > now)
      .map(([n]) => n);
    if (inFlight.length > 0)
      return fail(
        409,
        "parts_in_progress",
        `Parts ${inFlight.slice(0, 20).join(", ")} are still being uploaded; complete once they are stored.`,
      );
    if (missing.length > 0) {
      const list = missing.slice(0, 20).join(", ") + (missing.length > 20 ? ", ..." : "");
      return fail(409, "parts_missing", `Upload these parts first: ${list}.`);
    }
    // No part is taken or recorded from here on. A request whose reservation
    // expired may still be writing, but to a number not listed here.
    this.#save(uploadId, record, { completing: true, reserved: {} });
    let size: number;
    try {
      this.#count("complete_multipart");
      const object = await this.git.bucket
        .resumeMultipartUpload(multipart.key, multipart.multipartId)
        .complete(parts);
      size = object.size;
    } catch (error) {
      this.log.warn("chunked upload could not be assembled", { uploadId, error });
      await this.#discard(uploadId);
      return fail(
        422,
        "invalid_parts",
        "The uploaded parts could not be assembled; start a new upload.",
      );
    }
    this.git.uploads.clearMultipart(uploadId);
    if (size !== record.body.packBytes) {
      await this.#discard(uploadId);
      return fail(
        422,
        "size_mismatch",
        `The parts hold ${size} bytes, not the declared ${record.body.packBytes}; start a new upload.`,
      );
    }
    const { headBytes, packBytes } = record.body;
    if (
      !this.push.splitBodyStored(uploadId, {
        kind: "parts",
        headBytes,
        packBytes,
        ...partBytesOf(record.body),
      })
    )
      return fail(409, "upload_closed", "The upload is no longer open.");
    return { ok: true };
  }

  async #discard(uploadId: string): Promise<void> {
    await this.#abortMultipart(uploadId);
    await this.push.abort(uploadId);
  }

  /** Aborts the recorded multipart upload; one R2 no longer knows counts as aborted. */
  async #abortMultipart(uploadId: string): Promise<void> {
    const multipart = this.git.uploads.multipartOf(uploadId);
    if (!multipart) return;
    try {
      this.#count("abort_multipart");
      await this.git.bucket.resumeMultipartUpload(multipart.key, multipart.multipartId).abort();
      this.git.uploads.clearMultipart(uploadId);
    } catch (error) {
      // Left recorded: the reaper aborts it after the upload expires.
      this.log.warn("chunked upload abort failed", { uploadId, error });
    }
  }

  /** The upload if it is a chunked upload of `principal` (never a plain push's). */
  #chunkedUpload(uploadId: string, principal: string): UploadRecord | undefined {
    const upload = this.git.uploads.get(uploadId);
    if (!upload || upload.principal !== principal) return undefined;
    return readRecord(this.git, uploadId)?.body?.partBytes === undefined ? undefined : upload;
  }

  #open(
    uploadId: string,
    principal: string,
  ): { ok: true; upload: UploadRecord; record: SessionRecord } | ChunkedFailure {
    const upload = this.git.uploads.get(uploadId);
    if (!upload || upload.principal !== principal) return notFound;
    const record = sessionRecord(this.git, uploadId);
    if (!record) return notFound;
    if (upload.state !== "open")
      return fail(409, "upload_closed", "The upload is no longer receiving parts.");
    if (upload.expiresAt <= this.git.context.now())
      return fail(409, "upload_expired", "The upload session has expired.");
    return { ok: true, upload, record };
  }

  #view(upload: UploadRecord, refs?: RefOutcome[]): ChunkedView {
    const record = readRecord(this.git, upload.uploadId);
    const body = record?.body as SplitBody;
    const partBytes = body.partBytes ?? body.packBytes;
    const { partCount } = partLayout(body.packBytes, partBytes);
    const session = sessionRecord(this.git, upload.uploadId);
    const received =
      upload.state === "open"
        ? Object.keys(session?.session.parts ?? {})
            .map(Number)
            .sort((a, b) => a - b)
        : upload.state === "rejected" || upload.state === "expired"
          ? []
          : Array.from({ length: partCount }, (_, i) => i + 1);
    const state: ChunkedState =
      upload.state === "open"
        ? "receiving"
        : upload.state === "indexing" || upload.state === "indexed"
          ? "indexing"
          : upload.state;
    return {
      uploadId: upload.uploadId,
      state,
      size: body.packBytes,
      partBytes,
      partCount,
      partsReceived: received,
      expiresAt: upload.expiresAt,
      ...(refs ? { refs } : {}),
    };
  }

  #count(op: string): void {
    this.metrics.count("r2.class_a", { bucket: BUCKET_NAME, op });
  }
}

function partBytesOf(body: SplitBody): { partBytes?: number } {
  return body.partBytes === undefined ? {} : { partBytes: body.partBytes };
}

/** The session record of a chunked upload whose parts are still arriving. */
function sessionRecord(git: RepoGitStorage, uploadId: string): SessionRecord | undefined {
  const value = git.uploads.commandsOf(uploadId) as Partial<SessionRecord> | undefined;
  return value?.v === 1 && value.body?.kind === "parts" && value.session
    ? (value as SessionRecord)
    : undefined;
}
