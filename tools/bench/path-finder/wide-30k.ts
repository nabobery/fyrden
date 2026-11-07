// The declared workload of a repository's path list, frozen: 30,000 files
// across 600 directories, three levels deep, 30 bytes a path on average. No
// clock or randomness, so a tree's bytes are the same on every run. Its files
// in one directory share a blob, and each directory has its own, so all 600
// trees differ (a tree read once in a slice is not read again) while a test
// builds few objects. Blob contents are never read to list paths.

const TOP = 5;
const MIDDLE = 7;
const LEAF = 16;
const FILES_PER_DIRECTORY = 50;

export interface Wide30kDirectory {
  /** From the root, with no trailing slash. */
  readonly path: string;
  /** Its files' names. */
  readonly files: readonly string[];
  /** Its directories' names. */
  readonly directories: readonly string[];
}

const pad = (n: number) => String(n).padStart(2, "0");
const files = Array.from({ length: FILES_PER_DIRECTORY }, (_, i) => `f-${pad(i)}.txt`);
const range = (count: number) => Array.from({ length: count }, (_, i) => i);

/** Every directory but the root, parents before their children. */
export function wide30kDirectories(): Wide30kDirectory[] {
  const out: Wide30kDirectory[] = [];
  for (const g of range(TOP)) {
    const group = `group-${g}`;
    out.push({
      path: group,
      files,
      directories: range(MIDDLE).map((s) => `sub-${pad(s)}`),
    });
    for (const s of range(MIDDLE)) {
      const sub = `${group}/sub-${pad(s)}`;
      out.push({
        path: sub,
        files,
        directories: range(LEAF).map((l) => `leaf-${pad(l)}`),
      });
      for (const l of range(LEAF))
        out.push({ path: `${sub}/leaf-${pad(l)}`, files, directories: [] });
    }
  }
  return out;
}

/** The root's directories. */
export const WIDE_30K_ROOT: readonly string[] = range(TOP).map((g) => `group-${g}`);
