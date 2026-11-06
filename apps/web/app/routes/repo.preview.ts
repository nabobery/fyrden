import { apiFetch } from "../lib/api.server.js";
import { IMAGE_MAX_BYTES, IMAGE_MAX_PIXELS, SNIFF_MAX_BYTES, sniffRaster } from "../lib/raster.js";
import { refAndPath } from "../lib/target.js";
import { encodePath } from "../lib/types.js";
import type { Route } from "./+types/repo.preview";

/**
 * Every answer's headers, its failures' too. A resource route gets none of
 * `entry.server.tsx`'s. CORP keeps another site from embedding a private
 * image with the viewer's cookie; the two framing headers cover what CORP
 * does not, a frame's navigation.
 */
function guarded(extra: Record<string, string> = {}): Headers {
  return new Headers({
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; sandbox",
    "X-Frame-Options": "DENY",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Cache-Control": "private, no-store",
    ...extra,
  });
}

const refusal = () => new Response(null, { status: 415, headers: guarded() });

/**
 * Reads until `SNIFF_MAX_BYTES` are held or the stream ends. The last chunk
 * may pass them by what the platform hands over at once: 4,096 bytes a read
 * through the binding (measured under `wrangler dev`).
 */
async function readChunks(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<Uint8Array[]> {
  const chunks: Uint8Array[] = [];
  let held = 0;
  while (held < SNIFF_MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    held += value.length;
  }
  return chunks;
}

/** The first `SNIFF_MAX_BYTES` of `chunks`, in one piece: all a header is looked for in. */
function sniffWindow(chunks: readonly Uint8Array[]): Uint8Array {
  const held = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const window = new Uint8Array(Math.min(held, SNIFF_MAX_BYTES));
  let at = 0;
  for (const chunk of chunks) {
    if (at === window.length) break;
    const part = chunk.subarray(0, window.length - at);
    window.set(part, at);
    at += part.length;
  }
  return window;
}

/** `chunks` and then the rest of `reader`, erroring and cancelling it past the size limit. */
function capped(
  chunks: readonly Uint8Array[],
  reader: ReadableStreamDefaultReader<Uint8Array>,
): ReadableStream<Uint8Array> {
  let sent = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
      },
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        sent += value.length;
        if (sent > IMAGE_MAX_BYTES) {
          const tooLarge = new Error("The image is over the preview's size limit.");
          controller.error(tooLarge);
          await reader.cancel(tooLarge);
          return;
        }
        controller.enqueue(value);
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    },
    // Read from upstream only as the browser takes it.
    { highWaterMark: 0 },
  );
}

/**
 * A file's bytes as an image, for the file page's `<img>`: served only when
 * the bytes' own header says they are an allowed raster image within limits.
 * The type comes from that header, never from the name.
 */
export async function loader({ request, context, params }: Route.LoaderArgs) {
  const { ref, path } = refAndPath(request);
  const base = `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}`;
  const upstream = await apiFetch(
    context,
    request,
    "GET",
    `${base}/raw/${encodePath(path)}?ref=${encodeURIComponent(ref)}`,
  );
  if (!upstream.ok) {
    await upstream.body?.cancel();
    const retryAfter = upstream.headers.get("Retry-After");
    return new Response(null, {
      status: upstream.status,
      headers: guarded(retryAfter === null ? {} : { "Retry-After": retryAfter }),
    });
  }
  // A missing or malformed length reads as no claim; the stream's own count still applies.
  if (Number(upstream.headers.get("Content-Length")) > IMAGE_MAX_BYTES) {
    await upstream.body?.cancel();
    return refusal();
  }
  const reader = upstream.body?.getReader();
  if (!reader) return refusal();
  const chunks = await readChunks(reader);
  const raster = sniffRaster(sniffWindow(chunks));
  if (
    !raster ||
    raster.width * raster.height > IMAGE_MAX_PIXELS ||
    chunks.reduce((sum, chunk) => sum + chunk.length, 0) > IMAGE_MAX_BYTES
  ) {
    await reader.cancel();
    return refusal();
  }
  return new Response(capped(chunks, reader), {
    headers: guarded({ "Content-Type": raster.type }),
  });
}
