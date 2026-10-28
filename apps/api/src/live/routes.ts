import type { Input, issueLiveTicket, Output } from "@fyrden/api-contract";
import { hashToken } from "@fyrden/domain";
import type { Context, Hono } from "hono";
import type { AppEnv } from "../app.js";
import { LIVE_ADMITTED, type LiveAdmitted } from "../do/UserDO.js";
import { LIVE_POLICY } from "../do/user/live.js";
import { SESSION_COOKIE, sessionUser } from "../oauth/session.js";
import { type OpContext, OperationError } from "../ops/execute.js";
import { clock, newId } from "../services.js";
import { liveCredential } from "./credential.js";
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
    const allowance = liveAllowance(c.env);
    if (allowance === null) return c.text("This deployment sends no live hints.", 503);
    const ticket = c.req.query("ticket") ?? "";
    // Nothing is looked up for a request that cannot hold a ticket, or past the client's limit.
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(ticket)) return c.text("No ticket.", 401);
    const client = c.req.header("CF-Connecting-IP") ?? "unknown";
    if (!(await c.env.RATE_LIMIT_AUTH.limit({ key: client })).success)
      return c.text("Too many requests.", 429, { "Retry-After": "60" });
    const credentialId = await presented(c);
    if (!credentialId) return c.text("Not signed in as the ticket's credential.", 401);
    const now = clock();
    const credential = await liveCredential(c.env.DIRECTORY, credentialId, now);
    if (!credential) return c.text("The credential no longer holds.", 401);
    const feed = c.env.USER.getByName(credential.principalId);
    c.get("metrics")?.count("do.request", { class: "UserDO", method: "liveRedeem" });
    if (!(await feed.liveRedeem(ticket, credential.id)))
      return c.text("The ticket is not this credential's, used, or expired.", 401);
    const socketId = newId("lsk");
    const expiresAt = Math.min(now + LIVE_POLICY.lifeMs, credential.expiresAt);
    c.get("metrics")?.count("d1.query", { db: "directory", op: "live_admit" }, 3);
    const refused = await admit(
      c.env.DIRECTORY,
      { id: socketId, ticketId: await hashToken(ticket), feed: credential.principalId, expiresAt },
      credential,
      allowance,
      now,
    );
    if (refused === "daily")
      return c.text("Too many live sockets opened today.", 429, { "Retry-After": "3600" });
    if (refused === "allowance")
      return c.text("The deployment has no room for another live socket.", 503, {
        "Retry-After": "60",
      });
    // Checked again now that its dependencies are indexed: a revocation swept before they were
    // would have found no socket, so authority changed since the first check refuses it.
    const again = await liveCredential(c.env.DIRECTORY, credential.id, clock());
    if (!again || again.dependencies.join("\n") !== credential.dependencies.join("\n")) {
      await release(c.env.DIRECTORY, [socketId]);
      return c.text("The credential no longer holds.", 401);
    }
    const admitted: LiveAdmitted = {
      socketId,
      credentialId: credential.id,
      expiresAt,
      scopes: credential.scopes,
      repoIds: credential.repoIds,
      dependencies: credential.dependencies,
    };
    c.get("metrics")?.count("do.request", { class: "UserDO", method: "fetch" });
    return feed.fetch(
      new Request(c.req.url, {
        headers: { Upgrade: "websocket", [LIVE_ADMITTED]: JSON.stringify(admitted) },
      }),
    );
  });
}
