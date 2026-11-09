import { d1RowsRun, type Logger, type Metrics } from "@fyrden/adapters-cloudflare/obs";
import type { Input, issueLiveTicket, Output } from "@fyrden/api-contract";
import { hashToken } from "@fyrden/domain";
import type { Context, Hono } from "hono";
import type { AppEnv } from "../app.js";
import {
  LIVE_BUDGET,
  LIVE_TURN_WANTED,
  type LiveAdmitted,
  type LiveBudgetV1,
} from "../do/UserDO.js";
import { LIVE_POLICY, ticketHash } from "../do/user/live.js";
import { randomSecret } from "../oauth/params.js";
import { SESSION_COOKIE, sessionUser } from "../oauth/session.js";
import { type OpContext, OperationError } from "../ops/execute.js";
import { clock, newId } from "../services.js";
import {
  LIVE_NOW,
  type LiveEnvelope,
  type LiveRefusalReason,
  liveOpeningFits,
  liveTryAgain,
  makeLiveGrant,
} from "./budget.js";
import { type LiveCredential, liveCredential } from "./credential.js";
import { admit, LIVE_ADMISSION, liveAllowance, release } from "./directory.js";
import {
  type FundedResult,
  fund,
  LIVE_MANIFEST_REVISION,
  type LiveOpeningTarget,
  liveOpeningTarget,
  liveTarget,
  ownedCall,
  ownedRun,
  planFor,
} from "./funding.js";
import { LIVE_BLOCK_UNITS, LIVE_PRICES, type LiveManifestEntry, liveKindOf } from "./manifest.js";
import { liveRefusalMemo } from "./refusal-memo.js";
import { claimTransport, type LiveTransport } from "./transports.js";

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

/** Tickets a principal is issued a UTC day at most (each counted with its transport). */
export const LIVE_TICKETS_A_DAY = 60;

const DAY = 86_400_000;

/** A funding refusal, as the ticket operation answers it. */
function refusal(result: {
  readonly reason: "daily" | "temporary";
  readonly retryAt?: number;
  readonly gate?: LiveRefusalReason;
}) {
  if (result.reason === "daily" && result.retryAt !== undefined)
    return new OperationError(
      429,
      "live_budget",
      "Live hints have spent today's allowance. Try again tomorrow (UTC).",
      undefined,
      undefined,
      Math.max(1, Math.ceil((result.retryAt - clock()) / 1000)),
      result.retryAt,
      result.gate,
    );
  return new OperationError(
    503,
    "live_temporary",
    "Live hints cannot be funded right now. Try again shortly.",
    undefined,
    undefined,
    60,
    undefined,
    result.gate ?? "unknown",
  );
}

/**
 * One live opening refused, once its work is over: counted with every D1 row its
 * invocation read so far, apart from each grant's own refusal (`live.grant_refusal`). A keyed
 * ticket's idempotency answer is written after this, its rows not among them.
 */
export function noteLiveRefusal(
  metrics: Metrics | undefined,
  log: Logger | undefined,
  path: "ticket" | "listen" | "upgrade",
  reason: LiveRefusalReason,
): void {
  metrics?.count("live.refusal", { unit: path, gate: reason });
  metrics?.count("live.refused_rows", { unit: path }, d1RowsRun().read);
  log?.info("live refused", { path, reason });
}

type Unit =
  | "ticket"
  | "upgrade_transport"
  | "admission"
  | "terminal"
  | "control_block"
  | "mark_block"
  | "pump";

/** The plan of `unit` for `target`'s feed, starting at the ledger's time. */
const planOf = (target: LiveOpeningTarget, recipient: string, unit: Unit) =>
  planFor(
    LIVE_PRICES[unit] as LiveManifestEntry,
    {
      incarnation: target.incarnation,
      epoch: target.epoch,
      recipientType: "UserDO",
      recipient,
      class: "ordinary",
      kind: liveKindOf(unit),
      producesLocal: unit !== "upgrade_transport",
    },
    target.ledger.now,
  );

const grantFor = (target: LiveOpeningTarget, recipient: string, unit: Unit) =>
  makeLiveGrant(planOf(target, recipient, unit));

/**
 * Why `units` cannot all fit, seen before any is charged (null when they can),
 * remembered when the transport alone cannot, which closes every opening.
 */
