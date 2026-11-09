// Live notification hints: tickets, sockets admitted by the directory and
// confirmed by the feed's object, frames naming only streams the credential
// may read now, the send window, renewal and revocation (written by the
// directory's own triggers, swept to the feeds holding sockets resting on
// what was revoked).

import {
  createExecutionContext,
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { D1TokenStore } from "@fyrden/adapters-cloudflare/auth";
import type { FeedEntry } from "@fyrden/domain";
import { hashToken, secureRandomBytes } from "@fyrden/domain";
import { uniqueId } from "@fyrden/testing";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createApp } from "../src/app.js";
import type { OrgDO } from "../src/do/OrgDO.js";
import type { RepoDO } from "../src/do/RepoDO.js";
import { feedHooks, type UserDO } from "../src/do/UserDO.js";
import { ALARM_LIMITS, ALARM_UNITS } from "../src/do/user/alarm-budget.js";
import { feedEpochSource } from "../src/do/user/feed.js";
import { threadId } from "../src/do/user/inbox.js";
import { LIVE_POLICY, LIVE_TICKET_PRUNE, Live } from "../src/do/user/live.js";
import { LiveBudget } from "../src/do/user/live-budget.js";
import type { TurnRows } from "../src/do/user/turn-meter.js";
import {
  canonicalVector,
  LIVE_DAILY,
  LIVE_ESCROW_ENTRIES,
  LIVE_ORDINARY_DEBT_LIMIT,
  LIVE_PROTECTED,
  LIVE_RECEIPTS_OVERDUE,
  LIVE_TURN_RECEIPT_LOOK,
  LIVE_TURN_RECEIPT_PAGE,
  type LiveEnvelope,
  makeLiveGrant,
  reserveLive,
} from "../src/live/budget.js";
import { liveCredential } from "../src/live/credential.js";
import { LIVE_ADMISSION, sweep } from "../src/live/directory.js";
import { LIVE_PENDING_MS } from "../src/live/duration.js";
import { liveOpeningTarget, planFor } from "../src/live/funding.js";
import {
  LIVE_BLOCK_MS,
  LIVE_BLOCK_UNITS,
  LIVE_LOW_WATER,
  LIVE_PRICES,
  LIVE_TURN_STEPS,
  type LiveManifestEntry,
  liveBlockUnit,
  liveKindOf,
} from "../src/live/manifest.js";
import { openOwnedLiveSocket, socketUnits } from "../src/live/routes.js";
import { SESSION_COOKIE } from "../src/oauth/session.js";
import { newId } from "../src/services.js";
import { agentFor } from "./helpers/agents.js";
import { api, json, user, type Who } from "./helpers/api.js";
import { countingExec, entry } from "./helpers/feed.js";
import { countD1Rows, DAY, expiredReceipts, pinLedgerClock, ZERO } from "./helpers/live-budget.js";
import { handled, runTurns, say } from "./helpers/live-sockets.js";
import { testSession } from "./helpers/oauth.js";
import { scopedToken } from "./helpers/principals.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** A while into a socket's renewal period's second half, when a renewal is taken. */
const RENEW_LATE = Math.ceil(LIVE_POLICY.renewMs * 0.6);

afterEach(async () => {
  vi.useRealTimers();
  delete feedHooks.beforeEpochRead;
  // Each test spends its own day's allowance, as if it ran alone: what this file's tests grant
  // together passes a day's (Proposed) allowance. What its grants leave owed, and its turns left
  // unused (holding the day's escrow places), maintenance clears in production.
  await env.DIRECTORY.batch([
    // Its sockets' leases too (they lapse minutes after their sockets go): the deployment's
    // allowance is each test's own.
    env.DIRECTORY.prepare("DELETE FROM live_socket_deps"),
    env.DIRECTORY.prepare("DELETE FROM live_sockets"),
    // Its revocations and their targets: one left failing, due again a minute on, would take a
    // later test's sweep's deliveries ahead of its own.
    env.DIRECTORY.prepare("DELETE FROM revocation_targets"),
    env.DIRECTORY.prepare("DELETE FROM revocations"),
    env.DIRECTORY.prepare("DELETE FROM live_budget_days"),
    env.DIRECTORY.prepare(
      `UPDATE live_budget_state SET debt_do_requests = 0, debt_do_rows_read = 0,
         debt_do_rows_written = 0, debt_do_duration_ms = 0, debt_d1_rows_read = 0,
         debt_d1_rows_written = 0, debt_queue_ops = 0 WHERE id = 1`,
    ),
  ]);
});

const ORIGIN = "https://fyrden.test";
const LIVE = { FYRDEN_LIVE: "on" };

/** One request through the Worker, with live hints on (or the given vars). */
async function call(request: Request, vars: Record<string, string> = LIVE): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await createApp().fetch(request, { ...env, ...vars } as Env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

const ticketFor = async (token: string, vars: Record<string, string> = LIVE) =>
  call(
    new Request(`${ORIGIN}/api/notifications/live`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Idempotency-Key": crypto.randomUUID() },
    }),
    vars,
  );

/** A socket opened with `token`'s ticket; its frames, and its close. */
async function open(
  token: string,
  vars: Record<string, string> = LIVE,
  afterTicket?: () => Promise<unknown>,
) {
  const issued = (await (await ticketFor(token, vars)).json()) as { ticket: string };
  await afterTicket?.();
  const response = await call(
    new Request(`${ORIGIN}/api/notifications/live?ticket=${encodeURIComponent(issued.ticket)}`, {
      headers: { Upgrade: "websocket", Authorization: `Bearer ${token}` },
    }),
    vars,
  );
  const ws = response.webSocket;
  if (!ws)
    return {
      response,
      ws: null,
      frames: [],
      closed: Promise.resolve(null),
      next: async () => null,
    };
  ws.accept();
  const frames: unknown[] = [];
  const waiters: ((frame: unknown) => void)[] = [];
  ws.addEventListener("message", (event) => {
    const frame = JSON.parse(String(event.data)) as unknown;
    const waiter = waiters.shift();
    if (waiter) waiter(frame);
    else frames.push(frame);
  });
  const closed = new Promise<{ code: number } | null>((resolve) =>
    ws.addEventListener("close", (event) => resolve({ code: event.code })),
  );
  /** The next frame (waiting on the event itself, never a timer). */
  const next = () =>
    frames.length > 0
      ? Promise.resolve(frames.shift())
      : new Promise<unknown>((resolve) => waiters.push(resolve));
  return { response, ws, frames, closed, next };
}

const feedOf = (who: Who) => env.USER.getByName(who.principalId);

/**
 * What a socket sent has been handled (a round trip after it), then the
 * feed's turn run: a renewal is queued by its message and authorized by
 * the turn.
 */
/**
 * Moves this isolate's clock `ms` on, and the feed's object's idea of the
 * ledger's clock with it (D1's own clock in tests does not move: as if it
 * had, so what the object grants starts where D1 is).
 */
async function advance(who: Who, ms: number): Promise<void> {
  vi.setSystemTime(Date.now() + ms);
  await runInDurableObject(feedOf(who), (_: UserDO, state) =>
    state.storage.sql.exec(
      "UPDATE live_budget_fence SET ledger_offset_ms = ledger_offset_ms - ?",
      ms,
    ),
  );
}

