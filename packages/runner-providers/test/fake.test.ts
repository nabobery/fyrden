import { describe, expect, it } from "vitest";
import { isUnsupported } from "../src/index.js";
import { createFakeProvider } from "../testing/index.js";
import { job } from "./helpers/jobs.js";

const REGISTRATION = { token: "t" };

async function provisioned(fake = createFakeProvider()) {
  const handle = await fake.provider.provision(job(), REGISTRATION, "i-1");
  if (isUnsupported(handle)) throw new Error(handle.unsupported);
  return { fake, handle };
}

describe("the fake provider", () => {
  it("moves an instance on only when told to", async () => {
    const { fake, handle } = await provisioned();
    const seen = [];
    for (let i = 0; i < 4; i++) {
      seen.push(await fake.provider.status(handle));
      fake.advance(handle);
    }
    expect(seen).toEqual(["booting", "ready", "running", "running"]);
    fake.vanish(handle);
    expect(await fake.provider.status(handle)).toBe("gone");
    expect(() => fake.advance(handle)).toThrow(/no instance/);
  });

  it("counts the calls that reach its service, and a refused one is none", async () => {
    const { fake, handle } = await provisioned();
    expect(await fake.provider.provision(job({ os: "plan9" }), REGISTRATION, "i-2")).toEqual({
      unsupported: "os",
    });
    await fake.provider.status(handle);
    await fake.provider.teardown(handle);
    await fake.provider.teardown(handle);
    await fake.provider.listOrphans("");
    expect(fake.made()).toBe(1);
    expect(fake.calls).toEqual({ provision: 1, status: 1, teardown: 2, listOrphans: 1 });
  });

  it("knows none of another provider's instances", async () => {
    const { fake, handle } = await provisioned();
    const other = { ...handle, providerId: "other" };
    expect(await fake.provider.status(other)).toBe("gone");
    await fake.provider.teardown(other);
    expect(await fake.provider.status(handle)).toBe("booting");
  });
});