function openingRefusal(
  target: LiveOpeningTarget,
  recipient: string,
  units: readonly Unit[],
  ownerPlaces: number,
) {
  const plans = units.map((unit) => planOf(target, recipient, unit));
  const fit = liveOpeningFits(target.view, plans, ownerPlaces);
  if (fit.fits) return null;
  const alone = liveOpeningFits(target.view, [planOf(target, recipient, "upgrade_transport")]);
  if (!alone.fits) liveRefusalMemo.note(alone, clock());
  return fit;
}

/** The units an opening of `target`'s feed is granted: its blocks and turn only when it holds none. */
export const socketUnits = (target: LiveOpeningTarget): Unit[] => [
  "admission",
  "terminal",
  ...(target.controlsHeld ? [] : (["control_block"] as const)),
  ...(target.marksHeld ? [] : (["mark_block"] as const)),
  ...(target.turnHeld ? [] : (["pump"] as const)),
];

/**
 * The units an opening's pre-check counts for `target`'s feed: its grants, and its turn always.
 * The directory can hold a turn the feed's object has lost (its delivery never arrived, or it was
 * fenced), and the object then asks for one after the others are charged; counted here, that
 * request is never refused with the others' charges standing. An opening within one turn's price
 * of the day's room is refused, though its feed may hold a turn that would have served it.
 */
export const checkedUnits = (target: LiveOpeningTarget): Unit[] =>
  socketUnits({ ...target, turnHeld: false });

/** How long `kind`'s owned call is waited for at most. */
const pendingOf = (kind: "ticket" | "upgrade_transport") =>
  (LIVE_PRICES[kind] as LiveManifestEntry).pendingMs as number;

/**
 * Counts a ticket for `transport.feed` today (D1's day) and records its
 * transport, in one batch: neither past the day's `LIVE_TICKETS_A_DAY`.
 * The day's start of the next day when the day is full, else null.
 */
async function countTicket(db: D1Database, transport: LiveTransport): Promise<number | null> {
  const day = `CAST(${LIVE_NOW} / ${DAY} AS INTEGER)`;
  const [counted, , next] = await db.batch<{ issued?: number; tomorrow?: number }>([
    db
      .prepare(
        `INSERT INTO live_ticket_days (principal_id, day, issued) VALUES (?1, ${day}, 1)
         ON CONFLICT (principal_id, day) DO UPDATE SET issued = issued + 1 WHERE issued < ?2
         RETURNING issued`,
      )
      .bind(transport.feed, LIVE_TICKETS_A_DAY),
    db
      .prepare(
        `INSERT INTO live_ticket_transports (ticket_hash, feed, credential_id, expires_at,
           operation_id, envelope_json) SELECT ?1, ?2, ?3, ?4, ?5, ?6 WHERE changes() > 0`,
      )
      .bind(
        transport.ticketHash,
        transport.feed,
        transport.credentialId,
        transport.expiresAt,
        transport.operationId,
        transport.envelope === null ? null : JSON.stringify(transport.envelope),
      ),
    db.prepare(`SELECT (${day} + 1) * ${DAY} AS tomorrow`),
  ]);
  if (counted?.results[0]) return null;
  return (
    (next?.results[0]?.tomorrow as number | undefined) ?? (Math.floor(clock() / DAY) + 1) * DAY
  );
}

/**
 * The `notifications.live_ticket` operation: a ticket, funded before
 * anything is woken. A principal past the day's tickets is refused before
 * anything is paid for. Then its transport's grant (it pays for the
 * redemption, and a refusal's upgrade, later), counted with the day's
 * tickets and recorded in the directory; then the ticket's own grant, an
 * owned call of the feed's object that stores it. The ticket is made and
 * hashed here; only its hash leaves, and it is answered with the life it
 * has left. Anything failing on the way is refused for now.
 */
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
  const remembered = liveRefusalMemo.closed(clock());
  if (remembered) {
    noteLiveRefusal(ctx.metrics, ctx.log, "ticket", remembered.gate);
    throw refusal(remembered);
  }
  const db = ctx.env.DIRECTORY;
  const credential = await liveCredential(db, ctx.auth.id, clock());
  if (!credential)
    throw new OperationError(401, "invalid_token", "The token is invalid, expired or revoked.");
  const feed = credential.principalId;
  try {
    return await issueTicket(ctx, credential, feed);
  } catch (error) {
    const refused = error instanceof OperationError ? error : null;
    if (!refused) ctx.log.error("live ticket issuance failed", { error });
    const answer = refused ?? refusal({ reason: "temporary", gate: "unknown" });
    if (answer.reason !== undefined)
      noteLiveRefusal(ctx.metrics, ctx.log, "ticket", answer.reason as LiveRefusalReason);
    throw answer;
  }
}

