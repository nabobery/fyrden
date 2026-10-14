import { currentInvocation } from "@fyrden/adapters-cloudflare/obs";
import { bytesBody, encodeFatalError, requestedSideband } from "@fyrden/git-core";
import { isRepoDeleted } from "../do/repo/events.js";
import { authorizeGit } from "./auth.js";
import { checkRequestType, type GitContext, gitPayload, gitText, repoParams } from "./http.js";
import { contentType, NO_CACHE_HEADERS } from "./protocol.js";
import { releaseUpload, reserveUpload } from "./push/quota.js";
import { reauthorizePush } from "./push/reauthorize.js";
import { pushResponseBody } from "./push/respond.js";
import { storePushBody } from "./push/store-body.js";
import { pushTuning } from "./push/tuning.js";

const SERVICE = "git-receive-pack";

/** How much longer than the Worker's longest wait a push's reservation lasts. */
const RESERVATION_MARGIN_MS = 15 * 60 * 1000;

/** A `Content-Length` as a byte count; undefined when absent or not a plain decimal. */
function declaredLength(request: Request): number | undefined {
  const header = request.headers.get("Content-Length");
  if (header === null || !/^\d{1,16}$/.test(header.trim())) return undefined;
  return Number(header.trim());
}

function tooLargeMessage(limit: number, gzip: boolean): string {
  return gzip
    ? `a compressed push inflates to more than this server accepts (${limit} bytes); push without compression or in parts (fyrden push --chunked)`
    : `the push is larger than this server accepts in one request (${limit} bytes); push fewer commits at a time`;
}

/**
 * Refuses a body over the limit, in the client's terms: on side-band 3 when
 * its first command asked for side-band, else an `ERR` packet (status 200,
 * so git prints the message; see `gitError`).
 */
async function refuseTooLarge(head: Uint8Array, limit: number, gzip = false): Promise<Response> {
  const sideband = await requestedSideband(bytesBody(head));
  return gitPayload(
    encodeFatalError(tooLargeMessage(limit, gzip), sideband),
    contentType.result(SERVICE),
  );
}

/** The first bytes of the request body (the first command), without reading the rest. */
async function readHead(request: Request): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const { value } = await reader.read();
  await reader.cancel().catch(() => {});
  return value ?? new Uint8Array(0);
}

/** git's probe body: a flush packet alone. */
const PROBE = "0000";

/**
 * Reads a body of exactly the probe's length. git sends the probe (with
 * `Content-Length: 4`) before a body larger than its `http.postBuffer`, to
 * check that the request will be accepted (credentials, redirects), and
 * discards the answer (`probe_rpc` in git's remote-curl.c, v2.53.0). The
 * probe gets an empty 200, as git's own receive-pack gives a request with
 * no commands; any other 4-byte body goes on as a push request.
 */
async function readProbe(
  request: Request,
): Promise<{ probe: true } | { probe: false; request: Request }> {
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (new TextDecoder().decode(bytes) === PROBE) return { probe: true };
  return { probe: false, request: new Request(request, { body: bytes }) };
}

/**
 * `POST <repo>/git-receive-pack`: a push.
 *
 * The Worker authenticates (write access, the token checked on the D1
 * primary), applies the rate limit, has the repository object open an
 * upload, and stores the request body in R2 with one PUT (no code per
 * chunk when the body is uncompressed and has a length; see
 * `storePushBody`). The repository object reads the commands and indexes the pack
 * from R2, within a budget per call and then from its alarm; the Worker
 * waits between calls, re-authorizes the pusher just before the commit and
 * sends the report. Every protocol answer has status 200 (see `gitError`).
 */
