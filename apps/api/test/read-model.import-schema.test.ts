// A recovery's import refuses a preserved table whose columns changed since
// it was preserved (a migration applied after the restore that altered it):
// importing its rows would not reproduce them.

import { env } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { describe, expect, it } from "vitest";
import { DEFAULT_ORG_SHARD } from "../src/events/read-model.js";
import { importStep } from "../src/read-model/import.js";
import { pauseReadModel } from "../src/read-model/maintenance.js";
import {
  beginRecovery,
  PreservationMismatch,
  preserveStep,
} from "../src/read-model/preservation.js";

describe("a recovery's import of a table whose columns changed", () => {
  it("is refused before anything of it is written", async () => {
    for (let step = 0; step < 5; step++)
      if ((await pauseReadModel(env, DEFAULT_ORG_SHARD)).phase === "paused") break;
    const id = uniqueId("rcv");
    await beginRecovery(env, DEFAULT_ORG_SHARD, id);
    for (let step = 0; step < 200; step++)
      if ((await preserveStep(env, DEFAULT_ORG_SHARD, id)).done) break;
    // This file's database alone: the first preserved table gains a column.
    await env.ORG_READ.exec("ALTER TABLE consumer_epochs ADD COLUMN extra TEXT");
    await env.DIRECTORY.prepare(
      "UPDATE read_model_recoveries SET stage = 'importing' WHERE recovery_id = ?",
    )
      .bind(id)
      .run();
    await expect(importStep(env, DEFAULT_ORG_SHARD, id)).rejects.toBeInstanceOf(
      PreservationMismatch,
    );
  });
});
