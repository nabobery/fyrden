/**
 * Largest JSON request body the API reads (REST and MCP). Proposed: room
 * for a file write's 4 MiB of content as base64 and its JSON around it;
 * anything larger is refused before it is buffered or parsed.
 */
export const MAX_JSON_BODY_BYTES = 8 * 1024 * 1024;

/**
 * A request's body, read up to `maxBytes`: undefined when it is longer (by
 * its declared length, or as it streams in, whichever shows first), so an
 * oversized body is never held whole.
 */
export async function readBoundedBody(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array | undefined> {
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (declared > maxBytes) return undefined;
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > maxBytes) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    body.set(chunk, at);
    at += chunk.length;
  }
  return body;
}
