import { concatBytes, copyBytes, latin1Bytes } from "./bytes.js";
import { isDotGitName } from "./dotgit.js";
import { type FsckMessageId, GitObjectError, issue, type Parsed } from "./fsck.js";
import { isZeroOid, OID_BYTES, type Oid, oidFromBytes } from "./oid.js";

/** The modes git writes. Anything else in a tree is legacy or broken. */
export const FILE_MODES = {
  file: 0o100644,
  executable: 0o100755,
  symlink: 0o120000,
  tree: 0o40000,
  gitlink: 0o160000,
} as const;

const STANDARD_MODES = new Set<number>(Object.values(FILE_MODES));
/** Early git honoured group-write; fsck accepts it unless strict. */
const LEGACY_GROUP_WRITABLE = 0o100664;
/** git's fsck `max_tree_entry_len` default. */
const MAX_NAME_BYTES = 4096;
const SPACE = 0x20;
const SLASH = 0x2f;
const DOT = 0x2e;

export interface TreeEntry {
  /** The mode as git reads it: octal text truncated to 16 bits. */
  readonly mode: number;
  /** Raw bytes: git does not require names to be UTF-8. */
  readonly name: Uint8Array;
  readonly oid: Oid;
}

export function isTreeMode(mode: number): boolean {
  return (mode & 0o170000) === 0o40000;
}

/**
 * Parses a tree object's body. Throws `GitObjectError("badTree")` when the
 * entries cannot be read (git's `decode_tree_entry`), and otherwise returns
 * every entry with the findings of git's `fsck_tree`, each reported once.
 */
export function parseTree(body: Uint8Array): Parsed<TreeEntry[]> {
  const entries: TreeEntry[] = [];
  const found = new Set<FsckMessageId>();
  const dfCandidates: Uint8Array[] = [];
  let previous: TreeEntry | undefined;
  let offset = 0;
  while (offset < body.length) {
    const entryStart = offset;
    const space = body.indexOf(SPACE, offset);
    if (space <= offset) throw badTree("malformed mode in tree entry");
    let mode = 0;
    for (let i = offset; i < space; i++) {
      const digit = (body[i] as number) - 0x30;
      if (digit < 0 || digit > 7) throw badTree("malformed mode in tree entry");
      // git keeps the mode in 16 bits, so "1100644" reads as 100644.
      mode = (mode * 8 + digit) & 0xffff;
    }
    const nul = body.indexOf(0, space + 1);
    if (nul < 0 || nul + 1 + OID_BYTES > body.length) throw badTree("too-short tree object");
    if (nul === space + 1) throw badTree("empty filename in tree entry");
    const entry: TreeEntry = {
      mode,
      name: copyBytes(body, space + 1, nul),
      oid: oidFromBytes(body, nul + 1),
    };
    offset = nul + 1 + OID_BYTES;

    const { name } = entry;
    if (isZeroOid(entry.oid)) found.add("nullSha1");
    if (name.includes(SLASH)) found.add("fullPathname");
    if (name.length === 1 && name[0] === DOT) found.add("hasDot");
    if (name.length === 2 && name[0] === DOT && name[1] === DOT) found.add("hasDotdot");
    if (isDotGitName(name)) found.add("hasDotgit");
    if (body[entryStart] === 0x30) found.add("zeroPaddedFilemode");
    if (name.length > MAX_NAME_BYTES) found.add("largePathname");
    if (!STANDARD_MODES.has(mode) && mode !== LEGACY_GROUP_WRITABLE) found.add("badFilemode");
    if (previous) {
      const order = verifyOrdered(previous, entry, dfCandidates);
      if (order === "unordered") found.add("treeNotSorted");
      if (order === "duplicate") found.add("duplicateEntries");
    }
    previous = entry;
    entries.push(entry);
  }
  return { value: entries, issues: REPORT_ORDER.filter((id) => found.has(id)).map(issue) };
}

/**
 * A tree's entries one at a time, in stored order, without fsck checks or
 * copies (names and ids are views into `body`): for listing large trees in
 * bounded memory. Throws `GitObjectError("badTree")` at the first entry
 * that cannot be read, as `parseTree` does.
 */
