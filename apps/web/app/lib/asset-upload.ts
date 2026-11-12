/**
 * A release asset's upload from the browser. The session is begun, completed and ended
 * through the page's own route (`releaseUploads`), which calls the API through the binding;
 * the parts go straight to the API's parts route on this origin, which the web Worker hands
 * to the binding untouched. The part etags live only here, in memory: a reload loses them and
 * the upload starts again. Pure but for what `UploadDeps` gives it, so a test drives it with a
 * fake `fetch` and records its waits.
 */

import { assetContentType, assetName } from "@fyrden/domain";
import type { Release } from "./releases.js";

export type ReleaseAsset = Release["assets"][number];

/** Where an upload goes. */
export interface UploadTarget {
  readonly owner: string;
  readonly repo: string;
  readonly releaseId: number;
}

/** What the page's route answers for a session: the API's own shape, as far as it's read. */
interface Session {
  readonly id: string;
  readonly part_size: number;
  readonly part_count: number;
  readonly state: "receiving" | "completing" | "completed" | "aborted";
  readonly asset?: ReleaseAsset;
}

/** One file's upload, kept between a run and its Retry. */
export interface Upload {
  readonly target: UploadTarget;
  readonly file: Blob;
  readonly name: string;
  readonly replace: boolean;
  session: Session | null;
  /**
   * The key of a start whose answer never came, kept so the next start asks the same: the API
   * then answers the session the first one made, if it made one.
   */
  beginKey: string | null;
  /** Part n's etag at n - 1, once the API has it. */
  etags: (string | undefined)[];
  /** The key of the completion asked for with the parts as they stand: kept only to retry it. */
  completeKey: string | null;
}

export interface UploadDeps {
  readonly fetch: typeof fetch;
  /** Resolves after `ms` (the browser: a timer), or rejects once `signal` aborts. */
  readonly wait: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** A fresh `Idempotency-Key`: a UUID. */
  readonly newKey: () => string;
}

export interface UploadProgress {
  /** Bytes of the parts the API has. */
  readonly sent: number;
  readonly size: number;
  readonly state: "sending" | "completing" | "done";
}

export type UploadResult =
  | { readonly ok: true; readonly asset: ReleaseAsset }
  | {
      readonly ok: false;
      /** `retryable`: Retry goes on from here; `fatal`: start again. */
      readonly kind: "retryable" | "fatal" | "cancelled";
      readonly message: string;
    };

/** Parts sent at once. */
export const PARTS_AT_ONCE = 2;
/** Tries of a part after its first, for anything but a rate limit. */
export const PART_RETRIES = 3;
/** Rate-limited answers a part waits out before the upload stops (Retry goes on). */
const RATE_LIMITED_MAX = 20;
/** Completions asked for in one run before it stops (Retry asks again, with the same key). */
const COMPLETE_TRIES = 30;
/** How long to wait when an answer says to try again without saying when. */
const DEFAULT_WAIT_MS = 1_000;

/** The page's route that begins, completes and ends sessions. */
export const releaseUploads = (target: Pick<UploadTarget, "owner" | "repo">) =>
  `/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/releases/uploads`;

/** Part `n` of upload `id`, at the API on this origin. */
export const partUrl = (target: Pick<UploadTarget, "owner" | "repo">, id: string, n: number) =>
  `/api/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/releases/assets/uploads/${encodeURIComponent(id)}/parts/${n}`;

export function newUpload(target: UploadTarget, file: File, options: { replace: boolean }): Upload {
  return {
    target,
    file,
    name: file.name,
    replace: options.replace,
    session: null,
    beginKey: null,
    etags: [],
    completeKey: null,
  };
}

class Cancelled extends Error {}
class Stopped extends Error {
  constructor(
    readonly kind: "retryable" | "fatal",
    message: string,
  ) {
    super(message);
  }
}

