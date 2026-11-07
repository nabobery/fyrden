import type { CursorName, DiffCursor } from "@fyrden/git-core";

/** Whether two resumable diff positions are the same place. */
export function sameCursor(a: DiffCursor | null, b: DiffCursor | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.enter !== b.enter || a.path.length !== b.path.length) return false;
  return a.path.every((n, i) => {
    const m = b.path[i] as CursorName;
    return (
      n.tree === m.tree &&
      n.name.length === m.name.length &&
      n.name.every((x, k) => x === m.name[k])
    );
  });
}
