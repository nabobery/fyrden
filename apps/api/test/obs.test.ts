import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { logs } from "./setup/log-capture.js";

describe("request logging", () => {
  it("logs the request id in the Worker and inside the Durable Object", async () => {
    const res = await exports.default.fetch("https://fyrden.test/healthz", {
      headers: { "X-Request-Id": "req-obs-1" },
    });
    expect(res.status).toBe(200);
    const entries = logs.entries().filter((e) => e.requestId === "req-obs-1");
    expect(entries.find((e) => e.do === "RepoDO")?.msg).toBe("healthz probe");
    expect(entries.find((e) => e.msg === "request")).toMatchObject({
      route: "/healthz",
      status: 200,
      method: "GET",
    });
  });

  it("redacts a token smuggled into the request id (base64url with a suffix)", async () => {
    const token = `fyrden_pat_${"Q".repeat(36)}`;
    const encoded = `${btoa(token).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}AA`;
    const res = await exports.default.fetch("https://fyrden.test/no-such-route", {
      headers: { "X-Request-Id": encoded },
    });
    expect(res.status).toBe(404);
    // The shared log capture fails this test if the encoded token was logged.
    expect(logs.lines.some((line) => line.includes('"msg":"request"'))).toBe(true);
  });

  it("logs an unhandled error through redaction and answers with a generic problem", async () => {
    const token = `fyrden_pat_${"E".repeat(36)}`;
    const app = createApp();
    app.get("/boom", () => {
      throw new Error(`storage failed for ${token}`);
    });
    const ctx = createExecutionContext();
    const res = await app.request("https://fyrden.test/boom", {}, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(500);
    expect(res.headers.get("Content-Type")).toContain("application/problem+json");
    const body = await res.text();
    expect(JSON.parse(body)).toMatchObject({ status: 500, code: "internal_error" });
    expect(body).not.toContain("storage failed");
    expect(logs.entries().find((e) => e.msg === "unhandled error")).toBeDefined();
    // The shared log capture also fails the test if the token reached a log.
    expect(logs.lines.join("\n")).not.toContain(token);
  });

  it("never logs the Authorization header value", async () => {
    const token = `fyrden_pat_${"Z".repeat(36)}`;
    await exports.default.fetch(`https://fyrden.test/healthz?token=${token}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(logs.lines.join("\n")).not.toContain(token);
  });
});