async function issueTicket(
  ctx: OpContext,
  credential: LiveCredential,
  feed: string,
): Promise<Output<typeof issueLiveTicket>> {
  const db = ctx.env.DIRECTORY;
  const ticket = randomSecret(32);
  const hash = await ticketHash(ticket);
  ctx.metrics.count("d1.query", { db: "directory", op: "live_target" });
  // Plans start at the ledger's time (D1's), never ahead of it.
  const target = await liveOpeningTarget(db, feed);
  // Past the day's tickets: refused before a transport is paid for (the count below decides).
  if (target.ticketsToday >= LIVE_TICKETS_A_DAY)
    throw refusal({ reason: "daily", retryAt: target.tomorrow, gate: "tickets" });
  // A ticket that could only be refused at its redemption is not paid for. Told as a spent day,
  // which is what a browser waits for.
  if (target.admissionsToday >= LIVE_ADMISSION.perDay)
    throw refusal({ reason: "daily", retryAt: nextDay(clock()), gate: "admissions" });
  // Its socket's too: a ticket its redemption could only be refused for is not paid for.
  const unfit = openingRefusal(
    target,
    feed,
    ["upgrade_transport", "ticket", ...checkedUnits(target)],
    1,
  );
  if (unfit) throw refusal(unfit);
  // The redemption's funding, made with the ticket: a ticket that cannot be redeemed is not issued.
  ctx.metrics.count("d1.query", { db: "directory", op: "live_grant" });
  const transport = await fund(db, await grantFor(target, feed, "upgrade_transport"), ctx.metrics);
  if (transport.status !== "funded") {
    liveRefusalMemo.note(transport, clock());
    throw refusal(transport);
  }
  // The ticket lives by the clock its redemption is judged by (this Worker's, its object's).
  const expiresAt = clock() + LIVE_POLICY.ticketMs;
  ctx.metrics.count("d1.query", { db: "directory", op: "live_ticket_count" });
  const full = await countTicket(db, {
    ticketHash: hash,
    feed,
    credentialId: credential.id,
    expiresAt,
    operationId: transport.value.operationId,
    envelope: transport.value,
  });
  if (full !== null) throw refusal({ reason: "daily", retryAt: full, gate: "tickets" });
  ctx.metrics.count("do.request", { class: "UserDO", method: "liveTicketV1" });
  const stored = await ownedCall(
    db,
    await grantFor(target, feed, "ticket"),
    "ticket",
    (funding) =>
      ctx.env.USER.getByName(feed).liveTicketV1(funding, {
        hash,
        credentialId: credential.id,
        expiresAt,
        transport: { operationId: transport.value.operationId },
      }),
    { ledger: target.ledger, pendingMs: pendingOf("ticket"), metrics: ctx.metrics },
  );
  if (stored.status !== "funded") throw refusal(stored);
  if (stored.value.status === "retired")
    throw new OperationError(401, "invalid_token", "The account is being deleted.");
  // Stored with the life it has left: a ticket with under a second of it is not handed out.
  const left = Math.floor((expiresAt - clock()) / 1000);
  if (stored.value.status !== "stored" || left < 1)
    throw refusal({
      reason: "temporary",
      gate: stored.value.status === "stored" ? "given_up" : "validity",
    });
  return {
    ticket,
    expires_in: left,
    url: `${ctx.requestOrigin.replace(/^http/, "ws")}/api/notifications/live?ticket=${encodeURIComponent(ticket)}`,
  };
}