/** An answer's problem details, as far as they parse. */
async function problemOf(res: Response): Promise<{ code?: string; detail?: string }> {
  const body: unknown = await res.json().catch(() => null);
  return typeof body === "object" && body !== null
    ? (body as { code?: string; detail?: string })
    : {};
}

/** `Retry-After` in milliseconds: seconds, or a date; the default when absent or unreadable. */
function retryAfterMs(res: Response): number {
  const header = res.headers.get("Retry-After");
  if (header === null) return DEFAULT_WAIT_MS;
  if (/^\d+$/.test(header.trim())) return Number(header.trim()) * 1000;
  const at = Date.parse(header);
  return Number.isNaN(at) ? DEFAULT_WAIT_MS : Math.max(0, at - Date.now());
}

const isAbort = (error: unknown) => error instanceof DOMException && error.name === "AbortError";

/** Answers that mean the same request may go again unchanged. */
const RETRY_SAME = new Set([
  "idempotency_key_in_use",
  "quota_unavailable",
  "release_asset_transferring",
  "rate_limited",
]);

/**
 * Begins (unless it has), sends the parts the API lacks, and completes `upload`. Run it again
 * after a `retryable` result to go on; after `fatal`, start a new upload.
 */
export async function runUpload(
  upload: Upload,
  deps: UploadDeps,
  options: { signal?: AbortSignal; onProgress?: (progress: UploadProgress) => void } = {},
): Promise<UploadResult> {
  const { signal, onProgress } = options;
  const route = releaseUploads(upload.target);
  const checkCancelled = () => {
    if (signal?.aborted) throw new Cancelled();
  };
  const wait = async (ms: number) => {
    checkCancelled();
    try {
      await deps.wait(ms, signal);
    } catch (error) {
      if (signal?.aborted) throw new Cancelled();
      throw error;
    }
    checkCancelled();
  };
  /**
   * The page's route, with `body` as JSON. What isn't cancellable (a start, an ending) must not
   * be lost with the page either: it outlives the page as `keepalive`.
   */
  const ask = (body: Record<string, unknown>, cancellable = true) =>
    deps.fetch(route, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      ...(cancellable ? signal && { signal } : { keepalive: true }),
    });
  const sentBytes = () => {
    const session = upload.session;
    if (!session) return 0;
    let sent = 0;
    upload.etags.forEach((etag, i) => {
      if (etag !== undefined)
        sent += Math.min(session.part_size, upload.file.size - i * session.part_size);
    });
    return sent;
  };
  const report = (state: UploadProgress["state"]) =>
    onProgress?.({
      sent: state === "done" ? upload.file.size : sentBytes(),
      size: upload.file.size,
      state,
    });

  try {
    if (!upload.session) {
      if (upload.file.size === 0) throw new Stopped("fatal", "An empty file can't be uploaded.");
      const name = assetName(upload.name);
      if (!name.ok) throw new Stopped("fatal", `The file's name ${name.reason}.`);
      checkCancelled();
      upload.beginKey ??= deps.newKey();
      // Not cancellable: a session the API makes must be learnt, so a Cancel can end it.
      const res = await ask(startOf(upload, name.name, upload.beginKey), false);
      if (!res.ok) {
        const problem = res.status === 401 ? {} : await problemOf(res);
        // The lost start this key was kept for is still running: the same key gets its answer.
        const running = problem.code === "idempotency_key_in_use";
        // Else answered: the API keeps this answer for the key, so the next start needs a new one.
        if (!running) upload.beginKey = null;
        // A Cancel asked for meanwhile is what the person sees: nothing was begun to end.
        checkCancelled();
        if (running) throw new Stopped("retryable", "The upload is still starting; retry it.");
        // The repository's open uploads are at their limit: one may finish or end soon.
        throw new Stopped(
          problem.code === "too_many_uploads" ? "retryable" : "fatal",
          refusal(res.status, problem),
        );
      }
      upload.session = (await res.json()) as Session;
      upload.beginKey = null;
      upload.etags = [];
      upload.completeKey = null;
      checkCancelled();
    }
    report("sending");
    await sendParts(upload, deps, signal, wait, () => report("sending"));
    report("completing");
    const asset = await complete(upload, deps, ask, wait);
    report("done");
    return { ok: true, asset };
  } catch (error) {
    if (error instanceof Cancelled || (isAbort(error) && signal?.aborted))
      return cancelled(await end(upload, ask));
    if (error instanceof Stopped) {
      if (error.kind === "fatal") await end(upload, ask);
      return { ok: false, kind: error.kind, message: error.message };
    }
    throw error;
  }
}