/** The checks of `who`'s own account (its repositories' owner) the ledger granted. */
async function confirmations(who: Who): Promise<number> {
  const row = await env.DIRECTORY.prepare(
    `SELECT count(*) AS n FROM live_budget_receipts
     WHERE kind = 'org_confirmation' AND recipient_type = 'OrgDO'
       AND recipient = ?`,
  )
    .bind(who.principalId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Every day the ledger holds with its escrow places full (no owned unit is granted on them). */
async function fillEscrow(): Promise<void> {
  const held = Array.from({ length: LIVE_ESCROW_ENTRIES }, (_, i) => ({ test: i }));
  await env.DIRECTORY.prepare("UPDATE live_budget_days SET escrow = ?")
    .bind(JSON.stringify(held))
    .run();
}

/** A repository of `owner`'s with one issue; its id and the issue's conversation. */
async function repoWithIssue(owner: Who): Promise<{ id: string; conversation: string }> {
  const made = await json<{ id: string; name: string }>(
    api("POST", "/user/repos", owner.token, { name: uniqueId("live") }),
  );
  expect(
    (
      await api("POST", `/repos/${owner.handle}/${made.body.name}/issues`, owner.token, {
        title: "x",
      })
    ).status,
  ).toBe(201);
  const conversation = await runInDurableObject(
    env.REPO.getByName(made.body.id),
    (_: RepoDO, state) =>
      String(
        state.storage.sql
          .exec<{ c: string }>("SELECT conversation_id AS c FROM issues WHERE number = 1")
          .one().c,
      ),
  );
  return { id: made.body.id, conversation };
}

/** A change to `who`'s feed in issue 1 of `repo`, as the repository sends it. */
const change = (who: Who, repo: { id: string; conversation: string }, version: number): FeedEntry =>
  entry({
    version,
    thread: 1,
    subject: "issue",
    repoId: repo.id,
    principal: who.principalId,
    conversation: repo.conversation,
    kind: "mention",
    reasons: ["mentioned"],
    member: null,
    eventKey: `${repo.id}:${uniqueId("ev")}`,
  });

/**
 * `count` of `who`'s turns that ran, released but not yet settled, the first valid until
 * `firstValidUntil` and each `step` ms later: a feed whose turns came that far apart.
 */
let ranSeq = Number.MAX_SAFE_INTEGER - 100_000;
async function releasedTurns(
  who: Who,
  firstValidUntil: number,
  count = 100,
  step = 1_200,
): Promise<void> {
  const { incarnation } = (await env.DIRECTORY.prepare(
    "SELECT incarnation FROM live_budget_state WHERE id = 1",
  ).first<{ incarnation: string }>()) as { incarnation: string };
  const epoch =
    (
      await env.DIRECTORY.prepare("SELECT epoch_gen FROM source_epochs WHERE source_id = ?")
        .bind(feedEpochSource(who.principalId))
        .first<{ epoch_gen: number }>()
    )?.epoch_gen ?? 0;
  const zero = JSON.stringify(canonicalVector(ZERO));
  await env.DIRECTORY.batch(
    Array.from({ length: count }, (_, i) => {
      const validUntil = firstValidUntil + i * step;
      const validFrom = validUntil - 125 * MINUTE;
      const plan = JSON.stringify({
        charges: [...new Set([validFrom, validUntil].map((t) => Math.floor(t / DAY)))].map(
          (day) => ({ day }),
        ),
      });
      return env.DIRECTORY.prepare(
        `INSERT INTO live_budget_receipts (seq, operation_id, mint, incarnation, recipient_type,
           recipient, kind, class, epoch, produces_local, valid_from, valid_until, granted_at,
           plan, directory_cleanup_debt, settle_until, expires_at, released_owners)
         VALUES (?, ?, ?, ?, 'UserDO', ?, 'pump', 'ordinary', ?, 1, ?, ?, ?, ?, ?, ?, ?, '["own_ran"]')`,
      ).bind(
        ranSeq--,
        uniqueId("ran"),
        uniqueId("mint"),
        incarnation,
        who.principalId,
        epoch,
        validFrom,
        validUntil,
        validFrom,
        plan,
        zero,
        validUntil,
        validUntil + 2 * DAY,
      );
    }),
  );
}

const revocationsOf = (subject: string) =>
  env.DIRECTORY.prepare("SELECT count(*) AS n FROM revocations WHERE subject = ?")
    .bind(subject)
    .first<{ n: number }>()
    .then((r) => r?.n ?? 0);

describe("revocations", () => {
  it("are written by the revoking statement itself, once, for what holds authority", async () => {
    const who = await user();
    const token = await scopedToken(who.principalId, []);
    const { id } = (await env.DIRECTORY.prepare(
      "SELECT id FROM tokens WHERE principal_id = ? ORDER BY created_at DESC LIMIT 1",
    )
      .bind(who.principalId)
      .first<{ id: string }>()) as { id: string };
    expect(token).toBeTruthy();
    await env.DIRECTORY.prepare("UPDATE tokens SET revoked_at = ? WHERE id = ?").bind(1, id).run();
    // Again: nothing more.
    await env.DIRECTORY.prepare("UPDATE tokens SET revoked_at = ? WHERE id = ?").bind(2, id).run();
    expect(await revocationsOf(`credential:${id}`)).toBe(1);
    const { gen } = (await env.DIRECTORY.prepare(
      "SELECT lifecycle_gen AS gen FROM principals WHERE id = ?",
    )
      .bind(who.principalId)
      .first<{ gen: number }>()) as { gen: number };
    await env.DIRECTORY.prepare(
      "UPDATE principals SET lifecycle = 'suspended', disabled_at = 5 WHERE id = ?",
    )
      .bind(who.principalId)
      .run();
    expect(await revocationsOf(`principal:${who.principalId}:${gen}`)).toBe(1);
  });
});

describe("a live socket", () => {
  it("takes its object's epoch before a control is applied after waking, and applies none unread", async () => {
    const owner = await user();
    const repo = await repoWithIssue(owner);
    const socket = await open(owner.token);
    await feedOf(owner).applyFeed([change(owner, repo, 1)]);
    await runDurableObjectAlarm(feedOf(owner));
    expect(await socket.next()).toMatchObject({ t: "changed", n: 1 });
    await evictDurableObject(feedOf(owner));
    let reached = () => {};
    const tried = new Promise<void>((resolve) => {
      reached = resolve;
    });
    feedHooks.beforeEpochRead = async () => {
      reached();
      throw new Error("directory unavailable");
    };
    socket.ws?.send(JSON.stringify({ t: "ack", n: 1 }));
    await tried;
    delete feedHooks.beforeEpochRead;
    const acked = await runInDurableObject(
      feedOf(owner),
      (_: UserDO, state) =>
        state.storage.sql.exec<{ acked: number }>("SELECT acked FROM live_local").one().acked,
    );
    expect(acked).toBe(0);
  });

  it("applies nothing a socket says once its object was restored, and closes it to reread", async () => {
    const owner = await user();
    const repo = await repoWithIssue(owner);
    const socket = await open(owner.token);
    await feedOf(owner).applyFeed([change(owner, repo, 1)]);
    await runDurableObjectAlarm(feedOf(owner));
    expect(await socket.next()).toMatchObject({ t: "changed", n: 1 });
    // The restore: the directory's epoch for this feed moves; the object wakes cold.
    await env.DIRECTORY.prepare("INSERT INTO source_epochs (source_id, epoch_gen) VALUES (?, 7)")
      .bind(`feed:${owner.principalId}`)
      .run();
    await evictDurableObject(feedOf(owner));
    socket.ws?.send(JSON.stringify({ t: "ack", n: 1 }));
    expect(await socket.closed).toEqual({ code: 4409 });
    // Told to reread, nothing of it spent or applied: its credit went with the restore, so its
    // rows are its recovery's to retire.
    expect(
      await runInDurableObject(feedOf(owner), (_: UserDO, state) =>
        state.storage.sql.exec("SELECT count(*) AS n FROM live_local").one(),
      ),
    ).toEqual({ n: 1 });
  });

  it("wakes nothing when a socket it already forgot closes", async () => {
    const owner = await user();
    const socket = await open(owner.token);
    // As recovery leaves it: the socket's row gone, no alarm.
    await runInDurableObject(feedOf(owner), async (_: UserDO, state) => {
      state.storage.sql.exec("DELETE FROM live_local");
      state.storage.sql.exec("DELETE FROM user_schedule");
      await state.storage.deleteAlarm();
    });
    await evictDurableObject(feedOf(owner));
    const closed = handled(owner, "close");
    socket.ws?.close(1000, "done");
    await socket.closed;
    await closed();
    const [alarm, leases] = await Promise.all([
      runInDurableObject(feedOf(owner), (_: UserDO, state) => state.storage.getAlarm()),
      env.DIRECTORY.prepare("SELECT count(*) AS n FROM live_sockets WHERE feed = ?")
        .bind(owner.principalId)
        .first<{ n: number }>(),
    ]);
    expect(alarm).toBeNull();
    // Its lease is the reaper's.
    expect(leases).toEqual({ n: 1 });
  });

  it("is funded before anything is woken: its transport, ticket and admission granted, their owners released", async () => {
    const owner = await user();
    const count = async (sql: string, ...values: unknown[]) =>
      (
        await env.DIRECTORY.prepare(sql)
          .bind(...values)
          .first<{ n: number }>()
      )?.n;
    const receipts = () =>
      count(
        "SELECT count(*) AS n FROM live_budget_receipts WHERE json_extract(plan, '$.recipient') = ?",
        owner.principalId,
      );
    const issued = (await (await ticketFor(owner.token)).json()) as { ticket: string };
    expect(await receipts()).toBe(2);
    const upgrade = () =>
      call(
        new Request(
          `${ORIGIN}/api/notifications/live?ticket=${encodeURIComponent(issued.ticket)}`,
          {
            headers: { Upgrade: "websocket", Authorization: `Bearer ${owner.token}` },
          },
        ),
      );
    const opened = await upgrade();
    expect(opened.status).toBe(101);
    // Its admission, its end's provisions, the feed's first blocks of controls and marks, and its
    // first turn.
    expect(await receipts()).toBe(7);
    // Every owner accounted and released: none held.
    expect(
      await count(
        "SELECT count(*) AS n FROM live_duration_owners WHERE object_id = ?",
        owner.principalId,
      ),
    ).toBe(0);
    // Its transport claimed once: the ticket does not open another.
    expect((await upgrade()).status).toBe(401);
    opened.webSocket?.accept();
    opened.webSocket?.close(1000, "done");
  });

  it("is refused for its funding by an upgrade closed with why: 4413 for today, 4412 for now", async () => {
    const today = async () =>
      (
        await env.DIRECTORY.prepare("SELECT CAST(unixepoch() / 86400 AS INTEGER) AS d").first<{
          d: number;
        }>()
      )?.d as number;
    const refusedWith = async (spend: () => Promise<unknown>, undo: () => Promise<unknown>) => {
      const owner = await user();
      const issued = (await (await ticketFor(owner.token)).json()) as { ticket: string };
      await spend();
      try {
        const response = await call(
          new Request(
            `${ORIGIN}/api/notifications/live?ticket=${encodeURIComponent(issued.ticket)}`,
            { headers: { Upgrade: "websocket", Authorization: `Bearer ${owner.token}` } },
          ),
        );
        expect(response.status).toBe(101);
        const ws = response.webSocket as WebSocket;
        const closed = new Promise<number>((resolve) =>
          ws.addEventListener("close", (event) => resolve(event.code)),
        );
        ws.accept();
        // No socket of it was made.
        expect(
          await env.DIRECTORY.prepare("SELECT count(*) AS n FROM live_sockets WHERE feed = ?")
            .bind(owner.principalId)
            .first(),
        ).toEqual({ n: 0 });
        return await closed;
      } finally {
        await undo();
      }
    };
    const day = await today();
    const spent = await env.DIRECTORY.prepare(
      "SELECT do_requests FROM live_budget_days WHERE day = ?",
    )
      .bind(day)
      .first<{ do_requests: number }>();
    // Today's requests spent: a definitive refusal.
    expect(
      await refusedWith(
        () =>
          env.DIRECTORY.prepare("UPDATE live_budget_days SET do_requests = ? WHERE day = ?")
            .bind(LIVE_DAILY.do_requests, day)
            .run(),
        () =>
          env.DIRECTORY.prepare("UPDATE live_budget_days SET do_requests = ? WHERE day = ?")
            .bind(spent?.do_requests ?? 0, day)
            .run(),
      ),
    ).toBe(4413);
    // Ordinary work blocked by what cleanup owes: for now only.
    // (An admission leaves directory rows to clean up: debt of them past what ordinary work may.)
    const debt = await env.DIRECTORY.prepare(
      "SELECT debt_d1_rows_written AS n FROM live_budget_state WHERE id = 1",
    ).first<{ n: number }>();
    expect(
      await refusedWith(
        () =>
          env.DIRECTORY.prepare(
            "UPDATE live_budget_state SET debt_d1_rows_written = ? WHERE id = 1",
          )
            .bind(LIVE_ORDINARY_DEBT_LIMIT.d1_rows_written)
            .run(),
        () =>
          env.DIRECTORY.prepare(
            "UPDATE live_budget_state SET debt_d1_rows_written = ? WHERE id = 1",
          )
            .bind(debt?.n ?? 0)
            .run(),
      ),
    ).toBe(4412);
  });

  it("is refused for now (4412), not as a stranger, when its feed was restored since its ticket", async () => {
    const owner = await user();
    const issued = (await (await ticketFor(owner.token)).json()) as { ticket: string };
    // A restore since: the feed's epoch moved past the one its transport was granted under.
    await env.DIRECTORY.prepare(
      `INSERT INTO source_epochs (source_id, epoch_gen) VALUES (?, 1)
       ON CONFLICT (source_id) DO UPDATE SET epoch_gen = epoch_gen + 1`,
    )
      .bind(`feed:${owner.principalId}`)
      .run();
    const response = await call(
      new Request(`${ORIGIN}/api/notifications/live?ticket=${encodeURIComponent(issued.ticket)}`, {
        headers: { Upgrade: "websocket", Authorization: `Bearer ${owner.token}` },
      }),
    );
    expect(response.status).toBe(101);
    const ws = response.webSocket as WebSocket;
    const closed = new Promise<number>((resolve) =>
      ws.addEventListener("close", (event) => resolve(event.code)),
    );
    ws.accept();
    expect(await closed).toBe(4412);
  });

  it("is issued 60 tickets a principal a UTC day, then refused until the next (by the ledger's day)", async () => {
    const owner = await user();
    const day = (
      await env.DIRECTORY.prepare("SELECT CAST(unixepoch() / 86400 AS INTEGER) AS d").first<{
        d: number;
      }>()
    )?.d as number;
    await env.DIRECTORY.prepare(
      "INSERT INTO live_ticket_days (principal_id, day, issued) VALUES (?, ?, 60)",
    )
      .bind(owner.principalId, day)
      .run();
    const refused = await ticketFor(owner.token);
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({
      code: "live_budget",
      retry_at: (day + 1) * 86_400_000,
    });
    // Refused before its transport was paid for: nothing granted for it.
    expect(
      await env.DIRECTORY.prepare(
        "SELECT count(*) AS n FROM live_budget_receipts WHERE json_extract(plan, '$.recipient') = ?",
      )
        .bind(owner.principalId)
        .first(),
    ).toEqual({ n: 0 });
  });

  it("is answered with the life its ticket has left", async () => {
    const owner = await user();
    const issued = (await (await ticketFor(owner.token)).json()) as { expires_in: number };
    expect(issued.expires_in).toBeGreaterThan(0);
    expect(issued.expires_in).toBeLessThanOrEqual(LIVE_POLICY.ticketMs / 1000);
  });

  it("stores no ticket its funding does not pay for", async () => {
    const owner = await user();
    const stored = await feedOf(owner).liveTicketV1(
      { protocol: 1, revision: 1, envelope: null, quantity: 1, ownerId: "own_forged" },
      {
        hash: "a".repeat(64),
        credentialId: "tok_forged",
        expiresAt: Date.now() + 30_000,
        transport: { operationId: "op_forged" },
      },
    );
    expect(stored).toEqual({ status: "refused" });
    const rows = await runInDurableObject(feedOf(owner), (_: UserDO, state) =>
      state.storage.sql.exec("SELECT count(*) AS n FROM live_tickets").one(),
    );
    expect(rows).toEqual({ n: 0 });
  });

  it("is not offered while the deployment has not turned live hints on", async () => {
    const who = await user();
    expect((await ticketFor(who.token, {})).status).toBe(503);
  });

  it("is opened by an upgrade only: another request is answered 404, whether on or off", async () => {
    const who = await user();
    for (const vars of [{}, LIVE]) {
      const plain = await call(
        new Request(`${ORIGIN}/api/notifications/live?ticket=x`, {
          headers: { Authorization: `Bearer ${who.token}` },
        }),
        vars,
      );
      expect(plain.status).toBe(404);
    }
  });

  it("hears that a stream it may read changed, and nothing of one it may not", async () => {
    const owner = await user();
    const [mine, hidden] = [await repoWithIssue(owner), await repoWithIssue(owner)];
    // A token limited to one repository.
    const token = await scopedToken(owner.principalId, [], "pat", [mine.id]);
    const socket = await open(token);
    expect(socket.response.status).toBe(101);
    await feedOf(owner).applyFeed([change(owner, hidden, 1), change(owner, mine, 1)]);
    await runDurableObjectAlarm(feedOf(owner));
    expect(await socket.next()).toEqual({
      t: "changed",
      n: 1,
      streams: [{ repo: mine.id, kind: "issue" }],
    });
    // Its account's check was paid for by a grant of its own.
    expect(await confirmations(owner)).toBe(1);
    // Only the hidden repository changes: no frame.
    await feedOf(owner).applyFeed([change(owner, hidden, 2)]);
    await runDurableObjectAlarm(feedOf(owner));
    expect(socket.frames).toEqual([]);
    socket.ws?.close(1000, "done");
  });

  it("asks its account's check only once it is paid for: refused, its sockets try again a minute on", async () => {
    const owner = await user();
    const repo = await repoWithIssue(owner);
    const socket = await open(owner.token);
    // Today's object rows read spent: the turn (granted before) runs, its confirmation is refused.
    await env.DIRECTORY.prepare(
      "UPDATE live_budget_days SET do_rows_read = ? WHERE day = CAST(unixepoch() / 86400 AS INTEGER)",
    )
      .bind(LIVE_DAILY.do_rows_read)
      .run();
    await feedOf(owner).applyFeed([change(owner, repo, 1)]);
    const before = Date.now();
    await runDurableObjectAlarm(feedOf(owner));
    // No hint: only word that the day's room stops the feed's next turn too.
    expect(socket.frames).toEqual([expect.objectContaining({ t: "paused" })]);
    expect(await confirmations(owner)).toBe(0);
    const retryAt = await runInDurableObject(feedOf(owner), (_: UserDO, state) =>
      state.storage.sql.exec<{ at: number }>("SELECT retry_at AS at FROM live_local").one(),
    );
    expect(retryAt.at).toBeGreaterThanOrEqual(before + 60_000);
    socket.ws?.close(1000, "done");
  });

  it("hears of a page of changes a run, the rest in the next", async () => {
    const owner = await user();
    const repos = [];
    for (let i = 0; i < LIVE_POLICY.dirtyPage + 2; i++) repos.push(await repoWithIssue(owner));
    const socket = await open(owner.token);
    await feedOf(owner).applyFeed(repos.map((r) => change(owner, r, 1)));
    await runDurableObjectAlarm(feedOf(owner));
    const first = (await socket.next()) as { n: number; streams: { repo: string }[] };
    expect(first.streams.map((x) => x.repo)).toEqual(
      repos.slice(0, LIVE_POLICY.dirtyPage).map((r) => r.id),
    );
    await say(owner, socket, { t: "ack", n: first.n });
    await runDurableObjectAlarm(feedOf(owner));
    const second = (await socket.next()) as { streams: { repo: string }[] };
    expect(second.streams.map((x) => x.repo)).toEqual(
      repos.slice(LIVE_POLICY.dirtyPage).map((r) => r.id),
    );
    socket.ws?.close(1000, "done");
  });

  it("decides one owning account a run, the next account's changes in the next run", async () => {
    const [admin, owner] = [await user(true), await user()];
    const login = uniqueId("org").slice(0, 39);
    await api("POST", "/admin/organizations", admin.token, { login, admin: owner.handle });
    const own = await repoWithIssue(owner);
    const made = await json<{ id: string; name: string }>(
      api("POST", `/orgs/${login}/repos`, owner.token, { name: uniqueId("live") }),
    );
    expect(
      (await api("POST", `/repos/${login}/${made.body.name}/issues`, owner.token, { title: "x" }))
        .status,
    ).toBe(201);
    const orgs = {
      id: made.body.id,
      conversation: await runInDurableObject(env.REPO.getByName(made.body.id), (_: RepoDO, state) =>
        String(
          state.storage.sql
            .exec<{ c: string }>("SELECT conversation_id AS c FROM issues WHERE number = 1")
            .one().c,
        ),
      ),
    };
    const socket = await open(owner.token);
    await feedOf(owner).applyFeed([change(owner, own, 1), change(owner, orgs, 1)]);
    await runDurableObjectAlarm(feedOf(owner));
    const first = (await socket.next()) as { n: number; streams: { repo: string }[] };
    expect(first.streams.map((x) => x.repo)).toEqual([own.id]);
    await say(owner, socket, { t: "ack", n: first.n });
    await runDurableObjectAlarm(feedOf(owner));
    expect(
      ((await socket.next()) as { streams: { repo: string }[] }).streams.map((x) => x.repo),
    ).toEqual([orgs.id]);
    socket.ws?.close(1000, "done");
  });

  it("passes over a repository whose check cannot be bounded, and goes on", async () => {
    const [admin, owner] = [await user(true), await user()];
    const login = uniqueId("org").slice(0, 39);
    const org = (
      await json<{ id: string }>(
        api("POST", "/admin/organizations", admin.token, { login, admin: owner.handle }),
      )
    ).body;
    const made = await json<{ id: string; name: string }>(
      api("POST", `/orgs/${login}/repos`, owner.token, { name: uniqueId("live") }),
    );
    expect(
      (await api("POST", `/repos/${login}/${made.body.name}/issues`, owner.token, { title: "x" }))
        .status,
    ).toBe(201);
    const crowded = {
      id: made.body.id,
      conversation: await runInDurableObject(env.REPO.getByName(made.body.id), (_: RepoDO, state) =>
        String(
          state.storage.sql
            .exec<{ c: string }>("SELECT conversation_id AS c FROM issues WHERE number = 1")
            .one().c,
        ),
      ),
    };
    // More teams on it than the live check reads.
    await runInDurableObject(env.ORG.getByName(org.id), (_: OrgDO, state) => {
      for (let i = 0; i <= 100; i++) {
        state.storage.sql.exec(
          "INSERT INTO teams (team_id, slug, name, created_at) VALUES (?, ?, ?, 0)",
          `tm_many${i}`,
          `many-${i}`,
          `Many ${i}`,
        );
        state.storage.sql.exec(
          "INSERT INTO team_repos (team_id, repo_id, role, added_at) VALUES (?, ?, 'read', 0)",
          `tm_many${i}`,
          crowded.id,
        );
      }
    });
    const own = await repoWithIssue(owner);
    const socket = await open(owner.token);
    await feedOf(owner).applyFeed([change(owner, crowded, 1), change(owner, own, 1)]);
    // The organization's run: its repository not known, passed over; nothing to send.
    await runDurableObjectAlarm(feedOf(owner));
    expect(socket.frames).toEqual([]);
    // The next account's: the own repository, the crowded one never named.
    await runDurableObjectAlarm(feedOf(owner));
    expect(await socket.next()).toEqual({
      t: "changed",
      n: 1,
      streams: [{ repo: own.id, kind: "issue" }],
    });
    socket.ws?.close(1000, "done");
  });

  it("is opened only with its ticket, once, by the credential it was issued to", async () => {
    const owner = await user();
    const other = await scopedToken(owner.principalId, []);
    const issued = (await (await ticketFor(owner.token)).json()) as { ticket: string };
    const upgrade = (token: string) =>
      call(
        new Request(
          `${ORIGIN}/api/notifications/live?ticket=${encodeURIComponent(issued.ticket)}`,
          {
            headers: { Upgrade: "websocket", Authorization: `Bearer ${token}` },
          },
        ),
      );
    // Another credential of the same principal: refused, the ticket left unspent.
    expect((await upgrade(other)).status).toBe(401);
    const first = await upgrade(owner.token);
    expect(first.status).toBe(101);
    first.webSocket?.accept();
    expect((await upgrade(owner.token)).status).toBe(401);
    first.webSocket?.close(1000, "done");
  });

  it("closes when its credential is revoked, its lease released", async () => {
    const owner = await user();
    const token = await scopedToken(owner.principalId, []);
    const socket = await open(token);
    const { id } = (await env.DIRECTORY.prepare(
      "SELECT credential_id AS id FROM live_sockets WHERE feed = ?",
    )
      .bind(owner.principalId)
      .first<{ id: string }>()) as { id: string };
    await env.DIRECTORY.prepare("UPDATE tokens SET revoked_at = ? WHERE id = ?")
      .bind(Date.now(), id)
      .run();
    await sweep(env.DIRECTORY, (feed, deps) => env.USER.getByName(feed).revoked(deps), Date.now());
    expect(await socket.closed).toEqual({ code: 4403 });
    expect(
      await env.DIRECTORY.prepare("SELECT count(*) AS n FROM live_sockets WHERE feed = ?")
        .bind(owner.principalId)
        .first<{ n: number }>(),
    ).toEqual({ n: 0 });
  });

  it("closes on a control message past its bounds", async () => {
    const owner = await user();
    const socket = await open(owner.token);
    socket.ws?.send("not json");
    expect(await socket.closed).toEqual({ code: 1008 });
    const again = await open(owner.token);
    again.ws?.send(JSON.stringify({ t: "ack", n: 1, extra: true }));
    expect(await again.closed).toEqual({ code: 1008 });
  });

  it("is refused past the deployment's allowance for now (4412), past its principal's day until tomorrow (4413)", async () => {
    const owner = await user();
    const vars = { ...LIVE, FYRDEN_LIVE_SOCKETS: "1" };
    // The allowance counts every open lease: with one already open (any test's), none more.
    await env.DIRECTORY.prepare(
      `INSERT INTO live_sockets (socket_id, ticket_id, feed, credential_id, state, pending_until,
         expires_at) VALUES (?, ?, 'usr_x', 'tok_x', 'open', 0, ?)`,
    )
      .bind(uniqueId("lsk"), uniqueId("t"), Date.now() + 60_000)
      .run();
    const full = await open(owner.token, vars);
    expect(full.response.status).toBe(101);
    expect(await full.closed).toEqual({ code: 4412 });
    // The principal's admissions for the day (this Worker's) spent since its ticket.
    const other = await user();
    const spent = await open(other.token, LIVE, () =>
      env.DIRECTORY.prepare("INSERT INTO live_admissions (principal_id, day, n) VALUES (?, ?, ?)")
        .bind(other.principalId, Math.floor(Date.now() / 86_400_000), LIVE_ADMISSION.perDay)
        .run(),
    );
    expect(spent.response.status).toBe(101);
    expect(await spent.closed).toEqual({ code: 4413 });
    expect(
      await env.DIRECTORY.prepare("SELECT count(*) AS n FROM live_sockets WHERE feed IN (?, ?)")
        .bind(owner.principalId, other.principalId)
        .first(),
    ).toEqual({ n: 0 });
  });

  it("is admitted again after its principal is unsuspended, a delivery for the old authority aside", async () => {
    const owner = await user();
    const token = await scopedToken(owner.principalId, []);
    const { gen } = (await env.DIRECTORY.prepare(
      "SELECT lifecycle_gen AS gen FROM principals WHERE id = ?",
    )
      .bind(owner.principalId)
      .first<{ gen: number }>()) as { gen: number };
    // The old generation's authority revoked, told late.
    await feedOf(owner).revoked([`principal:${owner.principalId}:${gen}`]);
    await env.DIRECTORY.prepare(
      "UPDATE principals SET lifecycle_gen = lifecycle_gen + 1 WHERE id = ?",
    )
      .bind(owner.principalId)
      .run();
    const socket = await open(token);
    expect(socket.response.status).toBe(101);
    await feedOf(owner).revoked([`principal:${owner.principalId}:${gen}`]);
    expect(
      await runInDurableObject(feedOf(owner), (_: UserDO, state) =>
        state.storage.sql.exec("SELECT count(*) AS n FROM live_local").one(),
      ),
    ).toEqual({ n: 1 });
    socket.ws?.close(1000, "done");
  });

  it("holds frames past its window, sends them coalesced once acknowledged, and closes a slow consumer", async () => {
    const owner = await user();
    const repo = await repoWithIssue(owner);
    const socket = await open(owner.token);
    const pump = async (version: number) => {
      await feedOf(owner).applyFeed([change(owner, repo, version)]);
      await runTurns(owner);
    };
    for (let v = 1; v <= 8; v++) {
      await pump(v);
      expect(await socket.next()).toMatchObject({ t: "changed", n: v });
    }
    // The ninth waits: eight are unacknowledged.
    await pump(9);
    expect(socket.frames).toEqual([]);
    await say(owner, socket, { t: "ack", n: 8 });
    await pump(10);
    expect(await socket.next()).toEqual({
      t: "changed",
      n: 9,
      streams: [{ repo: repo.id, kind: "issue" }],
    });
    // Never acknowledged again: past the window for two minutes, closed to resynchronize.
    for (let v = 11; v <= 18; v++) await pump(v);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 3 * 60_000);
    await runInDurableObject(feedOf(owner), (_: UserDO, state) =>
      state.storage.setAlarm(Date.now()),
    );
    await runTurns(owner);
    await runTurns(owner);
    expect(await socket.closed).toEqual({ code: 4409 });
  });

  it("is renewed in its second half, and closed once its credential no longer holds", async () => {
    const owner = await user();
    const token = await scopedToken(owner.principalId, []);
    const socket = await open(token);
    // Early: nothing.
    await say(owner, socket, { t: "renew" });
    vi.useFakeTimers({ toFake: ["Date"] });
    await advance(owner, RENEW_LATE);
    await say(owner, socket, { t: "renew" });
    await runDurableObjectAlarm(feedOf(owner));
    expect(await socket.next()).toMatchObject({ t: "renewed" });
    await env.DIRECTORY.prepare(
      "UPDATE tokens SET revoked_at = ? WHERE id = (SELECT credential_id FROM live_sockets WHERE feed = ?)",
    )
      .bind(Date.now(), owner.principalId)
      .run();
    await advance(owner, RENEW_LATE);
    await say(owner, socket, { t: "renew" });
    await runDurableObjectAlarm(feedOf(owner));
    expect(await socket.closed).toEqual({ code: 4401 });
  });

  it("says nothing of activity the principal ignored or unsubscribed from after it changed, but for what asks something of it", async () => {
    const owner = await user();
    const repo = await repoWithIssue(owner);
    const socket = await open(owner.token);
    const comment = {
      ...change(owner, repo, 1),
      recipient: {
        ...change(owner, repo, 1).recipient,
        kind: "activity" as const,
        reasons: ["commenter"],
      },
    };
    await feedOf(owner).applyFeed([comment]);
    await env.DIRECTORY.prepare(
      `INSERT INTO thread_preferences (principal_id, repo_id, conversation, number, kind, root_id,
         state, revision, epoch_gen, at) VALUES (?1, ?2, ?3, 1, 'issue', ?1, 'unsubscribed', 1, 1, ?4)`,
    )
      .bind(owner.principalId, repo.id, repo.conversation, Date.now())
      .run();
    await runTurns(owner);
    expect(socket.frames).toEqual([]);
    // A mention goes through an unsubscribe.
    await feedOf(owner).applyFeed([change(owner, repo, 2)]);
    await runTurns(owner);
    expect(await socket.next()).toMatchObject({ t: "changed", n: 1 });
    // An ignored repository: nothing at all.
    await env.DIRECTORY.prepare(
      `INSERT INTO watch_preferences (principal_id, repo_id, root_id, level, revision, epoch_gen, at)
       VALUES (?1, ?2, ?1, 'ignoring', 1, 1, ?3)`,
    )
      .bind(owner.principalId, repo.id, Date.now())
      .run();
    await feedOf(owner).applyFeed([change(owner, repo, 3)]);
    await runTurns(owner);
    expect(socket.frames).toEqual([]);
    socket.ws?.close(1000, "done");
  });

  it("tells other sockets of the principal's own read, and closes all with the feed's retirement", async () => {
    const owner = await user();
    const repo = await repoWithIssue(owner);
    const socket = await open(owner.token);
    await feedOf(owner).applyFeed([change(owner, repo, 1)]);
    await runTurns(owner);
    expect(await socket.next()).toMatchObject({ n: 1 });
    expect(await feedOf(owner).markInboxThread(threadId(repo.id, repo.conversation), false)).toBe(
      true,
    );
    await runTurns(owner);
    expect(await socket.next()).toMatchObject({
      n: 2,
      streams: [{ repo: repo.id, kind: "issue" }],
    });
    await feedOf(owner).retire();
    expect(await socket.closed).toEqual({ code: 4403 });
  });

  it("opens from a browser only with its session's cookie, from this origin", async () => {
    const owner = await user();
    const { cookie } = await testSession(owner.principalId);
    const headers = { Cookie: `${SESSION_COOKIE}=${cookie}`, "X-Fyrden-Session": "1" };
    const ticket = async () =>
      (
        (await (
          await call(
            new Request(`${ORIGIN}/api/notifications/live`, {
              method: "POST",
              headers: { ...headers, "Idempotency-Key": crypto.randomUUID() },
            }),
          )
        ).json()) as { ticket: string }
      ).ticket;
    const upgrade = (t: string, origin: string) =>
      call(
        new Request(`${ORIGIN}/api/notifications/live?ticket=${encodeURIComponent(t)}`, {
          headers: { Upgrade: "websocket", Cookie: headers.Cookie, Origin: origin },
        }),
      );
    const first = await ticket();
    expect((await upgrade(first, "https://evil.test")).status).toBe(401);
    // Refused before it was spent.
    const opened = await upgrade(first, ORIGIN);
    expect(opened.status).toBe(101);
    opened.webSocket?.accept();
    opened.webSocket?.close(1000, "done");
  });
});

describe("a feed's live credit", () => {
  /** What the feed's object holds of live credit now: its pools' of today (the ledger's day). */
  const credit = (who: Who) =>
    runInDurableObject(feedOf(who), (_: UserDO, state) => {
      const sql = state.storage.sql;
      const today = Math.floor(new LiveBudget(sql).ledgerNow(Date.now()) / 86_400_000);
      const rows = (q: string, ...bind: unknown[]) =>
        sql.exec(q, ...bind).toArray() as Record<string, unknown>[];
      const pool = (kind: string) =>
        rows(
          "SELECT remaining FROM live_budget_balances WHERE kind = ? AND day = ?",
          kind,
          today,
        ).map((r) => (JSON.parse(r.remaining as string) as { do_requests: number }).do_requests);
      return {
        controls: pool("control"),
        marks: pool("mark"),
        terminal: rows("SELECT socket_id, day FROM live_budget_terminal").length,
        pending: rows("SELECT kind FROM live_budget_pending ORDER BY kind").map((r) => r.kind),
        dirty: rows("SELECT budget_seq FROM live_dirty").map((r) => r.budget_seq),
      };
    });
  /** Sets every control (or mark) balance of the feed to `units` whole units. */
  const leave = (who: Who, kind: "control" | "mark", units: number) =>
    runInDurableObject(feedOf(who), (_: UserDO, state) => {
      const unit = liveBlockUnit(kind);
      const left = Object.fromEntries(
        Object.entries(unit).map(([r, v]) => [r, (v as number) * units]),
      );
      state.storage.sql.exec(
        "UPDATE live_budget_balances SET remaining = ? WHERE kind = ?",
        JSON.stringify(canonicalVector(left as never)),
        kind,
      );
    });
  /** Sends an acknowledgement nothing was sent for (a control that changes nothing), handled. */
  const ack = (who: Who, socket: Awaited<ReturnType<typeof open>>) =>
    say(who, socket, { t: "ack", n: 0 });

  it("is installed with a socket: its end on each day it may live on, and the feed's first blocks", async () => {
    const owner = await user();
    const socket = await open(owner.token);
    const held = await credit(owner);
    expect(held.controls).toEqual([LIVE_BLOCK_UNITS]);
    expect(held.marks).toEqual([LIVE_BLOCK_UNITS]);
    // Its end provided for today, and tomorrow when its life reaches past midnight.
    expect(held.terminal).toBeGreaterThanOrEqual(1);
    // A second socket brings none: the feed holds its blocks still (refills top them up), nothing
    // more granted for them.
    const blockReceipts = () =>
      env.DIRECTORY.prepare(
        `SELECT count(*) AS n FROM live_budget_receipts
         WHERE recipient = ? AND kind IN ('control', 'mark')`,
      )
        .bind(owner.principalId)
        .first<{ n: number }>()
        .then((r) => r?.n);
    expect(await blockReceipts()).toBe(2);
    const second = await open(owner.token);
    const third = await open(owner.token);
    expect([second.response.status, third.response.status]).toEqual([101, 101]);
    expect([second.ws !== null, third.ws !== null]).toEqual([true, true]);
    expect(await blockReceipts()).toBe(2);
    expect((await credit(owner)).controls).toEqual([LIVE_BLOCK_UNITS]);
    expect((await credit(owner)).marks).toEqual([LIVE_BLOCK_UNITS]);
    for (const s of [socket, second, third]) s.ws?.close(1000, "done");
  });

  it("queues refills for pools left empty, the ledger holding blocks the feed never got", async () => {
    const owner = await user();
    const first = await open(owner.token);
    // Its blocks gone from the feed (an admission refused after they were granted, say).
    await runInDurableObject(feedOf(owner), (_: UserDO, state) =>
      state.storage.sql.exec("DELETE FROM live_budget_balances"),
    );
    first.ws?.close(1000, "done");
    const second = await open(owner.token);
    const pending = await runInDurableObject(feedOf(owner), (_: UserDO, state) =>
      state.storage.sql
        .exec<{ kind: string }>("SELECT kind FROM live_budget_pending ORDER BY kind")
        .toArray()
        .map((r) => r.kind),
    );
    expect(pending).toEqual(["control_refill", "mark_refill"]);
    second.ws?.close(1000, "done");
  });

  it("pays for each control from the feed's pool, and queues one refill at low water", async () => {
    const owner = await user();
    const socket = await open(owner.token);
    await ack(owner, socket);
    expect((await credit(owner)).controls).toEqual([LIVE_BLOCK_UNITS - 1]);
    await leave(owner, "control", LIVE_LOW_WATER + 2);
    await ack(owner, socket);
    expect((await credit(owner)).pending).toEqual([]);
    await ack(owner, socket);
    expect((await credit(owner)).pending).toEqual(["control_refill"]);
    // Queued once; nothing granted or authorized inline for it.
    await ack(owner, socket);
    const held = await credit(owner);
    expect(held.pending).toEqual(["control_refill"]);
    expect(held.controls).toEqual([LIVE_LOW_WATER - 1]);
    socket.ws?.close(1000, "done");
  });

  it("refills a pool whose block expires before the socket's next renewal, however full it is", async () => {
    const owner = await user();
    const socket = await open(owner.token);
    /** Sets the admission's control block to end `ms` after the ledger's now. */
    const endsIn = (ms: number) =>
      runInDurableObject(feedOf(owner), (_: UserDO, state) => {
        const at = new LiveBudget(state.storage.sql).ledgerNow(Date.now());
        state.storage.sql.exec(
          `UPDATE live_budget_balances SET budget_valid_until = ?
           WHERE kind = 'control' AND budget_seq = (
             SELECT min(budget_seq) FROM live_budget_balances WHERE kind = 'control')`,
          at + ms,
        );
      });
    // A quiet socket spends a block slower than it expires: its admission's block, nearly
    // full, lapses within a renewal period.
    await endsIn(60_000);
    await ack(owner, socket);
    expect((await credit(owner)).pending).toEqual(["control_refill"]);
    await runDurableObjectAlarm(feedOf(owner));
    expect((await credit(owner)).controls.sort()).toEqual([LIVE_BLOCK_UNITS - 1, LIVE_BLOCK_UNITS]);
    // Past the first block's end, the socket's controls are paid from the second.
    await endsIn(-1);
    await ack(owner, socket);
    const held = await credit(owner);
    expect(held.controls.sort()).toEqual([LIVE_BLOCK_UNITS - 1, LIVE_BLOCK_UNITS - 1]);
    expect(held.pending).toEqual([]);
    expect(socket.ws?.readyState).toBe(WebSocket.OPEN);
    socket.ws?.close(1000, "done");
  });

  it("closes a socket whose control nothing is left to pay for, on its terminal provision", async () => {
    const owner = await user();
    const socket = await open(owner.token);
    await leave(owner, "control", 0);
    socket.ws?.send(JSON.stringify({ t: "ack", n: 0 }));
    expect(await socket.closed).toEqual({ code: 4412 });
    const held = await credit(owner);
    expect(held.terminal).toBe(0);
    // Forgotten here; its lease is maintenance's to release.
    expect(
      await runInDurableObject(feedOf(owner), (_: UserDO, state) =>
        state.storage.sql.exec("SELECT count(*) AS n FROM live_local").one(),
      ),
    ).toEqual({ n: 0 });
  });

  it("ends a socket past midnight on the next day's provision, yesterday's credit unusable", async () => {
    const owner = await user();
    const socket = await open(owner.token);
    // Its provisions, and the ledger's clock as the object judges it.
    const { offset, provisions } = await runInDurableObject(feedOf(owner), (_: UserDO, state) => ({
      offset: state.storage.sql
        .exec<{ o: number }>("SELECT ledger_offset_ms AS o FROM live_budget_fence")
        .one().o,
      provisions: state.storage.sql
        .exec<{ day: number; until: number }>(
          "SELECT day, budget_valid_until AS until FROM live_budget_terminal ORDER BY day",
        )
        .toArray(),
    }));
    // Two minutes into the next day (on the ledger's clock), when its provision there still holds;
    // an admission in a day's first minutes has none past the next midnight, so it is past its
    // prepaid end there instead.
    const next = (provisions[0]?.day ?? 0) + 1;
    const target = next * 86_400_000 + 120_000;
    const covered = provisions.some((p) => p.day === next && p.until > target + 60_000);
    vi.setSystemTime(target - offset);
    socket.ws?.send(JSON.stringify({ t: "ack", n: 0 }));
    // Past its renewal deadline: closed, on that day's provision when it has one.
    expect(await socket.closed).toEqual({ code: 4401 });
    expect((await credit(owner)).terminal).toBe(covered ? 0 : provisions.length);
    // No control of any day spent for it: every block it was given whole.
    const blocks = await runInDurableObject(feedOf(owner), (_: UserDO, state) =>
      state.storage.sql
        .exec("SELECT remaining FROM live_budget_balances WHERE kind = 'control'")
        .toArray()
        .map((r) => (JSON.parse(r.remaining as string) as { do_requests: number }).do_requests),
    );
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.every((units) => units === LIVE_BLOCK_UNITS)).toBe(true);
  });

  it("pays for each mark, stamped with its grant; once marks run out the change still applies", async () => {
    const owner = await user();
    const repo = await repoWithIssue(owner);
    const socket = await open(owner.token);
    await feedOf(owner).applyFeed([change(owner, repo, 1)]);
    let held = await credit(owner);
    expect(held.marks).toEqual([LIVE_BLOCK_UNITS - 1]);
    expect(held.dirty.every((seq) => (seq as number) > 0)).toBe(true);
    await leave(owner, "mark", 0);
    const applied = await feedOf(owner).applyFeed([change(owner, repo, 2)]);
    expect(applied.changed).toBeGreaterThan(0);
    held = await credit(owner);
    // Nothing marked for it (no hint), and a refill queued.
    expect(held.pending).toContain("mark_refill");
    socket.ws?.close(1000, "done");
  });

  it("queues a refill under the feed's turn once every mark block has expired, and a turn installs it", async () => {
    const owner = await user();
    const repo = await repoWithIssue(owner);
    const socket = await open(owner.token);
    // Every mark block past its validity on the ledger's clock (none spendable, none to queue a
    // refill under).
    await runInDurableObject(feedOf(owner), (_: UserDO, state) =>
      state.storage.sql.exec(
        "UPDATE live_budget_balances SET budget_valid_until = ? WHERE kind = 'mark'",
        new LiveBudget(state.storage.sql).ledgerNow(Date.now()) - 1,
      ),
    );
    // A delivery with nothing to mark (the change applied before, again) buys nothing.
    const first = change(owner, repo, 1);
    await feedOf(owner).applyFeed([first]);
    expect((await credit(owner)).pending).toContain("mark_refill");
    await runInDurableObject(feedOf(owner), (_: UserDO, state) =>
      state.storage.sql.exec("DELETE FROM live_budget_pending WHERE kind = 'mark_refill'"),
    );
    await feedOf(owner).applyFeed([first]);
    expect((await credit(owner)).pending).not.toContain("mark_refill");
    // A change to mark queues its refill.
    await feedOf(owner).applyFeed([change(owner, repo, 2)]);
    expect((await credit(owner)).pending).toContain("mark_refill");
    // The feed's turn, brought due for it, grants and installs the refill.
    await runDurableObjectAlarm(feedOf(owner));
    const held = await credit(owner);
    expect(held.pending).not.toContain("mark_refill");
    expect(held.marks).toContain(LIVE_BLOCK_UNITS);
    // The next change is marked again.
    await feedOf(owner).applyFeed([change(owner, repo, 3)]);
    expect((await credit(owner)).marks).toContain(LIVE_BLOCK_UNITS - 1);
    socket.ws?.close(1000, "done");
  });

  it("does nothing for a socket past its prepaid end: closed, nothing read or spent", async () => {
    const owner = await user();
    const socket = await open(owner.token);
    const before = await credit(owner);
    vi.setSystemTime(Date.now() + 2 * 86_400_000);
    socket.ws?.send(JSON.stringify({ t: "ack", n: 0 }));
    expect(await socket.closed).toEqual({ code: 4401 });
    // Its rows as they were (its close's callback finding nothing to do either): its
    // recovery's to retire.
    const after = await credit(owner);
    expect(after.terminal).toBe(before.terminal);
    expect(
      await runInDurableObject(feedOf(owner), (_: UserDO, state) =>
        state.storage.sql.exec("SELECT count(*) AS n FROM live_local").one(),
      ),
    ).toEqual({ n: 1 });
  });

  it("is left to recovery when the feed retires: its sockets end on their provisions", async () => {
    const owner = await user();
    const repo = await repoWithIssue(owner);
    const socket = await open(owner.token);
    await feedOf(owner).applyFeed([change(owner, repo, 1)]);
    await feedOf(owner).retire();
    expect(await socket.closed).toEqual({ code: 4403 });
    await runDurableObjectAlarm(feedOf(owner));
    const held = await credit(owner);
    // The feed's own rows go a step at a time; live's stay for recovery.
    expect(held.dirty.length).toBeGreaterThan(0);
    expect(held.terminal).toBe(0);
  });
});

