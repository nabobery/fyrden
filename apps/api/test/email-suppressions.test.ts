// The provider's suppression list as Fyrden knows it: kept by signed
// callbacks under one ordering rule, so redeliveries, replays and any order
// of arrival end where the provider is; rechecked with the provider when
// due, an answer applying only to the row as it was read.

import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { type EmailProvider, emailHooks, resendProvider } from "../src/email/provider.js";
import {
  applying,
  type Lookup,
  makingDue,
  providerTime,
  recheckSuppressions,
} from "../src/email/suppressions.js";

const SECRET_BYTES = new Uint8Array(32).map((_, i) => i + 1);
const SECRET = `whsec_${btoa(String.fromCharCode(...SECRET_BYTES))}`;

afterEach(() => {
  delete emailHooks.provider;
  vi.restoreAllMocks();
});

/** A mailbox of its own. */
const mailbox = () => `Box.${crypto.randomUUID().slice(0, 8)}@Example.com`;
const sid = () => crypto.randomUUID();

type Event = { id: string; email: string; created_at: string; origin?: string };

/** A callback body as the provider sends it. */
const body = (type: string, data: Event) =>
  JSON.stringify({
    type,
    created_at: new Date().toISOString(),
    data: { origin: "bounce", source_id: null, ...data },
  });

/** Headers signing `text` with `secret` (Standard Webhooks). */
async function signed(text: string, secret = SECRET_BYTES): Promise<Record<string, string>> {
  const id = `msg_${crypto.randomUUID()}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const key = await crypto.subtle.importKey(
    "raw",
    secret,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${text}`)),
  );
  return {
    "svix-id": id,
    "svix-timestamp": timestamp,
    "svix-signature": `v1,${btoa(String.fromCharCode(...mac))}`,
  };
}