export async function receivePack(c: GitContext): Promise<Response> {
  const wrongType = checkRequestType(c, SERVICE);
  if (wrongType) return wrongType;
  const { owner, name } = repoParams(c);
  const access = await authorizeGit(c, owner, name, "write");
  if (!access.ok) return access.response;

  let request = c.req.raw;
  const encoding = (request.headers.get("Content-Encoding") ?? "identity").trim().toLowerCase();
  // git never compresses receive-pack requests (remote-curl.c gzips upload-pack
  // requests only); JGit gzips every one, and git's http-backend inflates it
  // (`inflate_request`), so gzip is accepted too.
  const gzip = encoding === "gzip" || encoding === "x-gzip";
  if (encoding !== "identity" && !gzip) {
    return gitText(
      c,
      415,
      `Unsupported Content-Encoding '${encoding.slice(0, 40)}'; send the push uncompressed or with gzip.`,
    );
  }
  const tuning = pushTuning(c.env);
  // A gzip body's limit applies to its inflated length, known only once read
  // (and held in the Worker until then, hence its own, smaller limit).
  const declared = gzip ? undefined : declaredLength(request);
  const maxBytes = gzip
    ? Math.min(tuning.maxGzipBodyBytes, tuning.maxBodyBytes)
    : tuning.maxBodyBytes;
  if (declared !== undefined && declared > tuning.maxBodyBytes) {
    return refuseTooLarge(await readHead(request), tuning.maxBodyBytes);
  }

  if (declared === PROBE.length) {
    const read = await readProbe(request);
    if (read.probe) {
      c.get("log").debug("git push probe answered", { repoId: access.repo.id });
      return gitPayload(new Uint8Array(0), contentType.result(SERVICE));
    }
    request = read.request;
  }

  const metrics = c.get("metrics");
  const log = c.get("log");
  const stub = c.env.REPO.getByName(access.repo.id);
  const call = (method: string) => metrics.count("do.request", { class: "RepoDO", method });
  const abort = (uploadId: string) => {
    call("abortPush");
    // The object's abort also frees the upload's reservation.
    c.executionCtx.waitUntil(stub.abortPush(uploadId));
  };
  call("beginPush");
  const begun = await stub.beginPush({
    principal: access.auth.principalId,
    tokenId: access.auth.id,
  });
  if (!begun.ok)
    return gitPayload(encodeFatalError(begun.error, false), contentType.result(SERVICE));

  // The account's storage, reserved before a byte is stored; the store stops at it.
  metrics.count("do.request", { class: "OrgDO", method: "reserveStorage" });
  const reservation = await reserveUpload(c.env, access.repo, begun.uploadId, {
    declared,
    maxBytes,
    ttlMs: tuning.maxWaitMs + RESERVATION_MARGIN_MS,
  }).catch((error: unknown) => {
    abort(begun.uploadId);
    throw error;
  });
  if (!reservation.ok) {
    abort(begun.uploadId);
    const sideband = await requestedSideband(bytesBody(await readHead(request)));
    return gitPayload(encodeFatalError(reservation.message, sideband), contentType.result(SERVICE));
  }
  const storeMax = Math.min(maxBytes, reservation.bytes);

  let stored: Awaited<ReturnType<typeof storePushBody>>;
  try {
    stored = await storePushBody(
      c.env.GIT,
      begun.bodyKey,
      request,
      { declaredBytes: declared, maxBytes: storeMax, gzip },
      metrics,
    );
  } catch (error) {
    abort(begun.uploadId);
    throw error;
  }
  if (!stored.ok) {
    abort(begun.uploadId);
    if (stored.reason === "too-large" && storeMax < maxBytes) {
      const sideband = await requestedSideband(bytesBody(stored.head));
      return gitPayload(
        encodeFatalError(
          `the push is larger than the account's storage quota has free (${storeMax} bytes)`,
          sideband,
        ),
        contentType.result(SERVICE),
      );
    }
    if (stored.reason === "too-large")
      return refuseTooLarge(stored.head, maxBytes, gzip && maxBytes < tuning.maxBodyBytes);
    return gitPayload(
      encodeFatalError("the push body is not valid gzip", false),
      contentType.result(SERVICE),
    );
  }

  const uploadId = begun.uploadId;
  const meta = { requestId: c.get("requestId"), repoId: access.repo.id };
  call("runPush");
  const first = await stub
    .runPush(uploadId, stored.bytes, tuning.indexBudgetMs)
    .catch((error: unknown) => {
      if (isRepoDeleted(error)) return "deleted" as const;
      // The object was reset mid-call: indexing continues from its cursor.
      log.warn("push run call failed; waiting for the index job", { uploadId, error });
      return { state: "indexing", sideband: false } as const;
    });
  if (first === "deleted" || (first.state === "done" && first.discardBody)) {
    // No upload holds the body any more (the repository was deleted, or the
    // upload expired, while the body was stored): nothing else will delete it
    // or free its reservation.
    c.executionCtx.waitUntil(releaseUpload(c.env, access.repo, uploadId).catch(() => {}));
    await c.env.GIT.delete(begun.bodyKey).catch((error: unknown) =>
      log.warn("deleting the body of a push nobody holds failed", { uploadId, error }),
    );
    return first === "deleted"
      ? gitPayload(encodeFatalError("repository not found", false), contentType.result(SERVICE))
      : new Response(first.response as BodyInit, {
          headers: { "Content-Type": contentType.result(SERVICE), ...NO_CACHE_HEADERS },
        });
  }
  const body = await pushResponseBody(
    first,
    {
      status: () => {
        call("pushStatus");
        return stub.pushStatus(uploadId, tuning.indexBudgetMs);
      },
      finalize: async () => {
        const decision = await reauthorizePush(c, access, { owner, name });
        call("finalizePush");
        return stub.finalizePush(uploadId, decision, meta);
      },
    },
    {
      tuning,
      // A streamed report: the request's subrequests are written once it is sent.
      waitUntil: (promise) => {
        const release = currentInvocation()?.hold();
        c.executionCtx.waitUntil(promise.finally(release));
      },
      onError: (error) => log.warn("push wait failed", { uploadId, error }),
    },
  );
  return new Response(body as BodyInit, {
    headers: { "Content-Type": contentType.result(SERVICE), ...NO_CACHE_HEADERS },
  });
}
