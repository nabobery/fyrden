import { execFile, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { gitBinary } from "../../testing/git-cli.js";

const run = promisify(execFile);

const ENV = {
  PATH: process.env.PATH ?? "",
  HOME: "/nonexistent",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};

export interface Changed {
  /** Lines of each side that the oracle marks changed, from 1. */
  readonly old: number[];
  readonly new: number[];
}

/**
 * The oracle's alignment of two files, by `git diff --no-index --text -U0`:
 * the same as blame's on every pair compared, and far cheaper to ask. Each
 * call has its own two files under `dir`.
 */
export async function diffChanged(
  dir: string,
  name: string,
  oldBytes: string,
  newBytes: string,
): Promise<Changed> {
  const a = join(dir, `${name}.a`);
  const b = join(dir, `${name}.b`);
  await writeFile(a, Buffer.from(oldBytes, "latin1"));
  await writeFile(b, Buffer.from(newBytes, "latin1"));
  let stdout: string;
  try {
    ({ stdout } = await run(gitBinary, ["diff", "--no-index", "--text", "-U0", a, b], {
      env: ENV,
      encoding: "latin1",
      maxBuffer: 256 * 1024 * 1024,
    }));
  } catch (error) {
    const failed = error as { code?: number; stdout?: string };
    if (failed.code !== 1) throw error;
    stdout = failed.stdout ?? "";
  }
  const changed: Changed = { old: [], new: [] };
  for (const match of stdout.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    const [, oldAt, oldCount, newAt, newCount] = match;
    for (let k = 0; k < Number(oldCount ?? 1); k++) changed.old.push(Number(oldAt) + k);
    for (let k = 0; k < Number(newCount ?? 1); k++) changed.new.push(Number(newAt) + k);
  }
  return changed;
}

/**
 * The same answers for many pairs at once, through one `fast-import` and one
 * `diff-tree`: about 10,000 pairs a second, where a process a pair is 100.
 */
export function batchChanged(pairs: readonly (readonly [string, string])[]): Changed[] {
  const dir = mkdtempSync(join(tmpdir(), "fyrden-blame-batch-"));
  try {
    const init = spawnSync(gitBinary, ["init", "-q", "--bare", dir], { env: ENV });
    if (init.status !== 0) throw new Error(`git init failed: ${init.status}`);
    const stream: Buffer[] = [];
    const inline = (text: string) => {
      const bytes = Buffer.from(text, "latin1");
      stream.push(Buffer.from(`data ${bytes.length}\n`), bytes, Buffer.from("\n"));
    };
    const WHO = "committer t <t@t> 0 +0000\ndata 0\n";
    pairs.forEach(([old, new_], k) => {
      stream.push(
        Buffer.from(
          `commit refs/heads/p\nmark :${2 * k + 1}\n${WHO}deleteall\nM 100644 inline f\n`,
        ),
      );
      inline(old);
      stream.push(
        Buffer.from(
          `commit refs/heads/p\nmark :${2 * k + 2}\n${WHO}from :${2 * k + 1}\ndeleteall\nM 100644 inline f\n`,
        ),
      );
      inline(new_);
    });
    const marksFile = join(dir, "marks");
    const imported = spawnSync(
      gitBinary,
      ["fast-import", "--quiet", "--force", `--export-marks=${marksFile}`],
      { cwd: dir, env: ENV, input: Buffer.concat(stream), maxBuffer: 1 << 30 },
    );
    if (imported.status !== 0) throw new Error(`git fast-import failed: ${imported.status}`);
    const children = new Map<string, number>();
    for (const row of readFileSync(marksFile, "latin1").trim().split("\n")) {
      const [mark, oid] = row.split(" ") as [string, string];
      const number = Number(mark.slice(1));
      if (number % 2 === 0) children.set(oid, number / 2 - 1);
    }
    const diffed = spawnSync(
      gitBinary,
      [
        "diff-tree",
        "--stdin",
        "-p",
        "-U0",
        "--text",
        "--no-renames",
        "--no-color",
        "--no-ext-diff",
      ],
      {
        cwd: dir,
        env: ENV,
        input: `${[...children.keys()].join("\n")}\n`,
        encoding: "latin1",
        maxBuffer: 2 ** 31 - 1,
      },
    );
    if (diffed.status !== 0) throw new Error(`git diff-tree failed: ${diffed.status}`);
    const out = pairs.map((): Changed => ({ old: [], new: [] }));
    let current: Changed | undefined;
    for (const line of diffed.stdout.split("\n")) {
      const at = children.get(line);
      if (at !== undefined) {
        current = out[at];
        continue;
      }
      const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (hunk && current) {
        for (let k = 0; k < Number(hunk[2] ?? 1); k++) current.old.push(Number(hunk[1]) + k);
        for (let k = 0; k < Number(hunk[4] ?? 1); k++) current.new.push(Number(hunk[3]) + k);
      }
    }
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** For each new line, the old line it's unchanged from, or -1, by the oracle's changed lines. */
export function oldOfNewFrom(changed: Changed, newLines: number): Int32Array {
  const newChanged = new Set(changed.new);
  const oldChanged = new Set(changed.old);
  const out = new Int32Array(newLines);
  let oldLine = 1;
  for (let line = 1; line <= newLines; line++) {
    if (newChanged.has(line)) {
      out[line - 1] = -1;
      continue;
    }
    while (oldChanged.has(oldLine)) oldLine++;
    out[line - 1] = oldLine - 1;
    oldLine++;
  }
  return out;
}

export const tempDir = () => mkdtemp(join(tmpdir(), "fyrden-blame-vectors-"));
export const removeDir = (dir: string) => rm(dir, { recursive: true, force: true });

/** `items` through `work`, `limit` at a time, in order. */
export async function pooled<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (next < items.length) {
        const index = next++;
        out[index] = await work(items[index] as T, index);
      }
    }),
  );
  return out;
}
