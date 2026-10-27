import { createLogger } from "@fyrden/adapters-cloudflare/obs";
import type { Context, Hono } from "hono";
import type { AppEnv } from "../app.js";
import { base64url } from "../oauth/params.js";
import { clock } from "../services.js";
import { EMAIL_CATEGORIES, type EmailCategory } from "./category.js";

/*
 * Unsubscribe links (RFC 8058). Each notification email carries one in its
 * `List-Unsubscribe` header (with `List-Unsubscribe-Post:
 * List-Unsubscribe=One-Click`) and its footer: `/unsubscribe?t=<token>`
 * on the public origin. The token names one address generation (its row
 * id) and one category, and is signed with the Worker secret `EMAIL_KEY`
 * (its own, so rotating the commit signing key leaves links working):
 * `v1.<address id>.<category>.<HMAC-SHA256 of "v1.<address id>.<category>">`,
 * read strictly. A `POST` (a mail client's one click: no credential, any
 * body) unsubscribes that address generation from that category; `GET`
 * and `HEAD` show a page that changes nothing (link scanners open links)
 * with a form posting the same. Re-adding the address starts clean.
 */

const ID = /^eml_[0-9A-HJKMNP-TV-Z]{26}$/;
const MAC = /^[A-Za-z0-9_-]{43}$/;

/** The decoded key, by its text, an isolate. */
let cached: { text: string | undefined; key: CryptoKey | null } | undefined;

/**
 * `EMAIL_KEY` (32 bytes, canonical base64url) as an HMAC key; null when missing or malformed,
 * which is logged once per key text (or once while it is missing).
 */
async function keyOf(env: object): Promise<CryptoKey | null> {
  const value = (env as { EMAIL_KEY?: unknown }).EMAIL_KEY;
  const text = typeof value === "string" ? value : undefined;
  if (cached && cached.text === text) return cached.key;
  let key: CryptoKey | null = null;
  const bytes = text === undefined ? undefined : decode(text);
  if (text === undefined) createLogger({ op: "email.unsubscribe" }).error("EMAIL_KEY is not set");
  else if (bytes?.length === 32)
    key = await crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, [
      "sign",
      "verify",
    ]);
  else createLogger({ op: "email.unsubscribe" }).error("EMAIL_KEY is not 32 bytes of base64url");
  cached = { text, key };
  return key;
}

/** Canonical unpadded base64url's bytes; undefined for any other text. */
function decode(text: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return undefined;
  let binary: string;
  try {
    binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    return undefined;
  }
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return base64url(bytes) === text ? bytes : undefined;
}

const payloadOf = (emailId: string, category: EmailCategory) =>
  new TextEncoder().encode(`v1.${emailId}.${category}`);

/** A link's token for an address generation and category; null without a usable key. */
export async function unsubscribeToken(
  env: object,
  emailId: string,
  category: EmailCategory,
): Promise<string | null> {
  const key = await keyOf(env);
  if (!key) return null;
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, payloadOf(emailId, category)));
  return `v1.${emailId}.${category}.${base64url(mac)}`;
}

/** What a token names, `invalid` for any other text, `unavailable` without a usable key. */
export async function verifyUnsubscribe(
  env: object,
  token: string,
): Promise<{ emailId: string; category: EmailCategory } | "invalid" | "unavailable"> {
  const key = await keyOf(env);
  if (!key) return "unavailable";
  const parts = token.split(".");
  if (parts.length !== 4) return "invalid";
  const [version, emailId, category, mac] = parts as [string, string, string, string];
  if (version !== "v1" || !ID.test(emailId) || !MAC.test(mac)) return "invalid";
  if (!(EMAIL_CATEGORIES as readonly string[]).includes(category)) return "invalid";
  const signature = decode(mac);
  if (signature?.length !== 32) return "invalid";
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    signature,
    payloadOf(emailId, category as EmailCategory),
  );
  return valid ? { emailId, category: category as EmailCategory } : "invalid";
}

const escapeHtml = (text: string): string =>
  text.replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch,
  );

const LISTS: Record<EmailCategory, string> = {
  direct: "what asks something of you (review requests, assignments, mentions)",
  participating: "activity on threads you take part in",
  watching: "activity in repositories you watch",
};

function page(c: Context<AppEnv>, status: 200 | 400 | 429 | 503, body: string): Response {
  return c.html(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Unsubscribe · Fyrden</title></head><body><main>${body}</main></body></html>`,
    status,
    { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  );
}

/** A throttled answer, telling when to try again. */
const throttled = (c: Context<AppEnv>) =>
  c.text("Too many requests: try again in a minute.", 429, { "Retry-After": "60" });

/** Mounts `GET`, `HEAD` and `POST /unsubscribe` (a public mail-protocol route: no credential). */
export function mountUnsubscribe(app: Hono<AppEnv>): void {
  app.on(["GET", "HEAD", "POST"], "/unsubscribe", async (c) => {
    const token = c.req.query("t") ?? "";
    const verified = await verifyUnsubscribe(c.env, token);
    if (verified === "unavailable")
      return page(c, 503, "<p>Unsubscribing is not available right now. Try again later.</p>");
    if (verified === "invalid") {
      const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
      if (!(await c.env.RATE_LIMIT_UNSUBSCRIBE_IP.limit({ key: ip })).success) return throttled(c);
      return page(c, 400, "<p>This unsubscribe link is not one Fyrden made.</p>");
    }
    const list = LISTS[verified.category];
    if (c.req.method !== "POST")
      return page(
        c,
        200,
        `<h1>Unsubscribe</h1><p>Stop emails about ${escapeHtml(list)} to this address?</p><form method="post" action="/unsubscribe?t=${encodeURIComponent(token)}"><button type="submit">Unsubscribe</button></form>`,
      );
    const key = `${verified.emailId}:${verified.category}`;
    if (!(await c.env.RATE_LIMIT_UNSUBSCRIBE.limit({ key })).success) return throttled(c);
    // Only while the address generation exists: a link replayed after it went writes nothing.
    c.get("metrics")?.count("d1.query", { db: "directory", op: "email_unsubscribe" });
    await c.env.DIRECTORY.prepare(
      `INSERT INTO email_unsubscribes (email_id, scope, at)
       SELECT ?1, ?2, ?3 WHERE EXISTS (SELECT 1 FROM user_emails WHERE id = ?1)
       ON CONFLICT (email_id, scope) DO NOTHING`,
    )
      .bind(verified.emailId, verified.category, clock())
      .run();
    return page(
      c,
      200,
      `<h1>Unsubscribed</h1><p>No more emails about ${escapeHtml(list)} will go to this address. You can change what Fyrden emails you in your settings.</p>`,
    );
  });
}
