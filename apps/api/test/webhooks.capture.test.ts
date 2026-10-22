// What a webhook capture keeps inline and what it stores once by content:
// every long text value becomes a reference to a blob named by the hash of
// its JSON encoding (lossless), resolved back exactly when the body is made.
import { Sha1 } from "@fyrden/git-core";
import { describe, expect, it, vi } from "vitest";
import {
  BLOB_FALLBACK_MIN_BYTES,
  BLOB_MIN_BYTES,
  type BlobRef,
  captureTree,
  INLINE_MAX_BYTES,
  refsOf,
  resolveTree,
} from "../src/webhooks/capture.js";

const bytesOf = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

describe("a webhook capture", () => {
  it("keeps short values inline and stores each long text once, shared by every place it appears", () => {
    const body = "b".repeat(5_000);
    const captured = captureTree({
      issue: { number: 1, title: "Short", body },
      changes: { body: { from: body } },
      labels: [{ id: 1, name: "bug" }],
    });
    const ref = (captured.tree as { issue: { body: BlobRef } }).issue.body;
    expect(ref).toEqual({ $blob: expect.stringMatching(/^[0-9a-f]{40}$/), bytes: bytesOf(body) });
    expect((captured.tree as { changes: { body: { from: BlobRef } } }).changes.body.from).toEqual(
      ref,
    );
    expect(captured.blobs.size).toBe(1);
    expect(captured.blobBytes).toBe(bytesOf(body));
    expect((captured.tree as { issue: { title: string } }).issue.title).toBe("Short");
    expect(refsOf(captured.tree)).toEqual([ref]);
    // Resolved, it is exactly what was captured.
    const texts = new Map([...captured.blobs].map(([hash, blob]) => [hash, blob.json]));
    expect(resolveTree(captured.tree, texts)).toEqual({
      issue: { number: 1, title: "Short", body },
      changes: { body: { from: body } },
      labels: [{ id: 1, name: "bug" }],
    });
  });

  it("names distinct strings distinctly, lone surrogates included, and keeps them exactly", () => {
    const a = "\ud800".repeat(BLOB_MIN_BYTES);
    const b = "\ud801".repeat(BLOB_MIN_BYTES);
    const captured = captureTree({ a, b });
    const refs = refsOf(captured.tree);
    expect(refs).toHaveLength(2);
    expect(refs[0]?.$blob).not.toBe(refs[1]?.$blob);
    const texts = new Map([...captured.blobs].map(([hash, blob]) => [hash, blob.json]));
    expect(resolveTree(captured.tree, texts)).toEqual({ a, b });
  });

  it("stays within its inline bound, storing shorter values too when long values alone would not", () => {
    // 100 labels with descriptions of 100 characters that each escape to 6 bytes.
    const labels = Array.from({ length: 100 }, (_, id) => ({
      id,
      name: `label-${id}-${"n".repeat(40)}`,
      description: "\u0000".repeat(100),
    }));
    const captured = captureTree({ labels });
    expect(bytesOf(captured.tree)).toBeLessThanOrEqual(INLINE_MAX_BYTES);
    expect(captured.blobs.size).toBeGreaterThan(0);
    const texts = new Map([...captured.blobs].map(([hash, blob]) => [hash, blob.json]));
    expect(resolveTree(captured.tree, texts)).toEqual({ labels });
  });

  it("refuses to resolve a missing blob or one of another size", () => {
    const captured = captureTree({ body: "x".repeat(4_096) });
    expect(() => resolveTree(captured.tree, new Map())).toThrow(/missing/);
    const [hash = ""] = captured.blobs.keys();
    expect(() => resolveTree(captured.tree, new Map([[hash, JSON.stringify("y")]]))).toThrow(
      /size/,
    );
  });

  it("says when its structure and short values alone are over the inline bound, every longer text stored", () => {
    const xs = Array.from({ length: 1_200 }, (_, i) => `${i}`.padEnd(61, "x"));
    const long = "l".repeat(BLOB_FALLBACK_MIN_BYTES);
    const captured = captureTree({ xs, long });
    expect(captured.inlineBytes).toBe(bytesOf(captured.tree));
    expect(captured.inlineBytes).toBeGreaterThan(INLINE_MAX_BYTES);
    expect(refsOf(captured.tree)).toHaveLength(1);
    expect(captureTree({ long }).inlineBytes).toBe(bytesOf({ long }));
  });

  it("encodes and hashes each text once, across the captures of a mutation too", () => {
    const update = vi.spyOn(Sha1.prototype, "update");
    try {
      const body = "h".repeat(70_000);
      const labels = Array.from({ length: 100 }, (_, id) => ({ id, description: "d".repeat(700) }));
      const cache = new Map();
      // Over the bound at first: the second pass hashes only what the first had not.
      captureTree({ body, changes: { body: { from: body } }, labels }, cache);
      captureTree({ issue: { body } }, cache);
      const hashed = update.mock.calls.reduce((sum, [bytes]) => sum + bytes.length, 0);
      expect(hashed).toBe(bytesOf(body) + bytesOf("d".repeat(700)));
    } finally {
      update.mockRestore();
    }
  });

  it("is over the inline bound with too many references alone, and says so", () => {
    const captured = captureTree({
      xs: Array.from({ length: 1_100 }, (_, i) => `${i}`.repeat(1_024)),
    });
    expect(captured.inlineBytes).toBe(bytesOf(captured.tree));
    expect(captured.inlineBytes).toBeGreaterThan(INLINE_MAX_BYTES);
  });

  it("holds only JSON values: nothing serializing would change", () => {
    const refused = [
      { at: new Date(0) },
      { v: { toJSON: () => "x".repeat(70_000) } },
      { n: Number.NaN },
      { u: undefined },
    ];
    for (const tree of refused) expect(() => captureTree(tree as never)).toThrow(/JSON|finite/);
  });

  it("refuses an object that would read as a reference", () => {
    expect(() => captureTree({ field: { $blob: "0".repeat(40), bytes: 1, extra: "x" } })).toThrow(
      /\$blob/,
    );
    expect(refsOf({ field: { $blob: "0".repeat(40), bytes: 1, extra: "x" } })).toEqual([]);
    const inherited = Object.assign(Object.create({ $blob: "0".repeat(40), bytes: 3 }), {
      a: 1,
      b: 2,
    });
    expect(refsOf(inherited)).toEqual([]);
  });
});
