// Stryker's test command: runs Vitest with the given arguments under a
// private TMPDIR and removes it afterwards. With --bail a failing run stops
// before the tests' cleanup hooks, and the git sandboxes they made (several
// MB each) would otherwise pile up in the system temp directory, once per
// mutant. A run Stryker kills on timeout cannot clean up, so each run also
// removes directories of earlier runs that are over an hour old.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PREFIX = "fyrden-mutant-";
const STALE_MS = 60 * 60 * 1000;
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

const dir = mkdtempSync(join(tmpdir(), PREFIX));
let status = 1;
try {
  const result = spawnSync("npx", ["vitest", "run", "--root", ".", ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, TMPDIR: dir },
  });
  status = result.status ?? 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(status);
