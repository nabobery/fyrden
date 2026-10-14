/** The API's shapes the pages read (see @fyrden/api-contract for the full ones). */

export interface Repo {
  id: string;
  owner: string;
  name: string;
  full_name: string;
  description: string | null;
  default_branch: string;
  fork: boolean;
  is_template: boolean;
  stargazers_count: number;
  expires_at: number | null;
}

export interface Entry {
  type: "file" | "dir" | "symlink" | "submodule";
  name: string;
  path: string;
  sha: string;
  size?: number;
}

export type Contents =
  | { type: "dir"; path: string; entries: Entry[]; next_cursor: string | null }
  | {
      type: "file";
      path: string;
      name: string;
      sha: string;
      size: number;
      encoding: "base64" | "none";
      content: string;
      download_url: string;
    }
  | { type: "symlink"; path: string; target: string }
  | { type: "submodule"; path: string; sha: string };

export interface Commit {
  sha: string;
  commit: {
    message: string;
    author: { name: string; email: string; date: string };
    verification: { verified: boolean; reason: string };
  };
}

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
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}