describe("a feed's turn", () => {
  const turnOf = (who: Who) =>
    runInDurableObject(feedOf(who), (_: UserDO, state) =>
      state.storage.sql
        .exec<{ phase: string; intended_at: number; operation_id: string }>(
          "SELECT phase, intended_at, operation_id FROM live_turn",
        )
        .toArray(),
    );

  it("wakes nothing for live work while none is prepared, and runs one when it is", async () => {
    const owner = await user();
    const repo = await repoWithIssue(owner);
    const socket = await open(owner.token);
    expect(await turnOf(owner)).toMatchObject([{ phase: "prepared" }]);
    // Its turn gone (its grant spent, say): a change marked wakes no alarm.
    const prepared = await runInDurableObject(feedOf(owner), async (_: UserDO, state) => {
      const row = state.storage.sql.exec("SELECT * FROM live_turn").one();
      state.storage.sql.exec("DELETE FROM live_turn");
      await state.storage.deleteAlarm();
      return row;
    });
    await feedOf(owner).applyFeed([change(owner, repo, 1)]);
    // Only the feed's own retention is due (days away), nothing of live.
    const alarm = await runInDurableObject(feedOf(owner), (_: UserDO, state) =>
      state.storage.getAlarm(),
    );
    expect(alarm === null || alarm > Date.now() + 60 * 60_000).toBe(true);
    // Prepared again: the next change brings it due, and its run sends the hint.
    await runInDurableObject(feedOf(owner), (_: UserDO, state) => {
      const columns = Object.keys(prepared);
      state.storage.sql.exec(
        `INSERT INTO live_turn (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
        ...Object.values(prepared),
      );
    });
    await feedOf(owner).applyFeed([change(owner, repo, 2)]);
    expect(
      await runInDurableObject(feedOf(owner), (_: UserDO, state) => state.storage.getAlarm()),
    ).toBeLessThanOrEqual(Date.now());
    await runDurableObjectAlarm(feedOf(owner));
    expect(await socket.next()).toMatchObject({ t: "changed" });
    // It named its successor: the feed has a socket still.
    expect(await turnOf(owner)).toMatchObject([{ phase: "prepared" }]);
    socket.ws?.close(1000, "done");
  });

  /** `who`'s feed's newest turn grant in the ledger (the order a held turn's lookup reads in). */
  const newestTurnGrant = async (who: Who) =>
    await env.DIRECTORY.prepare(
      `SELECT operation_id FROM live_budget_receipts
         WHERE recipient = ? AND kind IN ('pump', 'renewal') AND settled_at IS NULL
         ORDER BY valid_until DESC, seq DESC LIMIT 1`,
    )
      .bind(who.principalId)
      .first<string>("operation_id");

  // What lets an opening look at only a feed's newest turns for the one it holds: each successor
  // is granted by the turn running (`finishTurn` prepares it in the same transaction, its start
  // never before the running turn's, however the object's view of the ledger's clock widened), and
  // an opening's turn is prepared only when the feed holds none that can run (`prepareTurn`), so
  // the turn held is the newest granted and installed.
  it("holds its newest turn grant once each turn has named its successor", async () => {
    const owner = await user();
    const repo = await repoWithIssue(owner);
    const socket = await open(owner.token);
    const holds = async () => {
      const turns = await turnOf(owner);
      expect(turns).toHaveLength(1);
      expect(turns[0]?.operation_id).toBe(await newestTurnGrant(owner));
    };
    await holds();
    // Turns of renewals only with nothing to send, and pumps with a change (one a turn of renewals
    // names after it, due at once, when that turn was prepared before the change).
    for (let version = 1; version <= 3; version++) {
      await runTurnNow(owner);
      await holds();
      await feedOf(owner).applyFeed([change(owner, repo, version)]);
      for (let turn = 0; turn < 2 && socket.frames.length === 0; turn++) {
        await runTurnNow(owner);
        await holds();
      }
      expect(await socket.next()).toMatchObject({ t: "changed" });
    }
    socket.ws?.close(1000, "done");
  });

  it("still holds its newest turn grant when a late answer widened its view of the ledger's clock", async () => {
    const owner = await user();
    const socket = await open(owner.token);
    // More of the feed's turns run and released than an opening looks at.
    for (let turn = 0; turn < LIVE_TURN_RECEIPT_LOOK + 1; turn++) await runTurnNow(owner);
    // A check that read D1 at once but was answered 8 seconds later, heard just before the turn
    // names its successor: the ledger's earliest possible time is 8 seconds further back.
    feedHooks.afterTurnWork = async (_feed, state) => {
      delete feedHooks.afterTurnWork;
      const sent = Date.now();
      const ledgerAt = (
        (await env.DIRECTORY.prepare("SELECT unixepoch() * 1000 AS at").first<{
          at: number;
        }>()) as {
          at: number;
        }
      ).at;
      new LiveBudget(state.storage.sql).noteLedger(ledgerAt, sent, sent + 8_000);
    };
    onTestFinished(() => {
      delete feedHooks.afterTurnWork;
    });
    await runTurnNow(owner);
    const turns = await turnOf(owner);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.operation_id).toBe(await newestTurnGrant(owner));
    expect((await liveOpeningTarget(env.DIRECTORY, owner.principalId)).turnHeld).toBe(true);
    socket.ws?.close(1000, "done");
  });

  it("holds the turn an opening hands its feed after a late look at the ledger, though newer turns ran and were released meanwhile", async () => {
    const owner = await user();
    const repo = await repoWithIssue(owner);
    const socket = await open(owner.token);
    const tokenId = await env.DIRECTORY.prepare("SELECT id FROM tokens WHERE token_hash = ?")
      .bind(await hashToken(owner.token))
      .first<string>("id");
    const credential = await liveCredential(env.DIRECTORY, tokenId as string, Date.now());
    if (!credential) throw new Error("no credential");
    // An MCP listen whose look at the ledger is answered 10 seconds late: its feed holds a turn
    // then, so it grants none with its socket.
    const looked = Promise.withResolvers<number>();
    const answer = Promise.withResolvers<void>();
    type Preparing = { prepare(query: string): D1PreparedStatement };
    const proto = Object.getPrototypeOf(env.DIRECTORY.withSession("first-primary")) as Preparing;
    const prepare = proto.prepare;
    let looks = 0;
    proto.prepare = function (this: Preparing, query: string) {
      const statement = prepare.call(this, query);
      // Its second: the transport's grant reads the first.
      if (!query.includes("AS turn_held") || ++looks !== 2) return statement;
      proto.prepare = prepare;
      const bind = statement.bind;
      statement.bind = function (this: D1PreparedStatement, ...values: unknown[]) {
        const bound = bind.apply(this, values);
        const first = bound.first.bind(bound) as () => Promise<Record<string, unknown>>;
        bound.first = (async () => {
          const row = await first();
          looked.resolve(row.now as number);
          await answer.promise;
          return row;
        }) as typeof bound.first;
        return bound;
      };
      return statement;
    };
    onTestFinished(() => {
      proto.prepare = prepare;
      answer.resolve();
    });
    const opening = openOwnedLiveSocket(
      { ...env, ...LIVE } as Env,
      credential,
      uniqueId("lt"),
      undefined,
    );
    const at = await looked.promise;
    // Meanwhile more of the feed's turns run than an opening looks at, and the last is released as
    // the only socket closes.
    const unpin = await pinLedgerClock(at + 10_000);
    onTestFinished(unpin);
    vi.setSystemTime(Date.now() + 10_000);
    for (let version = 1; version <= LIVE_TURN_RECEIPT_LOOK + 1; version++) {
      await feedOf(owner).applyFeed([change(owner, repo, version)]);
      await runTurnNow(owner);
      await runTurnNow(owner);
    }
    const closed = handled(owner, "close");
    socket.ws?.close(1000, "done");
    await closed();
    await runTurnNow(owner);
    expect(await turnOf(owner)).toEqual([]);
    // The look answered: the socket opens, and the feed asks for a turn, granted after it.
    answer.resolve();
    const opened = await opening;
    if (!opened.ok) throw new Error(JSON.stringify(opened));
    opened.response.webSocket?.accept();
    onTestFinished(() => opened.response.webSocket?.close(1000, "done"));
    expect(await turnOf(owner)).toHaveLength(1);
    expect((await liveOpeningTarget(env.DIRECTORY, owner.principalId)).turnHeld).toBe(true);
  });

  it("refuses an opening whose turn its object would not take, rather than open it with none", async () => {
    const owner = await user();
    const tokenId = await env.DIRECTORY.prepare("SELECT id FROM tokens WHERE token_hash = ?")
      .bind(await hashToken(owner.token))
      .first<string>("id");
    const credential = await liveCredential(env.DIRECTORY, tokenId as string, Date.now());
    if (!credential) throw new Error("no credential");
    // A Worker of an earlier build: the feed's first turn granted at the pump's price then, which
    // the object, built with a higher one, will not take. That Worker asks for no other turn once
    // it supplied one.
    const pump = LIVE_PRICES.pump as LiveManifestEntry;
    onTestFinished(() => {
      LIVE_PRICES.pump = pump;
      delete feedHooks.beforeEpochRead;
    });
    feedHooks.beforeEpochRead = async () => {
      delete feedHooks.beforeEpochRead;
      LIVE_PRICES.pump = {
        ...pump,
        resources: { ...pump.resources, do_rows_read: pump.resources.do_rows_read + 3 },
      };
    };
    const opened = await openOwnedLiveSocket(
      { ...env, ...LIVE } as Env,
      credential,
      uniqueId("lt"),
      undefined,
    );
    if (opened.ok) opened.response.webSocket?.accept();
    onTestFinished(() => {
      if (opened.ok) opened.response.webSocket?.close(1000, "done");
    });
    expect(opened.ok).toBe(false);
    expect(await turnOf(owner)).toEqual([]);
    expect(
      await env.DIRECTORY.prepare("SELECT count(*) AS n FROM live_sockets WHERE feed = ?")
        .bind(owner.principalId)
        .first(),
    ).toEqual({ n: 0 });
  });

  it("runs one turn when an opening passed over the one the feed holds, and loses no hint", async () => {
    const owner = await user();
    const repo = await repoWithIssue(owner);
    const first = await open(owner.token);
    const [held] = await turnOf(owner);
    const receipt = (id: string | undefined) =>
      env.DIRECTORY.prepare(
        "SELECT valid_until, released_owners FROM live_budget_receipts WHERE operation_id = ?",
      )
        .bind(id)
        .first<{ valid_until: number; released_owners: string }>();
    // More of the feed's turns released after it than an opening looks at (none can be while it
    // is held): the next opening misses it and grants a turn of its own.
    await releasedTurns(
      owner,
      ((await receipt(held?.operation_id))?.valid_until as number) + 1_000,
      LIVE_TURN_RECEIPT_LOOK,
      1_000,
    );
    const second = await open(owner.token);
    const extra = (
      await env.DIRECTORY.prepare(
        `SELECT operation_id FROM live_budget_receipts WHERE recipient = ? AND kind = 'pump'
           AND settled_at IS NULL AND json_array_length(released_owners) = 0`,
      )
        .bind(owner.principalId)
        .all<{ operation_id: string }>()
    ).results
      .map((r) => r.operation_id)
      .filter((id) => id !== held?.operation_id);
    expect(extra).toHaveLength(1);
    // The feed keeps the turn it held: still one, the same.
    expect(await turnOf(owner)).toEqual([
      expect.objectContaining({ phase: "prepared", operation_id: held?.operation_id }),
    ]);
    // A change reaches both sockets, by the held turn alone: the opening's never runs.
    await feedOf(owner).applyFeed([change(owner, repo, 1)]);
    await runTurnNow(owner);
    expect(await first.next()).toMatchObject({ t: "changed" });
    expect(await second.next()).toMatchObject({ t: "changed" });
    expect((await receipt(held?.operation_id))?.released_owners).not.toBe("[]");
    expect((await receipt(extra[0]))?.released_owners).toBe("[]");
    const after = await turnOf(owner);
    expect(after).toHaveLength(1);
    expect([held?.operation_id, extra[0]]).not.toContain(after[0]?.operation_id);
    first.ws?.close(1000, "done");
    second.ws?.close(1000, "done");
  });

  it("renews a socket from when it asked, however late its turn runs", async () => {
    const owner = await user();
    const socket = await open(owner.token);
    vi.useFakeTimers({ toFake: ["Date"] });
    await advance(owner, RENEW_LATE);
    const asked = Date.now();
    await say(owner, socket, { t: "renew" });
    await advance(owner, 2 * 60_000);
    await runDurableObjectAlarm(feedOf(owner));
    const renewed = (await socket.next()) as { until: number };
    expect(renewed.until).toBeGreaterThanOrEqual(asked + LIVE_POLICY.renewMs);
    expect(renewed.until).toBeLessThan(asked + LIVE_POLICY.renewMs + 60_000);
    socket.ws?.close(1000, "done");
  });

  it("grants and installs a queued refill, its pool given another block", async () => {
    const owner = await user();
    const socket = await open(owner.token);
    // Down to low water: a control queues the refill.
    await runInDurableObject(feedOf(owner), (_: UserDO, state) => {
      const unit = liveBlockUnit("control");
      const left = Object.fromEntries(
        Object.entries(unit).map(([r, v]) => [r, (v as number) * (LIVE_LOW_WATER + 1)]),
      );
      state.storage.sql.exec(
        "UPDATE live_budget_balances SET remaining = ? WHERE kind = 'control'",
        JSON.stringify(canonicalVector(left as never)),
      );
    });
    await say(owner, socket, { t: "ack", n: 0 });
    // Queued, it brings the feed's turn due at once (its row, written with the message: the
    // alarm itself may still be being rewritten).
    const [due] = await turnOf(owner);
    expect(due?.phase).toBe("prepared");
    expect(due?.intended_at).toBeLessThanOrEqual(Date.now());
    await runDurableObjectAlarm(feedOf(owner));
    const after = await runInDurableObject(feedOf(owner), (_: UserDO, state) => ({
      pending: state.storage.sql.exec("SELECT kind FROM live_budget_pending").toArray(),
      blocks: state.storage.sql
        .exec("SELECT DISTINCT operation_id FROM live_budget_balances WHERE kind = 'control'")
        .toArray().length,
    }));
    expect(after).toEqual({ pending: [], blocks: 2 });
    socket.ws?.close(1000, "done");
  });

  it("keeps a refill granted while its pool is full, and asks again for the same grant", async () => {
    const owner = await user();
    const socket = await open(owner.token);
    // Two spendable blocks today (the admission's and another), together down to low water.
    await runInDurableObject(feedOf(owner), (_: UserDO, state) => {
      const unit = liveBlockUnit("control");
      const left = Object.fromEntries(
        Object.entries(unit).map(([r, v]) => [r, (v as number) * (LIVE_LOW_WATER / 2)]),
      );
      state.storage.sql.exec(
        "UPDATE live_budget_balances SET remaining = ? WHERE kind = 'control'",
        JSON.stringify(canonicalVector(left as never)),
      );
      state.storage.sql.exec(
        `INSERT INTO live_budget_balances (operation_id, day, kind, remaining, budget_epoch,
           budget_incarnation, budget_seq, budget_valid_until)
         SELECT 'op_other', day, kind, remaining, budget_epoch, budget_incarnation, budget_seq,
           budget_valid_until FROM live_budget_balances WHERE kind = 'control'`,
      );
    });
    await say(owner, socket, { t: "ack", n: 0 });
    await runDurableObjectAlarm(feedOf(owner));
    const refills = () =>
      env.DIRECTORY.prepare(
        "SELECT count(*) AS n FROM live_budget_receipts WHERE kind = 'control' AND recipient = ?",
      )
        .bind(owner.principalId)
        .first<{ n: number }>()
        .then((r) => r?.n ?? 0);
    const kept = () =>
      runInDurableObject(feedOf(owner), (_: UserDO, state) =>
        state.storage.sql
          .exec<{ phase: string; asked: number }>(
            "SELECT phase, request_json IS NOT NULL AS asked FROM live_budget_pending WHERE kind = 'control_refill'",
          )
          .toArray(),
      );
    // Granted (one charge), no room: kept with its request, to ask again a minute on.
    const charged = await refills();
    expect(await kept()).toEqual([{ phase: "queued", asked: 1 }]);
    vi.useFakeTimers({ toFake: ["Date"] });
    await advance(owner, 61_000);
    await runDurableObjectAlarm(feedOf(owner));
    // The same grant again: charged once, still kept while the pool is full.
    expect(await refills()).toBe(charged);
    expect(await kept()).toEqual([{ phase: "queued", asked: 1 }]);
    socket.ws?.close(1000, "done");
  });

  it("lets a refill go unused when its pool was filled meanwhile, rather than asking again", async () => {
    const owner = await user();
    const socket = await open(owner.token);
    // Two blocks at low water together: a control queues the refill.
    const setBoth = (units: number) =>
      runInDurableObject(feedOf(owner), (_: UserDO, state) => {
        const unit = liveBlockUnit("control");
        const left = Object.fromEntries(
          Object.entries(unit).map(([r, v]) => [r, (v as number) * units]),
        );
        state.storage.sql.exec(
          "UPDATE live_budget_balances SET remaining = ? WHERE kind = 'control'",
          JSON.stringify(canonicalVector(left as never)),
        );
      });
    await runInDurableObject(feedOf(owner), (_: UserDO, state) =>
      state.storage.sql.exec(
        `INSERT INTO live_budget_balances (operation_id, day, kind, remaining, budget_epoch,
           budget_incarnation, budget_seq, budget_valid_until)
         SELECT 'op_other', day, kind, remaining, budget_epoch, budget_incarnation, budget_seq,
           budget_valid_until FROM live_budget_balances WHERE kind = 'control'`,
      ),
    );
    await setBoth(LIVE_LOW_WATER / 2);
    await say(owner, socket, { t: "ack", n: 0 });
    // Before its turn, both are full again (admissions installed blocks of their own, say): no
    // room, and nothing low, so it goes rather than costing a turn a minute.
    await setBoth(LIVE_BLOCK_UNITS);
    await runDurableObjectAlarm(feedOf(owner));
    const pending = await runInDurableObject(feedOf(owner), (_: UserDO, state) =>
      state.storage.sql.exec("SELECT kind FROM live_budget_pending").toArray(),
    );
    expect(pending).toEqual([]);
    socket.ws?.close(1000, "done");
  });

  it("installs a refill beside two blocks lapsing before the next renewal, on today too, at once", async () => {
    const owner = await user();
    const socket = await open(owner.token);
    // Two full blocks today (the admission's and another) that both lapse within a renewal
    // period: neither holds a place, so the refill is not refused for room.
    await runInDurableObject(feedOf(owner), (_: UserDO, state) => {
      const at = new LiveBudget(state.storage.sql).ledgerNow(Date.now());
      state.storage.sql.exec(
        "UPDATE live_budget_balances SET budget_valid_until = ? WHERE kind = 'control'",
        at + 60_000,
      );
      state.storage.sql.exec(
        `INSERT INTO live_budget_balances (operation_id, day, kind, remaining, budget_epoch,
           budget_incarnation, budget_seq, budget_valid_until)
         SELECT 'op_other', day, kind, remaining, budget_epoch, budget_incarnation, budget_seq,
           budget_valid_until FROM live_budget_balances WHERE kind = 'control'`,
      );
    });
    await say(owner, socket, { t: "ack", n: 0 });
    await runDurableObjectAlarm(feedOf(owner));
    const pool = await runInDurableObject(feedOf(owner), (_: UserDO, state) => {
      const sql = state.storage.sql;
      const today = Math.floor(new LiveBudget(sql).ledgerNow(Date.now()) / 86_400_000);
      return {
        pending: sql.exec("SELECT kind FROM live_budget_pending").toArray(),
        today: sql
          .exec(
            "SELECT count(*) AS n FROM live_budget_balances WHERE kind = 'control' AND day = ?",
            today,
          )
          .one().n,
      };
    });
    expect(pool).toEqual({ pending: [], today: 3 });
    socket.ws?.close(1000, "done");
  });

  it("asks again a refill an instance gone left dispatched, once its turn is dealt with", async () => {
    const owner = await user();
    const socket = await open(owner.token);
    // A refill dispatched by an instance gone with its turn, its answer never heard.
    await runInDurableObject(feedOf(owner), async (_: UserDO, state) => {
      const budget = new LiveBudget(state.storage.sql);
      const fence = budget.fence();
      const request = await makeLiveGrant(
        planFor(
          LIVE_PRICES.control_block as LiveManifestEntry,
          {
            incarnation: fence.incarnation,
            epoch: fence.epoch,
            recipientType: "UserDO",
            recipient: owner.principalId,
            class: "ordinary",
            kind: "control",
            producesLocal: true,
          },
          budget.ledgerEarliest(Date.now()),
        ),
      );
      state.storage.sql.exec(
        "UPDATE live_turn SET phase = 'dispatched', owner_id = 'own_gone', dispatch_instance = 'gone', intended_at = 0",
      );
      state.storage.sql.exec(
        `INSERT INTO live_budget_pending (kind, operation_id, intended_at, authorization_gen,
           budget_epoch, budget_incarnation, budget_seq, budget_valid_until, phase)
         SELECT 'control_refill', 'refill_gone', 0, authorization_gen, epoch, incarnation, 1, ?1,
           'queued' FROM live_budget_fence WHERE id = 1`,
        Date.now() + 600_000,
      );
      budget.preparePending("control_refill", "refill_gone", request);
      state.storage.sql.exec(
        `UPDATE live_budget_pending SET phase = 'dispatched', owner_id = 'own_gone',
           dispatch_instance = 'gone' WHERE kind = 'control_refill'`,
      );
      return state.storage.setAlarm(Date.now());
    });
    // The turn is dealt with (forgotten: its owner never admitted, the refill queued again); a
    // new socket hands the feed another, whose next turn asks for the refill and installs it.
    await runDurableObjectAlarm(feedOf(owner));
    const second = await open(owner.token);
    for (let i = 0; i < 2; i++) {
      await runInDurableObject(feedOf(owner), (_: UserDO, state) => {
        state.storage.sql.exec("UPDATE live_turn SET intended_at = 0");
        return state.storage.setAlarm(Date.now());
      });
      await runDurableObjectAlarm(feedOf(owner));
    }
    const after = await runInDurableObject(feedOf(owner), (_: UserDO, state) => ({
      pending: state.storage.sql.exec("SELECT kind FROM live_budget_pending").toArray(),
      refilled: state.storage.sql
        .exec("SELECT DISTINCT operation_id FROM live_budget_balances WHERE kind = 'control'")
        .toArray().length,
    }));
    expect(after).toEqual({ pending: [], refilled: 2 });
    socket.ws?.close(1000, "done");
    second.ws?.close(1000, "done");
  });

  it("gives up on a turn's result 10 seconds on: nothing of it applies, its successor among it", async () => {
    const owner = await user();
    const socket = await open(owner.token);
    vi.useFakeTimers({ toFake: ["Date"] });
    // Its work answered 11 seconds after it was dispatched (the ledger's clock moved with it).
    feedHooks.afterTurnWork = (_feed, state) => {
      vi.setSystemTime(Date.now() + 11_000);
      state.storage.sql.exec(
        "UPDATE live_budget_fence SET ledger_offset_ms = ledger_offset_ms - 11000",
      );
      return Promise.resolve();
    };
    try {
      await runInDurableObject(feedOf(owner), (_: UserDO, state) =>
        state.storage.sql.exec("UPDATE live_turn SET intended_at = 0"),
      );
      await runInDurableObject(feedOf(owner), (_: UserDO, state) =>
        state.storage.setAlarm(Date.now()),
      );
      await runDurableObjectAlarm(feedOf(owner));
    } finally {
      delete feedHooks.afterTurnWork;
    }
    expect(await turnOf(owner)).toEqual([]);
    socket.ws?.close(1000, "done");
  });

  it("names no successor whose grant was answered past its turn's 10 seconds", async () => {
    const owner = await user();
    const socket = await open(owner.token);
    vi.useFakeTimers({ toFake: ["Date"] });
    // The successor's grant answered 11 seconds after the turn was dispatched.
    feedHooks.afterSuccessorGrant = (state) => {
      vi.setSystemTime(Date.now() + 11_000);
      state.storage.sql.exec(
        "UPDATE live_budget_fence SET ledger_offset_ms = ledger_offset_ms - 11000",
      );
    };
    try {
      await runInDurableObject(feedOf(owner), (_: UserDO, state) => {
        state.storage.sql.exec("UPDATE live_turn SET intended_at = 0");
        return state.storage.setAlarm(Date.now());
      });
      await runDurableObjectAlarm(feedOf(owner));
    } finally {
      delete feedHooks.afterSuccessorGrant;
    }
    expect(await turnOf(owner)).toEqual([]);
    socket.ws?.close(1000, "done");
  });

  it("forgets admissions never confirmed as its turns have room, their leases released", async () => {
    const owner = await user();
    const socket = await open(owner.token);
    const stale = Array.from({ length: LIVE_POLICY.perFeed }, (_, i) => `lsk_stale${i}`);
    await runInDurableObject(feedOf(owner), (_: UserDO, state) => {
      for (const id of stale)
        state.storage.sql.exec(
          `INSERT INTO live_local (socket_id, credential_id, phase, expires_at, deadline, sent, acked,
             refresh_pending, blocked_since, renew_failures, controls_used, minute_start,
             minute_count, delivered_seq, retry_at, scopes, repo_ids)
           VALUES (?1, 'tok_x', 'confirming', ?2, ?2, 0, 0, 0, NULL, 0, 0, ?3, 0, 0, 0, '[]', NULL)`,
          id,
          Date.now() + 60 * 60_000,
          Date.now() - 2 * 60_000,
        );
      state.storage.sql.exec("UPDATE live_turn SET intended_at = 0");
      return state.storage.setAlarm(Date.now());
    });
    const left = () =>
      runInDurableObject(
        feedOf(owner),
        (_: UserDO, state) =>
          state.storage.sql
            .exec<{ n: number }>(
              "SELECT count(*) AS n FROM live_local WHERE socket_id LIKE 'lsk_stale%'",
            )
            .one().n,
      );
    // A page a turn (each as many as its grant has room for), the rest the next turn's.
    await runDurableObjectAlarm(feedOf(owner));
    const afterOne = await left();
    expect(afterOne).toBeLessThan(stale.length);
    for (let i = 0; i < stale.length && (await left()) > 0; i++) {
      await runInDurableObject(feedOf(owner), (_: UserDO, state) => {
        state.storage.sql.exec("UPDATE live_turn SET intended_at = 0");
        return state.storage.setAlarm(Date.now());
      });
      await runDurableObjectAlarm(feedOf(owner));
    }
    expect(await left()).toBe(0);
    socket.ws?.close(1000, "done");
  });

  it("runs again a turn an instance gone claimed but never had admitted", async () => {
    const owner = await user();
    const repo = await repoWithIssue(owner);
    const socket = await open(owner.token);
    // Claimed by another instance, which stopped before its owner was admitted.
    await runInDurableObject(feedOf(owner), (_: UserDO, state) =>
      state.storage.sql.exec(
        "UPDATE live_turn SET phase = 'claimed', dispatch_instance = 'gone', intended_at = 0",
      ),
    );
    await feedOf(owner).applyFeed([change(owner, repo, 1)]);
    await runInDurableObject(feedOf(owner), (_: UserDO, state) =>
      state.storage.setAlarm(Date.now()),
    );
    await runDurableObjectAlarm(feedOf(owner));
    await runDurableObjectAlarm(feedOf(owner));
    expect(await socket.next()).toMatchObject({ t: "changed" });
    socket.ws?.close(1000, "done");
  });

  it("is handed a turn by an admission that finds it holding none it can run", async () => {
    const owner = await user();
    const first = await open(owner.token);
    // Its turn lost (never delivered, say) while its grant is still unspent in the ledger.
    await runInDurableObject(feedOf(owner), (_: UserDO, state) =>
      state.storage.sql.exec("DELETE FROM live_turn"),
    );
    const second = await open(owner.token);
    expect(second.response.status).toBe(101);
    expect(await turnOf(owner)).toMatchObject([{ phase: "prepared" }]);
    for (const s of [first, second]) s.ws?.close(1000, "done");
  });

  it("runs no turn its grant paid less for than today's price: the feed is handed a new one", async () => {
    const owner = await user();
    const socket = await open(owner.token);
    // A turn granted before the price rose (a deploy since): the ledger charged it the old price
    // (66 rows written a day), and it is the feed's prepared turn.
    await runInDurableObject(feedOf(owner), async (_: UserDO, state) => {
      const budget = new LiveBudget(state.storage.sql);
      const fence = budget.fence();
      const priced = planFor(
        LIVE_PRICES.pump as LiveManifestEntry,
        {
          incarnation: fence.incarnation,
          epoch: fence.epoch,
          recipientType: "UserDO",
          recipient: owner.principalId,
          class: "ordinary",
          kind: "pump",
          producesLocal: true,
        },
        budget.ledgerEarliest(Date.now()),
      );
      const cheaper = {
        ...priced,
        charges: priced.charges.map((c) => ({
          ...c,
          resources: { ...c.resources, do_rows_written: 66 },
        })),
      };
      const granted = await reserveLive(env.DIRECTORY, await makeLiveGrant(cheaper));
      if (granted.status !== "granted") throw new Error(granted.reason);
      state.storage.sql.exec(
        `UPDATE live_turn SET operation_id = ?, envelope_json = ?, budget_seq = ?,
           budget_valid_until = ?, phase = 'prepared', owner_id = NULL, dispatch_instance = NULL`,
        granted.grant.operationId,
        JSON.stringify(granted.grant),
        granted.grant.seq,
        granted.grant.plan.validUntil,
      );
    });
    // Not runnable: a renewal finds nothing to authorize it and closes the socket to reconnect.
    vi.useFakeTimers({ toFake: ["Date"] });
    await advance(owner, RENEW_LATE);
    await say(owner, socket, { t: "renew" });
    expect(await socket.closed).toEqual({ code: 4401 });
    // The reconnect's admission hands the feed a fresh grant at today's price, which runs and
    // names its successor.
    const again = await open(owner.token);
    const paid = await runInDurableObject(feedOf(owner), (_: UserDO, state) => {
      const row = state.storage.sql
        .exec<{ envelope_json: string; phase: string }>(
          "SELECT envelope_json, phase FROM live_turn",
        )
        .one();
      const envelope = JSON.parse(row.envelope_json) as LiveEnvelope;
      return { phase: row.phase, written: envelope.plan.charges[0]?.resources.do_rows_written };
    });
    expect(paid).toEqual({
      phase: "prepared",
      written: (LIVE_PRICES.pump as LiveManifestEntry).resources.do_rows_written,
    });
    const [fresh] = await turnOf(owner);
    await runInDurableObject(feedOf(owner), (_: UserDO, state) => {
      state.storage.sql.exec("UPDATE live_turn SET intended_at = 0");
      return state.storage.setAlarm(Date.now());
    });
    await runDurableObjectAlarm(feedOf(owner));
    const [successor] = await turnOf(owner);
    expect(successor?.phase).toBe("prepared");
    expect(successor?.operation_id).toBeDefined();
    expect(successor?.operation_id).not.toBe(fresh?.operation_id);
    again.ws?.close(1000, "done");
  });

  it("tells a socket to reconnect when its renewal finds no turn to authorize it", async () => {
    const owner = await user();
    const socket = await open(owner.token);
    // Its turn lost with no successor (a dispatched one adopted after its accounting failed, or
    // one whose successor the ledger refused): nothing would ever answer the renewal.
    await runInDurableObject(feedOf(owner), (_: UserDO, state) =>
      state.storage.sql.exec("DELETE FROM live_turn"),
    );
    vi.useFakeTimers({ toFake: ["Date"] });
    await advance(owner, RENEW_LATE);
    socket.ws?.send(JSON.stringify({ t: "renew" }));
    // Closed as an expired socket is, so the client reconnects at once: its admission grants a turn.
    expect(await socket.closed).toEqual({ code: 4401 });
  });

  it("tells a socket to reconnect when a turn running as it renews ends with no successor", async () => {
    const owner = await user();
    const socket = await open(owner.token);
    vi.useFakeTimers({ toFake: ["Date"] });
    await advance(owner, RENEW_LATE);
    // The renewal arrives while the turn runs, after its work (so it is left queued); then
    // today's escrow places fill, so its successor (an owned unit) is refused.
    feedHooks.afterTurnWork = async (feed, state) => {
      delete feedHooks.afterTurnWork;
      const [ws] = state.getWebSockets();
      if (ws) void feed.webSocketMessage(ws, JSON.stringify({ t: "renew" }));
      await fillEscrow();
    };
    const dataset = env.METRICS as unknown as { writeDataPoint: (point: unknown) => void };
    const write = dataset.writeDataPoint;
    const noted: string[][] = [];
    dataset.writeDataPoint = (point: unknown) => {
      const p = point as { indexes?: string[]; blobs?: string[] };
      if (p.indexes?.[0] === "live.turn_no_successor") noted.push(p.blobs ?? []);
      write.call(dataset, point);
    };
    try {
      await runInDurableObject(feedOf(owner), (_: UserDO, state) => {
        state.storage.sql.exec("UPDATE live_turn SET intended_at = 0");
        return state.storage.setAlarm(Date.now());
      });
      await runDurableObjectAlarm(feedOf(owner));
    } finally {
      delete feedHooks.afterTurnWork;
      dataset.writeDataPoint = write;
    }
    expect(await turnOf(owner)).toEqual([]);
    expect(await socket.closed).toEqual({ code: 4401 });
    expect(noted.map((blobs) => blobs.includes("escrow_full"))).toEqual([true]);
  });

  /** Runs the feed's due turns until none is due now; how many ran. */
  const runDueTurns = async (who: Who) => {
    let ran = 0;
    for (; ran < 8; ran++) {
      const [turn] = await turnOf(who);
      if (!turn || (turn.intended_at as number) > Date.now()) break;
      await runInDurableObject(feedOf(who), (_: UserDO, state) =>
        state.storage.setAlarm(Date.now()),
      );
      await runDurableObjectAlarm(feedOf(who));
    }
    return ran;
  };
  /** The feed's marks all spent, so the next change finds nothing to pay with. */
  const spendMarks = (who: Who) =>
    runInDurableObject(feedOf(who), (_: UserDO, state) =>
      state.storage.sql.exec(
        "UPDATE live_budget_balances SET remaining = ? WHERE kind = 'mark'",
        JSON.stringify(
          canonicalVector(
            Object.fromEntries(Object.keys(liveBlockUnit("mark")).map((r) => [r, 0])) as never,
          ),
        ),
      ),
    );

  /** Metric points named `name` written while `fn` runs. */
  const metricPoints = async (name: string, fn: () => Promise<unknown>) => {
    const dataset = env.METRICS as unknown as { writeDataPoint: (point: unknown) => void };
    const write = dataset.writeDataPoint;
    const noted: string[][] = [];
    dataset.writeDataPoint = (point: unknown) => {
      const p = point as { indexes?: string[]; blobs?: string[] };
      if (p.indexes?.[0] === name) noted.push(p.blobs ?? []);
      write.call(dataset, point);
    };
    try {
      await fn();
    } finally {
      dataset.writeDataPoint = write;
    }
    return noted;
  };
  const runTurnNow = async (who: Who) => {
    await runInDurableObject(feedOf(who), (_: UserDO, state) => {
      state.storage.sql.exec("UPDATE live_turn SET intended_at = 0");
      return state.storage.setAlarm(Date.now());
    });
    await runDurableObjectAlarm(feedOf(who));
  };

  /** Every mark block past its validity: what a feed quiet for 12 hours finds. */
  const expireMarks = (who: Who) =>
    runInDurableObject(feedOf(who), (_: UserDO, state) =>
      state.storage.sql.exec(
        "UPDATE live_budget_balances SET budget_valid_until = 0 WHERE kind = 'mark'",
      ),
    );

  it("names a change that found every mark block expired, and then rests", async () => {
    const owner = await user();
    const repo = await repoWithIssue(owner);
    const socket = await open(owner.token);
    await expireMarks(owner);
    await feedOf(owner).applyFeed([change(owner, repo, 1)]);
    expect(await runDueTurns(owner)).toBeLessThan(8);
    expect(await socket.next()).toMatchObject({ t: "changed", streams: [{ repo: repo.id }] });
    socket.ws?.close(1000, "done");
  });

  it("tells nothing of such a change to a token limited to another repository, past expiry too", async () => {
    const owner = await user();
    const [repo, other] = [await repoWithIssue(owner), await repoWithIssue(owner)];
    const socket = await open(await scopedToken(owner.principalId, [], "pat", [other.id]));
    await expireMarks(owner);
    await feedOf(owner).applyFeed([change(owner, repo, 1)]);
    expect(await runDueTurns(owner)).toBeLessThan(8);
    expect(socket.frames).toEqual([]);
    socket.ws?.close(1000, "done");
  });

  describe("with a refusal answered past its turn's 10 seconds", () => {
    /** The turn's result out of date when its refusal comes; `meanwhile` then acts for the feed. */
    const lateRefusal = async (
      owner: Who,
      meanwhile?: (state: DurableObjectState) => void,
      before?: () => Promise<unknown>,
    ) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      feedHooks.afterTurnWork = async () => {
        delete feedHooks.afterTurnWork;
        await before?.();
        await fillEscrow();
      };
      feedHooks.afterSuccessorGrant = (state) => {
        delete feedHooks.afterSuccessorGrant;
        vi.setSystemTime(Date.now() + 11_000);
        state.storage.sql.exec(
          "UPDATE live_budget_fence SET ledger_offset_ms = ledger_offset_ms - 11000",
        );
        meanwhile?.(state);
      };
      try {
        return await metricPoints("live.turn_no_successor", () => runTurnNow(owner));
      } finally {
        delete feedHooks.afterTurnWork;
        delete feedHooks.afterSuccessorGrant;
      }
    };
    const pausedFrames = (socket: { frames: unknown[] }) =>
      socket.frames.filter((f) => (f as { t: string }).t === "paused");

    it("leaves no socket of an unchanged feed silent: its turn gone, they are told", async () => {
      const owner = await user();
      const socket = await open(owner.token);
      const noted = await lateRefusal(owner);
      expect(noted.map((blobs) => blobs.includes("given_up"))).toEqual([true]);
      expect(await turnOf(owner)).toEqual([]);
      expect(pausedFrames(socket)).toEqual([
        expect.objectContaining({ t: "paused", reason: "given_up" }),
      ]);
      socket.ws?.close(1000, "done");
    });

    /** The turn's owner gone from under it: its accounting fails, so its turn stays for recovery. */
    const loseOwner = (who: Who) =>
      env.DIRECTORY.prepare(
        "DELETE FROM live_duration_owners WHERE object_type = 'UserDO' AND object_id = ?",
      )
        .bind(who.principalId)
        .run();

    it("tells them too when its accounting failed, keeping its turn and owner for recovery", async () => {
      const owner = await user();
      const socket = await open(owner.token);
      const noted = await lateRefusal(owner, undefined, () => loseOwner(owner));
      expect(noted.map((blobs) => blobs.includes("given_up"))).toEqual([true]);
      expect(await turnOf(owner)).toMatchObject([{ phase: "dispatched" }]);
      expect(
        await runInDurableObject(
          feedOf(owner),
          (_: UserDO, state) =>
            state.storage.sql.exec<{ owner_id: string }>("SELECT owner_id FROM live_turn").one()
              .owner_id,
        ),
      ).toEqual(expect.any(String));
      expect(pausedFrames(socket)).toEqual([
        expect.objectContaining({ t: "paused", reason: "given_up" }),
      ]);
      socket.ws?.close(1000, "done");
    });

    it("tells them when a grant in time was lost to a failed accounting, its turn kept", async () => {
      const owner = await user();
      const socket = await open(owner.token);
      feedHooks.afterTurnWork = async () => {
        delete feedHooks.afterTurnWork;
        await loseOwner(owner);
      };
      try {
        const noted = await metricPoints("live.turn_no_successor", () => runTurnNow(owner));
        expect(noted.map((blobs) => blobs.includes("given_up"))).toEqual([true]);
      } finally {
        delete feedHooks.afterTurnWork;
      }
      expect(await turnOf(owner)).toMatchObject([{ phase: "dispatched" }]);
      expect(pausedFrames(socket)).toEqual([
        expect.objectContaining({ t: "paused", reason: "given_up" }),
      ]);
      socket.ws?.close(1000, "done");
    });

    it("tells no socket, and counts nothing, when another turn has taken its place", async () => {
      const owner = await user();
      const socket = await open(owner.token);
      const noted = await lateRefusal(owner, (state) => {
        state.storage.sql.exec("UPDATE live_turn SET operation_id = 'another turn'");
      });
      // Another turn's sockets: nothing of this turn counted either.
      expect(noted).toEqual([]);
      expect(pausedFrames(socket)).toEqual([]);
      socket.ws?.close(1000, "done");
    });
  });

  describe("with a dispatched turn that never answers", () => {
    // Each leaves its owner holding its place, for recovery: the deployment's places are the next
    // test's.
    afterEach(() =>
      env.DIRECTORY.prepare("DELETE FROM live_duration_owners WHERE object_type = 'UserDO'").run(),
    );

    const pausedFrames = (socket: { frames: unknown[] }) =>
      socket.frames.filter((f) => (f as { t: string }).t === "paused");
    const ownerOfTurn = (who: Who) =>
      runInDurableObject(feedOf(who), (_: UserDO, state) =>
        state.storage.sql.exec<{ owner_id: string }>("SELECT owner_id FROM live_turn").one(),
      );

    /**
     * Its work given up on at its pending bound, from within it (the object's own context, as its
     * timer's). `then` is what its work does next, and only after that: ending, or never.
     */
    const outlast = async (
      who: Who,
      then: () => Promise<void>,
      meanwhile?: (state: DurableObjectState) => void,
    ) => {
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      feedHooks.afterTurnWork = async (_feed, state) => {
        delete feedHooks.afterTurnWork;
        meanwhile?.(state);
        vi.advanceTimersByTime(LIVE_PENDING_MS);
        await then();
      };
      try {
        return await metricPoints("live.turn_no_successor", () => runTurnNow(who));
      } finally {
        delete feedHooks.afterTurnWork;
      }
    };
    const ends = () => Promise.resolve();
    const neverEnds = () => new Promise<void>(() => {});

    for (const [title, then] of [
      ["ends late", ends],
      ["never ends", neverEnds],
    ] as const)
      it(`tells its sockets once when given up on, keeps it for recovery, and counts it once: work that ${title}`, async () => {
        const owner = await user();
        const socket = await open(owner.token);
        const noted = await outlast(owner, then);
        expect(pausedFrames(socket)).toEqual([
          expect.objectContaining({ t: "paused", reason: "given_up" }),
        ]);
        expect(noted.map((blobs) => blobs.includes("given_up"))).toEqual([true]);
        expect(await turnOf(owner)).toMatchObject([{ phase: "dispatched" }]);
        expect((await ownerOfTurn(owner)).owner_id).toEqual(expect.any(String));
        socket.ws?.close(1000, "done");
      });

    it("tells no socket, and counts nothing, when another turn has taken its place, given up on", async () => {
      const owner = await user();
      const socket = await open(owner.token);
      const noted = await outlast(owner, ends, (state) => {
        state.storage.sql.exec("UPDATE live_turn SET operation_id = 'another turn'");
      });
      // Another turn's sockets: nothing of this turn counted either.
      expect(noted).toEqual([]);
      expect(pausedFrames(socket)).toEqual([]);
      socket.ws?.close(1000, "done");
    });

    it("tells its sockets when its work failed, keeps it for recovery, and counts it once", async () => {
      const owner = await user();
      const socket = await open(owner.token);
      feedHooks.afterTurnWork = async () => {
        delete feedHooks.afterTurnWork;
        throw new Error("lost");
      };
      try {
        const noted = await metricPoints("live.turn_no_successor", () => runTurnNow(owner));
        expect(noted.map((blobs) => blobs.includes("unknown"))).toEqual([true]);
      } finally {
        delete feedHooks.afterTurnWork;
      }
      expect(pausedFrames(socket)).toEqual([
        expect.objectContaining({ t: "paused", reason: "given_up" }),
      ]);
      expect(await turnOf(owner)).toMatchObject([{ phase: "dispatched" }]);
      expect((await ownerOfTurn(owner)).owner_id).toEqual(expect.any(String));
      socket.ws?.close(1000, "done");
    });

    it("counts nothing for a feed with no socket left to tell", async () => {
      const owner = await user();
      const socket = await open(owner.token);
      feedHooks.afterTurnWork = async (_feed, state) => {
        delete feedHooks.afterTurnWork;
        for (const ws of state.getWebSockets()) ws.close(1000, "done");
        throw new Error("lost");
      };
      try {
        const noted = await metricPoints("live.turn_no_successor", () => runTurnNow(owner));
        expect(noted).toEqual([]);
      } finally {
        delete feedHooks.afterTurnWork;
      }
      expect(pausedFrames(socket)).toEqual([]);
    });
  });

  describe("whatever an attempt at a turn ends in", () => {
    afterEach(() =>
      env.DIRECTORY.prepare("DELETE FROM live_duration_owners WHERE object_type = 'UserDO'").run(),
    );

    const pausedFrames = (socket: { frames: unknown[] }) =>
      socket.frames.filter((f) => (f as { t: string }).t === "paused");
    /** The feed's own places for ordinary owners, all held by others. */
    const holdPlaces = async (who: Who) => {
      for (let i = 0; i < 2; i++)
        await env.DIRECTORY.prepare(
          `INSERT INTO live_duration_owners (owner_id, operation_id, object_type, object_id, class,
             epoch, incarnation, dispatch_from, dispatch_until, holds, status, admitted_at)
           VALUES (?1, ?1, 'UserDO', ?2, 'ordinary', 0, ?3, 0, 1, '[]', 'reserved', 0)`,
        )
          .bind(uniqueId("held"), who.principalId, "0".repeat(32))
          .run();
    };
    /** The ledger's clock, as the feed's object judges it, moved to `ms` before its turn lapses. */
    const toLapse = (state: DurableObjectState, ms: number) => {
      const budget = new LiveBudget(state.storage.sql);
      const turn = budget.turn() as NonNullable<ReturnType<LiveBudget["turn"]>>;
      const shift = turn.envelope.plan.validUntil - budget.ledgerNow(Date.now()) - ms;
      state.storage.sql.exec(
        "UPDATE live_budget_fence SET ledger_offset_ms = ledger_offset_ms + ?",
        shift,
      );
    };

    it("retries a turn whose owner was refused, telling nothing, while it can still run", async () => {
      const owner = await user();
      const socket = await open(owner.token);
      await holdPlaces(owner);
      const noted = await metricPoints("live.turn_no_successor", () => runTurnNow(owner));
      expect(noted).toEqual([]);
      expect(pausedFrames(socket)).toEqual([]);
      expect(await turnOf(owner)).toMatchObject([{ phase: "prepared" }]);
      socket.ws?.close(1000, "done");
    });

    it("tells them once when its owner was refused and its grant lapses before it could run again", async () => {
      const owner = await user();
      const socket = await open(owner.token);
      await holdPlaces(owner);
      await runInDurableObject(feedOf(owner), (_: UserDO, state) => toLapse(state, 30_000));
      const noted = await metricPoints("live.turn_no_successor", () => runTurnNow(owner));
      expect(noted.map((blobs) => blobs.includes("owner:capacity"))).toEqual([true]);
      expect(pausedFrames(socket)).toEqual([
        expect.objectContaining({ t: "paused", reason: "given_up" }),
      ]);
      socket.ws?.close(1000, "done");
    });

    it("tells them once when its grant lapsed during its accounting, no successor installed", async () => {
      const owner = await user();
      const socket = await open(owner.token);
      let feed: DurableObjectState | undefined;
      feedHooks.afterTurnWork = async (_feed, state) => {
        delete feedHooks.afterTurnWork;
        feed = state;
      };
      // Its owner's observation, once its successor was granted in time: the turn lapses then.
      const proto = Object.getPrototypeOf(env.DIRECTORY) as {
        prepare(query: string): D1PreparedStatement;
      };
      const prepare = proto.prepare;
      proto.prepare = function (this: unknown, query: string) {
        if (feed && query.includes("SET status = 'observing'")) {
          toLapse(feed, -1_000);
          feed = undefined;
        }
        return prepare.call(this, query);
      };
      try {
        const noted = await metricPoints("live.turn_no_successor", () => runTurnNow(owner));
        expect(noted.map((blobs) => blobs.includes("given_up"))).toEqual([true]);
      } finally {
        proto.prepare = prepare;
        delete feedHooks.afterTurnWork;
      }
      expect(await turnOf(owner)).toEqual([]);
      expect(pausedFrames(socket)).toEqual([
        expect.objectContaining({ t: "paused", reason: "given_up" }),
      ]);
      socket.ws?.close(1000, "done");
    });

    it("tells them once when its turn lapsed before the run could claim it", async () => {
      const owner = await user();
      const socket = await open(owner.token);
      await runInDurableObject(feedOf(owner), (_: UserDO, state) => toLapse(state, -1_000));
      const noted = await metricPoints("live.turn_no_successor", () => runTurnNow(owner));
      expect(noted.map((blobs) => blobs.includes("given_up"))).toEqual([true]);
      expect(pausedFrames(socket)).toEqual([
        expect.objectContaining({ t: "paused", reason: "given_up" }),
      ]);
      socket.ws?.close(1000, "done");
    });

    /** The feed's turn left dispatched by work no longer running anywhere (an instance gone). */
    const strand = (state: DurableObjectState) =>
      state.storage.sql.exec("UPDATE live_turn SET phase = 'dispatched', owner_id = 'own_gone'");

    it("tells them once when the run adopted a stranded turn and found none left to run", async () => {
      const owner = await user();
      const socket = await open(owner.token);
      await runInDurableObject(feedOf(owner), (_: UserDO, state) => strand(state));
      const noted = await metricPoints("live.turn_no_successor", () => runTurnNow(owner));
      expect(noted.map((blobs) => blobs.includes("given_up"))).toEqual([true]);
      expect(await turnOf(owner)).toEqual([]);
      expect(pausedFrames(socket)).toEqual([
        expect.objectContaining({ t: "paused", reason: "given_up" }),
      ]);
      socket.ws?.close(1000, "done");
    });

    it("tells them once when adopting a stranded turn failed, the turn left as it was", async () => {
      const owner = await user();
      const socket = await open(owner.token);
      await runInDurableObject(feedOf(owner), (_: UserDO, state) => strand(state));
      const proto = Object.getPrototypeOf(env.DIRECTORY) as {
        prepare(query: string): D1PreparedStatement;
      };
      const prepare = proto.prepare;
      proto.prepare = function (this: unknown, query: string) {
        if (query.includes("SELECT owner_id, status FROM live_duration_owners")) {
          proto.prepare = prepare;
          throw new Error("lost");
        }
        return prepare.call(this, query);
      };
      try {
        const noted = await metricPoints("live.turn_no_successor", () =>
          runTurnNow(owner).catch(() => {}),
        );
        expect(noted.map((blobs) => blobs.includes("unknown"))).toEqual([true]);
      } finally {
        proto.prepare = prepare;
      }
      expect(await turnOf(owner)).toMatchObject([{ phase: "dispatched" }]);
      expect(pausedFrames(socket)).toEqual([
        expect.objectContaining({ t: "paused", reason: "given_up" }),
      ]);
      socket.ws?.close(1000, "done");
    });

    it("tells them once when the turn it claimed, installed while it adopted another, fails", async () => {
      const owner = await user();
      const socket = await open(owner.token);
      // The feed's turn left looking stranded (another, dispatched by work gone), its own row kept.
      const { state, real } = await runInDurableObject(feedOf(owner), (_: UserDO, state) => {
        const real = state.storage.sql
          .exec<{ operation_id: string }>("SELECT operation_id FROM live_turn")
          .one().operation_id;
        state.storage.sql.exec(
          "UPDATE live_turn SET operation_id = 'stranded', phase = 'dispatched', owner_id = 'own_gone'",
        );
        return { state, real };
      });
      // While the run adopts it, an admission installs the feed's turn (its real one) in its place.
      const proto = Object.getPrototypeOf(env.DIRECTORY) as {
        prepare(query: string): D1PreparedStatement;
      };
      const prepare = proto.prepare;
      proto.prepare = function (this: unknown, query: string) {
        if (query.includes("SELECT owner_id, status FROM live_duration_owners")) {
          proto.prepare = prepare;
          state.storage.sql.exec(
            `UPDATE live_turn SET operation_id = ?, phase = 'prepared', owner_id = NULL,
               intended_at = 0`,
            real,
          );
        }
        return prepare.call(this, query);
      };
      // The turn it then claims fails after its dispatch: kept for recovery, nothing to run.
      feedHooks.afterTurnWork = async () => {
        delete feedHooks.afterTurnWork;
        throw new Error("lost");
      };
      try {
        const noted = await metricPoints("live.turn_no_successor", () => runTurnNow(owner));
        expect(noted.map((blobs) => blobs.includes("unknown"))).toEqual([true]);
      } finally {
        proto.prepare = prepare;
        delete feedHooks.afterTurnWork;
      }
      expect(await turnOf(owner)).toMatchObject([{ phase: "dispatched", operation_id: real }]);
      expect(pausedFrames(socket)).toEqual([
        expect.objectContaining({ t: "paused", reason: "given_up" }),
      ]);
      socket.ws?.close(1000, "done");
    });

    it("tells them once when a turn left for want of room lapsed while the alarm was set again", async () => {
      const owner = await user();
      const socket = await open(owner.token);
      const state = await runInDurableObject(feedOf(owner), (_: UserDO, state) => state);
      // No room for its turn in the run (the mandatory steps only), and the turn lapsing as the
      // alarm is set again: no alarm left for it.
      feedHooks.alarmLimits = { ...ALARM_LIMITS, d1: ALARM_UNITS.mandatory.d1 };
      feedHooks.beforeAlarmWrite = async () => {
        delete feedHooks.beforeAlarmWrite;
        toLapse(state, -1_000);
      };
      try {
        const noted = await metricPoints("live.turn_no_successor", () => runTurnNow(owner));
        expect(noted.map((blobs) => blobs.includes("given_up"))).toEqual([true]);
      } finally {
        delete feedHooks.alarmLimits;
        delete feedHooks.beforeAlarmWrite;
      }
      expect(
        await runInDurableObject(feedOf(owner), (_: UserDO, s) => s.storage.getAlarm()),
      ).toBeNull();
      expect(pausedFrames(socket)).toEqual([
        expect.objectContaining({ t: "paused", reason: "given_up" }),
      ]);
      socket.ws?.close(1000, "done");
    });

    it("tells them once when a turn left for want of room lapsed while the alarm was set again for later work of the feed's own", async () => {
      const owner = await user();
      const socket = await open(owner.token);
      const state = await runInDurableObject(feedOf(owner), (_: UserDO, state) => {
        // The feed's own cursors due a day on: an alarm is left once the turn has lapsed.
        state.storage.sql.exec(
          "INSERT INTO user_schedule (kind, due_at) VALUES ('cursors', ?)",
          Date.now() + DAY,
        );
        return state;
      });
      feedHooks.alarmLimits = { ...ALARM_LIMITS, d1: ALARM_UNITS.mandatory.d1 };
      feedHooks.beforeAlarmWrite = async () => {
        delete feedHooks.beforeAlarmWrite;
        toLapse(state, -1_000);
      };
      try {
        const noted = await metricPoints("live.turn_no_successor", () => runTurnNow(owner));
        expect(noted.map((blobs) => blobs.includes("given_up"))).toEqual([true]);
      } finally {
        delete feedHooks.alarmLimits;
        delete feedHooks.beforeAlarmWrite;
      }
      expect(
        await runInDurableObject(feedOf(owner), (_: UserDO, s) => s.storage.getAlarm()),
      ).toBeGreaterThan(Date.now() + DAY / 2);
      expect(pausedFrames(socket)).toEqual([
        expect.objectContaining({ t: "paused", reason: "given_up" }),
      ]);
      socket.ws?.close(1000, "done");
    });

    it("tells them once when the turn installed while it adopted another, left for want of room, lapsed while the alarm was set again", async () => {
      const owner = await user();
      const socket = await open(owner.token);
      // The feed's turn left looking stranded (another, dispatched by work gone), its own row kept.
      const { state, real } = await runInDurableObject(feedOf(owner), (_: UserDO, state) => {
        const real = state.storage.sql
          .exec<{ operation_id: string }>("SELECT operation_id FROM live_turn")
          .one().operation_id;
        state.storage.sql.exec(
          "UPDATE live_turn SET operation_id = 'stranded', phase = 'dispatched', owner_id = 'own_gone'",
        );
        return { state, real };
      });
      // While the run adopts it, an admission installs the feed's turn (its real one) in its place.
      const proto = Object.getPrototypeOf(env.DIRECTORY) as {
        prepare(query: string): D1PreparedStatement;
      };
      const prepare = proto.prepare;
      proto.prepare = function (this: unknown, query: string) {
        if (query.includes("SELECT owner_id, status FROM live_duration_owners")) {
          proto.prepare = prepare;
          state.storage.sql.exec(
            `UPDATE live_turn SET operation_id = ?, phase = 'prepared', owner_id = NULL,
               intended_at = 0`,
            real,
          );
        }
        return prepare.call(this, query);
      };
      // Room in the run for adopting, none for the turn; the turn lapsing as the alarm is set
      // again: no alarm left for it.
      feedHooks.alarmLimits = {
        ...ALARM_LIMITS,
        d1: ALARM_UNITS.mandatory.d1 + ALARM_UNITS.quarantine.d1,
      };
      feedHooks.beforeAlarmWrite = async () => {
        delete feedHooks.beforeAlarmWrite;
        toLapse(state, -1_000);
      };
      try {
        const noted = await metricPoints("live.turn_no_successor", () => runTurnNow(owner));
        expect(noted.map((blobs) => blobs.includes("given_up"))).toEqual([true]);
      } finally {
        proto.prepare = prepare;
        delete feedHooks.alarmLimits;
        delete feedHooks.beforeAlarmWrite;
      }
      expect(await turnOf(owner)).toMatchObject([{ phase: "prepared", operation_id: real }]);
      expect(
        await runInDurableObject(feedOf(owner), (_: UserDO, s) => s.storage.getAlarm()),
      ).toBeNull();
      expect(pausedFrames(socket)).toEqual([
        expect.objectContaining({ t: "paused", reason: "given_up" }),
      ]);
      socket.ws?.close(1000, "done");
    });

    it("tells them once when the turn installed while it adopted another lapsed before it could be readied", async () => {
      const owner = await user();
      const socket = await open(owner.token);
      // The feed's turn left looking stranded (another, dispatched by work gone), its own row kept.
      const { state, real } = await runInDurableObject(feedOf(owner), (_: UserDO, state) => {
        const real = state.storage.sql
          .exec<{ operation_id: string }>("SELECT operation_id FROM live_turn")
          .one().operation_id;
        state.storage.sql.exec(
          "UPDATE live_turn SET operation_id = 'stranded', phase = 'dispatched', owner_id = 'own_gone'",
        );
        return { state, real };
      });
      // While the run adopts it, an admission installs the feed's turn (its real one) in its place,
      // and that turn lapses before the run reads whether it can run.
      const proto = Object.getPrototypeOf(env.DIRECTORY) as {
        prepare(query: string): D1PreparedStatement;
      };
      const prepare = proto.prepare;
      proto.prepare = function (this: unknown, query: string) {
        if (query.includes("SELECT owner_id, status FROM live_duration_owners")) {
          proto.prepare = prepare;
          state.storage.sql.exec(
            `UPDATE live_turn SET operation_id = ?, phase = 'prepared', owner_id = NULL,
               intended_at = 0`,
            real,
          );
          toLapse(state, -1_000);
        }
        return prepare.call(this, query);
      };
      try {
        const noted = await metricPoints("live.turn_no_successor", () => runTurnNow(owner));
        expect(noted.map((blobs) => blobs.includes("given_up"))).toEqual([true]);
      } finally {
        proto.prepare = prepare;
      }
      expect(await turnOf(owner)).toMatchObject([{ phase: "prepared", operation_id: real }]);
      expect(pausedFrames(socket)).toEqual([
        expect.objectContaining({ t: "paused", reason: "given_up" }),
      ]);
      socket.ws?.close(1000, "done");
    });

    it("counts a turn once though a socket opened since is told of it too", async () => {
      const owner = await user();
      const first = await open(owner.token);
      const lapsed = await runInDurableObject(feedOf(owner), (_: UserDO, state) => {
        toLapse(state, -1_000);
        return new LiveBudget(state.storage.sql).turn()?.operationId as string;
      });
      const initial = await metricPoints("live.turn_no_successor", () => runTurnNow(owner));
      expect(initial).toHaveLength(1);
      expect(pausedFrames(first)).toHaveLength(1);
      // Another socket opened since (its admission's turn put back as the lapsed one, its id the
      // same): told of it too, the turn not counted again.
      const second = await open(owner.token);
      expect(second.ws).not.toBeNull();
      await runInDurableObject(feedOf(owner), (_: UserDO, state) => {
        state.storage.sql.exec("UPDATE live_turn SET operation_id = ?", lapsed);
        toLapse(state, -1_000);
      });
      const again = await metricPoints("live.turn_no_successor", () => runTurnNow(owner));
      expect(pausedFrames(first)).toHaveLength(1);
      expect(pausedFrames(second)).toHaveLength(1);
      expect(again).toEqual([]);
      first.ws?.close(1000, "done");
      second.ws?.close(1000, "done");
    });

    it("counts a turn once though the socket told of it closed before another was told", async () => {
      const owner = await user();
      const first = await open(owner.token);
      const lapsed = await runInDurableObject(feedOf(owner), (_: UserDO, state) => {
        toLapse(state, -1_000);
        return new LiveBudget(state.storage.sql).turn()?.operationId as string;
      });
      const initial = await metricPoints("live.turn_no_successor", () => runTurnNow(owner));
      expect(initial).toHaveLength(1);
      expect(pausedFrames(first)).toHaveLength(1);
      // Another socket opened (the lapsed turn put back, its id the same) before a later alarm
      // finds the turn again.
      const second = await open(owner.token);
      expect(second.ws).not.toBeNull();
      await runInDurableObject(feedOf(owner), (_: UserDO, state) => {
        state.storage.sql.exec("UPDATE live_turn SET operation_id = ?", lapsed);
        toLapse(state, -1_000);
      });
      // The first closed (by the object: the one told of the turn), then the object evicted.
      await runInDurableObject(feedOf(owner), (_: UserDO, state) => {
        for (const ws of state.getWebSockets())
          if ((ws.deserializeAttachment() as { paused?: string }).paused === lapsed)
            ws.close(1000, "gone");
      });
      await evictDurableObject(feedOf(owner));
      const again = await metricPoints("live.turn_no_successor", () => runTurnNow(owner));
      expect(pausedFrames(second)).toHaveLength(1);
      expect(again).toEqual([]);
      second.ws?.close(1000, "done");
    });

    it("tells them of a lapsed turn once, whichever later alarm finds it again", async () => {
      const owner = await user();
      const socket = await open(owner.token);
      await runInDurableObject(feedOf(owner), (_: UserDO, state) => toLapse(state, -1_000));
      const noted = await metricPoints("live.turn_no_successor", async () => {
        await runTurnNow(owner);
        await runTurnNow(owner);
      });
      expect(noted.map((blobs) => blobs.includes("given_up"))).toEqual([true]);
      expect(pausedFrames(socket)).toEqual([
        expect.objectContaining({ t: "paused", reason: "given_up" }),
      ]);
      socket.ws?.close(1000, "done");
    });

    it("tells a socket of a lapsed turn at most once, though its attachment had no room for the mark", async () => {
      const owner = await user();
      const socket = await open(owner.token);
      await runInDurableObject(feedOf(owner), (_: UserDO, state) => toLapse(state, -1_000));
      // The platform refusing the attachment with its mark (past its size): the frame must not be
      // sent again by every later alarm.
      const serialize = WebSocket.prototype.serializeAttachment;
      WebSocket.prototype.serializeAttachment = function (this: WebSocket, value: unknown) {
        if (typeof (value as { paused?: unknown } | null)?.paused === "string")
          throw new RangeError("attachment too large");
        return serialize.call(this, value);
      };
      try {
        await runTurnNow(owner);
        await runTurnNow(owner);
      } finally {
        WebSocket.prototype.serializeAttachment = serialize;
      }
      expect(pausedFrames(socket).length).toBeLessThanOrEqual(1);
      socket.ws?.close(1000, "done");
    });

    it("tells nothing of a turn left for want of room that can still run", async () => {
      const owner = await user();
      const socket = await open(owner.token);
      feedHooks.alarmLimits = { ...ALARM_LIMITS, d1: ALARM_UNITS.mandatory.d1 };
      try {
        const noted = await metricPoints("live.turn_no_successor", () => runTurnNow(owner));
        expect(noted).toEqual([]);
      } finally {
        delete feedHooks.alarmLimits;
      }
      expect(pausedFrames(socket)).toEqual([]);
      expect(await turnOf(owner)).toMatchObject([{ phase: "prepared" }]);
      socket.ws?.close(1000, "done");
    });

    it("tells them once when its end failed, keeping it for recovery", async () => {
      const owner = await user();
      const socket = await open(owner.token);
      const finish = LiveBudget.prototype.finishTurn;
      LiveBudget.prototype.finishTurn = () => {
        LiveBudget.prototype.finishTurn = finish;
        throw new Error("lost");
      };
      try {
        const noted = await metricPoints("live.turn_no_successor", () =>
          runTurnNow(owner).catch(() => {}),
        );
        expect(noted.map((blobs) => blobs.includes("unknown"))).toEqual([true]);
      } finally {
        LiveBudget.prototype.finishTurn = finish;
      }
      expect(await turnOf(owner)).toMatchObject([{ phase: "dispatched" }]);
      expect(pausedFrames(socket)).toEqual([
        expect.objectContaining({ t: "paused", reason: "given_up" }),
      ]);
      socket.ws?.close(1000, "done");
    });
  });

  it("tells its other sockets it is paused when one is closing, and counts the turn once", async () => {
    const owner = await user();
    const [a, b] = [await open(owner.token), await open(owner.token)];
    feedHooks.afterTurnWork = async () => {
      delete feedHooks.afterTurnWork;
      await fillEscrow();
    };
    feedHooks.afterSuccessorGrant = (state) => {
      delete feedHooks.afterSuccessorGrant;
      // The first the broadcast will come to.
      state.getWebSockets()[0]?.close(1000, "closing");
    };
    try {
      const noted = await metricPoints("live.turn_no_successor", () => runTurnNow(owner));
      expect(noted.map((blobs) => blobs.includes("escrow_full"))).toEqual([true]);
    } finally {
      delete feedHooks.afterTurnWork;
      delete feedHooks.afterSuccessorGrant;
    }
    const heard = [...a.frames, ...b.frames].filter((f) => (f as { t: string }).t === "paused");
    expect(heard).toHaveLength(1);
    a.ws?.close(1000, "done");
    b.ws?.close(1000, "done");
  });

  it("names a change that found no marks left, after its refill, and then rests", async () => {
    const owner = await user();
    const repo = await repoWithIssue(owner);
    const socket = await open(owner.token);
    await spendMarks(owner);
    await feedOf(owner).applyFeed([change(owner, repo, 1)]);
    expect(await runDueTurns(owner)).toBeLessThan(8);
    expect(await socket.next()).toMatchObject({ t: "changed", streams: [{ repo: repo.id }] });
    socket.ws?.close(1000, "done");
  });

  it("tells nothing of such a change to a token limited to another repository, and rests", async () => {
    const owner = await user();
    const [repo, other] = [await repoWithIssue(owner), await repoWithIssue(owner)];
    const token = await scopedToken(owner.principalId, [], "pat", [other.id]);
    const socket = await open(token);
    await spendMarks(owner);
    await feedOf(owner).applyFeed([change(owner, repo, 1)]);
    expect(await runDueTurns(owner)).toBeLessThan(8);
    expect(socket.frames).toEqual([]);
    socket.ws?.close(1000, "done");
  });

  it("writes at most one such change until it was delivered", async () => {
    const owner = await user();
    const [repo, other] = [await repoWithIssue(owner), await repoWithIssue(owner)];
    const socket = await open(owner.token);
    await spendMarks(owner);
    await feedOf(owner).applyFeed([change(owner, repo, 1)]);
    await feedOf(owner).applyFeed([change(owner, other, 1)]);
    const rows = await runInDurableObject(feedOf(owner), (_: UserDO, state) =>
      state.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM live_dirty").one(),
    );
    expect(rows.n).toBe(1);
    socket.ws?.close(1000, "done");
  });

  it("counts a turn left with no successor when its grant was never asked, given up on", async () => {
    const owner = await user();
    const socket = await open(owner.token);
    vi.useFakeTimers({ toFake: ["Date"] });
    feedHooks.afterTurnWork = async (_feed, state) => {
      delete feedHooks.afterTurnWork;
      vi.setSystemTime(Date.now() + 11_000);
      state.storage.sql.exec(
        "UPDATE live_budget_fence SET ledger_offset_ms = ledger_offset_ms - 11000",
      );
    };
    try {
      const noted = await metricPoints("live.turn_no_successor", () => runTurnNow(owner));
      expect(noted.map((blobs) => blobs.includes("given_up"))).toEqual([true]);
    } finally {
      delete feedHooks.afterTurnWork;
    }
    socket.ws?.close(1000, "done");
  });

  it("counts a turn left with no successor when asking for its grant failed", async () => {
    const owner = await user();
    const socket = await open(owner.token);
    feedHooks.afterSuccessorGrant = () => {
      delete feedHooks.afterSuccessorGrant;
      throw new Error("lost");
    };
    try {
      const noted = await metricPoints("live.turn_no_successor", () => runTurnNow(owner));
      expect(noted.map((blobs) => blobs.includes("unknown"))).toEqual([true]);
    } finally {
      delete feedHooks.afterSuccessorGrant;
    }
    expect(socket.frames).toContainEqual(expect.objectContaining({ t: "paused" }));
    socket.ws?.close(1000, "done");
  });

  it("reads no socket row to tell its sockets they are paused", async () => {
    const owner = await user();
    const socket = await open(owner.token);
    const statements: string[] = [];
    let watching = false;
    const restore = await runInDurableObject(feedOf(owner), (_: UserDO, state) => {
      const sql = state.storage.sql;
      const real = sql.exec.bind(sql);
      (sql as { exec: unknown }).exec = (query: string, ...bindings: never[]) => {
        if (watching) statements.push(query);
        return real(query, ...bindings);
      };
      return () => {
        (sql as { exec: unknown }).exec = real;
      };
    });
    feedHooks.afterTurnWork = async () => {
      delete feedHooks.afterTurnWork;
      await fillEscrow();
    };
    feedHooks.afterSuccessorGrant = () => {
      delete feedHooks.afterSuccessorGrant;
      watching = true;
    };
    try {
      await runTurnNow(owner);
    } finally {
      delete feedHooks.afterTurnWork;
      delete feedHooks.afterSuccessorGrant;
      restore();
    }
    expect(await socket.next()).toMatchObject({ t: "paused" });
    expect(statements.filter((q) => /FROM live_local\s+ORDER BY socket_id/.test(q))).toEqual([]);
    socket.ws?.close(1000, "done");
  });

  it("tells a feed's open sockets its hints are paused, in the invocation that was refused, writing nothing for it", async () => {
    const owner = await user();
    const socket = await open(owner.token);
    feedHooks.afterTurnWork = async () => {
      delete feedHooks.afterTurnWork;
      await fillEscrow();
    };
    const sentBefore = await runInDurableObject(
      feedOf(owner),
      (_: UserDO, state) =>
        state.storage.sql.exec<{ sent: number }>("SELECT sent FROM live_local").one().sent,
    );
    const before = Date.now();
    try {
      await runInDurableObject(feedOf(owner), (_: UserDO, state) => {
        state.storage.sql.exec("UPDATE live_turn SET intended_at = 0");
        return state.storage.setAlarm(Date.now());
      });
      await runDurableObjectAlarm(feedOf(owner));
    } finally {
      delete feedHooks.afterTurnWork;
    }
    const frame = (await socket.next()) as { t: string; until: number; reason: string };
    expect(frame).toMatchObject({ t: "paused", reason: "escrow_full" });
    expect(frame.until).toBeGreaterThanOrEqual(before + 5 * 60_000);
    expect(frame.until).toBeLessThan(before + 6 * 60_000);
    // Unnumbered: it takes no place in the socket's window, and the socket stays until it goes.
    expect(
      await runInDurableObject(
        feedOf(owner),
        (_: UserDO, state) =>
          state.storage.sql.exec<{ sent: number }>("SELECT sent FROM live_local").one().sent,
      ),
    ).toBe(sentBefore);
    socket.ws?.close(1000, "done");
  });

  it("tells them until tomorrow when the day's room is what refused", async () => {
    const owner = await user();
    const socket = await open(owner.token);
    const today = await env.DIRECTORY.prepare(
      "SELECT CAST(unixepoch() / 86400 AS INTEGER) AS d",
    ).first<{ d: number }>();
    feedHooks.afterTurnWork = async () => {
      delete feedHooks.afterTurnWork;
      await env.DIRECTORY.prepare("UPDATE live_budget_days SET do_requests = ? WHERE day = ?")
        .bind(LIVE_DAILY.do_requests, today?.d)
        .run();
    };
    try {
      await runInDurableObject(feedOf(owner), (_: UserDO, state) => {
        state.storage.sql.exec("UPDATE live_turn SET intended_at = 0");
        return state.storage.setAlarm(Date.now());
      });
      await runDurableObjectAlarm(feedOf(owner));
    } finally {
      delete feedHooks.afterTurnWork;
      await env.DIRECTORY.prepare("UPDATE live_budget_days SET do_requests = 0 WHERE day = ?")
        .bind(today?.d)
        .run();
    }
    expect(await socket.next()).toEqual({
      t: "paused",
      until: ((today?.d as number) + 1) * 86_400_000,
      reason: "daily_total",
    });
    socket.ws?.close(1000, "done");
  });

  it("refuses a reconnect whose feed's lost turn cannot be granted again: closed 4412", async () => {
    const owner = await user();
    const first = await open(owner.token);
    // Its turn lost while its grant is still unsettled in the ledger: the admission grants none,
    // and the replacement asked for after it finds today's escrow places full.
    await runInDurableObject(feedOf(owner), (_: UserDO, state) =>
      state.storage.sql.exec("DELETE FROM live_turn"),
    );
    const issued = (await (await ticketFor(owner.token)).json()) as { ticket: string };
    await fillEscrow();
    const response = await call(
      new Request(`${ORIGIN}/api/notifications/live?ticket=${encodeURIComponent(issued.ticket)}`, {
        headers: { Upgrade: "websocket", Authorization: `Bearer ${owner.token}` },
      }),
    );
    expect(response.status).toBe(101);
    const ws = response.webSocket as WebSocket;
    const closed = new Promise<number>((resolve) =>
      ws.addEventListener("close", (event) => resolve(event.code)),
    );
    ws.accept();
    expect(await closed).toBe(4412);
    expect(await turnOf(owner)).toEqual([]);
    first.ws?.close(1000, "done");
  });

  it("refuses an opening before any grant when the day has no room to replace the turn its object lost: closed 4413", async () => {
    const owner = await user();
    const first = await open(owner.token);
    // Its turn lost while its grant is still unsettled in the ledger: the directory takes it as
    // held, so the opening is granted none until its object asks for one, after the others.
    await runInDurableObject(feedOf(owner), (_: UserDO, state) =>
      state.storage.sql.exec("DELETE FROM live_turn"),
    );
    const issued = (await (await ticketFor(owner.token)).json()) as { ticket: string };
    const target = await liveOpeningTarget(env.DIRECTORY, owner.principalId);
    expect(target.turnHeld).toBe(true);
    const today = target.view.today;
    const need = socketUnits(target).reduce(
      (n, unit) =>
        n +
        (planFor(
          LIVE_PRICES[unit] as LiveManifestEntry,
          {
            incarnation: target.incarnation,
            epoch: target.epoch,
            recipientType: "UserDO",
            recipient: owner.principalId,
            class: "ordinary",
            kind: liveKindOf(unit),
            producesLocal: true,
          },
          target.ledger.now,
        ).charges.find((c) => c.day === today)?.resources.d1_rows_written ?? 0),
      0,
    );
    // Today's ordinary share left with room for the opening's grants, but not a turn as well.
    await env.DIRECTORY.prepare(
      "UPDATE live_budget_days SET d1_rows_written = ?1 + protected_d1_rows_written WHERE day = ?2",
    )
      .bind(LIVE_DAILY.d1_rows_written - LIVE_PROTECTED.d1_rows_written - need, today)
      .run();
    const charged = () =>
      env.DIRECTORY.prepare(
        `SELECT (SELECT count(*) FROM live_budget_receipts WHERE recipient = ?1) AS receipts,
           (SELECT d1_rows_written FROM live_budget_days WHERE day = ?2) AS written`,
      )
        .bind(owner.principalId, today)
        .first();
    const before = await charged();
    const response = await call(
      new Request(`${ORIGIN}/api/notifications/live?ticket=${encodeURIComponent(issued.ticket)}`, {
        headers: { Upgrade: "websocket", Authorization: `Bearer ${owner.token}` },
      }),
    );
    expect(response.status).toBe(101);
    const ws = response.webSocket as WebSocket;
    const closed = new Promise<number>((resolve) =>
      ws.addEventListener("close", (event) => resolve(event.code)),
    );
    ws.accept();
    expect(await closed).toBe(4413);
    // Nothing granted: no admission, end or turn charged and left standing.
    expect(await charged()).toEqual(before);
    first.ws?.close(1000, "done");
  });

  it("opens a feed that holds its turn without granting another, though its pre-check counts one", async () => {
    const owner = await user();
    const first = await open(owner.token);
    const turns = () =>
      env.DIRECTORY.prepare(
        "SELECT count(*) AS n FROM live_budget_receipts WHERE recipient = ? AND kind = 'pump'",
      )
        .bind(owner.principalId)
        .first<{ n: number }>()
        .then((r) => r?.n);
    const before = await turns();
    const second = await open(owner.token);
    expect(second.response.status).toBe(101);
    expect(
      await env.DIRECTORY.prepare(
        "SELECT count(*) AS n FROM live_sockets WHERE feed = ? AND state = 'open'",
      )
        .bind(owner.principalId)
        .first(),
    ).toEqual({ n: 2 });
    expect(await turns()).toBe(before);
    expect(await turnOf(owner)).toHaveLength(1);
    first.ws?.close(1000, "done");
    second.ws?.close(1000, "done");
  });

  it("leases a socket to its renewal deadline, each renewal extending the lease", async () => {
    const owner = await user();
    const socket = await open(owner.token);
    const lease = () =>
      env.DIRECTORY.prepare("SELECT expires_at AS at FROM live_sockets WHERE feed = ?")
        .bind(owner.principalId)
        .first<{ at: number }>()
        .then((r) => r?.at as number);
    const first = await lease();
    expect(first).toBeLessThanOrEqual(
      Date.now() + LIVE_POLICY.renewMs + LIVE_ADMISSION.leaseMarginMs,
    );
    vi.useFakeTimers({ toFake: ["Date"] });
    await advance(owner, RENEW_LATE);
    await say(owner, socket, { t: "renew" });
    await runDurableObjectAlarm(feedOf(owner));
    expect(await socket.next()).toMatchObject({ t: "renewed" });
    expect(await lease()).toBeGreaterThan(first);
    socket.ws?.close(1000, "done");
  });

  it("forgets a socket whose end nothing is left to pay for, and keeps no turn going for it", async () => {
    const owner = await user();
    const socket = await open(owner.token);
    // Past its deadline, its terminal provisions gone (its prepaid days over).
    await runInDurableObject(feedOf(owner), (_: UserDO, state) => {
      state.storage.sql.exec("DELETE FROM live_budget_terminal");
      state.storage.sql.exec("UPDATE live_local SET deadline = 0");
      state.storage.sql.exec("UPDATE live_turn SET intended_at = 0");
      return state.storage.setAlarm(Date.now());
    });
    await runDurableObjectAlarm(feedOf(owner));
    expect(await socket.closed).toEqual({ code: 4401 });
    // Forgotten by the turn (at its own cost): no socket left, no successor named for it.
    const left = await runInDurableObject(
      feedOf(owner),
      (_: UserDO, state) =>
        state.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM live_local").one().n,
    );
    expect(left).toBe(0);
    expect(await turnOf(owner)).toEqual([]);
  });

  it("names a pump for a slow consumer whose end nothing is left to pay for, which forgets it", async () => {
    const owner = await user();
    const socket = await open(owner.token);
    // Its first turn: nothing else due, a turn of renewals only named after it.
    await runInDurableObject(feedOf(owner), (_: UserDO, state) => {
      state.storage.sql.exec("UPDATE live_turn SET intended_at = 0");
      return state.storage.setAlarm(Date.now());
    });
    await runDurableObjectAlarm(feedOf(owner));
    // Full past the slow-consumer limit, its terminal provisions gone.
    await runInDurableObject(feedOf(owner), (_: UserDO, state) => {
      state.storage.sql.exec("DELETE FROM live_budget_terminal");
      state.storage.sql.exec(
        "UPDATE live_local SET sent = acked + ?, blocked_since = ?",
        LIVE_POLICY.window,
        Date.now() - LIVE_POLICY.slowMs - 1,
      );
    });
    const left = () =>
      runInDurableObject(
        feedOf(owner),
        (_: UserDO, state) =>
          state.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM live_local").one().n,
      );
    for (let i = 0; i < 4 && (await left()) > 0; i++) {
      await runInDurableObject(feedOf(owner), (_: UserDO, state) => {
        state.storage.sql.exec("UPDATE live_turn SET intended_at = 0");
        return state.storage.setAlarm(Date.now());
      });
      await runDurableObjectAlarm(feedOf(owner));
    }
    expect(await socket.closed).toEqual({ code: 4409 });
    expect(await left()).toBe(0);
  });

  it("names a turn of renewals only when nothing else is due, and a pump once a change waits", async () => {
    const owner = await user();
    const repo = await repoWithIssue(owner);
    const socket = await open(owner.token);
    const kindOf = () =>
      runInDurableObject(feedOf(owner), (_: UserDO, state) => {
        const row = state.storage.sql
          .exec<{ envelope_json: string }>("SELECT envelope_json FROM live_turn")
          .toArray()[0];
        return row ? (JSON.parse(row.envelope_json) as LiveEnvelope).plan.kind : null;
      });
    const due = () =>
      runInDurableObject(feedOf(owner), (_: UserDO, state) => {
        state.storage.sql.exec("UPDATE live_turn SET intended_at = 0");
        return state.storage.setAlarm(Date.now());
      });
    // Its first turn (the admission's, a pump): nothing to deliver, so its successor renews only.
    await due();
    await runDurableObjectAlarm(feedOf(owner));
    expect(await kindOf()).toBe("renewal");
    // A change marked: the cheap turn cannot pay for its delivery, so it names a pump after it.
    await feedOf(owner).applyFeed([change(owner, repo, 1)]);
    await due();
    await runDurableObjectAlarm(feedOf(owner));
    expect(socket.frames).toEqual([]);
    expect(await kindOf()).toBe("pump");
    // The pump delivers it.
    await due();
    await runDurableObjectAlarm(feedOf(owner));
    expect(await socket.next()).toMatchObject({ t: "changed" });
    socket.ws?.close(1000, "done");
  });

  it("names no successor once the feed has no socket", async () => {
    const owner = await user();
    const socket = await open(owner.token);
    const closed = handled(owner, "close");
    socket.ws?.close(1000, "done");
    expect(await socket.closed).not.toBeNull();
    // Its close heard, then its turn run: nothing left for another.
    await closed();
    await runInDurableObject(feedOf(owner), (_: UserDO, state) => {
      state.storage.sql.exec("UPDATE live_turn SET intended_at = 0");
      return state.storage.setAlarm(Date.now());
    });
    await runDurableObjectAlarm(feedOf(owner));
    expect(await turnOf(owner)).toEqual([]);
  });
});

describe("live work's rows in a feed's object", () => {
  type Rows = { read: number; written: number; d1Read: number; d1Written: number };
  /**
   * Counts the rows the feed's object reads and writes while `fn` runs, and
   * the D1 rows every statement run meanwhile read and wrote, as D1's results
   * report them (the Worker's as well as the object's: an invocation's own
   * points miss a request served outside one).
   */
  async function rows(who: Who, fn: () => Promise<unknown>): Promise<Rows> {
    const sql = await runInDurableObject(feedOf(who), (_: UserDO, state) => state.storage.sql);
    const count = countingExec(sql);
    const d1 = countD1Rows();
    let counted: { read: number; written: number } | undefined;
    let d1Counted: { d1Read: number; d1Written: number } | undefined;
    try {
      await fn();
    } finally {
      d1Counted = d1.stop();
      counted = count.stop();
    }
    return { ...counted, ...d1Counted };
  }
  /** What `a` used past `b` (the same work without live's part), counter by counter. */
  const past = (a: Rows, b: Rows): Rows => ({
    read: Math.max(0, a.read - b.read),
    written: Math.max(0, a.written - b.written),
    d1Read: Math.max(0, a.d1Read - b.d1Read),
    d1Written: Math.max(0, a.d1Written - b.d1Written),
  });
  const measured: Record<string, Rows> = {};
  /** Room in the deployment for the fixtures' sockets (others' leases may still hold places). */
  const ROOMY = { ...LIVE, FYRDEN_LIVE_SOCKETS: "500" };
  const openSockets = (who: Who) =>
    runInDurableObject(
      feedOf(who),
      (_: UserDO, state) =>
        state.storage.sql
          .exec<{ n: number }>("SELECT count(*) AS n FROM live_local WHERE phase = 'open'")
          .one().n,
    );
  /**
   * Rows of each kind `page` says a prune deletes, left prunable in `who`'s
   * feed (heard of by every socket, expired, or long past): what a prune of
   * a full page finds.
   */
  const prunable = (
    who: Who,
    page: { dirty: number; candidates: number; tickets: number; revoked: number },
  ) =>
    runInDurableObject(feedOf(who), (_: UserDO, state) => {
      const sql = state.storage.sql;
      for (let i = 0; i < page.dirty; i++)
        sql.exec(
          "INSERT INTO live_dirty (stream, repo_id, subject, seq, explicit_seq, many_seq) VALUES (?, ?, 'issue', 0, 0, 0)",
          `old${i}\nissue`,
          `old${i}`,
        );
      for (let i = 0; i < page.candidates; i++)
        sql.exec(
          "INSERT INTO live_candidates (stream, conversation, direct_seq, ordinary_seq) VALUES (?, ?, 0, 0)",
          `old${i % Math.max(1, page.dirty)}\nissue`,
          `c${i}`,
        );
      for (let i = 0; i < page.tickets; i++)
        sql.exec(
          "INSERT INTO live_tickets (ticket_hash, credential_id, expires_at) VALUES (?, 'tok_old', 0)",
          `old${i}`,
        );
      for (let i = 0; i < page.revoked; i++)
        sql.exec("INSERT INTO live_revoked (dependency, at) VALUES (?, 0)", `credential:old${i}`);
    });
  /** `who`'s mark pool, every block of it left with `units` marks. */
  const marksLeft = (who: Who, units: number) =>
    runInDurableObject(feedOf(who), (_: UserDO, state) => {
      const left = Object.fromEntries(
        Object.entries(liveBlockUnit("mark")).map(([r, v]) => [r, (v as number) * units]),
      );
      state.storage.sql.exec(
        "UPDATE live_budget_balances SET remaining = ? WHERE kind = 'mark'",
        JSON.stringify(canonicalVector(left as never)),
      );
    });
  /** `who`'s ticket issued, then its upgrade: each one's rows, and the socket. */
  async function opening(who: Who, vars: Record<string, string> = LIVE) {
    let issued: { ticket: string } | undefined;
    const ticket = await rows(who, async () => {
      issued = (await (await ticketFor(who.token, vars)).json()) as { ticket: string };
    });
    let upgraded: Response | undefined;
    const upgrade = await rows(who, async () => {
      upgraded = await call(
        new Request(
          `${ORIGIN}/api/notifications/live?ticket=${encodeURIComponent(issued?.ticket ?? "")}`,
          { headers: { Upgrade: "websocket", Authorization: `Bearer ${who.token}` } },
        ),
        vars,
      );
    });
    expect(upgraded?.status).toBe(101);
    upgraded?.webSocket?.accept();
    return { ticket, upgrade, ws: upgraded?.webSocket };
  }

  /** Each unit's rows within the most its manifest entry observed (all compared at once). */
  const withinObserved = (units: Record<string, Rows>) => {
    const capped = Object.fromEntries(
      Object.entries(units).map(([unit, r]) => {
        const entry = LIVE_PRICES[unit as keyof typeof LIVE_PRICES] as LiveManifestEntry;
        const observed = Object.values(entry.observed);
        const most = (k: "do_rows_read" | "do_rows_written" | "d1_rows_read" | "d1_rows_written") =>
          Math.max(...observed.map((o) => o[k]));
        return [
          unit,
          {
            read: Math.min(r.read, most("do_rows_read")),
            written: Math.min(r.written, most("do_rows_written")),
            d1Read: Math.min(r.d1Read, most("d1_rows_read")),
            d1Written: Math.min(r.d1Written, most("d1_rows_written")),
          },
        ];
      }),
    );
    expect(units).toEqual(capped);
  };
  const note = (unit: string, r: Rows) => {
    const was = measured[unit] ?? { read: 0, written: 0, d1Read: 0, d1Written: 0 };
    measured[unit] = {
      read: Math.max(was.read, r.read),
      written: Math.max(was.written, r.written),
      d1Read: Math.max(was.d1Read, r.d1Read),
      d1Written: Math.max(was.d1Written, r.d1Written),
    };
  };

  /**
   * As many of `who`'s turns done as a turn's grant looks at and removes (of each kind, the
   * newest a page past what it looks at), each over two days: what a grant's removal of done
   * turns reads at most.
   */
  let doneSeq = Number.MAX_SAFE_INTEGER - 100;
  async function doneTurnReceipts(who: Who, at: number): Promise<void> {
    const { incarnation } = (await env.DIRECTORY.prepare(
      "SELECT incarnation FROM live_budget_state WHERE id = 1",
    ).first<{ incarnation: string }>()) as { incarnation: string };
    const day = Math.floor(at / DAY);
    const plan = JSON.stringify({ charges: [{ day: day - 1 }, { day }] });
    const zero = JSON.stringify(canonicalVector(ZERO));
    const each = LIVE_TURN_RECEIPT_LOOK + LIVE_TURN_RECEIPT_PAGE;
    await env.DIRECTORY.batch(
      ["pump", "renewal"].flatMap((kind, k) =>
        Array.from({ length: each }, (_, i) => {
          const validUntil = at - (k * each + i + 1) * MINUTE;
          return env.DIRECTORY.prepare(
            `INSERT INTO live_budget_receipts (seq, operation_id, mint, incarnation, recipient_type,
               recipient, kind, class, epoch, produces_local, valid_from, valid_until, granted_at,
               plan, directory_cleanup_debt, settle_until, expires_at, released_owners)
             VALUES (?, ?, ?, ?, 'UserDO', ?, ?, 'ordinary', 0, 1, ?, ?, ?, ?, ?, ?, ?, '["own_done"]')`,
          ).bind(
            doneSeq--,
            uniqueId("done"),
            uniqueId("mint"),
            incarnation,
            who.principalId,
            kind,
            validUntil - 30 * MINUTE,
            validUntil,
            validUntil - 30 * MINUTE,
            plan,
            zero,
            validUntil,
            validUntil + 2 * DAY,
          );
        }),
      ),
    );
  }

  /** A user whose feed has an epoch of its own: each check of it in a grant reads a row. */
  async function userWithEpoch(): Promise<Who> {
    const who = await user();
    await env.DIRECTORY.prepare("INSERT INTO source_epochs (source_id, epoch_gen) VALUES (?, 1)")
      .bind(feedEpochSource(who.principalId))
      .run();
    return who;
  }

  /**
   * The ledger's clock held at `at`, D1's and this isolate's alike, its receipts this test's
   * own (another test's may be overdue at `at`), and as many expired receipts as grants still
   * allow (one fewer than a page, none of them for two hours): each grant's overdue check reads
   * every one of them.
   */
  /** Holds this object's clock and the ledger's at `at`; moves both on by `ms` when called. */
  async function atLedger(at: number): Promise<(ms: number) => Promise<void>> {
    vi.useFakeTimers({ toFake: ["Date"], now: at });
    let ledger = at;
    let unpin = await pinLedgerClock(ledger);
    const forgetReceipts = () => env.DIRECTORY.prepare("DELETE FROM live_budget_receipts").run();
    onTestFinished(async () => {
      try {
        await forgetReceipts();
      } finally {
        unpin();
      }
    });
    await forgetReceipts();
    await expiredReceipts(at, LIVE_RECEIPTS_OVERDUE.page - 1);
    return async (ms) => {
      unpin();
      ledger += ms;
      unpin = await pinLedgerClock(ledger);
      vi.setSystemTime(Date.now() + ms);
    };
  }

  /**
   * Each step of a feed's turn within its measured most, and each turn within its grant, with the
   * ledger's clock held at `hour` of today (UTC).
   */
  async function meterTurnSteps(hour: number): Promise<void> {
    const at = Math.floor(Date.now() / DAY) * DAY + hour;
    const later = await atLedger(at);
    const steps: Partial<Record<keyof typeof LIVE_TURN_STEPS, Rows>> = {};
    // Only once a scenario's sockets are all open (a turn running while they are being opened
    // counts their admissions' work, done meanwhile, as its own: conservative, but not a step's).
    let measuring = false;
    feedHooks.turnStep = (step, used, count) => {
      if (!measuring) return;
      const each: Rows = {
        read: Math.ceil(used.do_rows_read / count),
        written: Math.ceil(used.do_rows_written / count),
        d1Read: Math.ceil(used.d1_rows_read / count),
        d1Written: Math.ceil(used.d1_rows_written / count),
      };
      const was = steps[step] ?? { read: 0, written: 0, d1Read: 0, d1Written: 0 };
      steps[step] = {
        read: Math.max(was.read, each.read),
        written: Math.max(was.written, each.written),
        d1Read: Math.max(was.d1Read, each.d1Read),
        d1Written: Math.max(was.d1Written, each.d1Written),
      };
    };
    // Socket ends within a turn, each its terminal provision's.
    let closed: Rows = { read: 0, written: 0, d1Read: 0, d1Written: 0 };
    // What terminal provisions paid for, in all: taken out of the alarm a turn is compared with.
    const paidByEnds: Rows = { read: 0, written: 0, d1Read: 0, d1Written: 0 };
    feedHooks.turnClose = (used) => {
      paidByEnds.read += used.do_rows_read;
      paidByEnds.written += used.do_rows_written;
      paidByEnds.d1Read += used.d1_rows_read;
      paidByEnds.d1Written += used.d1_rows_written;
      if (!measuring) return;
      closed = {
        read: Math.max(closed.read, used.do_rows_read),
        written: Math.max(closed.written, used.do_rows_written),
        d1Read: Math.max(closed.d1Read, used.d1_rows_read),
        d1Written: Math.max(closed.d1Written, used.d1_rows_written),
      };
    };
    // Each turn's metered work (its end kept for after): within what its grant paid.
    const done: { used: TurnRows; paid: TurnRows }[] = [];
    feedHooks.turnDone = (used, paid) => {
      if (measuring) done.push({ used, paid });
    };
    const turns: Rows[] = [];
    const turn = async (who: Who) => {
      await runInDurableObject(feedOf(who), (_: UserDO, state) => {
        state.storage.sql.exec("UPDATE live_turn SET intended_at = 0");
        return state.storage.setAlarm(Date.now());
      });
      const before = done.length;
      const ends = { ...paidByEnds };
      const gross = await rows(who, () => runDurableObjectAlarm(feedOf(who)));
      turns.push(gross);
      // Its sockets' ends, paid by their terminal provisions, are not the turn's.
      const whole = {
        read: gross.read - (paidByEnds.read - ends.read),
        written: gross.written - (paidByEnds.written - ends.written),
        d1Read: gross.d1Read - (paidByEnds.d1Read - ends.d1Read),
        d1Written: gross.d1Written - (paidByEnds.d1Written - ends.d1Written),
      };
      // An alarm that ran one turn: its whole (its claim and end, the alarm around it) and what that
      // turn's grant paid, compared below.
      if (measuring && done.length === before + 1)
        wholes.push({ whole, paid: (done.at(-1) as { paid: TurnRows }).paid });
    };
    const wholes: { whole: Rows; paid: TurnRows }[] = [];
    /**
     * `who`'s turn with both clocks a second on, as they are between a feed's turns: its successor
     * starts later than any turn the feed prepared, which its end records.
     */
    const turnLater = async (who: Who) => {
      await later(1_000);
      await turn(who);
    };
    /** What a turn used outside its meter (its whole less what its meter counted): its end. */
    const noteEnd = () => {
      const whole = turns.at(-1) as Rows;
      const metered = done.at(-1)?.used as TurnRows;
      const was = steps.end ?? { read: 0, written: 0, d1Read: 0, d1Written: 0 };
      steps.end = {
        read: Math.max(was.read, whole.read - metered.do_rows_read),
        written: Math.max(was.written, whole.written - metered.do_rows_written),
        d1Read: Math.max(was.d1Read, whole.d1Read - metered.d1_rows_read),
        d1Written: Math.max(was.d1Written, whole.d1Written - metered.d1_rows_written),
      };
    };
    try {
      // A turn with nothing to do: its own end.
      const idle = await userWithEpoch();
      const idleSocket = await open(idle.token, ROOMY);
      await doneTurnReceipts(idle, at);
      measuring = true;
      await turnLater(idle);
      noteEnd();
      // A renewal.
      vi.useFakeTimers({ toFake: ["Date"] });
      await advance(idle, RENEW_LATE);
      await say(idle, idleSocket, { t: "renew" });
      await turn(idle);
      // A refill: a control at low water queues it.
      await runInDurableObject(feedOf(idle), (_: UserDO, state) => {
        const unit = liveBlockUnit("control");
        const left = Object.fromEntries(
          Object.entries(unit).map(([r, v]) => [r, (v as number) * (LIVE_LOW_WATER + 1)]),
        );
        state.storage.sql.exec(
          "UPDATE live_budget_balances SET remaining = ? WHERE kind = 'control'",
          JSON.stringify(canonicalVector(left as never)),
        );
      });
      await say(idle, idleSocket, { t: "ack", n: 0 });
      await turn(idle);
      // A socket past its deadline: ended by the turn's housekeeping, on its terminal provision.
      await runInDurableObject(feedOf(idle), (_: UserDO, state) =>
        state.storage.sql.exec("UPDATE live_local SET deadline = 0"),
      );
      await turn(idle);
      expect(await idleSocket.closed).toEqual({ code: 4401 });
      // A renewal of an agent's own credential (its owner a dependency too).
      const owner = await user();
      const agent = await agentFor(owner, ["issues:read"]);
      const bot: Who = { principalId: agent.id, token: agent.own, handle: agent.handle };
      const botSocket = await open(agent.own, ROOMY);
      vi.useFakeTimers({ toFake: ["Date"] });
      await advance(bot, RENEW_LATE);
      await say(bot, botSocket, { t: "renew" });
      await turn(bot);
      botSocket.ws?.close(1000, "done");
      measuring = false;
      // A feed with its most sockets (four credentials' five): its housekeeping at its most; and two
      // of them renewing in a turn of renewals only, both answered (it has room for them).
      const crowd = await userWithEpoch();
      const crowdSockets: Awaited<ReturnType<typeof open>>[] = [];
      const crowdTokens = [
        crowd.token,
        ...(await Promise.all([1, 2, 3].map(() => scopedToken(crowd.principalId, [])))),
      ];
      for (const token of crowdTokens)
        for (let i = 0; i < LIVE_POLICY.perCredential; i++)
          crowdSockets.push(await open(token, ROOMY));
      expect(await openSockets(crowd)).toBe(LIVE_POLICY.perFeed);
      await doneTurnReceipts(crowd, at);
      measuring = true;
      await turnLater(crowd);
      noteEnd();
      await advance(crowd, RENEW_LATE);
      const renewing = [crowdSockets[0], crowdSockets[1]];
      for (const s of renewing) await say(crowd, s, { t: "renew" });
      const kind = await runInDurableObject(feedOf(crowd), (_: UserDO, state) => {
        const row = state.storage.sql
          .exec<{ envelope_json: string }>("SELECT envelope_json FROM live_turn")
          .one();
        return (JSON.parse(row.envelope_json) as LiveEnvelope).plan.kind;
      });
      expect(kind).toBe("renewal");
      await turn(crowd);
      for (const s of renewing) expect(await s?.next()).toMatchObject({ t: "renewed" });
      // All of them past their deadline with nothing left to pay for their ends: its housekeeping
      // at its most (each end looked for, none found), their rows forgotten by the turns after.
      await runInDurableObject(feedOf(crowd), (_: UserDO, state) => {
        state.storage.sql.exec("DELETE FROM live_budget_terminal");
        state.storage.sql.exec("UPDATE live_local SET deadline = 0");
      });
      for (let i = 0; i < 6; i++) await turn(crowd);
      measuring = false;
      for (const s of crowdSockets) s.ws?.close(1000, "done");
      // A delivery at its most (a full page at full causes) for a credential's most sockets beside
      // admissions never confirmed (their leases and dependencies in the directory too), once with
      // every conversation unsubscribed; a full page to prune. (A feed of four credentials' sockets:
      // the busy pump of the units' rows.)
      for (const { unsubscribed, credentials } of [
        { unsubscribed: false, credentials: 1 },
        { unsubscribed: true, credentials: 1 },
      ]) {
        const heavy = await userWithEpoch();
        const repos: { id: string; conversation: string }[] = [];
        for (let i = 0; i < LIVE_POLICY.dirtyPage + 2; i++) repos.push(await repoWithIssue(heavy));
        const sockets: Awaited<ReturnType<typeof open>>[] = [];
        const tokens = [
          heavy.token,
          ...(await Promise.all(
            Array.from({ length: credentials - 1 }, () => scopedToken(heavy.principalId, [])),
          )),
        ];
        for (const token of tokens)
          for (let i = 0; i < LIVE_POLICY.perCredential; i++)
            sockets.push(await open(token, ROOMY));
        await doneTurnReceipts(heavy, at);
        measuring = true;
        const unconfirmed = Array.from(
          { length: LIVE_POLICY.perFeed - credentials * LIVE_POLICY.perCredential },
          (_, i) => `lsk_unconfirmed_${heavy.principalId}_${i}`,
        );
        const dependencies = (i: number) => [
          `credential:tok_unconfirmed${i}`,
          `credential:src${i}`,
          `credential:root${i}`,
          `principal:${heavy.principalId}:0`,
          `principal:owner${i}:0`,
        ];
        // Marked and seeded in one call, its alarm taken away: nothing runs before the turns here
        // (a turn running meanwhile would count this seeding as its own work).
        const conversations = await runInDurableObject(feedOf(heavy), async (_: UserDO, state) => {
          const sql = state.storage.sql;
          const budget = new LiveBudget(sql);
          const stamp = budget.turnStamp(budget.ledgerNow(Date.now())) ?? undefined;
          const live = new Live(sql);
          for (const repo of repos)
            for (let i = 0; i < LIVE_POLICY.candidatesPerStream; i++)
              live.mark(
                [{ repoId: repo.id, subject: "issue", conversation: `other${i}`, direct: false }],
                stamp,
              );
          for (const [i, id] of unconfirmed.entries()) {
            sql.exec(
              `INSERT INTO live_local (socket_id, credential_id, phase, expires_at, deadline, sent,
                 acked, refresh_pending, blocked_since, renew_failures, controls_used, minute_start,
                 minute_count, delivered_seq, retry_at, scopes, repo_ids)
               VALUES (?1, ?2, 'confirming', ?3, ?3, 0, 0, 0, NULL, 0, 0, ?4, 0, 0, 0, '[]', NULL)`,
              id,
              `tok_unconfirmed${i}`,
              Date.now() + 60 * 60_000,
              Date.now() - 2 * 60_000,
            );
            for (const dependency of dependencies(i))
              sql.exec(
                "INSERT INTO live_local_deps (socket_id, dependency) VALUES (?, ?)",
                id,
                dependency,
              );
          }
          await state.storage.deleteAlarm();
          return sql
            .exec<{ stream: string; conversation: string }>(
              "SELECT stream, conversation FROM live_candidates",
            )
            .toArray();
        });
        if (unconfirmed.length > 0)
          await env.DIRECTORY.batch(
            unconfirmed.flatMap((id, i) => [
              env.DIRECTORY.prepare(
                `INSERT INTO live_sockets (socket_id, ticket_id, feed, credential_id, state,
                 pending_until, expires_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
              ).bind(
                id,
                uniqueId("t"),
                heavy.principalId,
                `tok_unconfirmed${i}`,
                Date.now(),
                Date.now() + 600_000,
              ),
              ...dependencies(i).map((dependency) =>
                env.DIRECTORY.prepare(
                  "INSERT INTO live_socket_deps (dependency, socket_id) VALUES (?, ?)",
                ).bind(dependency, id),
              ),
            ]),
          );
        if (unsubscribed)
          await env.DIRECTORY.batch(
            conversations.map(({ stream, conversation }) =>
              env.DIRECTORY.prepare(
                `INSERT INTO thread_preferences (principal_id, repo_id, conversation, number, kind,
                   root_id, state, revision, epoch_gen, at)
                 VALUES (?1, ?2, ?3, 1, 'issue', ?1, 'unsubscribed', 1, 1, ?4)`,
              ).bind(heavy.principalId, stream.split("\n")[0], conversation, Date.now()),
            ),
          );
        await prunable(heavy, LIVE_POLICY.prunePage);
        // As many turns as its work takes (each within its grant).
        for (let i = 0; i < 4; i++) await turn(heavy);
        measuring = false;
        for (const s of sockets) s.ws?.close(1000, "done");
      }
    } finally {
      delete feedHooks.turnStep;
      delete feedHooks.turnClose;
      delete feedHooks.turnDone;
    }
    if (process.env.FYRDEN_PRINT_ROWS) throw new Error(JSON.stringify({ steps, turns, closed }));
    // A socket's end within a turn (one at least), within its terminal provision.
    expect(closed.written).toBeGreaterThan(0);
    const terminal = Object.values((LIVE_PRICES.terminal as LiveManifestEntry).observed);
    const most = (k: "do_rows_read" | "do_rows_written") => Math.max(...terminal.map((o) => o[k]));
    expect({ read: closed.read, written: closed.written }).toEqual({
      read: Math.min(closed.read, most("do_rows_read")),
      written: Math.min(closed.written, most("do_rows_written")),
    });
    // All compared at once, so a run shows every step past its most.
    expect(steps).toEqual(
      Object.fromEntries(
        Object.entries(steps).map(([step, r]) => {
          const most = LIVE_TURN_STEPS[step as keyof typeof LIVE_TURN_STEPS];
          return [
            step,
            {
              read: Math.min(r.read, most.do_rows_read),
              written: Math.min(r.written, most.do_rows_written),
              d1Read: Math.min(r.d1Read, most.d1_rows_read),
              d1Written: Math.min(r.d1Written, most.d1_rows_written),
            },
          ];
        }),
      ),
    );
    // Each alarm that ran one turn, measured whole, within what that turn's grant paid.
    expect(wholes.length).toBeGreaterThan(0);
    for (const { whole, paid } of wholes)
      expect(whole).toEqual({
        read: Math.min(whole.read, paid.do_rows_read),
        written: Math.min(whole.written, paid.do_rows_written),
        d1Read: Math.min(whole.d1Read, paid.d1_rows_read),
        d1Written: Math.min(whole.d1Written, paid.d1_rows_written),
      });
    // Each turn within what its grant paid (its end, after its work, included).
    expect(done.length).toBeGreaterThan(0);
    const end = LIVE_TURN_STEPS.end;
    for (const { used, paid } of done) {
      const whole = {
        do_rows_read: used.do_rows_read + end.do_rows_read,
        do_rows_written: used.do_rows_written + end.do_rows_written,
        d1_rows_read: used.d1_rows_read + end.d1_rows_read,
        d1_rows_written: used.d1_rows_written + end.d1_rows_written,
      };
      expect(whole).toEqual({
        do_rows_read: Math.min(whole.do_rows_read, paid.do_rows_read),
        do_rows_written: Math.min(whole.do_rows_written, paid.do_rows_written),
        d1_rows_read: Math.min(whole.d1_rows_read, paid.d1_rows_read),
        d1_rows_written: Math.min(whole.d1_rows_written, paid.d1_rows_written),
      });
    }
  }

  // A refill's block reaches past midnight from its length before it (12:00 UTC), a turn's grant
  // (125 minutes) from 21:55, an account's confirmation (a minute) from 23:59: a second day's rows
  // each.
  for (const [when, hour] of [
    ["before a refill's block reaches midnight", DAY - LIVE_BLOCK_MS - 30 * MINUTE],
    ["with a refill's block past midnight", DAY - LIVE_BLOCK_MS + 30 * MINUTE],
    ["with every grant of a turn past midnight", 23 * HOUR + 59 * MINUTE + 30_000],
  ] as const)
    it(
      `meters a turn's steps: each within its measured most, a turn within its grant, ${when}`,
      () => meterTurnSteps(hour),
      90_000,
    );

  it("is within its ticket's, upgrade's (a browser's or an MCP listen's) and confirmation's D1 past midnight", async () => {
    // Half a minute to midnight: every grant of an opening (a ticket's, a minute) and of a
    // confirmation (a minute) reaches the next day; the ledger with an epoch, both days' rows,
    // as many expired receipts as grants allow, the feed's done turns to remove, and its turns
    // that ran still valid (passed over by the lookup of a turn it holds).
    const at = Math.floor(Date.now() / DAY) * DAY + DAY - 30_000;
    await atLedger(at);
    // Both days' rows there already (another feed's socket, its end provided for over two days).
    const other = await user();
    const warm = await open(other.token);
    // A repository of its own too: its socket's dependencies indexed with it.
    const owner = await userWithEpoch();
    await repoWithIssue(owner);
    await doneTurnReceipts(owner, at);
    await releasedTurns(owner, at + 27 * MINUTE);
    // The feed's first opening, and one after everything it granted is gone (its turn and
    // blocks granted again, the feed's object already there).
    const first = await opening(owner);
    await runInDurableObject(feedOf(owner), (_: UserDO, state) => {
      state.storage.sql.exec("DELETE FROM live_turn");
      state.storage.sql.exec("UPDATE live_budget_balances SET budget_valid_until = 0");
    });
    const again = await opening(owner);
    // An MCP listen's opening, with no ticket (its transport granted as it opens), as the first
    // of another such feed.
    const listener = await userWithEpoch();
    await repoWithIssue(listener);
    await doneTurnReceipts(listener, at);
    await releasedTurns(listener, at + 27 * MINUTE);
    const credential = (await liveCredential(
      env.DIRECTORY,
      (
        await env.DIRECTORY.prepare("SELECT id FROM tokens WHERE token_hash = ?")
          .bind(await hashToken(listener.token))
          .first<{ id: string }>()
      )?.id as string,
      Date.now(),
    )) as NonNullable<Awaited<ReturnType<typeof liveCredential>>>;
    let listened: Awaited<ReturnType<typeof openOwnedLiveSocket>> | undefined;
    const listen = await rows(listener, async () => {
      listened = await openOwnedLiveSocket(
        { ...env, ...LIVE } as Env,
        credential,
        `listen:${uniqueId("lsk")}`,
        undefined,
      );
    });
    expect(listened?.ok).toBe(true);
    const listenSocket = listened?.ok ? listened.response.webSocket : null;
    listenSocket?.accept();
    // Its turn granted again by it.
    expect(
      await runInDurableObject(feedOf(owner), (_: UserDO, state) =>
        state.storage.sql.exec("SELECT 1 FROM live_turn").toArray(),
      ),
    ).toHaveLength(1);
    const most = (a: Rows, b: Rows): Rows => ({
      read: 0,
      written: 0,
      d1Read: Math.max(a.d1Read, b.d1Read),
      d1Written: Math.max(a.d1Written, b.d1Written),
    });
    // A confirmation's grant alone, of an account's object.
    const confirmation = await rows(owner, async () => {
      const request = await makeLiveGrant(
        planFor(
          LIVE_PRICES.org_confirmation as LiveManifestEntry,
          {
            incarnation: (
              await env.DIRECTORY.prepare(
                "SELECT incarnation FROM live_budget_state WHERE id = 1",
              ).first<{ incarnation: string }>()
            )?.incarnation as string,
            epoch: 0,
            recipientType: "OrgDO",
            recipient: uniqueId("org"),
            class: "ordinary",
            kind: "org_confirmation",
            producesLocal: false,
          },
          at,
        ),
      );
      expect((await reserveLive(env.DIRECTORY, request)).status).toBe("granted");
    });
    withinObserved({
      ticket: most(first.ticket, again.ticket),
      upgrade_transport: most(most(first.upgrade, again.upgrade), listen),
      org_confirmation: { ...confirmation, read: 0, written: 0 },
    });
    for (const ws of [warm.ws, first.ws, again.ws, listenSocket]) ws?.close(1000, "done");
  });

  it("is within each unit's observed rows", async () => {
    const owner = await user();
    const repo = await repoWithIssue(owner);
    // A ticket stored, pruning a full page of expired tickets as it is.
    await prunable(owner, LIVE_TICKET_PRUNE);
    let issued: { ticket: string } | undefined;
    note(
      "ticket",
      await rows(owner, async () => {
        issued = (await (await ticketFor(owner.token)).json()) as { ticket: string };
      }),
    );
    // Its upgrade: the redemption and the admission with its provisions, blocks and turn (the
    // object's rows the admission's; its D1 the transport's to pay for, the whole attempt's,
    // measured apart from its ticket's on an opening of its own).
    const measuredOpening = await opening(owner);
    note("ticket", { ...measuredOpening.ticket, read: 0, written: 0 });
    note("upgrade_transport", { ...measuredOpening.upgrade, read: 0, written: 0 });
    measuredOpening.ws?.close(1000, "done");
    let socket: Awaited<ReturnType<typeof open>> | undefined;
    const opened = await rows(owner, async () => {
      socket = await open(owner.token);
    });
    note("admission", { ...opened, d1Read: 0, d1Written: 0 });
    // A control.
    note("control", await rows(owner, () => say(owner, socket, { t: "ack", n: 0 })));
    // A mark: a change applied with and without live sockets, its difference the mark's.
    const marked = await rows(owner, () => feedOf(owner).applyFeed([change(owner, repo, 1)]));
    // A turn running the pump.
    note("pump", await rows(owner, () => runDurableObjectAlarm(feedOf(owner))));
    // A renewal's turn.
    vi.useFakeTimers({ toFake: ["Date"] });
    await advance(owner, RENEW_LATE);
    await say(owner, socket, { t: "renew" });
    note("pump", await rows(owner, () => runDurableObjectAlarm(feedOf(owner))));
    // The socket's end.
    note(
      "terminal",
      await rows(owner, async () => {
        const closed = handled(owner, "close");
        socket?.ws?.close(1000, "done");
        await socket?.closed;
        await closed();
      }),
    );
    // The pump's most: a page of changed streams (and more), each holding its most causes, for a
    // credential's most sockets on a feed with its most, and a full page to prune.
    const busy = await user();
    const busyRepos: { id: string; conversation: string }[] = [];
    for (let i = 0; i < LIVE_POLICY.dirtyPage + 2; i++) busyRepos.push(await repoWithIssue(busy));
    const busySockets: Awaited<ReturnType<typeof open>>[] = [];
    const busyTokens = [
      busy.token,
      ...(await Promise.all([1, 2, 3].map(() => scopedToken(busy.principalId, [])))),
    ];
    for (const token of busyTokens)
      for (let i = 0; i < LIVE_POLICY.perCredential; i++)
        busySockets.push(await open(token, ROOMY));
    expect(await openSockets(busy)).toBe(LIVE_POLICY.perFeed);
    await feedOf(busy).applyFeed(busyRepos.map((r) => change(busy, r, 1)));
    // Each changed stream's other causes, as marks of other conversations leave them.
    await runInDurableObject(feedOf(busy), (_: UserDO, state) => {
      const sql = state.storage.sql;
      for (const { stream, seq } of sql
        .exec<{ stream: string; seq: number }>("SELECT stream, seq FROM live_dirty")
        .toArray())
        for (let i = 1; i < LIVE_POLICY.candidatesPerStream; i++)
          sql.exec(
            "INSERT INTO live_candidates (stream, conversation, direct_seq, ordinary_seq) VALUES (?, ?, 0, ?)",
            stream,
            `other${i}`,
            seq,
          );
    });
    await prunable(busy, LIVE_POLICY.prunePage);
    // Its delivery (a feed of four credentials' sockets), within its step's most too.
    let delivered: TurnRows | undefined;
    feedHooks.turnStep = (step, used) => {
      if (step === "delivery") delivered = used;
    };
    try {
      note("pump", await rows(busy, () => runDurableObjectAlarm(feedOf(busy))));
    } finally {
      delete feedHooks.turnStep;
    }
    // Every socket's window newly full: the delivery marks each blocked (and sends nothing).
    await runInDurableObject(feedOf(busy), (_: UserDO, state) =>
      state.storage.sql.exec(
        "UPDATE live_local SET sent = acked + ?, blocked_since = NULL",
        LIVE_POLICY.window,
      ),
    );
    await feedOf(busy).applyFeed([change(busy, busyRepos[0] as never, 2)]);
    let blocked: TurnRows | undefined;
    feedHooks.turnStep = (step, used) => {
      if (step === "delivery") blocked = used;
    };
    try {
      await runInDurableObject(feedOf(busy), (_: UserDO, state) => {
        state.storage.sql.exec("UPDATE live_turn SET intended_at = 0");
        return state.storage.setAlarm(Date.now());
      });
      await runDurableObjectAlarm(feedOf(busy));
    } finally {
      delete feedHooks.turnStep;
    }
    if (process.env.FYRDEN_PRINT_ROWS) throw new Error(JSON.stringify({ delivered, blocked }));
    expect(blocked).toBeDefined();
    for (const each of [delivered, blocked])
      expect(each).toEqual({
        do_rows_read: Math.min(each?.do_rows_read ?? 0, LIVE_TURN_STEPS.delivery.do_rows_read),
        do_rows_written: Math.min(
          each?.do_rows_written ?? 0,
          LIVE_TURN_STEPS.delivery.do_rows_written,
        ),
        d1_rows_read: Math.min(each?.d1_rows_read ?? 0, LIVE_TURN_STEPS.delivery.d1_rows_read),
        d1_rows_written: Math.min(
          each?.d1_rows_written ?? 0,
          LIVE_TURN_STEPS.delivery.d1_rows_written,
        ),
      });
    // A mark of a stream already holding its most causes, on a feed with its most sockets, and
    // one at its pool's low water (its refill queued): each the same change applied to a feed
    // made the same way without sockets taken out.
    const causeOf = (
      who: Who,
      repo: { id: string; conversation: string },
      i: number,
      version = 100 + i,
    ) =>
      entry({
        version,
        thread: 1,
        subject: "issue",
        repoId: repo.id,
        principal: who.principalId,
        conversation: `cause${i}`,
        kind: "mention",
        reasons: ["mentioned"],
        member: null,
        eventKey: `${repo.id}:${uniqueId("ev")}`,
      });
    const crowd = await user();
    const crowdRepo = await repoWithIssue(crowd);
    const crowdSockets: Awaited<ReturnType<typeof open>>[] = [];
    const tokens = [
      crowd.token,
      ...(await Promise.all([1, 2, 3].map(() => scopedToken(crowd.principalId, [])))),
    ];
    for (const token of tokens)
      for (let i = 0; i < LIVE_POLICY.perCredential; i++)
        crowdSockets.push(await open(token, ROOMY));
    expect(await openSockets(crowd)).toBe(LIVE_POLICY.perFeed);
    const plain = await user();
    const plainRepo = await repoWithIssue(plain);
    for (const [who, repo] of [
      [crowd, crowdRepo],
      [plain, plainRepo],
    ] as const) {
      await marksLeft(who, LIVE_BLOCK_UNITS);
      for (let i = 0; i < LIVE_POLICY.candidatesPerStream; i++)
        await feedOf(who).applyFeed([causeOf(who, repo, i)]);
    }
    const causes = await runInDurableObject(
      feedOf(crowd),
      (_: UserDO, state) =>
        state.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM live_candidates").one().n,
    );
    expect(causes).toBe(LIVE_POLICY.candidatesPerStream);
    const markOf = async (i: number, version = 100 + i) => {
      const marked = await rows(crowd, () =>
        feedOf(crowd).applyFeed([causeOf(crowd, crowdRepo, i, version)]),
      );
      const unmarked = await rows(plain, () =>
        feedOf(plain).applyFeed([causeOf(plain, plainRepo, i, version)]),
      );
      return past(marked, unmarked);
    };
    // Past its most causes (the stream is then marked as having many), with marks to spare.
    await marksLeft(crowd, LIVE_BLOCK_UNITS);
    note("mark", await markOf(LIVE_POLICY.candidatesPerStream));
    // One of its causes changed again (its row updated), with marks to spare.
    await marksLeft(crowd, LIVE_BLOCK_UNITS);
    // (Versions only grow: the thread's later changes each newer than the last.)
    note("mark", await markOf(0, 200));
    // At low water: its refill queued with it.
    await marksLeft(crowd, LIVE_LOW_WATER + 1);
    note("mark", await markOf(LIVE_POLICY.candidatesPerStream + 1, 300));
    const queued = await runInDurableObject(feedOf(crowd), (_: UserDO, state) =>
      state.storage.sql.exec("SELECT kind FROM live_budget_pending").toArray(),
    );
    expect(queued).toEqual([{ kind: "mark_refill" }]);
    // One of its causes changed again at low water: the cause's row updated and the refill queued.
    await runInDurableObject(feedOf(crowd), (_: UserDO, state) =>
      state.storage.sql.exec("DELETE FROM live_budget_pending"),
    );
    await marksLeft(crowd, LIVE_LOW_WATER + 1);
    note("mark", await markOf(0, 400));
    expect(
      await runInDurableObject(feedOf(crowd), (_: UserDO, state) =>
        state.storage.sql.exec("SELECT kind FROM live_budget_pending").toArray(),
      ),
    ).toEqual([{ kind: "mark_refill" }]);
    // The same with every socket's window full (each a socket the mark's scheduling looks at).
    await runInDurableObject(feedOf(crowd), (_: UserDO, state) => {
      state.storage.sql.exec("DELETE FROM live_budget_pending");
      state.storage.sql.exec("UPDATE live_local SET sent = acked + ?", LIVE_POLICY.window);
    });
    await marksLeft(crowd, LIVE_LOW_WATER + 1);
    note("mark", await markOf(1, 500));
    for (const s of crowdSockets) s.ws?.close(1000, "done");
    for (const s of busySockets) s.ws?.close(1000, "done");
    // A transport whose admission is refused: its redemption and the refusal's upgrade.
    const refusedOwner = await user();
    await env.DIRECTORY.prepare(
      `INSERT INTO live_sockets (socket_id, ticket_id, feed, credential_id, state, pending_until,
         expires_at) VALUES (?, ?, 'usr_x', 'tok_x', 'open', 0, ?)`,
    )
      .bind(uniqueId("lsk"), uniqueId("t"), Date.now() + 60_000)
      .run();
    // Measured apart from its ticket's issuance, as an upgrade's own.
    const refused = await opening(refusedOwner, { ...LIVE, FYRDEN_LIVE_SOCKETS: "1" });
    note("ticket", { ...refused.ticket, read: 0, written: 0 });
    note("upgrade_transport", { ...refused.upgrade, read: 0, written: 0 });
    const bare = await user();
    const bareRepo = await repoWithIssue(bare);
    const unmarked = await rows(bare, () => feedOf(bare).applyFeed([change(bare, bareRepo, 1)]));
    note("mark", past(marked, unmarked));
    expect(issued?.ticket).toBeDefined();
    // What was measured (for the manifest's observations), when asked.
    if (process.env.FYRDEN_PRINT_ROWS) throw new Error(JSON.stringify(measured));
    withinObserved(measured);
  }, 90_000);

  it("is within a revocation page's observed rows, a feed's most sockets closed by its tell", async () => {
    // A feed with its most sockets, all resting on the dependency revoked (the principal's), closed
    // and forgotten with their ends' provisions. Its own test: opening twenty sockets takes a while.
    const revokedFeed = await user();
    for (const token of [
      revokedFeed.token,
      ...(await Promise.all([1, 2, 3].map(() => scopedToken(revokedFeed.principalId, [])))),
    ])
      for (let i = 0; i < LIVE_POLICY.perCredential; i++) await open(token, ROOMY);
    expect(await openSockets(revokedFeed)).toBe(LIVE_POLICY.perFeed);
    const principal = await runInDurableObject(feedOf(revokedFeed), (_: UserDO, state) =>
      state.storage.sql
        .exec<{ dependency: string }>(
          "SELECT dependency FROM live_local_deps WHERE dependency LIKE 'principal:%' LIMIT 1",
        )
        .one(),
    );
    let closed: readonly string[] = [];
    const page = {
      revocation_page: await rows(revokedFeed, async () => {
        closed = await feedOf(revokedFeed).revoked([principal.dependency]);
      }),
    };
    expect(closed).toHaveLength(LIVE_POLICY.perFeed);
    if (process.env.FYRDEN_PRINT_ROWS) throw new Error(JSON.stringify(page));
    withinObserved(page);
  });
});

