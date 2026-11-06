// The smallest bytes each raster format's header can be read from, and whole files a
// browser draws. A header alone is enough for the checks; the whole files are for the page.

const ascii = (text: string) => [...text].map((ch) => ch.charCodeAt(0));
const be16 = (n: number) => [(n >>> 8) & 255, n & 255];
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const le16 = (n: number) => [n & 255, (n >>> 8) & 255];
const le24 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255];

export const png = (width: number, height: number) =>
  Uint8Array.from([
    0x89,
    ...ascii("PNG\r\n\x1a\n"),
    ...be32(13),
    ...ascii("IHDR"),
    ...be32(width),
    ...be32(height),
  ]);

export const gif = (width: number, height: number) =>
  Uint8Array.from([...ascii("GIF89a"), ...le16(width), ...le16(height)]);

/** A JPEG's start, `segments` (each a marker and its payload), and a start-of-frame `sof`. */
export const jpeg = (
  width: number,
  height: number,
  sof = 0xc0,
  segments: readonly (readonly [number, readonly number[]])[] = [],
) =>
  Uint8Array.from([
    0xff,
    0xd8,
    ...segments.flatMap(([marker, payload]) => [
      0xff,
      marker,
      ...be16(payload.length + 2),
      ...payload,
    ]),
    0xff,
    sof,
    ...be16(11),
    8,
    ...be16(height),
    ...be16(width),
  ]);

const riff = (chunk: string, body: readonly number[]) =>
  Uint8Array.from([
    ...ascii("RIFF"),
    ...le16(body.length + 12),
    0,
    0,
    ...ascii("WEBP"),
    ...ascii(chunk),
    ...le16(body.length),
    0,
    0,
    ...body,
  ]);

export const webpLossy = (width: number, height: number) =>
  riff("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(width), ...le16(height)]);

export const webpLossless = (width: number, height: number) => {
  const bits = (width - 1) | ((height - 1) << 14);
  return riff("VP8L", [0x2f, ...le16(bits & 0xffff), ...le16(bits >>> 16)]);
};

export const webpExtended = (width: number, height: number) =>
  riff("VP8X", [0, 0, 0, 0, ...le24(width - 1), ...le24(height - 1)]);

/** Every format's header, one of each kind of WebP and of JPEG's frames. */
export const HEADERS = [
  { name: "PNG", type: "image/png", make: png, max: 0x7fffffff },
  { name: "GIF", type: "image/gif", make: gif, max: 0xffff },
  { name: "JPEG", type: "image/jpeg", make: (w: number, h: number) => jpeg(w, h), max: 0xffff },
  {
    name: "progressive JPEG",
    type: "image/jpeg",
    make: (w: number, h: number) => jpeg(w, h, 0xc2),
    max: 0xffff,
  },
  { name: "lossy WebP", type: "image/webp", make: webpLossy, max: 0x3fff },
  { name: "lossless WebP", type: "image/webp", make: webpLossless, max: 0x4000 },
  { name: "extended WebP", type: "image/webp", make: webpExtended, max: 0x1000000 },
] as const;

/** Base64 of bytes. */
export const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

/** Bytes as a stream of the given chunk sizes (the last chunk holds what remains). */
export function chunked(
  bytes: Uint8Array,
  sizes: readonly number[],
  onCancel?: (reason: unknown) => void,
  onPull?: () => void,
): ReadableStream<Uint8Array> {
  let at = 0;
  let turn = 0;
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        onPull?.();
        if (at >= bytes.length) {
          controller.close();
          return;
        }
        const size = sizes[turn++] ?? bytes.length - at;
        controller.enqueue(bytes.slice(at, at + Math.max(1, size)));
        at += Math.max(1, size);
      },
      cancel(reason) {
        onCancel?.(reason);
      },
    },
    { highWaterMark: 0 },
  );
}
