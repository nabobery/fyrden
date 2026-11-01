import type { Metrics } from "@fyrden/adapters-cloudflare/obs";
import type { Input, issueLiveTicket, Output } from "@fyrden/api-contract";
import { hashToken } from "@fyrden/domain";
import type { Context, Hono } from "hono";
import type { AppEnv } from "../app.js";
import { LIVE_ADMITTED, type LiveAdmitted } from "../do/UserDO.js";
import { LIVE_POLICY } from "../do/user/live.js";
import { SESSION_COOKIE, sessionUser } from "../oauth/session.js";
import { type OpContext, OperationError } from "../ops/execute.js";
import { clock, newId } from "../services.js";
import { type LiveCredential, liveCredential } from "./credential.js";
import { admit, liveAllowance, release } from "./directory.js";

/*
 * Live notification hints: a ticket (`notifications.live_ticket`), then
 * `GET /api/notifications/live?ticket=` upgraded to a WebSocket on the
 * caller's feed object. The upgrade is outside the operation registry: a
 * browser's WebSocket carries no `X-Fyrden-Session` header, so it proves its
 * session differently. A ticket issued to a session needs that session's
 * cookie and the request's `Origin` to be this deployment's own; one issued
 * to a token needs that token in `Authorization`. A mismatch refuses before
 * the ticket is spent.
 */

const unavailable = () =>
  new OperationError(503, "live_unavailable", "This deployment sends no live hints.");

/** The `notifications.live_ticket` operation. */
export async function issueLiveTicketOperation(
  ctx: OpContext,
  _input: Input<typeof issueLiveTicket>,
): Promise<Output<typeof issueLiveTicket>> {
  if (liveAllowance(ctx.env) === null) throw unavailable();
  if (ctx.auth.grantId !== null)
    throw new OperationError(
      403,
      "delegated_listing",
      "Open live hints with the user's own credentials.",
    );
  const credential = await liveCredential(ctx.env.DIRECTORY, ctx.auth.id, clock());
  if (!credential)
    throw new OperationError(401, "invalid_token", "The token is invalid, expired or revoked.");
  ctx.metrics.count("do.request", { class: "UserDO", method: "liveTicket" });
  const ticket = await ctx.env.USER.getByName(credential.principalId).liveTicket(credential.id);
  if (ticket === null)
    throw new OperationError(401, "invalid_token", "The account is being deleted.");
  return {
    ticket,
    expires_in: LIVE_POLICY.ticketMs / 1000,
    url: `${ctx.requestOrigin.replace(/^http/, "ws")}/api/notifications/live?ticket=${encodeURIComponent(ticket)}`,
  };
}

/** Why a live socket was not opened: an HTTP status, a message and its headers. */
export interface LiveRefusal {
  readonly ok: false;
  readonly status: 401 | 409 | 429 | 503;
  readonly code: "invalid_token" | "live_conflict" | "too_many_sockets" | "live_unavailable";
  readonly message: string;
  readonly headers: Record<string, string>;
}

/**
 * Opens a live socket of `credential` on its feed's object, once whatever
 * proved the request is spent (a ticket, or an authenticated MCP listen):
 * admitted by the directory (the deployment's allowance, the principal's
 * daily admissions), checked again now that its dependencies are indexed,
 * then handed to the object, which confirms it and applies the caps. The
 * object's 101 carries the socket; `ticketId` is unique to the admission.
 */