describe("a live socket's authority", () => {
  const sweepNow = () =>
    sweep(env.DIRECTORY, (feed, deps) => env.USER.getByName(feed).revoked(deps), Date.now());

  it("is checked again by every run that would send to it, whatever the sweep has done", async () => {
    const owner = await user();
    const repo = await repoWithIssue(owner);
    const token = await scopedToken(owner.principalId, []);
    const socket = await open(token);
    await env.DIRECTORY.prepare("UPDATE tokens SET revoked_at = ? WHERE token_hash = ?")
      .bind(Date.now(), await hashToken(token))
      .run();
    // No sweep yet: the change finds the credential gone, and sends nothing.
    await feedOf(owner).applyFeed([change(owner, repo, 1)]);
    await runDurableObjectAlarm(feedOf(owner));
    expect(await socket.closed).toEqual({ code: 4401 });
    expect(socket.frames).toEqual([]);
  });

  it("closes, after an unsuspension, only the sockets of the ended generation, by a run or a renewal", async () => {
    const owner = await user();
    const repo = await repoWithIssue(owner);
    const token = await scopedToken(owner.principalId, []);
    const old = await open(token);
    // Suspended and unsuspended before any sweep: a new generation.
    await env.DIRECTORY.prepare(
      "UPDATE principals SET lifecycle = 'suspended', disabled_at = ? WHERE id = ?",
    )
      .bind(Date.now(), owner.principalId)
      .run();
    await env.DIRECTORY.prepare(
      `UPDATE principals SET lifecycle = 'active', disabled_at = NULL,
         lifecycle_gen = lifecycle_gen + 1 WHERE id = ?`,
    )
      .bind(owner.principalId)
      .run();
    const fresh = await open(token);
    expect(fresh.response.status).toBe(101);
    await feedOf(owner).applyFeed([change(owner, repo, 1)]);
    await runDurableObjectAlarm(feedOf(owner));
    expect(await old.closed).toEqual({ code: 4401 });
    expect(await fresh.next()).toMatchObject({ t: "changed", n: 1 });
    // A renewal of another ended-generation socket is refused as well.
    const stale = await open(token);
    await runInDurableObject(feedOf(owner), (_: UserDO, state) =>
      state.storage.sql.exec(
        "UPDATE live_local_deps SET dependency = ? WHERE dependency LIKE 'principal:%' AND socket_id = (SELECT max(socket_id) FROM live_local)",
        `principal:${owner.principalId}:0`,
      ),
    );
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + RENEW_LATE);
    await say(owner, stale, { t: "renew" });
    await runDurableObjectAlarm(feedOf(owner));
    expect(await stale.closed).toEqual({ code: 4401 });
    fresh.ws?.close(1000, "done");
  });

  it("rests on an agent's owner: suspending the owner closes the agent's socket", async () => {
    const owner = await user();
    const agent = await agentFor(owner, ["issues:read"]);
    const socket = await open(agent.own);
    expect(socket.response.status).toBe(101);
    await env.DIRECTORY.prepare(
      "UPDATE principals SET lifecycle = 'suspended', disabled_at = ? WHERE id = ?",
    )
      .bind(Date.now(), owner.principalId)
      .run();
    await sweepNow();
    expect(await socket.closed).toEqual({ code: 4403 });
  });

  it("rests on the token it was minted from", async () => {
    const owner = await user();
    const store = new D1TokenStore(env.DIRECTORY, {
      clock: () => Date.now(),
      newId,
      randomBytes: secureRandomBytes,
    });
    const audit = { actorId: owner.principalId, requestId: null } as never;
    const source = await store.mint({
      type: "pat",
      principalId: owner.principalId,
      scopes: [],
      ttlMs: 3_600_000,
      audit,
    });
    const minted = await store.mint({
      type: "pat",
      principalId: owner.principalId,
      scopes: [],
      ttlMs: 3_600_000,
      sourceId: source.id,
      audit,
    });
    const socket = await open(minted.token);
    expect(socket.response.status).toBe(101);
    await env.DIRECTORY.prepare("UPDATE tokens SET revoked_at = ? WHERE id = ?")
      .bind(Date.now(), source.id)
      .run();
    await sweepNow();
    expect(await socket.closed).toEqual({ code: 4403 });
  });

  it("is not opened by a delegated or a DPoP-bound token", async () => {
    const owner = await user();
    const agent = await agentFor(owner, ["issues:read"]);
    expect((await ticketFor(agent.delegated)).status).toBe(403);
    const bound = await scopedToken(owner.principalId, []);
    await env.DIRECTORY.prepare("UPDATE tokens SET dpop_jkt = 'thumbprint' WHERE token_hash = ?")
      .bind(await hashToken(bound))
      .run();
    expect((await ticketFor(bound)).status).toBe(401);
  });

  it("is opened from a browser only with the very session its ticket was issued to", async () => {
    const owner = await user();
    const [mine, other] = [
      await testSession(owner.principalId),
      await testSession(owner.principalId),
    ];
    const issued = (await (
      await call(
        new Request(`${ORIGIN}/api/notifications/live`, {
          method: "POST",
          headers: {
            Cookie: `${SESSION_COOKIE}=${mine.cookie}`,
            "X-Fyrden-Session": "1",
            "Idempotency-Key": crypto.randomUUID(),
          },
        }),
      )
    ).json()) as { ticket: string };
    const upgrade = (cookie: string) =>
      call(
        new Request(
          `${ORIGIN}/api/notifications/live?ticket=${encodeURIComponent(issued.ticket)}`,
          {
            headers: {
              Upgrade: "websocket",
              Cookie: `${SESSION_COOKIE}=${cookie}`,
              Origin: ORIGIN,
            },
          },
        ),
      );
    expect((await upgrade(other.cookie)).status).toBe(401);
    const opened = await upgrade(mine.cookie);
    expect(opened.status).toBe(101);
    opened.webSocket?.accept();
    opened.webSocket?.close(1000, "done");
  });
});

