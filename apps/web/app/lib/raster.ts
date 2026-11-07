/**
 * Raster images as bytes alone say they are: whether a file may be served as
 * an image, its name aside. No pixels are decoded, and SVG is never one.
 */

import { commitOf } from "./file-view.js";
import { bytesOfBase64, type Contents, encodePath } from "./types.js";

/** The largest image previewed: more than this is left to Raw. */
export const IMAGE_MAX_BYTES = 4 * 1024 * 1024;
/** The most pixels an image previewed may say it has. */
export const IMAGE_MAX_PIXELS = 16_000_000;
/** How far into a file its header is looked for. */
export const SNIFF_MAX_BYTES = 256 * 1024;

export interface Raster {
  readonly type: "image/png" | "image/gif" | "image/jpeg" | "image/webp";
  readonly width: number;
  readonly height: number;
}

const PNG_START = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];
const PNG_IHDR = [0x49, 0x48, 0x44, 0x52];
const GIF87 = [0x47, 0x49, 0x46, 0x38, 0x37, 0x61];
const GIF89 = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];
const RIFF = [0x52, 0x49, 0x46, 0x46];
const WEBP = [0x57, 0x45, 0x42, 0x50];
const VP8_LOSSY = [0x56, 0x50, 0x38, 0x20];
const VP8_LOSSLESS = [0x56, 0x50, 0x38, 0x4c];
const VP8_EXTENDED = [0x56, 0x50, 0x38, 0x58];
const VP8_START_CODE = [0x9d, 0x01, 0x2a];
/** Bytes enough for `hasSignature` to tell any format. */
const SIGNATURE_BYTES = 12;

const startsAt = (bytes: Uint8Array, at: number, expected: readonly number[]): boolean =>
  at + expected.length <= bytes.length && expected.every((byte, i) => bytes[at + i] === byte);

const isWebp = (bytes: Uint8Array) => startsAt(bytes, 0, RIFF) && startsAt(bytes, 8, WEBP);
const isGif = (bytes: Uint8Array) => startsAt(bytes, 0, GIF87) || startsAt(bytes, 0, GIF89);
const isJpeg = (bytes: Uint8Array) => bytes[0] === 0xff && bytes[1] === 0xd8;

const hasSignature = (bytes: Uint8Array) =>
  startsAt(bytes, 0, PNG_START.slice(0, 8)) || isGif(bytes) || isJpeg(bytes) || isWebp(bytes);

/** The type and size a file's own header states, or null when it has no whole one. */
export function sniffRaster(bytes: Uint8Array): Raster | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const found = isGif(bytes)
    ? gifSize(bytes, view)
    : isJpeg(bytes)
      ? jpegSize(bytes, view)
      : isWebp(bytes)
        ? webpSize(bytes, view)
        : pngSize(bytes, view);
  return found && found.width > 0 && found.height > 0 ? found : null;
}

function pngSize(bytes: Uint8Array, view: DataView): Raster | null {
  if (bytes.length < 24 || !startsAt(bytes, 0, PNG_START) || !startsAt(bytes, 12, PNG_IHDR))
    return null;
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  // The format's own limit, 2^31 - 1 (PNG specification, 11.2.2 IHDR).
  if (width > 0x7fffffff || height > 0x7fffffff) return null;
  return { type: "image/png", width, height };
}

function gifSize(bytes: Uint8Array, view: DataView): Raster | null {
  if (bytes.length < 10) return null;
  return { type: "image/gif", width: view.getUint16(6, true), height: view.getUint16(8, true) };
}

