// The attempt mark on the run's row: written, then waited on until the
// storage is durable, before a slice does any work, so a slice that dies
// leaves it for the next request to find. Whether it survives a real reset
// isn't tested here: in this harness ctx.abort() fails the test with an error
// no code can catch, and abortAllDurableObjects() stops the test worker.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { oidFromHex } from "@fyrden/git-core";
import { uniqueId } from "@fyrden/testing";
import { describe, expect, it } from "vitest";
import { MemoryAttemptLedger, RunRowAttemptLedger } from "../src/do/repo/blame-attempts.js";
import { BlameRuns } from "../src/do/repo/blame-runs.js";

const key = {
  commit: oidFromHex("1".repeat(40)),
  path: "f.txt",
  engineVersion: 1,
  epochGen: 0,
};

/** A fresh repository object with one run; its id. */
async function withRun(): Promise<{ stub: DurableObjectStub; runId: string }> {
  const stub = env.REPO.getByName(uniqueId("repo"));
  const runId = await runInDurableObject(
    stub,
    (_, state) => new BlameRuns(state.storage).create(key, 1_000, new Set()).row.runId,
  );
  return { stub, runId };
}

describe("RunRowAttemptLedger", () => {
  it("counts as the memory ledger does, and peeks without counting", async () => {
    const { stub, runId } = await withRun();
    const steps: [string, number][] = [
      ["begin", 0],
      ["begin", 0],
      ["peek", 0],
      ["begin", 1],
      ["peek", 0],
      ["clear", 0],
      ["peek", 1],
      ["begin", 1],
    ];
    const run = (ledger: MemoryAttemptLedger | RunRowAttemptLedger) =>
      (async () => {
        const out: number[] = [];
        for (const [step, generation] of steps) {
          if (step === "begin") out.push(await ledger.begin(runId, generation));
          else if (step === "peek") out.push(ledger.peek(runId, generation));
          else ledger.clear(runId);
        }
        return out;
      })();
    const fromRows = await runInDurableObject(stub, (_, state) =>
      run(new RunRowAttemptLedger(new BlameRuns(state.storage), state.storage)),
    );
    expect(fromRows).toEqual(await run(new MemoryAttemptLedger()));
    expect(fromRows).toEqual([1, 2, 2, 1, 0, 0, 1]);
  });

  it("writes the mark, then resolves only once the write is durable", async () => {
    const { stub, runId } = await withRun();
    const order = await runInDurableObject(stub, async (_, state) => {
      const events: string[] = [];
      let finishSync!: () => void;
      const storage = {
        sync: () => {
          events.push(`sync after mark ${new BlameRuns(state.storage).peekAttempt(runId, 0)}`);
          return new Promise<void>((resolve) => {
            finishSync = resolve;
          });
        },
      };
      const begun = new RunRowAttemptLedger(new BlameRuns(state.storage), storage)
        .begin(runId, 0)
        .then((n) => events.push(`begun ${n}`));
      await Promise.resolve();
      events.push("still waiting");
      finishSync();
      await begun;
      return events;
    });
    expect(order).toEqual(["sync after mark 1", "still waiting", "begun 1"]);
  });
});
