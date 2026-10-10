#!/usr/bin/env node
// Runs the package's Vitest suite twice with shuffled file and test order and
// different seeds, so a test that depends on another test's state fails here
// instead of flaking later. Usage: fyrden-shuffle-guard [extra vitest args]
import { spawnSync } from "node:child_process";
import { randomInt } from "node:crypto";

const runs = Number(process.env.SHUFFLE_RUNS ?? 3);
for (let i = 0; i < runs; i++) {
  const seed = randomInt(1, 2 ** 31 - 1);
  console.log(`shuffle-guard: run ${i + 1}/${runs}, seed ${seed}`);
  const result = spawnSync(
    "vitest",
    [
      "run",
      "--sequence.shuffle.files",
      "--sequence.shuffle.tests",
      `--sequence.seed=${seed}`,
      ...process.argv.slice(2),
    ],
    { stdio: "inherit", shell: false },
  );
  if (result.status !== 0) {
    console.error(
      `shuffle-guard: failed with seed ${seed}; rerun with --sequence.seed=${seed} to reproduce`,
    );
    process.exit(result.status ?? 1);
  }
}