/** Why a live socket was not opened: an HTTP status, a message and its headers. */
export interface LiveRefusal {
  readonly ok: false;
  readonly status: 401 | 409 | 429 | 503;
  readonly code:
    | "invalid_token"
    | "live_conflict"
    | "too_many_sockets"
    | "live_unavailable"
    | "live_budget"
    | "live_temporary";
  readonly message: string;
  readonly headers: Record<string, string>;
  /**
   * How a browser's upgrade is refused, its credential holding: today's
   * allowance (or the principal's day) spent, until `retryAt` (4413), or
   * for now (4412). None for a credential that no longer holds.
   */
  readonly budget?: "daily" | "temporary";
  readonly retryAt?: number;
  /** Which check refused it. */
  readonly gate?: LiveRefusalReason;
}

type Opened = { readonly ok: true; readonly response: Response } | LiveRefusal;

const refused = (
  status: LiveRefusal["status"],
  code: LiveRefusal["code"],
  message: string,
  budget: LiveRefusal["budget"],
  headers: Record<string, string> = {},
  gate?: LiveRefusalReason,
): LiveRefusal => ({
  ok: false,
  status,
  code,
  message,
  headers,
  ...(budget ? { budget } : {}),
  ...(gate ? { gate } : {}),
});

/** Refused for now: a retry soon may succeed. */
const temporary = (gate: LiveRefusalReason, message = "Live hints cannot be funded right now.") =>
  refused(503, "live_temporary", message, "temporary", { "Retry-After": "60" }, gate);

const nextDay = (now: number) => (Math.floor(now / DAY) + 1) * DAY;

const pastAdmissions = (now: number) =>
  daily("too_many_sockets", "Too many live sockets opened today.", nextDay(now), "admissions");

/** The pre-check's refusal, as an opening answers it. */
const unfitAnswer = (fit: {
  reason: "daily" | "temporary";
  gate: LiveRefusalReason;
  retryAt?: number;
}) =>
  fit.reason === "daily" && fit.retryAt !== undefined
    ? daily("live_budget", "Live hints have spent today's allowance.", fit.retryAt, fit.gate)
    : temporary(fit.gate);

/** The refusal this isolate remembers for any new opening (see `liveRefusalMemo`), if any. */
export function rememberedRefusal(): LiveRefusal | null {
  const closure = liveRefusalMemo.closed(clock());
  return closure && unfitAnswer(closure);
}

/** Refused until `retryAt` (the next UTC day). */
const daily = (
  code: "live_budget" | "too_many_sockets",
  message: string,
  retryAt: number,
  gate?: LiveRefusalReason,
) => ({
  ...refused(
    429,
    code,
    message,
    "daily",
    { "Retry-After": String(Math.max(1, Math.ceil((retryAt - clock()) / 1000))) },
    gate,
  ),
  retryAt,
});

/**
 * Opens a live socket of `credential` on its feed's object, once whatever
 * proved the request is spent (a ticket, or an authenticated MCP listen),
 * as the owned work of its transport (`signal` aborted once that outlasts
 * its pending bound: nothing more is done, a lease taken released). The
 * admission's own grant first; then admitted by the directory against it
 * (the deployment's allowance, the principal's daily admissions), checked
 * again now that its dependencies are indexed, then handed to the object
 * with the grant, which confirms it and applies the caps. The object's 101
 * carries the socket; `ticketId` is unique to the admission.
 */
