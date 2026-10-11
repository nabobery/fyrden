// Storage support for the push path: writing an upload's preallocated pack
// (again, after an interrupted attempt), a completion pack in the upload's
// pack unit, the upload's recorded commands and indexing cursor, packs a
// push never wrote, and running one named job outside the alarm.
import { env } from "cloudflare:workers";
import type { Oid } from "@fyrden/git-core";
import { describe, expect, it } from "vitest";
import { createDoMemoryBudget, indexJobId, JobQueue } from "../../src/git/index.js";
import type { GitStorageContext } from "../../src/git/sql.js";
import { inProbe, newProbe } from "./harness.js";

const oid = (n: number) => new Uint8Array(20).fill(n) as Oid;

const uploadInput = (networkId: string) => ({
  networkId,
  principal: "usr_push",
  tokenId: "tok_push",
  commands: [],
  atomic: false,
  withPack: true,
  ttlMs: 60 * 60 * 1000,
  leaseTtlMs: 10 * 60 * 1000,
});

describe("push storage support", () => {
  it("writes an upload's preallocated pack, and writes it again after an interrupted attempt", async () => {
    const { stub, networkId } = await newProbe();
    const result = await inProbe(stub, async ({ git }) => {
      const upload = git.uploads.begin(uploadInput(networkId));
      const packId = upload.packId as NonNullable<typeof upload.packId>;
      const first = git.packStore.rewritePack(packId);
      await first.write(new Uint8Array([1, 2, 3]));
      await first.finish();
      const afterFirst = git.registry.get(packId)?.state;
      // The attempt died after finishing: the next attempt starts the pack over.
      const second = git.packStore.rewritePack(packId);
      const reset = git.registry.get(packId)?.state;
      await second.write(new Uint8Array([4, 5]));
      await second.abort();
      const aborted = git.registry.get(packId)?.state;
      const third = git.packStore.rewritePack(packId);
      await third.write(new Uint8Array([6, 7, 8, 9]));
      const info = await third.finish();
      const bytes = await git.packStore.openRange(packId, 0, 4);
      return { packId, afterFirst, reset, aborted, info, bytes, key: upload.r2Key };
    });
    expect(result).toMatchObject({
      afterFirst: "indexing",
      reset: "pending",
      aborted: "discarded",
      info: { packId: result.packId, bytes: 4 },
    });
    expect([...result.bytes]).toEqual([6, 7, 8, 9]);
    expect((await env.GIT.head(result.key as string))?.size).toBe(4);
  });

  it("refuses to rewrite a pack that is indexed, live or unknown", async () => {
    const { stub, networkId } = await newProbe();
    const errors = await inProbe(stub, async ({ git }) => {
      const upload = git.uploads.begin(uploadInput(networkId));
      const packId = upload.packId as NonNullable<typeof upload.packId>;
      const writer = git.packStore.rewritePack(packId);
      await writer.write(new Uint8Array([1]));
      await writer.finish();
      git.uploads.markBodyStored(upload.uploadId);
      git.uploads.markIndexed(upload.uploadId, { deps: [] });
      const out: string[] = [];
      for (const id of [packId, "01J0000000000000000000000Z"]) {
        try {
          git.packStore.rewritePack(id as typeof packId);
          out.push("ok");
        } catch (error) {
          out.push((error as Error).message);
        }
      }
      return out;
    });
    expect(errors[0]).toMatch(/cannot be written again/);
    expect(errors[1]).toMatch(/cannot be written again/);
  });

  it("starts a completion pack in the upload's pack unit", async () => {
    const { stub, networkId } = await newProbe();
    const row = await inProbe(stub, async ({ git }) => {
      const upload = git.uploads.begin(uploadInput(networkId));
      const writer = git.packStore.beginUnitPack({
        kind: "completion",
        unitId: upload.uploadId,
        uploadId: upload.uploadId,
      });
      await writer.write(new Uint8Array([1]));
      await writer.finish();
      const pack = git.registry.get(writer.packId);
      return {
        pack,
        unit: git.registry.unitOf(pack as NonNullable<typeof pack>).map((p) => p.packId),
        upload,
      };
    });
    expect(row.pack).toMatchObject({
      kind: "completion",
      unitId: row.upload.uploadId,
      uploadId: row.upload.uploadId,
      state: "indexing",
    });
    expect(row.unit.sort()).toEqual([row.upload.packId, row.pack?.packId].sort());
  });

  it("records the body as stored without touching the pack, and keeps commands and cursor", async () => {
    const { stub, networkId } = await newProbe();
    const result = await inProbe(stub, async ({ git }) => {
      const upload = git.uploads.begin(uploadInput(networkId));
      const stored = git.uploads.markBodyStored(upload.uploadId);
      const again = git.uploads.markBodyStored(upload.uploadId);
      const recorded = git.uploads.recordCommands(upload.uploadId, { v: 1, refs: ["a"] });
      git.uploads.saveCursor(upload.uploadId, new Uint8Array([9, 8, 7]));
      const cursor = git.uploads.cursorOf(upload.uploadId);
      git.uploads.saveCursor(upload.uploadId, null);
      return {
        stored,
        again,
        recorded,
        state: git.uploads.get(upload.uploadId)?.state,
        pack: git.registry.get(upload.packId as string)?.state,
        commands: git.uploads.commandsOf(upload.uploadId),
        cursor: cursor && [...cursor],
        cleared: git.uploads.cursorOf(upload.uploadId),
        missing: git.uploads.commandsOf("01J0000000000000000000000Z"),
      };
    });
    expect(result).toEqual({
      stored: true,
      again: false,
      recorded: true,
      state: "indexing",
      pack: "pending",
      commands: { v: 1, refs: ["a"] },
      cursor: [9, 8, 7],
      cleared: null,
      missing: undefined,
    });
  });

  it("commits an upload whose received pack was empty (never written) with its completion-free unit", async () => {
    const { stub, networkId } = await newProbe();
    const result = await inProbe(stub, async ({ git }) => {
      // A base commit, live, for the new ref to point at.
      const base = git.uploads.begin(uploadInput(networkId));
      const baseWriter = git.packStore.rewritePack(base.packId as NonNullable<typeof base.packId>);
      await baseWriter.write(new Uint8Array([1]));
      await baseWriter.finish();
      git.uploads.markBodyStored(base.uploadId);
      git.uploads.markIndexed(base.uploadId, { deps: [] });
      const first = git.refStore.commitSync({
        addPacks: [],
        removePacks: [],
        refUpdates: [{ name: "refs/heads/main", oldOid: null, newOid: oid(1) }],
        expectedVersion: 0,
        uploadId: base.uploadId,
      });
      // The second push sends an empty pack: its writer aborts.
      const upload = git.uploads.begin(uploadInput(networkId));
      git.uploads.markBodyStored(upload.uploadId);
      const writer = git.packStore.rewritePack(upload.packId as NonNullable<typeof upload.packId>);
      await writer.abort();
      const indexed = git.uploads.markIndexed(upload.uploadId, {
        deps: [base.packId as NonNullable<typeof base.packId>],
      });
      const second = git.refStore.commitSync({
        addPacks: [],
        removePacks: [],
        refUpdates: [{ name: "refs/heads/other", oldOid: null, newOid: oid(1) }],
        expectedVersion: 1,
        uploadId: upload.uploadId,
      });
      return {
        first,
        indexed,
        second,
        upload: git.uploads.get(upload.uploadId)?.state,
        pack: git.registry.get(upload.packId as string)?.state,
        live: (await git.packStore.listPacks()).map((p) => p.packId),
        basePack: base.packId,
      };
    });
    expect(result.first).toEqual({ ok: true, version: 1 });
    expect(result.indexed).toBe(true);
    expect(result.second).toEqual({ ok: true, version: 2 });
    expect(result.upload).toBe("committed");
    expect(result.pack).toBe("discarded");
    expect(result.live).toEqual([result.basePack]);
  });

  it("leaves a discarded completion attempt out of the unit, at the commit and when the unit is compacted", async () => {
    const { stub, networkId } = await newProbe();
    const result = await inProbe(stub, async ({ git }) => {
      const upload = git.uploads.begin(uploadInput(networkId));
      git.uploads.markBodyStored(upload.uploadId);
      const received = git.packStore.rewritePack(
        upload.packId as NonNullable<typeof upload.packId>,
      );
      await received.write(new Uint8Array([1]));
      await received.finish();
      const completion = () =>
        git.packStore.beginUnitPack({
          kind: "completion",
          unitId: upload.uploadId,
          uploadId: upload.uploadId,
        });
      // The first completion writer fails and is discarded; the retry succeeds.
      const failed = completion();
      await failed.write(new Uint8Array([2]));
      await failed.abort();
      const retried = completion();
      await retried.write(new Uint8Array([3]));
      await retried.finish();
      git.uploads.markIndexed(upload.uploadId, { deps: [] });
      const commit = git.refStore.commitSync({
        addPacks: [],
        removePacks: [],
        refUpdates: [{ name: "refs/heads/main", oldOid: null, newOid: oid(1) }],
        expectedVersion: 0,
        uploadId: upload.uploadId,
      });
      // A tail merge compacts the unit's live packs into one.
      const merged = git.packStore.beginPack();
      await merged.write(new Uint8Array([4]));
      await merged.finish();
      const compact = git.refStore.commitSync({
        addPacks: [merged.packId],
        removePacks: [upload.packId as NonNullable<typeof upload.packId>, retried.packId],
        refUpdates: [],
        expectedVersion: 1,
      });
      const state = (id: string) => git.registry.get(id)?.state;
      return {
        commit,
        compact,
        states: [upload.packId as string, failed.packId, retried.packId, merged.packId].map(state),
      };
    });
    expect(result.commit).toEqual({ ok: true, version: 1 });
    expect(result.compact).toEqual({ ok: true, version: 2 });
    expect(result.states).toEqual(["superseded", "discarded", "superseded", "live"]);
  });

  it("runs one named job now, and never while another run holds it", async () => {
    const { stub } = await newProbe();
    const result = await inProbe(stub, async ({ git }) => {
      const clock = { now: 1_000_000 };
      const context: GitStorageContext = { ...git.context, now: () => clock.now };
      const alarms: number[] = [];
      const policy = { leaseMs: 1_000, maxAttempts: 3, backoffMs: 100, memoryRetryMs: 500 };
      const jobs = new JobQueue(context, (at) => alarms.push(at), policy);
      const id = indexJobId("01J00000000000000000000000");
      // Scheduled for later; runJob runs it now anyway.
      jobs.ensure("index", id, { runAt: clock.now + 60_000 });
      const slices: string[] = [];
      let nested: unknown;
      const memory = createDoMemoryBudget(1024);
      const ran = await jobs.runJob(
        id,
        {
          async runSlice(job) {
            slices.push(job.jobId);
            // A second runner meanwhile finds the job taken.
            nested = await jobs.runJob(id, { runSlice: async () => ({ done: true }) }, memory, 0);
            clock.now += 10;
            return slices.length < 3 ? { done: false, cursor: null } : { done: true };
          },
        },
        memory,
        clock.now + 15,
      );
      const afterDeadline = jobs.get(id);
      const finished = await jobs.runJob(
        id,
        { runSlice: async () => ({ done: true }) },
        memory,
        clock.now + 1_000,
      );
      const unknown = await jobs.runJob(
        "index:none",
        { runSlice: async () => ({ done: true }) },
        memory,
        clock.now + 1_000,
      );
      return {
        ran,
        nested,
        slices: slices.length,
        afterDeadline: afterDeadline?.state,
        finished,
        state: jobs.get(id)?.state,
        unknown,
        alarms: alarms.length > 0,
      };
    });
    // Two slices fit before the deadline; the job is queued again for the alarm.
    expect(result).toEqual({
      ran: { slices: 2, state: "queued" },
      nested: { slices: 0, state: "busy" },
      slices: 2,
      afterDeadline: "queued",
      finished: { slices: 1, state: "done" },
      state: "done",
      unknown: { slices: 0, state: "missing" },
      alarms: true,
    });
  });
});