/** The start of `upload`'s session, as sent with `key`: the same each time it is asked. */
function startOf(upload: Upload, name: string, key: string): Record<string, unknown> {
  const type = assetContentType(upload.file.type || undefined);
  return {
    intent: "begin",
    release_id: upload.target.releaseId,
    name,
    size: upload.file.size,
    ...(type.ok && upload.file.type !== "" ? { content_type: type.type } : {}),
    replace: upload.replace,
    key,
  };
}

/**
 * Whether `upload` may hold a session to end: one it knows, or one a start whose answer was
 * lost may have made (its key kept).
 */
export const holdsSession = (upload: Upload) => upload.session !== null || upload.beginKey !== null;

/** What a refusal to begin says, for the person uploading. */
function refusal(status: number, problem: { code?: string; detail?: string }): string {
  if (status === 401) return "Sign in again, then start the upload again.";
  if (problem.code === "wrong_token")
    return "You signed in again since this upload began; start it again.";
  return problem.detail ?? `The upload was refused (${status}).`;
}

/**
 * What ending a session came to: `ended` (or ended already), `completed` (it made its asset
 * first, so nothing was undone), `unknown` (no answer that says), or `none` (no session).
 */
export type Ending = "ended" | "completed" | "unknown" | "none";

/**
 * Ends the upload's session, if it has one, freeing what it holds, and says how that went. A
 * session whose ending isn't confirmed stays on the upload, so ending it can be asked again.
 */
async function end(
  upload: Upload,
  ask: (body: Record<string, unknown>, cancellable?: boolean) => Promise<Response>,
): Promise<Ending> {
  const session = upload.session;
  // Taken at once, so an ending asked for meanwhile doesn't ask again.
  upload.session = null;
  upload.etags = [];
  upload.completeKey = null;
  if (!session) return "none";
  const ending = await endingOf(session, ask);
  if (ending === "unknown") upload.session ??= session;
  return ending;
}

async function endingOf(
  session: Session,
  ask: (body: Record<string, unknown>, cancellable?: boolean) => Promise<Response>,
): Promise<Ending> {
  let res: Response;
  try {
    res = await ask({ intent: "abort", upload_id: session.id }, false);
  } catch {
    return "unknown";
  }
  if (res.ok) {
    await res.body?.cancel();
    return "ended";
  }
  const problem = await problemOf(res);
  if (problem.code === "upload_completed") return "completed";
  // Ended already. A 404 proves nothing: the API answers it too when access has gone or the
  // session is another's, without looking at the upload.
  if (problem.code === "upload_aborted") return "ended";
  return "unknown";
}

/** What a Cancel that came to `ending` says. */
function cancelled(ending: Ending): UploadResult {
  switch (ending) {
    case "completed":
      return {
        ok: false,
        kind: "fatal",
        message: "It finished uploading before it could be cancelled, and is kept.",
      };
    case "unknown":
      return {
        ok: false,
        kind: "fatal",
        message: "The upload may not have ended; the release's assets show whether it was kept.",
      };
    default:
      return { ok: false, kind: "cancelled", message: "Cancelled." };
  }
}