/** One request to the callback route, as the deployment's Worker with its secret. */
async function post(
  text: string,
  headers: Record<string, string>,
  bindings: Record<string, unknown> = {},
): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await createApp().fetch(
    new Request("https://fyrden.test/auth/email/events", { method: "POST", body: text, headers }),
    { ...env, RESEND_WEBHOOK_SECRET: SECRET, ...bindings },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

const deliver = async (type: string, data: Event) => {
  const text = body(type, data);
  return (await post(text, await signed(text))).status;
};

const rowOf = (email: string) =>
  env.DIRECTORY.prepare(
    `SELECT suppression_id AS id, suppressed, origin, rev, next_check_at AS due
     FROM email_suppressions WHERE address_key = ?`,
  )
    .bind(email.toLowerCase())
    .first<{ id: string; suppressed: number; origin: string; rev: number; due: number }>();

const at = (ms: number) => new Date(ms).toISOString();

describe("a provider time", () => {
  it("is read from ISO 8601 and from the list's SQL form alike", () => {
    const ms = Date.UTC(2026, 9, 6, 23, 47, 56, 678);
    expect(providerTime("2026-10-06T23:47:56.678Z")).toBe(ms);
    expect(providerTime("2026-10-06 23:47:56.678+00")).toBe(ms);
    expect(providerTime("2026-10-06 23:47:56.678123+00:00")).toBe(ms);
    expect(providerTime("2026-10-07 01:47:56.678+0200")).toBe(ms);
    expect(providerTime("2026-10-06T23:47:56Z")).toBe(ms - 678);
    expect(providerTime("2028-02-29T00:00:00Z")).toBe(Date.UTC(2028, 1, 29));
    expect(providerTime("2000-02-29T00:00:00Z")).toBe(Date.UTC(2000, 1, 29));
    expect(providerTime("0000-02-29T00:00:00Z")).toBeDefined();
    expect(providerTime("2100-02-29T00:00:00Z")).toBeUndefined();
    for (const bad of [
      "",
      "yesterday",
      "2026-10-06",
      "2026-10-06T23:47:56",
      "2026-02-29T00:00:00Z",
      "2026-02-30 00:00:00+00",
      "2026-13-01T00:00:00Z",
      "2026-10-06T24:00:00Z",
      "2026-10-06T23:60:00Z",
      "2026-10-06T23:00:00+15",
      12,
      null,
    ])
      expect(providerTime(bad), String(bad)).toBeUndefined();
  });
});

describe("the provider's callbacks", () => {
  it("suppress and release a mailbox, a replay of either changing nothing", async () => {
    const email = mailbox();
    const a = { id: sid(), email, created_at: at(Date.now() - 60_000) };
    expect(await deliver("suppression.added", a)).toBe(200);
    expect(await rowOf(email)).toMatchObject({ id: a.id, suppressed: 1, origin: "bounce" });
    // Redelivered: nothing changes, not even its revision.
    const { rev } = (await rowOf(email)) as { rev: number };
    expect(await deliver("suppression.added", a)).toBe(200);
    expect((await rowOf(email))?.rev).toBe(rev);
    expect(await deliver("suppression.removed", a)).toBe(200);
    expect(await rowOf(email)).toMatchObject({ id: a.id, suppressed: 0 });
    // The add replayed after its removal, however late: still removed.
    expect(await deliver("suppression.added", a)).toBe(200);
    expect(await rowOf(email)).toMatchObject({ id: a.id, suppressed: 0 });
    // A later suppression of the mailbox (another case of its address) suppresses it again.
    const b = { id: sid(), email: email.toUpperCase(), created_at: at(Date.now()) };
    expect(await deliver("suppression.added", { ...b, origin: "complaint" })).toBe(200);
    expect(await rowOf(email)).toMatchObject({ id: b.id, suppressed: 1, origin: "complaint" });
  });

  it("end where the provider is, whatever order they come in", async () => {
    const email = mailbox();
    const a = { id: sid(), email, created_at: at(Date.now() - 120_000) };
    const b = { id: sid(), email, created_at: at(Date.now() - 60_000) };
    // The provider: added A, removed A, added B, removed B. Fyrden sees A added, then the rest
    // out of order.
    await deliver("suppression.added", a);
    await deliver("suppression.removed", b);
    expect(await rowOf(email)).toMatchObject({ id: b.id, suppressed: 0 });
    await deliver("suppression.added", b);
    await deliver("suppression.removed", a);
    expect(await rowOf(email)).toMatchObject({ id: b.id, suppressed: 0 });
    // A removal before its add: the add that follows changes nothing.
    const other = mailbox();
    const c = { id: sid(), email: other, created_at: at(Date.now()) };
    await deliver("suppression.removed", c);
    await deliver("suppression.added", c);
    expect(await rowOf(other)).toMatchObject({ id: c.id, suppressed: 0 });
  });

  it("leave a tie of two suppressions created at once to the provider", async () => {
    const email = mailbox();
    const time = at(Date.now() - 1000);
    const [low, high] = [sid(), sid()].sort();
    await deliver("suppression.added", { id: high as string, email, created_at: time });
    await deliver("suppression.removed", { id: high as string, email, created_at: time });
    await deliver("suppression.added", { id: low as string, email, created_at: time });
    const row = await rowOf(email);
    expect(row).toMatchObject({ id: "", suppressed: 1 });
    expect(row?.due).toBeLessThanOrEqual(Date.now());
    // A replay of either removal leaves it to the provider still.
    await deliver("suppression.removed", { id: high as string, email, created_at: time });
    await deliver("suppression.removed", { id: low as string, email, created_at: time });
    expect(await rowOf(email)).toMatchObject({ id: "", suppressed: 1 });
  });

  it("are refused unsigned, with no directory work, and limited by client", async () => {
    const email = mailbox();
    const text = body("suppression.added", { id: sid(), email, created_at: at(Date.now()) });
    const forged = await signed(text, new Uint8Array(32));
    const failing = {
      DIRECTORY: new Proxy(env.DIRECTORY, {
        get: () => {
          throw new Error("no directory work for a forged callback");
        },
      }),
    };
    const ip = { "CF-Connecting-IP": `2001:db8::${crypto.randomUUID().slice(0, 4)}` };
    const statuses: number[] = [];
    for (let i = 0; i < 120; i++)
      statuses.push((await post(text, { ...forged, ...ip }, failing)).status);
    expect(statuses.every((s) => s === 401)).toBe(true);
    const throttled = await post(text, { ...forged, ...ip }, failing);
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get("Retry-After")).toBe("60");
    // Unsigned, or past the body limit whatever it claims: refused alike.
    expect((await post(text, {}, failing)).status).toBe(401);
    const big = "x".repeat(64 * 1024 + 1);
    expect(
      (await post(big, { ...(await signed(big)), "Content-Length": "10" }, failing)).status,
    ).toBe(413);
    expect(await rowOf(email)).toBeNull();
  });

  it("are verified over the bytes received, a byte-order mark included", async () => {
    const email = mailbox();
    const text = body("suppression.added", { id: sid(), email, created_at: at(Date.now()) });
    // Prepended to a body signed without it: not what was signed.
    expect((await post(`\uFEFF${text}`, await signed(text))).status).toBe(401);
    expect(await rowOf(email)).toBeNull();
    // Signed with it: verified, and read.
    expect((await post(`\uFEFF${text}`, await signed(`\uFEFF${text}`))).status).toBe(200);
    expect(await rowOf(email)).toMatchObject({ suppressed: 1 });
  });

  it("are acknowledged only once written, and refused without a secret", async () => {
    const email = mailbox();
    const text = body("suppression.added", { id: sid(), email, created_at: at(Date.now()) });
    const failing = {
      DIRECTORY: {
        ...env.DIRECTORY,
        prepare: () => {
          throw new Error("the directory is unavailable");
        },
      },
    };
    expect((await post(text, await signed(text), failing)).status).toBe(500);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    for (let i = 0; i < 2; i++)
      expect(
        (await post(text, await signed(text), { RESEND_WEBHOOK_SECRET: undefined })).status,
      ).toBe(503);
    expect(
      errors.mock.calls.filter((c) => String(c[0]).includes("RESEND_WEBHOOK_SECRET")),
    ).toHaveLength(1);
    // Signed but unreadable, or of another type: refused, or acknowledged and ignored.
    const unreadable = body("suppression.added", { id: "x y", email, created_at: "soon" });
    expect((await post(unreadable, await signed(unreadable))).status).toBe(400);
    for (const text of ["null", "[]", "not json"])
      expect((await post(text, await signed(text))).status, text).toBe(400);
    const other = JSON.stringify({ type: "email.delivered", data: {} });
    expect((await post(other, await signed(other))).status).toBe(200);
    expect(await rowOf(email)).toBeNull();
  });
});

