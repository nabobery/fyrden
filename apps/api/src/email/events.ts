import { createLogger } from "@fyrden/adapters-cloudflare/obs";
import type { Context, Hono } from "hono";
import type { AppEnv } from "../app.js";
import { readBoundedBody } from "../http/body.js";
import { clock } from "../services.js";
import { applying, suppressionOf } from "./suppressions.js";
import { verifyWebhook, webhookKey } from "./webhook-signature.js";

/*
 * The email provider's callbacks: `POST /auth/email/events` (public, under
 * `/auth/` so the web Worker forwards it and no owner's path is taken),
 * signed as Standard Webhooks with the Worker secret
 * `RESEND_WEBHOOK_SECRET`. The webhook subscribes to `suppression.added`
 * and `suppression.removed`, applied to Fyrden's copy of the provider's
 * suppression list (`suppressions.ts`); other events are acknowledged and
 * ignored. A request whose signature does not verify costs no directory
 * work, only the per-client limiter. Acknowledged only once its write
 * committed: a failure answers 500 and the provider tries again.
 */

/** The largest body read. */
export const EVENT_BODY_LIMIT = 64 * 1024;

/** The secret's key, by its text, an isolate (a missing or malformed secret logged once). */
let cached: { text: string | undefined; key: CryptoKey | null } | undefined;

async function keyOf(env: object): Promise<CryptoKey | null> {
  const value = (env as { RESEND_WEBHOOK_SECRET?: unknown }).RESEND_WEBHOOK_SECRET;
  const text = typeof value === "string" && value !== "" ? value : undefined;
  if (cached && cached.text === text) return cached.key;
  const key = text === undefined ? null : await webhookKey(text);
  if (!key)
    createLogger({ op: "email.events" }).error(
      text === undefined
        ? "RESEND_WEBHOOK_SECRET is not set: the provider's callbacks are refused"
        : "RESEND_WEBHOOK_SECRET is not a whsec_ secret: the provider's callbacks are refused",
    );
  cached = { text, key };
  return key;
}

/** An answer to a request that did not verify, after the client's limiter. */
async function unverified(c: Context<AppEnv>, status: 401 | 413): Promise<Response> {
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  if (!(await c.env.RATE_LIMIT_EMAIL_EVENTS_IP.limit({ key: ip })).success)
    return c.text("Too many requests.", 429, { "Retry-After": "60" });
  return c.text(status === 413 ? "Too large." : "Not signed by the provider.", status);
}

/** Mounts `POST /auth/email/events`. */
export function mountEmailEvents(app: Hono<AppEnv>): void {
  app.post("/auth/email/events", async (c) => {
    const key = await keyOf(c.env);
    if (!key) return c.text("Not configured.", 503);
    // The bytes as received: the signature covers them, not a decoding of them.
    const body = await readBoundedBody(c.req.raw, EVENT_BODY_LIMIT);
    if (body === undefined) return unverified(c, 413);
    if (!(await verifyWebhook(key, c.req.raw.headers, body, Date.now()))) return unverified(c, 401);
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(body));
    } catch {
      parsed = undefined;
    }
    const log = c.get("log") ?? createLogger({ op: "email.events" });
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      log.warn("a signed callback that is not a JSON object");
      return c.text("Unreadable event.", 400);
    }
    const event = parsed as { type?: unknown; data?: unknown };
    if (event.type !== "suppression.added" && event.type !== "suppression.removed") {
      c.get("metrics")?.count("email.event", { type: "ignored" });
      return c.json({});
    }
    const suppression = suppressionOf(event.data);
    if (!suppression) {
      log.warn("a signed suppression event that could not be read", { type: event.type });
      return c.text("Unreadable event.", 400);
    }
    c.get("metrics")?.count("email.event", { type: event.type });
    c.get("metrics")?.count("d1.query", { db: "directory", op: "email_suppression" });
    await applying(c.env.DIRECTORY, suppression, event.type === "suppression.added", clock()).run();
    return c.json({});
  });
}