/**
 * Lets an upload go: its session ends, freeing the storage it holds, and the result says what
 * that came to (see `cancelled`). The request outlives the page that asks (`keepalive`), so a
 * page being left still ends it, though the result is then never seen.
 */
export async function abandonUpload(upload: Upload, deps: UploadDeps): Promise<UploadResult> {
  const ask = (body: Record<string, unknown>) =>
    deps.fetch(releaseUploads(upload.target), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      keepalive: true,
    });
  if (upload.session === null && upload.beginKey !== null) {
    // A start whose answer was lost: the same start again answers the session it made.
    if ((await relearn(upload, upload.beginKey, ask)) === "unknown") return cancelled("unknown");
  }
  return cancelled(await end(upload, ask));
}

/**
 * Asks `upload`'s lost start again with its `key`, taking the session it made: `learnt`, or
 * `none` when it made none (it was refused), or `unknown`. Not for a page being unloaded: no
 * script would run to end what it learns, and a start that never arrived would then make one.
 */
async function relearn(
  upload: Upload,
  key: string,
  ask: (body: Record<string, unknown>) => Promise<Response>,
): Promise<"learnt" | "none" | "unknown"> {
  const name = assetName(upload.name);
  if (!name.ok) {
    upload.beginKey = null;
    return "none";
  }
  let res: Response;
  try {
    res = await ask(startOf(upload, name.name, key));
  } catch {
    return "unknown";
  }
  if (res.ok) {
    try {
      upload.session = (await res.json()) as Session;
    } catch {
      return "unknown";
    }
    upload.beginKey = null;
    return "learnt";
  }
  // Answered before the key was looked at (signed out, refused, timed out, rate limited) or
  // failing: nothing said of the lost start, which is still to learn with the same key.
  if (res.status >= 500 || NOT_KEPT.has(res.status)) {
    await res.body?.cancel();
    return "unknown";
  }
  const problem = await problemOf(res);
  // Still running or busy, or a refusal that can't be read: still to learn, the same way.
  if (problem.code === undefined || STILL_TO_LEARN.has(problem.code)) return "unknown";
  // Refused, so it made nothing; or its outcome can no longer be learnt by this key.
  upload.beginKey = null;
  return problem.code === "idempotent_outcome_unknown" ? "unknown" : "none";
}

/** Statuses the API answers without keeping them for the key (`limits.md`, idempotent requests). */
const NOT_KEPT = new Set([401, 403, 408, 429]);
/** Answers that say the key's request is still to be decided, or was undone to run again. */
const STILL_TO_LEARN = new Set(["idempotency_key_in_use", "busy", "network_busy"]);

