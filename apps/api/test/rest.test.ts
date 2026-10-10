import { exports } from "cloudflare:workers";
import { registry } from "@fyrden/api-contract";
import { describe, expect, it } from "vitest";

describe("REST surface", () => {
  it("serves the OpenAPI document generated from the registry", async () => {
    const res = await exports.default.fetch("https://fyrden.test/api/openapi.json");
    expect(res.status).toBe(200);
    const doc = await res.json<{
      openapi: string;
      paths: Record<string, unknown>;
      servers: { url: string }[];
    }>();
    expect(doc.openapi).toBe("3.1.1");
    expect(doc.servers[0]?.url).toBe("https://fyrden.test/api");
    for (const op of registry) expect(doc.paths[op.path]).toHaveProperty(op.method.toLowerCase());
  });

  it("mounts every operation and requires authentication", async () => {
    for (const op of registry) {
      const res = await exports.default.fetch(`https://fyrden.test/api${op.path}`, {
        method: op.method,
      });
      expect(res.status, op.id).toBe(401);
      expect(await res.json()).toMatchObject({ status: 401, code: "unauthenticated" });
    }
  });
});
