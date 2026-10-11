import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PackWriter } from "../../src/ports/pack-store.js";
import { bytesBody, readPushBody } from "../../src/receive-pack/body.js";
import { planPush } from "../../src/receive-pack/commands.js";
import { finalizePush } from "../../src/receive-pack/finalize.js";
import { PushIndexer } from "../../src/receive-pack/indexer.js";
import { encodePushResponse } from "../../src/receive-pack/report.js";
import { createGitSandbox, type GitSandbox } from "../../testing/git-cli.js";
import { buildRepo, packObjects } from "../pack/repo-fixture.js";
import { type MemoryServer, memoryServer, reportLines, request } from "./support.js";

/*
 * Resumable indexing: the job checkpoints after every phase; a new job
 * resumed from the last checkpoint (a Durable Object evicted mid-index)
 * finishes the push, even when the eviction hit in the middle of a phase.
 * Refs move only at the commit after indexing, and the client gets its
 * report.
 */

let sandbox: GitSandbox;
let first: Uint8Array;
let second: Uint8Array;
let tips: { old: string; tip: string };

beforeAll(async () => {
  sandbox = await createGitSandbox();
  await buildRepo(sandbox, { seed: 3, commits: 10, files: 3, binaryBytes: 2000 });
  const rev = async (r: string) => (await sandbox.git(["rev-parse", r])).stdout.trim();
  tips = { old: await rev("main~4"), tip: await rev("main") };
  first = request(
    [{ new: tips.old, ref: "refs/heads/main" }],
    await packObjects(sandbox, { revs: ["main~4"] }),
  );
  // A thin pack, so every phase has work (including the completion pack).
  second = request(
    [{ old: tips.old, new: tips.tip, ref: "refs/heads/main" }],
    await packObjects(sandbox, { thin: true, revs: ["main", "^main~4"] }),
  );
});
afterAll(() => sandbox.dispose());

async function seeded(): Promise<MemoryServer> {
  const server = memoryServer();
  expect((await server.push(first)).lines).toEqual(["unpack ok", "ok refs/heads/main"]);
  return server;
}

const hex = (b: Uint8Array | undefined) => (b ? Buffer.from(b).toString("hex") : undefined);

describe("push.resumable-indexing", () => {
  it("resumes from every checkpoint in a new job and moves the ref only at the end", async () => {
    const server = await seeded();
    const body = bytesBody(second);
    const { request: req, packOffset } = await readPushBody(body, { pushOptionsAdvertised: true });
    const plan = planPush(req, await server.refStore.readRefs());
    let cursor = PushIndexer.start({ uploadId: "u1", packOffset, plan }).checkpoint();
    const phases: string[] = [];
    for (;;) {
      // Every step runs in a fresh job, as after an eviction.
      const job = PushIndexer.resume(cursor);
      if (job.phase === "done") break;
      phases.push(job.phase);
      await job.step(await server.indexEnv(), body);
      cursor = job.checkpoint();
      expect(hex((await server.refStore.readRefs()).refs.get("refs/heads/main"))).toBe(tips.old);
    }
    expect(phases).toEqual(["parse", "completion", "connect", "graph"]);
    const outcome = PushIndexer.resume(cursor).outcome();
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.packs).toHaveLength(2);
    const result = await finalizePush(plan, outcome, "u1", server.finalizeEnv());
    expect(
      reportLines(encodePushResponse(result.report, plan.capabilities, result.messages)),
    ).toEqual(["unpack ok", "ok refs/heads/main"]);
    expect(hex((await server.refStore.readRefs()).refs.get("refs/heads/main"))).toBe(tips.tip);
  });

  it("reruns a phase interrupted in the middle", async () => {
    const server = await seeded();
    const body = bytesBody(second);
    const { request: req, packOffset } = await readPushBody(body, { pushOptionsAdvertised: true });
    const plan = planPush(req, await server.refStore.readRefs());
    const env = await server.indexEnv();
    // The first received-pack writer dies after one write: an eviction mid-parse.
    let writers = 0;
    const crashing = {
      ...env,
      beginPack: (): PackWriter => {
        const inner = env.beginPack("received");
        if (++writers > 1) return inner;
        return {
          packId: inner.packId,
          write: async () => {
            throw new Error("evicted");
          },
          finish: () => inner.finish(),
          abort: () => inner.abort(),
        };
      },
    };
    const job = PushIndexer.start({ uploadId: "u2", packOffset, plan });
    const before = job.checkpoint();
    await expect(job.step(crashing, body)).rejects.toThrow("evicted");
    // A new instance continues from the last checkpoint.
    const resumed = PushIndexer.resume(before);
    const outcome = await resumed.run(crashing, body);
    expect(outcome.ok).toBe(true);
    expect(writers).toBe(3); // crashed received, received again, completion
    const result = await finalizePush(plan, outcome, "u2", server.finalizeEnv());
    expect(result.uploadCommitted).toBe(true);
    expect(hex((await server.refStore.readRefs()).refs.get("refs/heads/main"))).toBe(tips.tip);
  });

  it("refuses a cursor it did not write", () => {
    expect(() => PushIndexer.resume(new Uint8Array([1, 2, 3]))).toThrow(RangeError);
    const cursor = PushIndexer.start({
      uploadId: "u",
      packOffset: 0,
      plan: {
        commands: [],
        capabilities: {
          reportStatus: true,
          reportStatusV2: false,
          sideband: false,
          quiet: false,
          atomic: false,
          agent: undefined,
        },
        pushOptions: [],
        shallow: [],
        expectsPack: true,
        messages: [],
      },
    }).checkpoint();
    expect(() => PushIndexer.resume(cursor.subarray(0, cursor.length - 1))).toThrow(RangeError);
    const future = cursor.slice();
    future[4] = 99;
    expect(() => PushIndexer.resume(future)).toThrow(/version 99/);
  });
});
