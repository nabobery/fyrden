import { execFile } from "node:child_process";
import { promisify } from "node:util";

/** The commit a deploy is made from, and whether the working tree differs from it. */
export interface SourceState {
  /** Undefined outside a git checkout. */
  commit: string | undefined;
  /** Any change git does not ignore, new files included. */
  dirty: boolean;
}

/** Appended to the commit a deploy records when the working tree had changes. */
export const DIRTY_SUFFIX = "-dirty";

/** The commit a deploy records outside a git checkout. */
export const UNKNOWN_COMMIT = "unknown";

/** FYRDEN_COMMIT's value: the commit, marked when the tree was dirty, or "unknown". */
export function commitLabel(source: SourceState): string {
  if (source.commit === undefined) return UNKNOWN_COMMIT;
  return source.dirty ? `${source.commit}${DIRTY_SUFFIX}` : source.commit;
}

const run = promisify(execFile);

export async function readSource(repoRoot: string): Promise<SourceState> {
  let commit: string;
  try {
    commit = (await run("git", ["rev-parse", "HEAD"], { cwd: repoRoot })).stdout.trim();
  } catch {
    return { commit: undefined, dirty: false };
  }
  const { stdout } = await run("git", ["status", "--porcelain"], { cwd: repoRoot });
  return { commit, dirty: stdout.trim() !== "" };
}
