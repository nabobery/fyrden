import { exports } from "cloudflare:workers";
import { openApiPath, registry } from "@fyrden/api-contract";
import { describe, expect, it } from "vitest";
import { user } from "./helpers/api.js";

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
    for (const op of registry)
      expect(doc.paths[openApiPath(op.path)]).toHaveProperty(op.method.toLowerCase());
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

// Stock `gh` sends REST calls for any host but github.com to `/api/v3/<path>`,
// as for GitHub Enterprise Server, with `Authorization: token <token>`.
describe("REST under /api/v3", () => {
  it("mounts every operation there too, behind the same authentication", async () => {
    for (const op of registry) {
      const res = await exports.default.fetch(`https://fyrden.test/api/v3${op.path}`, {
        method: op.method,
      });
      expect(res.status, op.id).toBe(401);
      expect(await res.json()).toMatchObject({ status: 401, code: "unauthenticated" });
    }
  });

  it("answers as /api does, and takes a token sent with the token scheme as a bearer token", async () => {
    const owner = await user();
    const asBearer = await exports.default.fetch("https://fyrden.test/api/user", {
      headers: { Authorization: `Bearer ${owner.token}` },
    });
    const asToken = await exports.default.fetch("https://fyrden.test/api/v3/user", {
      headers: { Authorization: `token ${owner.token}` },
    });
    expect(asBearer.status).toBe(200);
    expect(asToken.status).toBe(200);
    expect(await asToken.json()).toEqual(await asBearer.json());
  });

  it("serves only operations: no OpenAPI document, and not the runner protocol", async () => {
    expect((await exports.default.fetch("https://fyrden.test/api/v3/openapi.json")).status).toBe(
      404,
    );
    const runner = await exports.default.fetch(
      "https://fyrden.test/api/v3/actions/runner.v1.RunnerService/Register",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
    );
    expect(runner.status).toBe(404);
  });
});
