import { describe, expect, it, vi } from "vitest";
import { FyrdenClient } from "../src/index.js";

// No operation of the registry answers 201 with no body yet: one is added to the table.
vi.mock("../src/generated.js", async (original) => {
  const generated = await original<typeof import("../src/generated.js")>();
  return {
    ...generated,
    OPERATIONS: {
      ...generated.OPERATIONS,
      "admin.users.suspend": {
        ...generated.OPERATIONS["admin.users.suspend"],
        noContent: [201, 204],
      },
    },
  };
});

describe("FyrdenClient, an operation answering 201 or 204 with no body", () => {
  it("gives null for each status", async () => {
    for (const status of [201, 204]) {
      const fetchFn = vi.fn(
        async () => new Response(status === 204 ? null : "", { status }),
      ) as unknown as typeof fetch;
      const client = new FyrdenClient({
        baseUrl: "https://f.test/api",
        token: "t",
        fetch: fetchFn,
      });
      expect(
        await client.call("admin.users.suspend", { username: "someone" }),
        String(status),
      ).toBeNull();
    }
  });
});
