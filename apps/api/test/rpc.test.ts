import { exports } from "cloudflare:workers";
import { API_RPC_VERSION } from "@fyrden/api-contract";
import { describe, expect, it } from "vitest";

describe("ApiRpc entrypoint", () => {
  it("reports the RPC version", async () => {
    expect(await exports.ApiRpc.rpcVersion()).toBe(API_RPC_VERSION);
  });

  it("serves healthz over RPC", async () => {
    const result = await exports.ApiRpc.healthz({ requestId: "req-rpc-1" });
    expect(result).toMatchObject({ rateLimited: false, report: { ok: true } });
  });
});