export async function openLiveSocket(
  env: Env,
  credential: LiveCredential,
  ticketId: string,
  metrics: Metrics | undefined,
): Promise<{ readonly ok: true; readonly response: Response } | LiveRefusal> {
  const refused = (
    status: LiveRefusal["status"],
    code: LiveRefusal["code"],
    message: string,
    headers: Record<string, string> = {},
  ): LiveRefusal => ({ ok: false, status, code, message, headers });
  const allowance = liveAllowance(env);
  if (allowance === null)
    return refused(503, "live_unavailable", "This deployment sends no live hints.");
  const now = clock();
  const socketId = newId("lsk");
  const expiresAt = Math.min(now + LIVE_POLICY.lifeMs, credential.expiresAt);
  metrics?.count("d1.query", { db: "directory", op: "live_admit" }, 3);
  const refusal = await admit(
    env.DIRECTORY,
    { id: socketId, ticketId, feed: credential.principalId, expiresAt },
    credential,
    allowance,
    now,
  );
  if (refusal === "daily")
    return refused(429, "too_many_sockets", "Too many live sockets opened today.", {
      "Retry-After": "3600",
    });
  if (refusal === "allowance")
    return refused(503, "live_unavailable", "The deployment has no room for another live socket.", {
      "Retry-After": "60",
    });
  // Checked again now that its dependencies are indexed: a revocation swept before they were
  // would have found no socket, so authority changed since the first check refuses it. The
  // lease is this function's until the object takes the socket: released if this fails.
  let holds: boolean;
  try {
    const again = await liveCredential(env.DIRECTORY, credential.id, clock());
    holds = again !== null && again.dependencies.join("\n") === credential.dependencies.join("\n");
  } catch (error) {
    await release(env.DIRECTORY, [socketId]).catch(() => {});
    throw error;
  }
  if (!holds) {
    await release(env.DIRECTORY, [socketId]);
    return refused(401, "invalid_token", "The credential no longer holds.");
  }
  const admitted: LiveAdmitted = {
    socketId,
    credentialId: credential.id,
    expiresAt,
    scopes: credential.scopes,
    repoIds: credential.repoIds,
    dependencies: credential.dependencies,
  };
  metrics?.count("do.request", { class: "UserDO", method: "fetch" });
  // From here the object owns it: it releases a socket it refuses, and one whose answer is lost
  // here closes at its renewal deadline, nothing renewing it.
  const response = await env.USER.getByName(credential.principalId).fetch(
    new Request("https://user.internal/live", {
      headers: { Upgrade: "websocket", [LIVE_ADMITTED]: JSON.stringify(admitted) },
    }),
  );
  if (response.status === 101 && response.webSocket) return { ok: true, response };
  // The object released its lease: past a cap, its credential revoked or its feed retired, or
  // its confirmation lost.
  if (response.status === 429)
    return refused(429, "too_many_sockets", "This credential or feed holds its most live sockets.");
  if (response.status === 410)
    return refused(401, "invalid_token", "The credential no longer holds.");
  return refused(409, "live_conflict", "The live socket could not be confirmed; try again.");
}

/** The credential a live upgrade presents: the session of its cookie, or its bearer token. */
async function presented(c: Context<AppEnv>): Promise<string | null> {
  const authorization = c.req.header("Authorization");
  // A DPoP-bound token proves its key per request; live sockets take none (see `liveCredential`).
  if (authorization !== undefined && !authorization.startsWith("Bearer ")) return null;
  const bearer = /^Bearer (\S+)$/.exec(authorization ?? "")?.[1];
  if (bearer) {
    const row = await c.env.DIRECTORY.withSession("first-primary")
      .prepare("SELECT id FROM tokens WHERE token_hash = ?")
      .bind(await hashToken(bearer))
      .first<{ id: string }>();
    return row?.id ?? null;
  }
  // A browser: its session, from this deployment's own pages only.
  const origin = c.req.header("Origin");
  if (origin !== new URL(c.req.url).origin) return null;
  if (!c.req.header("Cookie")?.includes(`${SESSION_COOKIE}=`)) return null;
  const user = await sessionUser(c as never);
  return user?.sessionId ?? null;
}

/** Mounts `GET /api/notifications/live` (the WebSocket upgrade). */
export function mountLive(app: Hono<AppEnv>): void {
  app.get("/api/notifications/live", async (c, next) => {
    // Only an upgrade is this route's: any other request goes on to the API, which has no
    // `GET` there (404).
    if (c.req.header("Upgrade") !== "websocket") return next();
    if (liveAllowance(c.env) === null) return c.text("This deployment sends no live hints.", 503);
    const ticket = c.req.query("ticket") ?? "";
    // Nothing is looked up for a request that cannot hold a ticket, or past the client's limit.
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(ticket)) return c.text("No ticket.", 401);
    const client = c.req.header("CF-Connecting-IP") ?? "unknown";
    if (!(await c.env.RATE_LIMIT_AUTH.limit({ key: client })).success)
      return c.text("Too many requests.", 429, { "Retry-After": "60" });
    const credentialId = await presented(c);
    if (!credentialId) return c.text("Not signed in as the ticket's credential.", 401);
    const credential = await liveCredential(c.env.DIRECTORY, credentialId, clock());
    if (!credential) return c.text("The credential no longer holds.", 401);
    const feed = c.env.USER.getByName(credential.principalId);
    c.get("metrics")?.count("do.request", { class: "UserDO", method: "liveRedeem" });
    if (!(await feed.liveRedeem(ticket, credential.id)))
      return c.text("The ticket is not this credential's, used, or expired.", 401);
    const opened = await openLiveSocket(
      c.env,
      credential,
      await hashToken(ticket),
      c.get("metrics"),
    );
    if (!opened.ok) return c.text(opened.message, opened.status, opened.headers);
    return opened.response;
  });
}
