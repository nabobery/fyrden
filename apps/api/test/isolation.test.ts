import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { describe, expect, it } from "vitest";

// Storage isolation is per test file, not per test. Tests stay independent by
// using unique Durable Object names and keys, which this pair demonstrates:
// each test passes in either order.
describe("unique ids per test", () => {
  it("writes through one object", async () => {
    const stub = env.REPO.getByName(uniqueId("repo"));
    expect(await stub.healthProbe("hello")).toBe(true);
    expect(await runInDurableObject(stub, (_, state) => state.storage.get("healthz"))).toBe(
      "hello",
    );
  });

  it("sees nothing in an object with a different id", async () => {
    const stub = env.REPO.getByName(uniqueId("repo"));
    expect(
      await runInDurableObject(stub, (_, state) => state.storage.get("healthz")),
    ).toBeUndefined();
  });
});
