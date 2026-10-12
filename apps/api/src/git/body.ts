export type BodyResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; status: 400 | 413 | 415; message: string };

/**
 * Reads a request body of at most `maxBytes` (after decompression). git
 * gzips request bodies above 1,024 bytes (remote-curl.c `post_rpc`), so
 * `Content-Encoding: gzip` is accepted; the limit applies to the inflated
 * bytes, which bounds a compression bomb.
 */
export async function readRequestBody(request: Request, maxBytes: number): Promise<BodyResult> {
  const encoding = (request.headers.get("Content-Encoding") ?? "identity").trim().toLowerCase();
  if (encoding !== "identity" && encoding !== "gzip" && encoding !== "x-gzip") {
    return { ok: false, status: 415, message: `Unsupported Content-Encoding '${encoding}'.` };
  }
  const tooLarge = {
    ok: false,
    status: 413,
    message: `The request is larger than ${maxBytes} bytes.`,
  } as const;
  const declared = Number(request.headers.get("Content-Length") ?? Number.NaN);
  if (encoding === "identity" && declared > maxBytes) return tooLarge;
  if (!request.body) return { ok: true, bytes: new Uint8Array(0) };

  const stream =
    encoding === "identity"
      ? request.body
      : request.body.pipeThrough(new DecompressionStream("gzip"));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > maxBytes) {
        await reader.cancel();
        return tooLarge;
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, status: 400, message: "The request body could not be read or inflated." };
  }
  const bytes = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return { ok: true, bytes };
}
