// Connect unary framing for the runner protocol: binary protobuf only, never
// compressed (measured: the pinned runners send `application/proto` with no
// content encoding), errors as Connect's JSON body with its HTTP status.

/** Connect's error codes and the HTTP status each is sent with (verified: https://connectrpc.com/docs/protocol#error-codes). */
export const CONNECT_HTTP_STATUS = {
  canceled: 499,
  unknown: 500,
  invalid_argument: 400,
  deadline_exceeded: 504,
  not_found: 404,
  already_exists: 409,
  permission_denied: 403,
  resource_exhausted: 429,
  failed_precondition: 400,
  aborted: 409,
  out_of_range: 400,
  unimplemented: 501,
  internal: 500,
  unavailable: 503,
  data_loss: 500,
  unauthenticated: 401,
} as const;

export type ConnectCode = keyof typeof CONNECT_HTTP_STATUS;

/** Ping, Register, Declare and FetchTask bodies are tiny. */
export const MAX_SMALL_CALL_BYTES = 64 * 1024;
/** Up to 1 MiB of outputs plus room for the task state and its steps. */
export const MAX_UPDATE_TASK_BYTES = 1.25 * 1024 * 1024;
/** A longer UpdateLog body is read up to this and decoded as a truncated prefix. */
export const UPDATE_LOG_PREFIX_BYTES = 4 * 1024 * 1024;

export function connectError(code: ConnectCode, message: string): Response {
  return new Response(JSON.stringify({ code, message }), {
    status: CONNECT_HTTP_STATUS[code],
    headers: { "content-type": "application/json" },
  });
}

export function protoResponse(bytes: Uint8Array): Response {
  return new Response(bytes, { headers: { "content-type": "application/proto" } });
}

/**
 * The response refusing a request this framing does not serve, or undefined
 * when the request is a POST of uncompressed binary protobuf.
 */
export function checkConnectRequest(request: Request): Response | undefined {
  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { allow: "POST" } });
  }
  const mediaType = (request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  if (mediaType !== "application/proto") {
    return connectError("unimplemented", "only binary protobuf is supported");
  }
  for (const header of ["content-encoding", "connect-content-encoding"]) {
    const encoding = request.headers.get(header);
    if (encoding !== null && encoding.trim().toLowerCase() !== "identity") {
      return connectError("unimplemented", `${header} ${encoding} is not supported`);
    }
  }
  return undefined;
}

/**
 * At most `maxBytes` of a body, and whether there was more. Each chunk is
 * copied into one buffer as it arrives, so the read holds no reference to
 * any chunk, never more than `maxBytes` of body, and at most twice that
 * while the buffer grows. Reading stops (and the stream is cancelled) as
 * soon as the body is known to be longer.
 */
export async function readPrefix(
  request: Pick<Request, "body">,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!request.body) return { bytes: new Uint8Array(0), truncated: false };
  const reader = request.body.getReader();
  let buffer = new Uint8Array(Math.min(maxBytes, 64 * 1024));
  let length = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const take = Math.min(value.length, maxBytes - length);
    if (length + take > buffer.length) {
      const grown = new Uint8Array(Math.min(maxBytes, Math.max(buffer.length * 2, length + take)));
      grown.set(buffer.subarray(0, length));
      buffer = grown;
    }
    buffer.set(value.subarray(0, take), length);
    length += take;
    if (take < value.length) {
      truncated = true;
      await reader.cancel();
      break;
    }
  }
  return { bytes: length === buffer.length ? buffer : buffer.slice(0, length), truncated };
}
