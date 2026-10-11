/**
 * Names that a checkout on HFS+ or NTFS would treat as `.gitmodules`,
 * `.gitattributes`, `.gitignore` or `.mailmap`, ported from git v2.53.0
 * (`is_hfs_dot_generic` in utf8.c, `is_ntfs_dot_generic` in path.c,
 * verified). The tree checks of the push policy use them: a symbolic link
 * under such a name, and the contents of a `.gitmodules` blob, are checked
 * as `git fsck` checks them.
 *
 * `.git` itself is `isDotGitName` in the object model (`hasDotgit`).
 */

export type SpecialFile = "gitmodules" | "gitattributes" | "gitignore" | "mailmap";

/** The NTFS 8.3 fallback short-name prefixes git derives for each name (path.c). */
const NTFS_SHORT_PREFIX: Record<SpecialFile, string> = {
  gitmodules: "gi7eba",
  gitattributes: "gi7d29",
  gitignore: "gi250a",
  mailmap: "maba30",
};

/** Whether `name` (one tree entry name) refers to `.<file>` on HFS+ or NTFS. */
export function isSpecialName(name: Uint8Array, file: SpecialFile): boolean {
  return isHfsDot(name, file) || isNtfsDot(name, 0, file);
}

/**
 * Whether NTFS would read `name` as `.<file>`, from byte `start`. git checks
 * `.gitmodules` again after every backslash in a name (NTFS reads it as a
 * separator); callers do that.
 */
export function isNtfsDot(name: Uint8Array, start: number, file: SpecialFile): boolean {
  const at = (i: number) => name[start + i] ?? 0;
  const lower = (c: number) => (c >= 0x41 && c <= 0x5a ? c | 0x20 : c);
  const onlySpacesAndPeriods = (from: number): boolean => {
    for (let i = from; ; i++) {
      const c = at(i);
      if (c === 0 || c === 0x3a) return true;
      if (c !== 0x20 && c !== 0x2e) return false;
    }
  };
  const ascii = (i: number, text: string) => lower(at(i)) === text.charCodeAt(0);
  // ".gitmodules" in any case, then only spaces and periods up to the end or ':'.
  if (at(0) === 0x2e && matchesIgnoreCase(name, start + 1, file)) {
    return onlySpacesAndPeriods(file.length + 1);
  }
  // The regular short name: the first six letters, then "~1" to "~4".
  if (matchesIgnoreCase(name, start, file.slice(0, 6)) && at(6) === 0x7e) {
    const digit = at(7);
    if (digit >= 0x31 && digit <= 0x34) return onlySpacesAndPeriods(8);
  }
  // The fallback short name: a hash-derived prefix, then '~' and digits.
  const prefix = NTFS_SHORT_PREFIX[file];
  let sawTilde = false;
  for (let i = 0; i < 8; i++) {
    const c = at(i);
    if (c === 0) return false;
    if (sawTilde) {
      if (c < 0x30 || c > 0x39) return false;
    } else if (c === 0x7e) {
      i++;
      const d = at(i);
      if (d < 0x31 || d > 0x39) return false;
      sawTilde = true;
    } else if (i >= 6) {
      return false;
    } else if (c & 0x80) {
      return false;
    } else if (!ascii(i, prefix.charAt(i))) {
      return false;
    }
  }
  return onlySpacesAndPeriods(8);
}

/** `strncasecmp(name + at, text, text.length) == 0` for an ASCII `text`. */
function matchesIgnoreCase(name: Uint8Array, at: number, text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = name[at + i];
    if (c === undefined) return false;
    const folded = c >= 0x41 && c <= 0x5a ? c | 0x20 : c;
    if (folded !== text.charCodeAt(i)) return false;
  }
  return true;
}

/** Code points HFS+ ignores when comparing names (utf8.c `next_hfs_char`). */
const HFS_IGNORABLE = new Set([
  0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x206a, 0x206b, 0x206c,
  0x206d, 0x206e, 0x206f, 0xfeff,
]);

function isHfsDot(name: Uint8Array, file: SpecialFile): boolean {
  const reader = { offset: 0 };
  if (nextHfsChar(name, reader) !== 0x2e) return false;
  for (let i = 0; i < file.length; i++) {
    const c = nextHfsChar(name, reader);
    if (c > 127) return false;
    const folded = c >= 0x41 && c <= 0x5a ? c | 0x20 : c;
    if (folded !== file.charCodeAt(i)) return false;
  }
  const c = nextHfsChar(name, reader);
  // is_dir_sep outside Windows: '/'.
  return c === 0 || c === 0x2f;
}

/** The next code point, skipping HFS ignorables; 0 at the end or on invalid UTF-8. */
function nextHfsChar(name: Uint8Array, reader: { offset: number }): number {
  for (;;) {
    const c = pickOneUtf8Char(name, reader);
    if (c < 0) return 0;
    if (!HFS_IGNORABLE.has(c)) return c;
  }
}

/**
 * git's `pick_one_utf8_char`: one code point, or -1 for invalid UTF-8
 * (overlong forms, surrogates, U+FFFE and U+FFFF included); 0 at the end.
 */
function pickOneUtf8Char(s: Uint8Array, reader: { offset: number }): number {
  const i = reader.offset;
  const b0 = s[i];
  if (b0 === undefined) return 0;
  const b1 = s[i + 1] ?? 0;
  const b2 = s[i + 2] ?? 0;
  const b3 = s[i + 3] ?? 0;
  const cont = (b: number) => (b & 0xc0) === 0x80;
  let ch: number;
  let length: number;
  if (b0 < 0x80) {
    ch = b0;
    length = 1;
  } else if ((b0 & 0xe0) === 0xc0) {
    if (!cont(b1) || (b0 & 0xfe) === 0xc0) return -1;
    ch = ((b0 & 0x1f) << 6) | (b1 & 0x3f);
    length = 2;
  } else if ((b0 & 0xf0) === 0xe0) {
    if (
      !cont(b1) ||
      !cont(b2) ||
      (b0 === 0xe0 && (b1 & 0xe0) === 0x80) ||
      (b0 === 0xed && (b1 & 0xe0) === 0xa0) ||
      (b0 === 0xef && b1 === 0xbf && (b2 & 0xfe) === 0xbe)
    ) {
      return -1;
    }
    ch = ((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f);
    length = 3;
  } else if ((b0 & 0xf8) === 0xf0) {
    if (
      !cont(b1) ||
      !cont(b2) ||
      !cont(b3) ||
      (b0 === 0xf0 && (b1 & 0xf0) === 0x80) ||
      (b0 === 0xf4 && b1 > 0x8f) ||
      b0 > 0xf4
    ) {
      return -1;
    }
    ch = ((b0 & 0x07) << 18) | ((b1 & 0x3f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f);
    length = 4;
  } else {
    return -1;
  }
  if (i + length > s.length) return -1;
  reader.offset = i + length;
  return ch;
}