/** Sends every part the API lacks, `PARTS_AT_ONCE` at a time. */
async function sendParts(
  upload: Upload,
  deps: UploadDeps,
  signal: AbortSignal | undefined,
  wait: (ms: number) => Promise<void>,
  onPart: () => void,
): Promise<void> {
  const session = upload.session;
  if (!session) return;
  const missing: number[] = [];
  for (let n = 1; n <= session.part_count; n++)
    if (upload.etags[n - 1] === undefined) missing.push(n);
  if (missing.length > 0) upload.completeKey = null;
  let stopped: Error | null = null;
  const sendOne = async (n: number) => {
    const start = (n - 1) * session.part_size;
    const body = upload.file.slice(start, Math.min(start + session.part_size, upload.file.size));
    let failures = 0;
    let limited = 0;
    for (;;) {
      if (stopped) return;
      if (signal?.aborted) throw new Cancelled();
      let res: Response;
      try {
        res = await deps.fetch(partUrl(upload.target, session.id, n), {
          method: "PUT",
          headers: { "X-Fyrden-Session": "1" },
          body,
          ...(signal && { signal }),
        });
      } catch (error) {
        if (signal?.aborted) throw new Cancelled();
        if (isAbort(error)) throw error;
        if (++failures > PART_RETRIES)
          throw new Stopped("retryable", `Part ${n} could not be sent; check the connection.`);
        await wait(DEFAULT_WAIT_MS * failures);
        continue;
      }
      if (res.ok) {
        const answer = (await res.json()) as { etag?: unknown };
        if (typeof answer.etag !== "string" || answer.etag === "")
          throw new Stopped("retryable", `Part ${n} was not acknowledged.`);
        upload.etags[n - 1] = answer.etag;
        onPart();
        return;
      }
      if (res.status === 429) {
        await res.body?.cancel();
        if (++limited > RATE_LIMITED_MAX)
          throw new Stopped("retryable", "Too many requests for now; retry later.");
        await wait(retryAfterMs(res));
        continue;
      }
      const problem = await problemOf(res);
      if (res.status >= 500 || problem.code === "part_not_stored") {
        if (++failures > PART_RETRIES)
          throw new Stopped("retryable", problem.detail ?? `Part ${n} was not stored.`);
        await wait(DEFAULT_WAIT_MS * failures);
        continue;
      }
      if (res.status === 401)
        throw new Stopped("fatal", "Sign in again, then start the upload again.");
      throw new Stopped("fatal", problem.detail ?? `Part ${n} was refused (${res.status}).`);
    }
  };
  const worker = async () => {
    for (;;) {
      if (stopped) return;
      const n = missing.shift();
      if (n === undefined) return;
      try {
        await sendOne(n);
      } catch (error) {
        // The first failure stops both; the other finishes the part it is sending.
        stopped ??= error as Error;
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: PARTS_AT_ONCE }, worker));
  // A Cancel wins over a part's failure that came first: the person asked for it.
  if (signal?.aborted) throw new Cancelled();
  if (stopped) throw stopped;
}

/**
 * Completes the upload: one key for the request as it stands, kept to retry it, and a new one
 * only when its outcome was never learnt (the upload's own state makes that safe).
 */
async function complete(
  upload: Upload,
  deps: UploadDeps,
  ask: (body: Record<string, unknown>) => Promise<Response>,
  wait: (ms: number) => Promise<void>,
): Promise<ReleaseAsset> {
  const session = upload.session;
  if (!session) throw new Stopped("fatal", "The upload has no session.");
  const parts = upload.etags.map((etag, i) => ({ part_number: i + 1, etag }));
  upload.completeKey ??= deps.newKey();
  for (let tries = 0; tries < COMPLETE_TRIES; tries++) {
    let res: Response;
    try {
      res = await ask({
        intent: "complete",
        upload_id: session.id,
        parts,
        key: upload.completeKey,
      });
    } catch (error) {
      if (isAbort(error)) throw error;
      await wait(DEFAULT_WAIT_MS);
      continue;
    }
    if (res.ok) {
      const answer = (await res.json()) as Session;
      if (answer.state === "completed" && answer.asset) return answer.asset;
      if (answer.state === "aborted")
        throw new Stopped("fatal", "The upload ended before it completed; start it again.");
      await wait(retryAfterMs(res));
      continue;
    }
    if (res.status === 401)
      throw new Stopped("fatal", "Sign in again, then start the upload again.");
    const problem = await problemOf(res);
    if (problem.code === "idempotent_outcome_unknown") {
      upload.completeKey = deps.newKey();
      continue;
    }
    // An unexpected failure may have completed it: the same request again, whose answer then
    // says so, or that its outcome was never learnt (a new key, above).
    if (
      res.status === 429 ||
      res.status >= 500 ||
      (problem.code !== undefined && RETRY_SAME.has(problem.code))
    ) {
      await wait(retryAfterMs(res));
      continue;
    }
    if (problem.code === "wrong_token")
      throw new Stopped("fatal", "You signed in again since this upload began; start it again.");
    throw new Stopped("fatal", problem.detail ?? `The upload was not completed (${res.status}).`);
  }
  throw new Stopped("retryable", "The upload is still completing; retry in a moment.");
}