describe("a live socket's protocol", () => {
  it("is closed by a renewal once its deadline passed, and by a control that is not an object", async () => {
    const owner = await user();
    const socket = await open(owner.token);
    socket.ws?.send("null");
    expect(await socket.closed).toEqual({ code: 1008 });
    const late = await open(owner.token);
    vi.useFakeTimers({ toFake: ["Date"] });
    // Past its deadline (a renewal period and a minute on).
    vi.setSystemTime(Date.now() + LIVE_POLICY.renewMs + 60_000);
    late.ws?.send(JSON.stringify({ t: "renew" }));
    expect(await late.closed).toEqual({ code: 4401 });
  });

  it("forgets an admission whose confirmation never finished", async () => {
    const owner = await user();
    // A socket of its own (which gives the feed its turn), then one left confirming.
    const socket = await open(owner.token);
    await runInDurableObject(feedOf(owner), (_: UserDO, state) => {
      state.storage.sql.exec(
        `INSERT INTO live_local (socket_id, credential_id, phase, expires_at, deadline, sent, acked,
           refresh_pending, blocked_since, renew_failures, controls_used, minute_start,
           minute_count, delivered_seq, retry_at, scopes, repo_ids)
         VALUES ('lsk_stale', 'tok_x', 'confirming', ?1, ?1, 0, 0, 0, NULL, 0, 0, ?2, 0, 0, 0, '[]', NULL)`,
        Date.now() + 60 * 60_000,
        Date.now() - 2 * 60_000,
      );
      state.storage.sql.exec("UPDATE live_turn SET intended_at = 0");
      return state.storage.setAlarm(Date.now());
    });
    await runDurableObjectAlarm(feedOf(owner));
    expect(
      await runInDurableObject(feedOf(owner), (_: UserDO, state) =>
        state.storage.sql.exec("SELECT socket_id FROM live_local").toArray(),
      ),
    ).not.toContainEqual({ socket_id: "lsk_stale" });
    socket.ws?.close(1000, "done");
  });

  it("owes a slower socket the mention it has not heard of, though a later comment was unsubscribed", async () => {
    const owner = await user();
    const repo = await repoWithIssue(owner);
    const [fast, slow] = [
      await open(owner.token),
      await open(await scopedToken(owner.principalId, [])),
    ];
    // One credential a turn: a turn for each.
    const apply = async (e: FeedEntry) => {
      await feedOf(owner).applyFeed([e]);
      await runTurns(owner);
      await runTurns(owner);
    };
    // The slow socket's window fills; the fast one acknowledges as it goes.
    for (let v = 1; v <= 8; v++) {
      await apply(change(owner, repo, v));
      const frame = (await fast.next()) as { n: number };
      await say(owner, fast, { t: "ack", n: frame.n });
      await slow.next();
    }
    // A mention: the fast socket hears of it; the slow one is full.
    await apply(change(owner, repo, 9));
    const heard = (await fast.next()) as { n: number };
    await say(owner, fast, { t: "ack", n: heard.n });
    // Then a comment in the same conversation, unsubscribed before the next run.
    const comment = change(owner, repo, 10);
    await feedOf(owner).applyFeed([
      { ...comment, recipient: { ...comment.recipient, kind: "activity", reasons: ["commenter"] } },
    ]);
    await env.DIRECTORY.prepare(
      `INSERT INTO thread_preferences (principal_id, repo_id, conversation, number, kind, root_id,
         state, revision, epoch_gen, at) VALUES (?1, ?2, ?3, 1, 'issue', ?1, 'unsubscribed', 1, 1, ?4)`,
    )
      .bind(owner.principalId, repo.id, repo.conversation, Date.now())
      .run();
    await say(owner, slow, { t: "ack", n: 8 });
    await runInDurableObject(feedOf(owner), (_: UserDO, state) =>
      state.storage.setAlarm(Date.now()),
    );
    await runTurns(owner);
    expect(await slow.next()).toMatchObject({ t: "changed", n: 9 });
    expect(fast.frames).toEqual([]);
  });
});

