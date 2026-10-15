import type { Hunk } from "./hunks.js";
import { type Lines, lineAt } from "./text.js";

/*
 * Unified diff output. A patch is bytes: the repository's lines exactly as
 * stored, so `git apply` rebuilds the file whatever its encoding. Text for
 * display decodes it as UTF-8, keeping a byte order mark and showing an
 * invalid sequence as U+FFFD. Hunk headers carry no function context.
 * File headers follow git's format, with paths quoted as `core.quotePath`
 * documents it (git-config(1)): a path with a control character, `"`,
 * `\` or a byte of 0x80 or more is written in double quotes, C-style
 * escapes for the control characters with one, octal for the rest.
 */

const encoder = new TextEncoder();
const display = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });
const NO_NEWLINE = encoder.encode("\n\\ No newline at end of file\n");

/** A hunk range as unified diffs write it: `start` alone for one line, else `start,count`. */
function range(start: number, count: number): string {
  return count === 1 ? `${start}` : `${start},${count}`;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Hunks as patch bytes, each line exactly as stored. */
export function formatHunks(hunks: readonly Hunk[], oldLines: Lines, newLines: Lines): Uint8Array {
  const parts: Uint8Array[] = [];
  const prefix = { " ": encoder.encode(" "), "-": encoder.encode("-"), "+": encoder.encode("+") };
  for (const hunk of hunks) {
    parts.push(
      encoder.encode(
        `@@ -${range(hunk.oldStart, hunk.oldLines)} +${range(hunk.newStart, hunk.newLines)} @@\n`,
      ),
    );
    for (const line of hunk.lines) {
      const bytes = lineAt(line.kind === "+" ? newLines : oldLines, line.index);
      parts.push(prefix[line.kind], bytes);
      if (bytes[bytes.length - 1] !== 0x0a) parts.push(NO_NEWLINE);
    }
  }
  return concat(parts);
}

/** Patch bytes as text to show: UTF-8, a byte order mark kept, an invalid sequence as U+FFFD. */
export function patchText(patch: Uint8Array): string {
  return display.decode(patch);
}

const ESCAPES: Record<number, string> = {
  7: "\\a",
  8: "\\b",
  9: "\\t",
  10: "\\n",
  11: "\\v",
  12: "\\f",
  13: "\\r",
  34: '\\"',
  92: "\\\\",
};

const needsQuoting = (byte: number) =>
  byte < 0x20 || byte === 0x22 || byte === 0x5c || byte >= 0x7f;

/** `prefix` and `path` as a patch header writes them: quoted when the path needs it. */
export function quotePath(prefix: string, path: Uint8Array): string {
  if (!path.some(needsQuoting)) return prefix + String.fromCharCode(...path);
  let out = `"${prefix}`;
  for (const byte of path) {
    if (!needsQuoting(byte)) out += String.fromCharCode(byte);
    else out += ESCAPES[byte] ?? `\\${byte.toString(8).padStart(3, "0")}`;
  }
  return `${out}"`;
}

export type FileStatus = "added" | "removed" | "modified" | "renamed" | "copied" | "changed";

/** One file of a diff, as its header needs it. */
export interface FileHeader {
  readonly status: FileStatus;
  /** Path bytes; null for the side that does not exist. */
  readonly oldPath: Uint8Array | null;
  readonly newPath: Uint8Array | null;
  /** Octal modes as git writes them (`100644`); null for the side that does not exist. */
  readonly oldMode: string | null;
  readonly newMode: string | null;
  /** Hex blob ids; null for the side that does not exist. */
  readonly oldOid: string | null;
  readonly newOid: string | null;
  /** For a rename or copy: the share of the content kept, 0-100. */
  readonly similarity?: number;
  readonly binary?: boolean;
}

const ZERO = "0".repeat(7);
const short = (oid: string | null) => (oid ? oid.slice(0, 7) : ZERO);

/** The kind of file a mode names: regular (either permission), symlink, submodule. */
function kindOf(mode: string | null): string | null {
  return mode === null ? null : mode.startsWith("100") ? "file" : mode;
}

/**
 * A file's header lines (ASCII), ending before its hunks, or with git's
 * line for a binary change. A file that changes kind (a regular file
 * becoming a symlink) is no single change to git: write it as a removal,
 * then an addition, each with its own header. Throws RangeError for one.
 */
export function formatFileHeader(file: FileHeader): string {
  if (
    file.status !== "added" &&
    file.status !== "removed" &&
    kindOf(file.oldMode) !== kindOf(file.newMode)
  )
    throw new RangeError(
      `${file.oldMode} to ${file.newMode} changes the file's kind: write a removal and an addition`,
    );
  const a = file.oldPath ?? (file.newPath as Uint8Array);
  const b = file.newPath ?? (file.oldPath as Uint8Array);
  let out = `diff --git ${quotePath("a/", a)} ${quotePath("b/", b)}\n`;
  if (file.status === "added") out += `new file mode ${file.newMode}\n`;
  else if (file.status === "removed") out += `deleted file mode ${file.oldMode}\n`;
  else if (file.oldMode !== file.newMode)
    out += `old mode ${file.oldMode}\nnew mode ${file.newMode}\n`;
  if (file.status === "renamed" || file.status === "copied") {
    const verb = file.status === "renamed" ? "rename" : "copy";
    out += `similarity index ${file.similarity ?? 100}%\n${verb} from ${quotePath("", a)}\n${verb} to ${quotePath("", b)}\n`;
  }
  if (file.oldOid !== file.newOid) {
    const mode =
      file.status !== "added" && file.status !== "removed" && file.oldMode === file.newMode
        ? ` ${file.newMode}`
        : "";
    out += `index ${short(file.oldOid)}..${short(file.newOid)}${mode}\n`;
    const from =
      file.oldPath === null || file.status === "added" ? "/dev/null" : quotePath("a/", a);
    const to =
      file.newPath === null || file.status === "removed" ? "/dev/null" : quotePath("b/", b);
    if (file.binary) out += `Binary files ${from} and ${to} differ\n`;
    else out += `--- ${from}\n+++ ${to}\n`;
  }
  return out;
}
