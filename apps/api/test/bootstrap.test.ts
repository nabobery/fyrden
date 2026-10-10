import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const bootstrap = (secret: string | null, body: unknown = { handle: "admin" }) =>
  exports.default.fetch("https://fyrden.test/v0/admin/bootstrap", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(secret !== null && { "X-Fyrden-Bootstrap-Secret": secret }),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const whoami = (authorization?: string) =>
  exports.default.fetch("https://fyrden.test/api/user", {
    headers: authorization ? { Authorization: authorization } : {},
  });

const SECRET = "test-bootstrap-secret";

// One file shares one D1 database, so every test here is self-contained and
// only the bootstrap test creates an admin: they pass in any order.
describe("first-run bootstrap", () => {
  it("refuses a missing or wrong bootstrap secret", async () => {
    expect((await bootstrap(null)).status).toBe(403);
    expect((await bootstrap("wrong")).status).toBe(403);
  });

  it.each([
    ["null"],
    ["[]"],
    ['"text"'],
    ["42"],
    ["{not json"],
    [{ handle: "-bad-" }],
    [{ handle: 7 }],
  ])("rejects the body %j with a 422 problem", async (body) => {
    const res = await bootstrap(SECRET, body);
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: "invalid_handle" });
  });

  it("creates exactly one admin when bootstraps race, and refuses later ones", async () => {
    const responses = await Promise.all(
      ["root", "root2", "root3"].map((handle) => bootstrap(SECRET, { handle })),
    );
    expect(responses.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    const created = responses.find((r) => r.status === 201);
    const body = await created?.json<{ token: string; user: { id: string } }>();
    const token = body?.token ?? "";
    expect(token).toMatch(/^fyrden_pat_[0-9A-Za-z]{36}$/);
    expect(body?.user.id).toMatch(/^usr_/);

    const late = await bootstrap(SECRET, { handle: "late" });
    expect(late.status).toBe(409);
    expect(late.headers.get("Content-Type")).toContain("application/problem+json");

    for (const header of [`Bearer ${token}`, `Basic ${btoa(`x-access-token:${token}`)}`]) {
      const res = await whoami(header);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        type: "user",
        is_instance_admin: true,
        token: { type: "pat", scopes: ["admin"] },
      });
    }
  });
});

describe("authentication failures", () => {
  it("rejects missing, malformed and unknown tokens with a Bearer challenge", async () => {
    for (const header of [
      undefined,
      "Bearer nope",
      `Bearer fyrden_pat_${"a".repeat(36)}`,
      "Digest x",
    ]) {
      const res = await whoami(header);
      expect(res.status).toBe(401);
      expect(res.headers.get("WWW-Authenticate")).toContain('Bearer realm="fyrden"');
    }
  });
});
