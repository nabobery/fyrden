import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { fetchObjectKey } from "../../src/git/keys.js";
import { inProbe, newNetworkId, newProbe } from "./harness.js";

const KEY_A = "a".repeat(40);
const KEY_B = "b".repeat(40);

describe("FetchObjectStore (materialised fetch objects)", () => {
  it("writes an object under the network's fetch prefix and finds it again by key", async () => {
    const { stub, networkId } = await newProbe();
    const result = await inProbe(stub, async ({ git }) => {
      const writer = git.fetchObjects.begin(KEY_A);
      await writer.write(new TextEncoder().encode("framed pack bytes"));
      const info = await writer.finish();
      const row = git.registry.get(info.packId);
      const found = await git.fetchObjects.find(KEY_A);
      const missing = await git.fetchObjects.find(KEY_B);
      const bytes = await git.packStore.openRange(info.packId, 0, info.bytes);
      const lease = git.leases.grant("read", [info.packId], "clone-1", 60_000);
      return { info, row, found, missing, text: new TextDecoder().decode(bytes), lease };
    });
    const key = `net/${networkId}/fetch/${KEY_A}/${result.info.packId}.pack`;
    expect(result.row).toMatchObject({ kind: "fetch", state: "indexing", r2Key: key });
    expect(result.found).toEqual(result.info);
    expect(result.missing).toBeUndefined();
    expect(result.text).toBe("framed pack bytes");
    expect(result.lease.ok).toBe(true);
    expect((await env.GIT.head(key))?.size).toBe(result.info.bytes);
    // Never under the pack prefix, which the orphan sweep owns.
    expect(await env.GIT.head(`net/${networkId}/p/${result.info.packId}.pack`)).toBeNull();
  });

  it("finds the newest finished object for a key, never an aborted or unfinished one", async () => {
    const { stub } = await newProbe();
    const result = await inProbe(stub, async ({ git }) => {
      const first = git.fetchObjects.begin(KEY_A);
      await first.write(new Uint8Array([1]));
      const one = await first.finish();
      const second = git.fetchObjects.begin(KEY_A);
      await second.write(new Uint8Array([2, 2]));
      const two = await second.finish();
      const open = git.fetchObjects.begin(KEY_B);
      await open.write(new Uint8Array([3]));
      const whileOpen = await git.fetchObjects.find(KEY_B);
      await open.abort();
      const afterAbort = await git.fetchObjects.find(KEY_B);
      return { one, two, found: await git.fetchObjects.find(KEY_A), whileOpen, afterAbort };
    });
    expect(result.found).toEqual(result.two);
    expect(result.found?.packId).not.toBe(result.one.packId);
    expect(result.whileOpen).toBeUndefined();
    expect(result.afterAbort).toBeUndefined();
  });

  it("refuses keys that are not 40 lowercase hex digits", async () => {
    const { stub } = await newProbe();
    for (const bad of ["", "A".repeat(40), `${"a".repeat(39)}/`, "../p/x", "a".repeat(41)]) {
      await expect(inProbe(stub, ({ git }) => git.fetchObjects.find(bad))).rejects.toThrow(
        RangeError,
      );
      await expect(
        inProbe(stub, ({ git }) => {
          git.fetchObjects.begin(bad);
        }),
      ).rejects.toThrow(RangeError);
    }
  });

  it("builds keys only from a network id, a cache key and a pack id", () => {
    const networkId = newNetworkId();
    expect(() => fetchObjectKey("nope", KEY_A, "01JZ0000000000000000000000")).toThrow(RangeError);
    expect(() => fetchObjectKey(networkId, KEY_A, "../x")).toThrow(RangeError);
    expect(() => fetchObjectKey(networkId, "x", "01JZ0000000000000000000000")).toThrow(RangeError);
    expect(fetchObjectKey(networkId, KEY_A, "01JZ0000000000000000000000")).toBe(
      `net/${networkId}/fetch/${KEY_A}/01JZ0000000000000000000000.pack`,
    );
  });
});
