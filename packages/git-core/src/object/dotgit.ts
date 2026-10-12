/**
 * Names that a checkout would treat as `.git` on HFS+ or NTFS, ported from
 * git's `is_hfs_dotgit` (utf8.c) and `is_ntfs_dotgit` (path.c), v2.53.0.
 * A tree entry with such a name can overwrite a client's repository
 * metadata (CVE-2014-9390).
 */
export function isDotGitName(name: Uint8Array): boolean {
  if (isHfsDotGit(name) || isNtfsDotGit(name, 0)) return true;
  // NTFS also treats a backslash as a path separator.
  for (let i = name.indexOf(0x5c); i >= 0; i = name.indexOf(0x5c, i + 1)) {
    if (isNtfsDotGit(name, i + 1)) return true;
  }
  return false;
}

/** Code points HFS+ ignores when comparing names. */
const HFS_IGNORABLE = new Set([
  0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x206a, 0x206b, 0x206c,
  0x206d, 0x206e, 0x206f, 0xfeff,
]);

function isHfsDotGit(name: Uint8Array): boolean {
  const reader = { offset: 0 };
  if (nextHfsChar(name, reader) !== 0x2e) return false;
  for (const expected of [0x67, 0x69, 0x74]) {
    const c = nextHfsChar(name, reader);
    if (c > 127 || (c | 0x20) !== expected) return false;
  }
  const c = nextHfsChar(name, reader);
  // git's is_dir_sep: '/' outside Windows. Invalid UTF-8 reads as 0 (the end).
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
 * git's `pick_one_utf8_char`: decodes one code point, or returns -1 for
 * invalid UTF-8 (including overlong forms, surrogates, U+FFFE and U+FFFF).
 * Returns 0 at the end of the name.
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
  // A sequence cut off by the end of the name is invalid too.
  if (i + length > s.length) return -1;
  reader.offset = i + length;
  return ch;
}

/** `.git` or `git~1` (any case), then only dots and spaces up to the end, '/', '\\' or ':'. */
function isNtfsDotGit(name: Uint8Array, start: number): boolean {
  const at = (i: number) => name[start + i] ?? 0;
  const lower = (i: number) => at(i) | 0x20;
  let i: number;
  if (at(0) === 0x2e) {
    if (lower(1) !== 0x67 || lower(2) !== 0x69 || lower(3) !== 0x74) return false;
    i = 4;
  } else if (lower(0) === 0x67) {
    if (lower(1) !== 0x69 || lower(2) !== 0x74 || at(3) !== 0x7e || at(4) !== 0x31) return false;
    i = 5;
  } else {
    return false;
  }
  for (; ; i++) {
    const c = at(i);
    if (c === 0 || c === 0x2f || c === 0x5c || c === 0x3a) return true;
    if (c !== 0x2e && c !== 0x20) return false;
  }
}
