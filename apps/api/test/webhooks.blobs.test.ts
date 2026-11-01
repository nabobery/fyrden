// The repository object's store of webhook capture blobs: each kept once,
// until a day after the latest deadline of an event that names it; read only
// while the event is still the repository's; pruned a bounded slice at a time.
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { Metrics } from "@fyrden/adapters-cloudflare/obs";
import { uniqueId } from "@fyrden/testing";
import { beforeEach, describe, expect, it } from "vitest";
import type { RepoDO } from "../src/do/RepoDO.js";
import { RepoWebhookBlobs, WEBHOOK_BLOB_GRACE_MS } from "../src/do/repo/webhook-blobs.js";
import { captureTree } from "../src/webhooks/capture.js";
import { api, json, user } from "./helpers/api.js";

let stub: DurableObjectStub<RepoDO>;

beforeEach(async () => {
  const owner = await user();
  const repo = (
    await json<{ id: string }>(api("POST", "/user/repos", owner.token, { name: uniqueId("r") }))
  ).body;
  stub = env.REPO.getByName(repo.id);
});

const blobsOf = (texts: string[]) => captureTree({ texts }).blobs;

/** What the store holds: hash to retain_until. */
const held = () =>
  runInDurableObject(stub, (_, state) =>
    Object.fromEntries(
      state.storage.sql
        .exec<{ hash: string; retain_until: number }>(
          "SELECT hash, retain_until FROM webhook_blobs",
        )
        .toArray()
        .map((row) => [row.hash, row.retain_until]),
    ),
  );

/** The repository's current restore and ownership generations. */
const gens = () =>
  runInDurableObject(stub, async (instance) => {
    await instance.checkEpoch();
    return {
      epochGen: instance.events.epochGen(),
      ownerGen: instance.events.account()?.ownerGen ?? 0,
    };
  });

describe("webhook capture blobs", () => {
  it("keep each blob once, until a day past the latest deadline naming it, written only when that moves", async () => {
    const blobs = blobsOf(["a".repeat(2_000), "b".repeat(3_000)]);
    const [a = "", b = ""] = blobs.keys();
    const deadline = Date.now() + 7 * 86_400_000;
    const written = (until: number) =>
      runInDurableObject(stub, (instance, state) =>
        state.storage.transactionSync(() => instance.webhookBlobStore.store(blobs, until)),
      );
    expect(await written(deadline)).toBeGreaterThan(0);
    expect(await held()).toEqual({
      [a]: deadline + WEBHOOK_BLOB_GRACE_MS,
      [b]: deadline + WEBHOOK_BLOB_GRACE_MS,
    });
    // An equal or earlier deadline writes nothing; a later one moves both.
    expect(await written(deadline)).toBe(0);
    expect(await written(deadline - 1_000)).toBe(0);
    expect(await written(deadline + 1_000)).toBeGreaterThan(0);
    expect((await held())[a]).toBe(deadline + 1_000 + WEBHOOK_BLOB_GRACE_MS);
  });

  it("are read only while the event is still the repository's, and say which are missing", async () => {
    const blobs = blobsOf(["c".repeat(2_000)]);
    const [c = ""] = blobs.keys();
    await runInDurableObject(stub, (instance, state) =>
      state.storage.transactionSync(() =>
        instance.webhookBlobStore.store(blobs, Date.now() + 86_400_000),
      ),
    );
    const now = await gens();
    expect(await stub.webhookBlobs({ hashes: [c], ...now })).toEqual({
      texts: { [c]: blobs.get(c)?.json },
    });
    expect(await stub.webhookBlobs({ hashes: [c, "0".repeat(40)], ...now })).toEqual({
      missing: "absent",
    });
    expect(
      await stub.webhookBlobs({ hashes: [c], epochGen: now.epochGen - 1, ownerGen: now.ownerGen }),
    ).toEqual({ missing: "restored" });
    expect(
      await stub.webhookBlobs({ hashes: [c], epochGen: now.epochGen, ownerGen: now.ownerGen + 1 }),
    ).toEqual({ missing: "transferred" });
  });

  it("are pruned past their time a bounded slice at a time, the next time kept", async () => {
    const old = blobsOf(Array.from({ length: 3 }, (_, i) => `${i}`.repeat(2_000)));
    const later = blobsOf(["z".repeat(2_000)]);
    const day = 86_400_000;
    const now = Date.now();
    await runInDurableObject(stub, (instance, state) =>
      state.storage.transactionSync(() => {
        instance.webhookBlobStore.store(old, now + day);
        instance.webhookBlobStore.store(later, now + 10 * day);
      }),
    );
    const prune = () =>
      runInDurableObject(stub, (instance) => instance.webhookBlobStore.prune(now + 3 * day, 2));
    expect(await prune()).toMatchObject({ pruned: 2 });
    expect(await prune()).toEqual({ pruned: 1, nextAt: now + 10 * day + WEBHOOK_BLOB_GRACE_MS });
    expect(Object.keys(await held())).toEqual([...later.keys()]);
  });

  it("are pruned by the job the store sets, from the alarm with nothing else to do", async () => {
    const old = blobsOf(Array.from({ length: 3 }, (_, i) => `old${i}`.repeat(500)));
    await runInDurableObject(stub, (instance, state) =>
      state.storage.transactionSync(() =>
        instance.webhookBlobStore.store(old, Date.now() - 2 * WEBHOOK_BLOB_GRACE_MS),
      ),
    );
    for (let i = 0; i < 5 && Object.keys(await held()).length > 0; i++)
      await runDurableObjectAlarm(stub);
    expect(await held()).toEqual({});
  });

  it("cost what they cost: rows written for a new blob, a reuse, an extension and a collection", async () => {
    const costs = await runInDurableObject(stub, (instance, state) => {
      let written = 0;
      const metrics = {
        count(name: string, _dimensions: Record<string, string>, value = 1) {
          if (name === "do.rows_written") written += value;
        },
      } as unknown as Metrics;
      const store = new RepoWebhookBlobs({ git: instance.git, metrics, pruneAt: () => {} });
      const blobs = blobsOf(["d".repeat(2_000)]);
      const measured = (run: () => unknown) => {
        written = 0;
        state.storage.transactionSync(run);
        return written;
      };
      return {
        created: measured(() => store.store(blobs, 1_000)),
        reused: measured(() => store.store(blobs, 1_000)),
        earlier: measured(() => store.store(blobs, 500)),
        extended: measured(() => store.store(blobs, 2_000)),
        collected: measured(() => store.prune(Number.MAX_SAFE_INTEGER, 10)),
      };
    });
    // Measured: the row and its index entry; nothing when its time does not move.
    expect(costs).toEqual({ created: 2, reused: 0, earlier: 0, extended: 2, collected: 1 });
  });
});