describe("the revocation sweep", () => {
  it("tells every feed in turn, failing ones behind the others", async () => {
    const seq = (
      await env.DIRECTORY.prepare(
        "INSERT INTO revocations (subject, at, expanded) VALUES (?, ?, 1) RETURNING seq",
      )
        .bind(`credential:${uniqueId("tok")}`, Date.now())
        .first<{ seq: number }>()
    )?.seq as number;
    const feeds = Array.from(
      { length: LIVE_ADMISSION.deliveries + 1 },
      (_, i) => `usr_f${String(i).padStart(3, "0")}`,
    );
    const now = Date.now();
    await env.DIRECTORY.batch(
      feeds.map((feed, i) =>
        env.DIRECTORY.prepare(
          "INSERT INTO revocation_targets (seq, feed, attempts, next_attempt_at) VALUES (?, ?, 0, ?)",
        ).bind(seq, feed, now - 1_000_000 + i),
      ),
    );
    const told: string[] = [];
    const failing = new Set(feeds.slice(0, LIVE_ADMISSION.deliveries));
    const tell = async (feed: string) => {
      if (!feed.startsWith("usr_f")) return;
      told.push(feed);
      if (failing.has(feed)) throw new Error("down");
    };
    await sweep(env.DIRECTORY, tell, now);
    // The first run tried the 200 due first; the next takes the 201st before any retried one.
    told.length = 0;
    await sweep(env.DIRECTORY, tell, now + 1);
    expect(told[0]).toBe(feeds.at(-1));
    expect(
      await env.DIRECTORY.prepare(
        "SELECT count(*) AS n FROM revocation_targets WHERE seq = ? AND feed = ?",
      )
        .bind(seq, feeds.at(-1))
        .first<{ n: number }>(),
    ).toEqual({ n: 0 });
  });
});
