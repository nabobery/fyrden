// Notification settings and unsubscribe links. Settings: three categories
// with defaults, set a field at a time from a web session, the last write
// winning. Links (RFC 8058): signed with their own key, read strictly,
// naming one address generation and category; a credential-free one-click
// POST unsubscribes it (only while the address row exists), GET and HEAD
// change nothing; cleanup takes unsubscribes with their address.

import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emailWriteHooks, reapEmails } from "../src/accounts/emails.js";
import { createApp } from "../src/app.js";
import { unsubscribeToken, verifyUnsubscribe } from "../src/email/unsubscribe.js";
import { SESSION_COOKIE } from "../src/oauth/session.js";
import { newId } from "../src/services.js";
import { api, user, type Who } from "./helpers/api.js";
import { ORIGIN } from "./helpers/git-http.js";
import { testSession } from "./helpers/oauth.js";
import { untilThrottled } from "./helpers/rate-limits.js";

afterEach(() => {
  delete emailWriteHooks.beforeWrite;
  vi.restoreAllMocks();
});

type Signed = Who & { cookie: string };

async function signedIn(): Promise<Signed> {
  const who = await user();
  const { cookie } = await testSession(who.principalId);
  return { ...who, cookie: `${SESSION_COOKIE}=${cookie}` };
}

