import { describe, expect, it, vi } from "vitest";
import { FyrdenClient } from "../src/index.js";

// A repository secret's PUT answers 201 with `{}` (as GitHub's, which `gh` decodes) when it
// creates and 204 with no body when it updates: the client gives null for both.
describe("FyrdenClient, an operation answering 201 or 204 and nothing else", () => {
  it("gives null for each status", async () => {
    for (const status of [201, 204]) {
      const fetchFn = vi.fn(
        async () =>
          status === 204
            ? new Response(null, { status })
            : new Response("{}", { status, headers: { "Content-Type": "application/json" } }),
      ) as unknown as typeof fetch;
      const client = new FyrdenClient({
        baseUrl: "https://f.test/api",
        token: "t",
        fetch: fetchFn,
      });
      expect(
        await client.call("repos.actions.secrets.set", {
          owner: "ada",
          repo: "demo",
          secret_name: "DEPLOY_KEY",
          encrypted_value: "c2VhbGVk",
          key_id: "1.0123456789abcdef",
        }),
        String(status),
      ).toBeNull();
    }
  });
});