function webpSize(bytes: Uint8Array, view: DataView): Raster | null {
  const type = "image/webp";
  if (startsAt(bytes, 12, VP8_LOSSY)) {
    // A key frame's tag, its start code, then 14 bits of each size under 2 bits of scale.
    if (bytes.length < 30 || !startsAt(bytes, 23, VP8_START_CODE) || (view.getUint8(20) & 1) !== 0)
      return null;
    return {
      type,
      width: view.getUint16(26, true) & 0x3fff,
      height: view.getUint16(28, true) & 0x3fff,
    };
  }
  if (startsAt(bytes, 12, VP8_LOSSLESS)) {
    if (bytes.length < 25 || bytes[20] !== 0x2f) return null;
    const sizes = view.getUint32(21, true);
    return { type, width: (sizes & 0x3fff) + 1, height: ((sizes >>> 14) & 0x3fff) + 1 };
  }
  if (startsAt(bytes, 12, VP8_EXTENDED)) {
    if (bytes.length < 30) return null;
    const uint24 = (at: number) => view.getUint16(at, true) + view.getUint8(at + 2) * 0x10000;
    return { type, width: uint24(24) + 1, height: uint24(27) + 1 };
  }
  return null;
}

/** JPEG's frame headers: every SOF marker; 0xC4, 0xC8 and 0xCC share their range and are not. */
const isJpegFrame = (marker: number) =>
  marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
/** Markers with no length after them: restarts and TEM. */
const standsAlone = (marker: number) => (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01;

/** Walks the segments before the first scan to the frame header; every step moves forward. */
function jpegSize(bytes: Uint8Array, view: DataView): Raster | null {
  let at = 2;
  while (at < bytes.length) {
    if (bytes[at] !== 0xff) return null;
    while (bytes[at] === 0xff) at++;
    const marker = bytes[at++];
    if (marker === undefined) return null;
    if (standsAlone(marker)) continue;
    // Stuffing, a second start, the end, or the scan, past which a frame's size is not read.
    if (marker === 0x00 || marker === 0xd8 || marker === 0xd9 || marker === 0xda) return null;
    if (at + 2 > bytes.length) return null;
    const length = view.getUint16(at);
    if (length < 2) return null;
    if (isJpegFrame(marker)) {
      if (length < 8 || at + 7 > bytes.length) return null;
      return { type: "image/jpeg", height: view.getUint16(at + 3), width: view.getUint16(at + 5) };
    }
    at += length;
  }
  return null;
}

const RASTER_NAME = /\.(png|jpe?g|gif|webp)$/i;

export type FilePreviewState =
  | {
      readonly kind: "image";
      readonly commit: string;
      readonly width: number | null;
      readonly height: number | null;
    }
  | { readonly kind: "image-too-large" };

/**
 * What a file's page does with it as an image, or null to go on as any other
 * file. Bytes that came inline decide, whatever the name. A larger file is
 * not read here, so its name decides whether the page tries, and the preview
 * route checks the bytes.
 */
export function previewOf(
  contents: Pick<
    Extract<Contents, { type: "file" }>,
    "encoding" | "content" | "size" | "download_url"
  >,
  path: string,
): FilePreviewState | null {
  const commit = commitOf(contents.download_url);
  if (commit === null) return null;
  if (contents.encoding === "none")
    return contents.size <= IMAGE_MAX_BYTES && RASTER_NAME.test(path)
      ? { kind: "image", commit, width: null, height: null }
      : null;
  // The start first: most files are text, and this keeps them from being decoded twice.
  const start = bytesOfBase64(contents.content.slice(0, (SIGNATURE_BYTES / 3) * 4));
  if (!hasSignature(start)) return null;
  const raster = sniffRaster(bytesOfBase64(contents.content));
  if (!raster) return null;
  return raster.width * raster.height > IMAGE_MAX_PIXELS
    ? { kind: "image-too-large" }
    : { kind: "image", commit, width: raster.width, height: raster.height };
}

/**
 * A file's bytes as an image. The trailing slash keeps a name ending in
 * `.data` from reading as React Router's data request, which only a
 * navigation is redirected out of.
 */
export const previewUrl = (repoPage: string, commit: string, path: string): string =>
  `${repoPage}/preview/${encodeURIComponent(commit)}/${encodePath(path)}/`;