export function* treeEntries(body: Uint8Array): Generator<TreeEntry> {
  let offset = 0;
  while (offset < body.length) {
    const space = body.indexOf(SPACE, offset);
    if (space <= offset) throw badTree("malformed mode in tree entry");
    let mode = 0;
    for (let i = offset; i < space; i++) {
      const digit = (body[i] as number) - 0x30;
      if (digit < 0 || digit > 7) throw badTree("malformed mode in tree entry");
      mode = (mode * 8 + digit) & 0xffff;
    }
    const nul = body.indexOf(0, space + 1);
    if (nul < 0 || nul + 1 + OID_BYTES > body.length) throw badTree("too-short tree object");
    if (nul === space + 1) throw badTree("empty filename in tree entry");
    offset = nul + 1 + OID_BYTES;
    yield {
      mode,
      name: body.subarray(space + 1, nul),
      oid: body.subarray(nul + 1, offset) as Oid,
    };
  }
}

/** The order git's fsck_tree reports its findings in. */
const REPORT_ORDER: readonly FsckMessageId[] = [
  "nullSha1",
  "fullPathname",
  "hasDot",
  "hasDotdot",
  "hasDotgit",
  "zeroPaddedFilemode",
  "badFilemode",
  "duplicateEntries",
  "treeNotSorted",
  "largePathname",
];

function badTree(detail: string): GitObjectError {
  return new GitObjectError("badTree", `cannot be parsed as a tree (${detail})`);
}

const isLessThanSlash = (c: number) => c > 0 && c < SLASH;

/**
 * git's `verify_ordered`: entries are in path order, where a directory sorts
 * as if its name ended in '/'. A file and a directory of the same name can be
 * separated by other entries ("foo", "foo.bar", "foo/"), so file names that
 * could still collide are kept on a stack.
 */
function verifyOrdered(
  a: TreeEntry,
  b: TreeEntry,
  candidates: Uint8Array[],
): "ok" | "unordered" | "duplicate" {
  const length = Math.min(a.name.length, b.name.length);
  for (let i = 0; i < length; i++) {
    const d = (a.name[i] as number) - (b.name[i] as number);
    if (d < 0) return "ok";
    if (d > 0) return "unordered";
  }
  let c1 = a.name[length] ?? 0;
  let c2 = b.name[length] ?? 0;
  if (c1 === 0 && c2 === 0) return "duplicate";
  if (c1 === 0 && isTreeMode(a.mode)) c1 = SLASH;
  if (c2 === 0 && isTreeMode(b.mode)) c2 = SLASH;
  if (c1 === 0 && isLessThanSlash(c2)) {
    candidates.push(a.name);
  } else if (c2 === SLASH && isLessThanSlash(c1)) {
    for (let file = candidates.pop(); file; file = candidates.pop()) {
      if (!startsWith(b.name, file)) continue;
      const next = b.name[file.length] ?? 0;
      if (next === 0) return "duplicate";
      if (isLessThanSlash(next)) {
        candidates.push(file);
        break;
      }
    }
  }
  return c1 < c2 ? "ok" : "unordered";
}

function startsWith(name: Uint8Array, prefix: Uint8Array): boolean {
  if (prefix.length > name.length) return false;
  for (let i = 0; i < prefix.length; i++) if (name[i] !== prefix[i]) return false;
  return true;
}

/** git's tree order: bytewise, with a directory's name compared as if it ended in '/'. */
export function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const length = Math.min(a.name.length, b.name.length);
  for (let i = 0; i < length; i++) {
    const d = (a.name[i] as number) - (b.name[i] as number);
    if (d !== 0) return d;
  }
  const c1 = a.name[length] ?? (isTreeMode(a.mode) ? SLASH : 0);
  const c2 = b.name[length] ?? (isTreeMode(b.mode) ? SLASH : 0);
  return c1 - c2;
}

/**
 * Encodes entries as git writes a tree: sorted, with canonical mode text.
 * Refuses what git would not write: a non-standard mode, an empty name or
 * one containing '/' or NUL, or two entries with the same name.
 */
export function encodeTree(entries: readonly TreeEntry[]): Uint8Array<ArrayBuffer> {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Uint8Array[] = [];
  let total = 0;
  const names = new Set<string>();
  for (const { mode, name, oid } of sorted) {
    if (!STANDARD_MODES.has(mode))
      throw new RangeError(`not a mode git writes: ${mode.toString(8)}`);
    if (name.length === 0 || name.includes(SLASH) || name.includes(0)) {
      throw new RangeError("a tree entry name must be non-empty, without '/' or NUL");
    }
    const key = name.join(",");
    if (names.has(key)) throw new RangeError("duplicate tree entry name");
    names.add(key);
    const modeText = latin1Bytes(`${mode.toString(8)} `);
    const part = new Uint8Array(modeText.length + name.length + 1 + OID_BYTES);
    part.set(modeText, 0);
    part.set(name, modeText.length);
    part.set(oid, modeText.length + name.length + 1);
    parts.push(part);
    total += part.length;
  }
  return concatBytes(parts, total);
}