/** Rows suppressed and due, inserted as callbacks would (`applying`), then made due. */
/** Each call's rows due before every earlier call's (rows of other tests stay due). */
let earliest = -10_000_000;

async function suppressedDue(n: number): Promise<string[]> {
  earliest -= 100;
  const base = earliest;
  const emails = Array.from({ length: n }, mailbox);
  const now = Date.now();
  await env.DIRECTORY.batch([
    ...emails.map((email, i) =>
      applying(
        env.DIRECTORY,
        { id: sid(), email, origin: "bounce", createdAt: now - 1000 + i },
        true,
        now,
      ),
    ),
    makingDue(env.DIRECTORY, JSON.stringify(emails.map((e) => e.toLowerCase())), -1_000_000 + now),
  ]);
  // The oldest due first, in the order given.
  await env.DIRECTORY.batch(
    emails.map((email, i) =>
      env.DIRECTORY.prepare(
        "UPDATE email_suppressions SET next_check_at = ? WHERE address_key = ?",
      ).bind(base + i, email.toLowerCase()),
    ),
  );
  return emails;
}

/** A provider whose lookups answer from `answers`, recording what was asked. */
function looking(answers: (email: string) => Promise<Lookup>): { asked: string[] } {
  const asked: string[] = [];
  const provider: EmailProvider = {
    name: "test",
    from: "Fyrden <n@fyrden.test>",
    send: async () => ({ status: "accepted", id: "x" }),
    async lookupSuppression(email) {
      asked.push(email);
      return answers(email);
    },
  };
  emailHooks.provider = provider;
  return { asked };
}