const settings = async (who: Signed, method = "GET", body?: unknown) => {
  const response = await exports.default.fetch(`${ORIGIN}/api/user/notification-settings`, {
    method,
    headers: {
      Cookie: who.cookie,
      "X-Fyrden-Session": "1",
      ...(body !== undefined && { "Content-Type": "application/json" }),
      ...(method !== "GET" && { "Idempotency-Key": crypto.randomUUID() }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

/** An address row of `who`'s (written as adding one would, for speed); its id. */
async function address(who: Who, removedAt: number | null = null): Promise<string> {
  const id = newId("eml");
  const mailbox = `${id.toLowerCase()}@example.com`;
  await env.DIRECTORY.prepare(
    `INSERT INTO user_emails (id, principal_id, address, address_key, verified_at, created_at, removed_at)
     VALUES (?1, ?2, ?3, ?3, ?4, ?4, ?5)`,
  )
    .bind(id, who.principalId, mailbox, Date.now(), removedAt)
    .run();
  return id;
}

const unsubscribed = async (emailId: string) =>
  (
    await env.DIRECTORY.prepare(
      "SELECT scope FROM email_unsubscribes WHERE email_id = ? ORDER BY scope",
    )
      .bind(emailId)
      .all<{ scope: string }>()
  ).results.map((r) => r.scope);

const click = (token: string, init: RequestInit = {}) =>
  exports.default.fetch(`${ORIGIN}/unsubscribe?t=${encodeURIComponent(token)}`, init);

/** A client of its own (the limiter's state outlives a test). */
const client = () => ({ "CF-Connecting-IP": `2001:db8::${crypto.randomUUID().slice(0, 4)}` });

describe("notification settings", () => {
  it("start from the defaults and change a field at a time, the last write winning", async () => {
    const who = await signedIn();
    expect(await settings(who)).toEqual({
      status: 200,
      body: { email: { direct: true, participating: false, watching: false } },
    });
    expect((await settings(who, "PUT", { email: { watching: true } })).body).toEqual({
      email: { direct: true, participating: false, watching: true },
    });
    expect((await settings(who, "PUT", { email: { direct: false } })).body).toEqual({
      email: { direct: false, participating: false, watching: true },
    });
    // Two first writes at once: each field as its own write left it.
    const other = await signedIn();
    await Promise.all([
      settings(other, "PUT", { email: { participating: true } }),
      settings(other, "PUT", { email: { watching: true } }),
    ]);
    expect((await settings(other)).body).toEqual({
      email: { direct: true, participating: true, watching: true },
    });
  });

  it("are a web session's only, and written only while the user holds", async () => {
    const who = await signedIn();
    expect((await api("GET", "/user/notification-settings", who.token)).status).toBe(403);
    emailWriteHooks.beforeWrite = async () => {
      await env.DIRECTORY.prepare(
        "UPDATE principals SET lifecycle_gen = lifecycle_gen + 1 WHERE id = ?",
      )
        .bind(who.principalId)
        .run();
    };
    expect((await settings(who, "PUT", { email: { watching: true } })).status).toBe(401);
  });
});

describe("an unsubscribe link", () => {
  it("names one address generation and category, and is read strictly", async () => {
    const id = newId("eml");
    const token = (await unsubscribeToken(env, id, "watching")) as string;
    expect(token).toMatch(/^v1\.eml_[0-9A-Z]{26}\.watching\.[A-Za-z0-9_-]{43}$/);
    expect(await verifyUnsubscribe(env, token)).toEqual({ emailId: id, category: "watching" });
    const [v, e, c, mac] = token.split(".") as [string, string, string, string];
    const other = newId("eml");
    for (const bad of [
      `${v}.${e}.direct.${mac}`,
      `${v}.${other}.${c}.${mac}`,
      `v2.${e}.${c}.${mac}`,
      `${v}.${e}.${c}.${mac}=`,
      `${v}.${e}.${c}.${mac.slice(0, -1)}`,
      `${v}.${e}.${c}`,
      `${v}.${e}.${c}.${mac}.x`,
      "",
    ])
      expect(await verifyUnsubscribe(env, bad), bad).toBe("invalid");
    // Another key's: not ours. No key at all: not available.
    const otherKey = { EMAIL_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8" };
    expect(await verifyUnsubscribe(otherKey, token)).toBe("invalid");
    expect(await verifyUnsubscribe({}, token)).toBe("unavailable");
    expect(await unsubscribeToken({ EMAIL_KEY: "short" }, id, "watching")).toBeNull();
    // The commit signing key is not its key: replacing it changes nothing.
    expect(
      await verifyUnsubscribe(
        { ...env, SIGNING_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=" },
        token,
      ),
    ).toEqual({ emailId: id, category: "watching" });
  });

  it("unsubscribes on a one-click post with no credential, whatever its body, once", async () => {
    const who = await user();
    const id = await address(who);
    const token = (await unsubscribeToken(env, id, "participating")) as string;
    const oneClick = await click(token, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click",
    });
    expect(oneClick.status).toBe(200);
    expect(await unsubscribed(id)).toEqual(["participating"]);
    const form = new FormData();
    form.set("List-Unsubscribe", "One-Click");
    expect((await click(token, { method: "POST", body: form })).status).toBe(200);
    expect((await click(token, { method: "POST" })).status).toBe(200);
    expect(await unsubscribed(id)).toEqual(["participating"]);
  });

  it("changes nothing when opened, and nothing for an address gone or another generation", async () => {
    const who = await user();
    const id = await address(who);
    const token = (await unsubscribeToken(env, id, "direct")) as string;
    for (const method of ["GET", "HEAD"]) {
      const opened = await click(token, { method });
      expect(opened.status).toBe(200);
    }
    expect(await unsubscribed(id)).toEqual([]);
    const page = await (await click(token)).text();
    expect(page).toContain('method="post"');
    // A link of a generation reaped (or never made): answered alike, nothing written.
    const gone = (await unsubscribeToken(env, newId("eml"), "direct")) as string;
    expect((await click(gone, { method: "POST" })).status).toBe(200);
    expect(
      (
        await env.DIRECTORY.prepare(
          "SELECT count(*) AS n FROM email_unsubscribes WHERE email_id = ?",
        )
          .bind(gone.split(".")[1])
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
    // A link Fyrden did not make.
    expect((await click("v1.nope", { method: "POST" })).status).toBe(400);
  });

  it("is not available without a usable key, said once, nothing written", async () => {
    const who = await user();
    const id = await address(who);
    const token = (await unsubscribeToken(env, id, "direct")) as string;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = createApp();
    for (const EMAIL_KEY of [undefined, "short"]) {
      errors.mockClear();
      for (const method of ["GET", "HEAD", "POST", "POST"]) {
        const ctx = createExecutionContext();
        const response = await app.fetch(
          new Request(`${ORIGIN}/unsubscribe?t=${encodeURIComponent(token)}`, { method }),
          { ...env, EMAIL_KEY },
          ctx,
        );
        await waitOnExecutionContext(ctx);
        expect(response.status, `${EMAIL_KEY} ${method}`).toBe(503);
      }
      const said = errors.mock.calls.filter((call) => String(call[0]).includes("EMAIL_KEY"));
      expect(said, String(EMAIL_KEY)).toHaveLength(1);
    }
    expect(await unsubscribed(id)).toEqual([]);
  });

  it("is limited by client for links Fyrden did not make, whatever the method", async () => {
    const who = await user();
    const token = (await unsubscribeToken(env, await address(who), "watching")) as string;
    const headers = client();
    const { passed, throttled } = await untilThrottled(
      (i) => click(`v1.forged${i}`, { method: ["GET", "HEAD", "POST"][i % 3] as string, headers }),
      120,
    );
    expect(passed.length).toBeGreaterThanOrEqual(120);
    expect(passed.every((s) => s === 400)).toBe(true);
    expect(throttled?.headers.get("Retry-After")).toBe("60");
    // Another client is not held back by it, nor is a link Fyrden made by its allowance.
    expect((await click("v1.forged", { method: "POST", headers: client() })).status).toBe(400);
    expect((await click(token, { headers })).status).toBe(200);
    expect((await click(token, { method: "POST", headers })).status).toBe(200);
  });

  it("is limited by address and list for one-click posts only", async () => {
    const who = await user();
    const id = await address(who);
    const token = (await unsubscribeToken(env, id, "watching")) as string;
    // Opening it spends nothing of the posts' allowance.
    for (let i = 0; i < 20; i++) expect((await click(token)).status).toBe(200);
    const { passed, throttled } = await untilThrottled(() => click(token, { method: "POST" }), 10);
    expect(passed.length).toBeGreaterThanOrEqual(10);
    expect(passed.every((s) => s === 200)).toBe(true);
    expect(throttled?.headers.get("Retry-After")).toBe("60");
    // Another address's link is not held back by it.
    const other = (await unsubscribeToken(env, await address(who), "watching")) as string;
    expect((await click(other, { method: "POST" })).status).toBe(200);
  });

  it("goes with its address when the address is reaped", async () => {
    const who = await user();
    const removedLongAgo = Date.now() - 31 * 24 * 60 * 60_000;
    const id = await address(who, removedLongAgo);
    const token = (await unsubscribeToken(env, id, "watching")) as string;
    expect((await click(token, { method: "POST" })).status).toBe(200);
    expect(await unsubscribed(id)).toEqual(["watching"]);
    await reapEmails(env, { now: Date.now() });
    expect(await unsubscribed(id)).toEqual([]);
    expect(
      (
        await env.DIRECTORY.prepare("SELECT count(*) AS n FROM user_emails WHERE id = ?")
          .bind(id)
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
    // Its link replayed after: nothing comes back.
    expect((await click(token, { method: "POST" })).status).toBe(200);
    expect(await unsubscribed(id)).toEqual([]);
  });
});