export async function openLiveSocket(
  env: Env,
  credential: LiveCredential,
  ticketId: string,
  metrics: Metrics | undefined,
  signal: AbortSignal,
): Promise<Opened> {
  const allowance = liveAllowance(env);
  if (allowance === null)
    return refused(503, "live_unavailable", "This deployment sends no live hints.", undefined);
  // Its grants first: no lease or local obligation before they are paid for. The admission, its
  // end on each day it may live on, and the feed's first blocks of controls and marks, granted
  // together, with the feed's first turn when it holds none (one refused refuses the socket; the
  // others' charges stand).
  const target = await liveOpeningTarget(env.DIRECTORY, credential.principalId);
  // Refused here, nothing is charged beyond the transport that already paid.
  if (target.admissionsToday >= LIVE_ADMISSION.perDay) return pastAdmissions(clock());
  // Its feed's blocks and turn only when it holds none still valid (refills top its pools up);
  // the pre-check counts its turn always.
  const units = socketUnits(target);
  const unfit = openingRefusal(target, credential.principalId, checkedUnits(target), 0);
  if (unfit) return unfitAnswer(unfit);
  metrics?.count("d1.query", { db: "directory", op: "live_grant" }, units.length + 1);
  const grants = await Promise.all(
    units.map(async (unit) =>
      fund(env.DIRECTORY, await grantFor(target, credential.principalId, unit), metrics),
    ),
  );
  const granted = (unit: (typeof units)[number]) => grants[units.indexOf(unit)];
  const [admission, terminal] = grants;
  const [controls, marks, turn] = [
    granted("control_block"),
    granted("mark_block"),
    granted("pump"),
  ];
  if (
    admission?.status !== "funded" ||
    terminal?.status !== "funded" ||
    grants.some((g) => g.status !== "funded")
  ) {
    const spent = grants.find((g) => g.status === "refused" && g.reason === "daily");
    if (spent?.status === "refused" && spent.reason === "daily")
      return daily(
        "live_budget",
        "Live hints have spent today's allowance.",
        spent.retryAt,
        spent.gate,
      );
    const first = grants.find((g) => g.status === "refused");
    return temporary(first?.status === "refused" ? first.gate : "unknown");
  }
  if (signal.aborted) return temporary("given_up");
  const now = clock();
  const socketId = newId("lsk");
  // Never past what its end is provided for: its terminal grant's validity (the ledger's time,
  // on this Worker's clock as sampled), a minute kept.
  const expiresAt = Math.min(
    now + LIVE_POLICY.lifeMs,
    credential.expiresAt,
    terminal.value.plan.validUntil - target.ledger.now + target.ledger.at - 60_000,
  );
  metrics?.count("d1.query", { db: "directory", op: "live_admit" }, 3);
  // Its lease lapses past its first renewal deadline unless renewals extend it.
  const leaseUntil = Math.min(expiresAt, now + LIVE_POLICY.renewMs + LIVE_ADMISSION.leaseMarginMs);
  const refusal = await admit(
    env.DIRECTORY,
    { id: socketId, ticketId, feed: credential.principalId, expiresAt: leaseUntil },
    credential,
    allowance,
    now,
    admission.value.operationId,
  );
  if (refusal === "daily") return pastAdmissions(now);
  if (refusal === "allowance")
    return temporary("allowance", "The deployment has no room for another live socket.");
  if (refusal === "funding") return temporary("validity");
  // The lease is this function's until the object takes the socket: released if what follows
  // fails, or once it is given up on.
  if (signal.aborted) {
    await release(env.DIRECTORY, [socketId]);
    return temporary("given_up");
  }
  // Checked again now that its dependencies are indexed: a revocation swept before they were
  // would have found no socket, so authority changed since the first check refuses it.
  let holds: boolean;
  try {
    const again = await liveCredential(env.DIRECTORY, credential.id, clock());
    holds = again !== null && again.dependencies.join("\n") === credential.dependencies.join("\n");
  } catch (error) {
    await release(env.DIRECTORY, [socketId]).catch(() => {});
    throw error;
  }
  if (!holds || signal.aborted) {
    await release(env.DIRECTORY, [socketId]);
    return holds
      ? temporary("given_up")
      : refused(401, "invalid_token", "The credential no longer holds.", undefined);
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
  const funding = (envelope: LiveEnvelope, quantity = 1) => ({
    protocol: 1,
    revision: LIVE_MANIFEST_REVISION,
    envelope,
    quantity,
    ownerId: null,
  });
  const budget: LiveBudgetV1 = {
    admitted,
    admission: funding(admission.value),
    terminal: funding(terminal.value),
    ...(controls?.status === "funded" && {
      controls: funding(controls.value, LIVE_BLOCK_UNITS),
    }),
    ...(marks?.status === "funded" && { marks: funding(marks.value, LIVE_BLOCK_UNITS) }),
    ...(turn?.status === "funded" && { turn: funding(turn.value) }),
  };
  const response = await env.USER.getByName(credential.principalId).fetch(
    new Request("https://user.internal/live", {
      headers: { Upgrade: "websocket", [LIVE_BUDGET]: JSON.stringify(budget) },
    }),
  );
  if (response.status === 101 && response.webSocket) {
    // Opened only after it was given up on: nobody takes it, so it is closed at once (its object
    // releasing its lease as for any close).
    if (signal.aborted) {
      response.webSocket.accept();
      response.webSocket.close(4412, liveTryAgain("given_up"));
      return temporary("given_up");
    }
    // The feed holds no turn to run (its first was never delivered, say): one granted and handed
    // over now, after the socket (whose opening does not wait on it). Refused or lost, the socket
    // would have nothing to renew it or send it hints: it is refused as its admission would be.
    const wanted = response.headers.get(LIVE_TURN_WANTED);
    const delivered =
      wanted && turn === undefined
        ? await deliverTurn(
            env,
            target,
            credential.principalId,
            metrics,
            Number(wanted) || 0,
          ).catch(
            (): FundedResult<never> => ({
              status: "refused",
              reason: "temporary",
              gate: "unknown",
            }),
          )
        : null;
    if (delivered?.status === "refused") {
      response.webSocket.accept();
      if (delivered.reason === "daily") {
        response.webSocket.close(4413, "today's allowance is spent");
        return daily(
          "live_budget",
          "Live hints have spent today's allowance.",
          delivered.retryAt,
          delivered.gate,
        );
      }
      response.webSocket.close(4412, liveTryAgain(delivered.gate));
      return temporary(delivered.gate);
    }
    // Given up on while it was handed over: nobody takes the socket, so it is closed at once.
    if (signal.aborted) {
      response.webSocket.accept();
      response.webSocket.close(4412, liveTryAgain("given_up"));
      return temporary("given_up");
    }
    return {
      ok: true,
      response: new Response(null, { status: 101, webSocket: response.webSocket }),
    };
  }
  // The object released its lease: past a cap, its credential revoked or its feed retired, or
  // its confirmation lost.
  if (response.status === 429)
    return refused(
      429,
      "too_many_sockets",
      "This credential or feed holds its most live sockets.",
      "temporary",
      { "Retry-After": "60" },
      "feed_cap",
    );
  if (response.status === 410)
    return refused(401, "invalid_token", "The credential no longer holds.", undefined);
  return {
    ...refused(
      409,
      "live_conflict",
      "The live socket could not be confirmed; try again.",
      "temporary",
      {},
      "conflict",
    ),
  };
}

/**
 * Grants the feed a turn and hands it to its object to prepare; its grant's refusal, if any. It
 * starts no earlier than `from`, the latest start of a turn the object prepared: this opening's
 * look at the ledger may be older than turns that ran since, and a turn starting before them would
 * end before them, so an opening's lookup of the newest few would pass over the one held.
 */
async function deliverTurn(
  env: Env,
  target: LiveOpeningTarget,
  feed: string,
  metrics: Metrics | undefined,
  from: number,
): Promise<FundedResult<void>> {
  metrics?.count("d1.query", { db: "directory", op: "live_grant" });
  const turn = await fund(
    env.DIRECTORY,
    await makeLiveGrant(
      planOf(
        { ...target, ledger: { ...target.ledger, now: Math.max(target.ledger.now, from) } },
        feed,
        "pump",
      ),
    ),
    metrics,
  );
  if (turn.status !== "funded") return turn;
  metrics?.count("do.request", { class: "UserDO", method: "liveTurnV1" });
  await env.USER.getByName(feed).liveTurnV1({
    protocol: 1,
    revision: LIVE_MANIFEST_REVISION,
    envelope: turn.value,
    quantity: 1,
    ownerId: null,
  });
  return { status: "funded", value: undefined };
}

/**
 * Opens a live socket of `credential` with no ticket (an MCP listen): its
 * transport's grant made here, and the opening run as that transport's
 * owned work, as a ticket's redemption is. A refusal of the transport is
 * answered as the opening's own.
 */
export async function openOwnedLiveSocket(
  env: Env,
  credential: LiveCredential,
  ticketId: string,
  metrics: Metrics | undefined,
): Promise<Opened> {
  metrics?.count("d1.query", { db: "directory", op: "live_grant" }, 2);
  const feed = credential.principalId;
  const target = await liveOpeningTarget(env.DIRECTORY, feed);
  if (target.admissionsToday >= LIVE_ADMISSION.perDay) return pastAdmissions(clock());
  const unfit = openingRefusal(target, feed, ["upgrade_transport", ...checkedUnits(target)], 1);
  if (unfit) return unfitAnswer(unfit);
  const transport = await fund(
    env.DIRECTORY,
    await grantFor(target, feed, "upgrade_transport"),
    metrics,
  );
  if (transport.status !== "funded") {
    liveRefusalMemo.note(transport, clock());
    return unfitAnswer(transport);
  }
  const opened = await ownedRun(
    env.DIRECTORY,
    transport.value,
    "upgrade",
    (_funding, signal) => openLiveSocket(env, credential, ticketId, metrics, signal),
    {
      ledger: target.ledger,
      pendingMs: pendingOf("upgrade_transport"),
      ...(metrics && { metrics }),
    },
  );
  return opened.status === "funded" ? opened.value : unfitAnswer(opened);
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
    const db = c.env.DIRECTORY;
    const metrics = c.get("metrics");
    const hash = await ticketHash(ticket);
    const notTheirs = () => c.text("The ticket is not this credential's, used, or expired.", 401);
    // The ticket's transport, claimed once: what pays for this whole attempt.
    metrics?.count("d1.query", { db: "directory", op: "live_transport_claim" }, 2);
    const transport = await claimTransport(db, hash, credential.id, crypto.randomUUID(), clock());
    if (!transport?.envelope || transport.feed !== credential.principalId) return notTheirs();
    const ledger = await liveTarget(db, credential.principalId)
      .then((target) => target.ledger)
      .catch(() => undefined);
    const feed = c.env.USER.getByName(credential.principalId);
    // Refused for its funding or capacity, its credential holding: upgraded to be closed with why
    // (4413 today's allowance or the principal's day spent, 4412 try again soon, naming why), paid
    // for by the transport.
    // What refused it, counted once the attempt's accounting is over.
    const seen: { reason?: LiveRefusalReason } = {};
    const refuse = (code: 4412 | 4413, funding: unknown, reason: LiveRefusalReason) => {
      seen.reason = reason;
      const refusal: LiveBudgetV1 = { refusal: code, transport: funding, reason };
      metrics?.count("do.request", { class: "UserDO", method: "fetch" });
      return feed.fetch(
        new Request("https://user.internal/live", {
          headers: { Upgrade: "websocket", [LIVE_BUDGET]: JSON.stringify(refusal) },
        }),
      );
    };
    const attempt = await ownedRun(
      db,
      transport.envelope,
      "upgrade",
      async (funding, signal) => {
        metrics?.count("do.request", { class: "UserDO", method: "liveRedeemV1" });
        const redeemed = await feed.liveRedeemV1(funding, hash, credential.id);
        // Its funding refused by the feed (fenced since it was granted): for now, not the ticket.
        if (redeemed === "refused") return refuse(4412, funding, "epoch");
        if (redeemed !== "redeemed" || signal.aborted) return notTheirs();
        const opened = await openLiveSocket(c.env, credential, hash, metrics, signal).catch(
          (error: unknown) => {
            c.get("log")?.error("live socket opening failed", { error });
            return temporary("unknown");
          },
        );
        if (opened.ok) return opened.response;
        if (!opened.budget || signal.aborted) {
          if (opened.gate) seen.reason = opened.gate;
          return c.text(opened.message, opened.status, opened.headers);
        }
        return refuse(opened.budget === "daily" ? 4413 : 4412, funding, opened.gate ?? "unknown");
      },
      {
        ...(ledger ? { ledger } : {}),
        pendingMs: pendingOf("upgrade_transport"),
        ...(metrics && { metrics }),
      },
    );
    if (attempt.status === "funded") {
      if (seen.reason) noteLiveRefusal(metrics, c.get("log"), "upgrade", seen.reason);
      return attempt.value;
    }
    noteLiveRefusal(metrics, c.get("log"), "upgrade", attempt.gate);
    // Its owner not admitted (owner capacity), or its run failed: refused for now, paid for by the
    // transport with no owner named. Only an unreachable feed answers over HTTP.
    try {
      return await refuse(
        4412,
        {
          protocol: 1,
          revision: LIVE_MANIFEST_REVISION,
          envelope: transport.envelope,
          quantity: 1,
          ownerId: null,
        },
        attempt.gate,
      );
    } catch {
      return c.text("Live hints cannot be funded right now.", 503, { "Retry-After": "60" });
    }
  });
}
