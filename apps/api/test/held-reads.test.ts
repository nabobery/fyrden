// Reads that hold their memory: a tree's hold covers each entry it may
// have, a hold past the object's whole budget refuses the work as too
// large, and every hold is released once the work is done.
import { createDoMemoryBudget } from "@fyrden/adapters-cloudflare/git";
import { encodeTree, type Oid, parseTree } from "@fyrden/git-core";
import { describe, expect, it } from "vitest";
import {
  ReadsTooLargeError,
  TREE_ENTRY_MEMORY_BYTES,
  treeMemoryBytes,
  withHeldReads,
} from "../src/do/repo/held-reads.js";

const enc = new TextEncoder();
const oid = (n: number) => {
  const id = new Uint8Array(20) as Oid;
  id[19] = n;
  return id;
};

/** A flat tree of `count` files with one- to three-byte names, as stored. */
function flatTree(count: number): Uint8Array {
  return encodeTree(
    Array.from({ length: count }, (_, i) => ({
      mode: 0o100644,
      name: enc.encode(String(i)),
      oid: oid(1),
    })),
  );
}

/** A reader of one tree object. */
const readerOf = (bytes: Uint8Array) => ({
  readHeader: async () => ({ type: "tree" as const, size: bytes.length }),
  readObject: async () => ({ type: "tree" as const, bytes }),
});

describe("held reads", () => {
  it("hold for a tree at least the memory each of its entries takes, however short the names", async () => {
    const bytes = flatTree(1_000);
    const memory = createDoMemoryBudget(64 * 1024 * 1024);
    const held: number[] = [];
    const counted = {
      tryReserve: (n: number) => {
        held.push(n);
        return memory.tryReserve(n);
      },
    };
    const limits = { maxTreeBytes: bytes.length, maxReadBytes: bytes.length };
    const entries = await withHeldReads(readerOf(bytes), counted, limits, (reads) =>
      reads.readTree(oid(9)),
    );
    expect(entries).toHaveLength(parseTree(bytes).value.length);
    expect(held).toEqual([treeMemoryBytes(bytes.length)]);
    expect(held[0]).toBeGreaterThanOrEqual(1_000 * TREE_ENTRY_MEMORY_BYTES);
    // Released once the work is done.
    expect(memory.stats().reservedBytes).toBe(0);
  });

  it("refuse a tree whose hold is more than the whole budget as too large, holding nothing", async () => {
    const bytes = flatTree(1_000);
    const memory = createDoMemoryBudget(treeMemoryBytes(bytes.length) - 1);
    const limits = { maxTreeBytes: bytes.length, maxReadBytes: bytes.length };
    await expect(
      withHeldReads(readerOf(bytes), memory, limits, (reads) => reads.readTree(oid(9))),
    ).rejects.toThrow(ReadsTooLargeError);
    expect(memory.stats().reservedBytes).toBe(0);
  });
});
