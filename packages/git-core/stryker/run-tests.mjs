// Stryker's test command: runs Vitest with the given arguments under a
// private TMPDIR and removes it afterwards. With --bail a failing run stops
// before the tests' cleanup hooks, and the git sandboxes they made (several
// MB each) would otherwise pile up in the system temp directory, once per
// mutant. A run Stryker kills on timeout cannot clean up, so each run also
// removes directories of earlier runs that are over an hour old.
//
// It also caps the run's memory. Stryker stops a mutant only on time, and
// some mutants allocate without bound (a growth condition mutated to `true`
// doubles typed arrays on every call): within seconds they exhaust the
// machine, and a CI runner dies with them. The run gets its own process
// group; when the group's resident memory passes FYRDEN_MUTANT_MAX_RSS_MB
// (default 3072) it is killed, and the mutant counts as detected.
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PREFIX = "fyrden-mutant-";
const STALE_MS = 60 * 60 * 1000;
const MAX_RSS_MB = Number(process.env.FYRDEN_MUTANT_MAX_RSS_MB) || 3072;
const POLL_MS = 100;

for (const name of readdirSync(tmpdir())) {
  if (!name.startsWith(PREFIX)) continue;
  const path = join(tmpdir(), name);
  try {
    if (Date.now() - statSync(path).mtimeMs > STALE_MS)
      rmSync(path, { recursive: true, force: true });
  } catch {
    // Another run removed it first.
  }
}

/** Resident memory of every process in group `pgid`, in MB (`ps` reports KB, on Linux and macOS). */
function groupRssMb(pgid) {
  let total = 0;
  for (const line of execFileSync("ps", ["-A", "-o", "pgid=,rss="], { encoding: "utf8" }).split(
    "\n",
  )) {
    const [group, rss] = line.trim().split(/\s+/);
    if (Number(group) === pgid) total += Number(rss) || 0;
  }
  return total / 1024;
}

const dir = mkdtempSync(join(tmpdir(), PREFIX));
const child = spawn("npx", ["vitest", "run", "--root", ".", ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, TMPDIR: dir },
  detached: true,
});
const killGroup = () => {
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // Already gone.
  }
};
// Stryker kills a timed-out run's process tree by parent pid (tree-kill),
// which reaches this group too. A SIGTERM or Ctrl-C takes the group along.
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    killGroup();
    rmSync(dir, { recursive: true, force: true });
    process.exit(1);
  });
}

let overLimit = 0;
const watch = setInterval(() => {
  let rss;
  try {
    rss = groupRssMb(child.pid);
  } catch {
    return; // ps failed this once; the next poll tries again.
  }
  if (rss > MAX_RSS_MB) {
    overLimit = rss;
    killGroup();
  }
}, POLL_MS);

const status = await new Promise((resolve) => {
  child.on("error", () => resolve(1));
  child.on("close", (code) => resolve(code ?? 1));
});
clearInterval(watch);
killGroup(); // Anything the run left behind in its group.
rmSync(dir, { recursive: true, force: true });
if (overLimit > 0) {
  console.error(
    `run-tests: killed the test run at ${Math.round(overLimit)} MB, over the ${MAX_RSS_MB} MB limit (FYRDEN_MUTANT_MAX_RSS_MB)`,
  );
  process.exit(1);
}
process.exit(status);