describe("a suppression recheck", () => {
  it("releases a mailbox the provider no longer suppresses, and confirms one it does", async () => {
    const [gone, kept] = await suppressedDue(2);
    const found = new Map<string, string>();
    const { asked } = looking(async (email) => {
      if (email === gone) return { status: "absent" };
      const id = sid();
      found.set(email, id);
      return {
        status: "found",
        suppression: { id, email, origin: "complaint", createdAt: Date.now() },
      };
    });
    await recheckSuppressions({ ...env, FYRDEN_EMAIL_RECHECKS: "2" } as Env, { now: Date.now() });
    expect(asked).toEqual([gone, kept]);
    expect(await rowOf(gone as string)).toMatchObject({ suppressed: 0 });
    const confirmed = await rowOf(kept as string);
    expect(confirmed).toMatchObject({
      id: found.get(kept as string),
      suppressed: 1,
      origin: "complaint",
    });
    expect(confirmed?.due).toBeGreaterThan(Date.now() + 6 * 24 * 60 * 60_000);
  });

  it("drops an answer a callback overtook", async () => {
    const [email] = (await suppressedDue(1)) as [string];
    const newer = { id: sid(), email, created_at: at(Date.now() + 1000) };
    looking(async () => {
      // Created and delivered while the lookup was out.
      await deliver("suppression.added", newer);
      return { status: "absent" };
    });
    await recheckSuppressions({ ...env, FYRDEN_EMAIL_RECHECKS: "1" } as Env, { now: Date.now() });
    expect(await rowOf(email)).toMatchObject({ id: newer.id, suppressed: 1 });
  });

  it("lets no row hold the others back, and stops at a provider failure", async () => {
    const [poison, next, failing, after] = (await suppressedDue(4)) as string[];
    const { asked } = looking(async (email) =>
      email === poison
        ? { status: "invalid" }
        : email === failing
          ? { status: "failed" }
          : { status: "absent" },
    );
    await recheckSuppressions({ ...env, FYRDEN_EMAIL_RECHECKS: "4" } as Env, { now: Date.now() });
    // The poison row moves a day on, the next is rechecked, the failing one an hour on, and the
    // run stops there.
    expect(asked).toEqual([poison, next, failing]);
    expect((await rowOf(poison as string))?.due).toBeGreaterThan(Date.now() + 23 * 60 * 60_000);
    expect(await rowOf(next as string)).toMatchObject({ suppressed: 0 });
    const moved = (await rowOf(failing as string))?.due as number;
    expect(moved).toBeGreaterThan(Date.now() + 59 * 60_000);
    expect(moved).toBeLessThan(Date.now() + 61 * 60_000);
    expect(await rowOf(after as string)).toMatchObject({ suppressed: 1 });
  });

  it("settles a tie as the provider answers", async () => {
    const [found, absent] = [mailbox(), mailbox()];
    const time = at(Date.now() - 1000);
    for (const email of [found, absent])
      for (const id of [sid(), sid()])
        await deliver("suppression.added", { id, email, created_at: time });
    expect(await rowOf(found)).toMatchObject({ id: "", suppressed: 1 });
    // Ahead of every other due row.
    await env.DIRECTORY.batch(
      [found, absent].map((email, i) =>
        env.DIRECTORY.prepare(
          "UPDATE email_suppressions SET next_check_at = ? WHERE address_key = ?",
        ).bind(-20_000_000 + i, email.toLowerCase()),
      ),
    );
    const settled = { id: sid(), createdAt: Date.UTC(2026, 9, 6, 23, 47, 56, 678) };
    looking(async (email) =>
      email === found
        ? {
            status: "found",
            suppression: { ...settled, email: email.toUpperCase(), origin: "manual" },
          }
        : { status: "absent" },
    );
    await recheckSuppressions({ ...env, FYRDEN_EMAIL_RECHECKS: "2" } as Env, { now: Date.now() });
    expect(
      await env.DIRECTORY.prepare(
        "SELECT email, suppression_id AS id, created_at AS c, origin, suppressed FROM email_suppressions WHERE address_key = ?",
      )
        .bind(found.toLowerCase())
        .first(),
    ).toEqual({
      email: found.toUpperCase(),
      id: settled.id,
      c: settled.createdAt,
      origin: "manual",
      suppressed: 1,
    });
    expect(await rowOf(absent)).toMatchObject({ id: "", suppressed: 0 });
  });

  it("is made due at once by an add that meets one, never pushed back", async () => {
    const [email] = (await suppressedDue(1)) as [string];
    const key = JSON.stringify([email.toLowerCase()]);
    await env.DIRECTORY.prepare(
      "UPDATE email_suppressions SET next_check_at = ? WHERE address_key = ?",
    )
      .bind(Date.now() + 1_000_000, email.toLowerCase())
      .run();
    await makingDue(env.DIRECTORY, key, Date.now()).run();
    const due = (await rowOf(email))?.due as number;
    expect(due).toBeLessThanOrEqual(Date.now());
    await makingDue(env.DIRECTORY, key, Date.now() + 5000).run();
    expect((await rowOf(email))?.due).toBe(due);
  });

  it("looks an address up as one path segment", async () => {
    const urls: string[] = [];
    const provider = resendProvider("re_test", "Fyrden <n@example.com>", (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ name: "not_found" }), { status: 404 });
    }) as typeof fetch);
    expect(await provider.lookupSuppression?.("../domains/a#b?c%d+e@x.com")).toEqual({
      status: "absent",
    });
    expect(urls).toEqual([
      "https://api.resend.com/suppressions/..%2Fdomains%2Fa%23b%3Fc%25d%2Be%40x.com",
    ]);
    const answer = (status: number, body: unknown) =>
      resendProvider(
        "re_test",
        "Fyrden <n@example.com>",
        (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch,
      ).lookupSuppression?.("a@x.com");
    expect(await answer(401, {})).toEqual({ status: "failed" });
    expect(await answer(429, {})).toEqual({ status: "failed" });
    expect(await answer(503, {})).toEqual({ status: "failed" });
    expect(await answer(422, {})).toEqual({ status: "invalid" });
    expect(await answer(200, { id: "nope" })).toEqual({ status: "invalid" });
    expect(
      await answer(200, {
        object: "suppression",
        id: "e169aa45-1ecf-4183-9955-b1499d5701d3",
        email: "A@x.com",
        origin: "manual",
        source_id: null,
        created_at: "2026-10-06 23:47:56.678+00",
      }),
    ).toEqual({
      status: "found",
      suppression: {
        id: "e169aa45-1ecf-4183-9955-b1499d5701d3",
        email: "A@x.com",
        origin: "manual",
        createdAt: Date.UTC(2026, 9, 6, 23, 47, 56, 678),
      },
    });
  });
});
