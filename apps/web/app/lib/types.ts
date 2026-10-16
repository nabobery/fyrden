/**
 * Repositories as the pages read them: the API's own shapes, from its
 * contract (types only: nothing of it is in the browser's bundle).
 */

import type { getContents, getRepo, listCommits, listRepos, Output } from "@fyrden/api-contract";

export type Repo = Output<typeof getRepo>;

/** A page of the signed-in user's repositories. */
export type ReposPage = Output<typeof listRepos>;

/** What a path names: a directory page, a file, a symlink or a submodule. */
export type Contents = Output<typeof getContents>;
export type Entry = Extract<Contents, { type: "dir" }>["entries"][number];

/** A page of a branch's history. */
export type CommitsPage = Output<typeof listCommits>;

/**
 * `path` without its trailing slashes. A loop, not /\/+$/: that regex is
 * quadratic on many slashes that do not end the string, and a route's
 * decoded path can carry thousands.
 */
export function withoutTrailingSlashes(path: string): string {
  let end = path.length;
  while (end > 0 && path.charCodeAt(end - 1) === 0x2f) end--;
  return path.slice(0, end);
}

/** A repository path's segments, each encoded for a URL (slashes kept). */
export const encodePath = (path: string): string =>
  path
    .split("/")
    .filter((s) => s !== "")
    .map(encodeURIComponent)
    .join("/");

/** Base64 to text (UTF-8), or undefined for bytes that are not text. */
export function decodeText(base64: string): string | undefined {
  const bytes = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
  if (bytes.includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** Text to base64 (UTF-8). */
export function encodeText(text: string): string {
  const bytes = new TextEncoder().encode(text);
  // A chunk at a time: a string grown a byte at a time holds millions of pieces.
  const chunks: string[] = [];
  for (let at = 0; at < bytes.length; at += 0x8000)
    chunks.push(String.fromCharCode(...bytes.subarray(at, at + 0x8000)));
  return btoa(chunks.join(""));
}
