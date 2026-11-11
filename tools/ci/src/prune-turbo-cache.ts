// Keeps only the Turbo cache entries this job's runs used, so the archive CI
// restores and saves again stays one run's size instead of growing with
// every run. CI runs it before saving the cache:
//   node tools/ci/src/prune-turbo-cache.ts <cache-dir> <runs-dir>
// The runs directory holds the run summaries Turbo writes when
// TURBO_RUN_SUMMARY=true; each lists the hash of every task it ran or replayed.
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const HASH = /^[0-9a-f]{16}$/;
/** Turbo 2.11's local cache: an archive, its metadata and its manifest a task hash. */
const ENTRY = /^([0-9a-f]{16})(?:\.tar\.zst|-meta\.json|-manifest\.json)$/;

/** Every task hash in the run summaries; throws on a summary of another shape. */
export function usedHashes(summaries: readonly unknown[]): Set<string> {
  const hashes = new Set<string>();
  for (const summary of summaries) {
    const tasks = (summary as { tasks?: unknown } | null)?.tasks;
    if (!Array.isArray(tasks)) throw new Error("a run summary without a tasks list");
    for (const task of tasks) {
      const hash = (task as { hash?: unknown } | null)?.hash;
      if (typeof hash !== "string" || !HASH.test(hash))
        throw new Error(`a run summary task without a task hash: ${JSON.stringify(task)}`);
      hashes.add(hash);
    }
  }
  return hashes;
}

/** The cache entries no used hash names. Files of any other name are left alone. */
export function unusedEntries(fileNames: readonly string[], used: ReadonlySet<string>): string[] {
  return fileNames.filter((name) => {
    const hash = ENTRY.exec(name)?.[1];
    return hash !== undefined && !used.has(hash);
  });
}

/** Removes the unused entries from `cacheDir`; a job that ran no Turbo task is a mistake. */
export function pruneTurboCache(
  cacheDir: string,
  runsDir: string,
): { kept: number; removed: number } {
  const summaryFiles = readdirSync(runsDir).filter((name) => name.endsWith(".json"));
  if (summaryFiles.length === 0)
    throw new Error(`no Turbo run summaries in ${runsDir}; was TURBO_RUN_SUMMARY set?`);
  const used = usedHashes(
    summaryFiles.map((name) => JSON.parse(readFileSync(join(runsDir, name), "utf8")) as unknown),
  );
  const entries = readdirSync(cacheDir);
  const unused = unusedEntries(entries, used);
  for (const name of unused) rmSync(join(cacheDir, name));
  return { kept: entries.length - unused.length, removed: unused.length };
}

if (import.meta.main) {
  const [cacheDir, runsDir] = process.argv.slice(2);
  if (!cacheDir || !runsDir) {
    console.error("usage: prune-turbo-cache.ts <cache-dir> <runs-dir>");
    process.exit(2);
  }
  const { kept, removed } = pruneTurboCache(cacheDir, runsDir);
  console.log(`Turbo cache: kept ${kept} files, removed ${removed} unused`);
}
