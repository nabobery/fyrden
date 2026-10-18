// The shared port contract suites, run against the Durable Object SQLite and
// R2 adapters inside workerd. Each port call is forwarded into a probe
// object, because SQLite storage is usable only from inside its own object.
import type { PackId, PackStore, PackWriter, RefStore } from "@fyrden/git-core";
import {
  describeCommitGraphContract,
  describeMemoryBudgetContract,
  describeRepoStoreContract,
} from "@fyrden/git-core/testing";
import { newPackId } from "../../src/git/keys.js";
import { createDoMemoryBudget } from "../../src/git/memory-budget.js";
import { promotePendingCommits } from "../../src/git/sqlite-commit-graph.js";
import { inProbe, newProbe } from "./harness.js";

describeRepoStoreContract("Durable Object SQLite + R2", async () => {
  const { stub } = await newProbe();
  // Pack creation is synchronous in the port, so the proxy names the pack
  // here and starts it in the object before any later call runs.
  let begun: Promise<unknown> = Promise.resolve();
  const call = async <R>(fn: Parameters<typeof inProbe<R>>[1]): Promise<R> => {
    await begun;
    return inProbe(stub, fn);
  };
  const packStore: PackStore = {
    listPacks: () => call((p) => p.git.packStore.listPacks()),
    openRange: (packId, offset, length) =>
      call((p) => p.git.packStore.openRange(packId, offset, length)),
    beginPack(): PackWriter {
      const packId: PackId = newPackId();
      begun = begun.then(() => inProbe(stub, (p) => p.beginPackWithId(packId)));
      return {
        packId,
        // Copied here: the bytes cross into the object when the call runs.
        write: (chunk) => {
          const copy = new Uint8Array(chunk);
          return call((p) => p.writer(packId).write(copy));
        },
        finish: () => call((p) => p.writer(packId).finish()),
        abort: () => call((p) => p.writer(packId).abort()),
      };
    },
  };
  const refStore: RefStore = {
    readRefs: () => call((p) => p.git.refStore.readRefs()),
    readReflog: (name, limit) => call((p) => p.git.refStore.readReflog(name, limit)),
    commit: (request) => call((p) => p.git.refStore.commit(request)),
  };
  return { packStore, refStore };
});

describeCommitGraphContract("Durable Object SQLite", async () => {
  const { stub } = await newProbe();
  return {
    graph: {
      read: (oids, view) => inProbe(stub, (p) => p.git.commitGraph.read(oids, view)),
      insertPending: (uploadId, rows) =>
        inProbe(stub, (p) => p.git.commitGraph.insertPending(uploadId, rows)),
      discardPending: (uploadId) =>
        inProbe(stub, (p) => p.git.commitGraph.discardPending(uploadId)),
    },
    promote: (uploadId) =>
      inProbe(stub, (p) => {
        p.git.context.storage.transactionSync(() => promotePendingCommits(p.git.context, uploadId));
      }),
  };
});

describeMemoryBudgetContract("Durable Object memory pool", async (total) =>
  createDoMemoryBudget(total),
);

describeMemoryBudgetContract("A started operation's memory", async (total) =>
  createDoMemoryBudget(total).begin(total),
);
