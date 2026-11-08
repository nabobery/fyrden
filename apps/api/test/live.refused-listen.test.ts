// A live opening that cannot be funded costs next to nothing: refused from
// what one statement shows, before any grant, nothing charged. A principal
// past its day's admissions spends nothing more, however often it asks, so
// one token cannot close the ledger to everyone else.

import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { LIVE_DAILY, LIVE_ORDINARY_DEBT_LIMIT, LIVE_PROTECTED } from "../src/live/budget.js";
import { LIVE_ADMISSION } from "../src/live/directory.js";
import { LIVE_PRICES, type LiveManifestEntry } from "../src/live/manifest.js";
import { LIVE_OWNER_LIMITS } from "../src/live/owners.js";
import { liveRefusalMemo } from "../src/live/refusal-memo.js";
import { user, type Who } from "./helpers/api.js";
import { rowCountingD1 } from "./helpers/d1.js";

const ORIGIN = "https://fyrden.test";
const DAY = 86_400_000;
const RESOURCES = [
  "do_requests",
  "do_rows_read",
  "do_rows_written",
  "do_duration_ms",
  "d1_rows_read",
  "d1_rows_written",
  "queue_ops",
] as const;

/** Whatever limits a listen lets every attempt through: what is asserted is the path, not a limit. */
const unlimited = { limit: async () => ({ success: true }) };
const LIVE = {
  FYRDEN_LIVE: "on",
  FYRDEN_LIVE_SOCKETS: "500",
  RATE_LIMIT_WRITE: unlimited,
  RATE_LIMIT_LIVE: unlimited,
};

afterEach(async () => {
  listenLimit = unlimited;
  racing = null;
  await env.DIRECTORY.batch([
    env.DIRECTORY.prepare("DELETE FROM live_socket_deps"),
    env.DIRECTORY.prepare("DELETE FROM live_sockets"),
    env.DIRECTORY.prepare("DELETE FROM live_admissions"),
    env.DIRECTORY.prepare("DELETE FROM live_budget_receipts"),
    env.DIRECTORY.prepare("DELETE FROM live_budget_days"),
    env.DIRECTORY.prepare(
      `UPDATE live_budget_state SET ${RESOURCES.map((r) => `debt_${r} = 0`).join(", ")} WHERE id = 1`,
    ),
    env.DIRECTORY.prepare("DELETE FROM live_ticket_transports"),
    env.DIRECTORY.prepare("DELETE FROM live_duration_owners"),
    env.DIRECTORY.prepare("DELETE FROM live_recovery_targets"),
  ]);
});

/** Where the Worker's D1 rows are added up, while a test counts them. */
let counted: { read: number; written: number; statements: string[] } | null = null;
/** The listen limit a test puts in place. */
let listenLimit: { limit: (options: { key: string }) => Promise<{ success: boolean }> } = unlimited;

/** The grant whose batch finds the ledger closed since its pre-check: the 1st, the 2nd. */
let racing: number | null = null;

/** The ledger, its debt gate closing just before its `nth` grant's batch. */
function closedBefore(nth: number): D1Database {
  let grants = 0;
  let closed = false;
  const wrap = (db: D1Database | D1DatabaseSession): D1Database =>
    new Proxy(db, {
      get(target, prop) {
        if (prop === "prepare")
          return (query: string) => {
            if (query.includes("INSERT INTO live_budget_receipts")) grants++;
            return target.prepare(query);
          };
        if (prop === "batch")
          return async (statements: D1PreparedStatement[]) => {
            if (grants === nth && !closed) {
              closed = true;
              await closeDebtGate();
            }
            return target.batch(statements);
          };
        if (prop === "withSession")
          return (constraint?: D1SessionConstraint | D1SessionBookmark) =>
            wrap((target as D1Database).withSession(constraint));
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as D1Database;
  return wrap(env.DIRECTORY);
}

async function call(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const on = {
    ...env,
    ...LIVE,
    RATE_LIMIT_LIVE: listenLimit,
    ...(counted && { DIRECTORY: rowCountingD1(env.DIRECTORY, counted) }),
    ...(racing && { DIRECTORY: closedBefore(racing) }),
  } as unknown as Env;
  const response = await createApp().fetch(request, on, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

const listen = (who: Who, abort = new AbortController()) =>
  call(
    new Request(`${ORIGIN}/mcp`, {
      method: "POST",
      signal: abort.signal,
      headers: {
        Authorization: `Bearer ${who.token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "subscriptions/listen",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "listen-1",
        method: "subscriptions/listen",
        params: {
          notifications: { resourceSubscriptions: [`fyrden://feed/${who.principalId}`] },
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": { name: "fyrden-test", version: "0.0.0" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    }),
  );

const ticket = (who: Who) =>
  call(
    new Request(`${ORIGIN}/api/notifications/live`, {
      method: "POST",
      headers: { Authorization: `Bearer ${who.token}`, "Idempotency-Key": crypto.randomUUID() },
    }),
  );

/** The error a refused listen answers with (its first message). */
async function refusal(response: Response) {
  const text = await response.text();
  const data = text
    .split("\n")
    .find((line) => line.startsWith("data: "))
    ?.slice(6);
  return (JSON.parse(data ?? text) as { error?: { data?: Record<string, unknown> } }).error?.data;
}

/** The D1 rows the Worker read and wrote while `fn` ran. */
async function d1Rows(fn: () => Promise<unknown>) {
  const rows = { read: 0, written: 0, statements: [] as string[] };
  counted = rows;
  try {
    await fn();
  } finally {
    counted = null;
  }
  return rows;
}

/** The statements among `rows` that read or write live's ledger. */
const ledgerStatements = (rows: { statements: string[] }) =>
  rows.statements.filter((sql) => /live_budget|live_duration_owners/.test(sql));

/** What the ledger holds: its debts, each day's use, and its receipts. */
async function ledger() {
  const [state, days, receipts] = await env.DIRECTORY.batch([
    env.DIRECTORY.prepare(
      `SELECT ${RESOURCES.map((r) => `debt_${r}`).join(", ")} FROM live_budget_state WHERE id = 1`,
    ),
    env.DIRECTORY.prepare(`SELECT day, ${RESOURCES.join(", ")} FROM live_budget_days ORDER BY day`),
    env.DIRECTORY.prepare("SELECT count(*) AS n FROM live_budget_receipts"),
  ]);
  return { state: state?.results, days: days?.results, receipts: receipts?.results };
}

async function pastTheDay(who: Who) {
  await env.DIRECTORY.prepare("INSERT INTO live_admissions (principal_id, day, n) VALUES (?, ?, ?)")
    .bind(who.principalId, Math.floor(Date.now() / DAY), LIVE_ADMISSION.perDay)
    .run();
}

const setDebt = (value: number) =>
  env.DIRECTORY.prepare("UPDATE live_budget_state SET debt_d1_rows_written = ? WHERE id = 1")
    .bind(value)
    .run();

const closeDebtGate = () => setDebt(LIVE_ORDINARY_DEBT_LIMIT.d1_rows_written);

/** Reads a listen's first message and lets it go: what it says of its socket. */
async function firstMessage(response: Response, abort: AbortController) {
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  try {
    const decoder = new TextDecoder();
    let text = "";
    while (!text.includes("\n\n")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
    const data = text.split("\n").find((line) => line.startsWith("data: "));
    return JSON.parse(data?.slice(6) ?? "null") as { method?: string };
  } finally {
    abort.abort();
    await reader.cancel();
  }
}

/** A listen that holds its socket: true when its first message acknowledges it. */
async function listens(who: Who) {
  const abort = new AbortController();
  const message = await firstMessage(await listen(who, abort), abort);
  return message?.method === "notifications/subscriptions/acknowledged";
}

/** Upgrades `who`'s ticket; its close code and reason. */
async function upgrade(who: Who, issued: string) {
  const response = await call(
    new Request(`${ORIGIN}/api/notifications/live?ticket=${encodeURIComponent(issued)}`, {
      headers: { Upgrade: "websocket", Authorization: `Bearer ${who.token}` },
    }),
  );
  expect(response.status).toBe(101);
  const ws = response.webSocket as WebSocket;
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    ws.addEventListener("close", (event) => resolve({ code: event.code, reason: event.reason })),
  );
  ws.accept();
  return closed;
}

const receiptKinds = async () =>
  (
    await env.DIRECTORY.prepare("SELECT kind FROM live_budget_receipts ORDER BY seq").all<{
      kind: string;
    }>()
  ).results.map((row) => row.kind);

describe("a listen past its principal's daily admissions", () => {
  it("is refused until tomorrow with nothing charged", async () => {
    const who = await user();
    await pastTheDay(who);
    const before = await ledger();
    expect(await refusal(await listen(who))).toMatchObject({
      status: 429,
      code: "too_many_sockets",
    });
    expect(await ledger()).toEqual(before);
  });

  it("cannot close the ledger to everyone else, however often it asks", async () => {
    const [spent, other] = [await user(), await user()];
    await pastTheDay(spent);
    // More attempts than the debt limit takes at the 8 debt an attempt leaves today.
    const attempts = Math.ceil(LIVE_ORDINARY_DEBT_LIMIT.d1_rows_written / 8) + 1;
    for (let i = 0; i < attempts; i++) await (await listen(spent)).body?.cancel();
    const row = await env.DIRECTORY.prepare(
      "SELECT debt_d1_rows_written AS debt FROM live_budget_state WHERE id = 1",
    ).first<{ debt: number }>();
    expect(row?.debt).toBe(0);
    const abort = new AbortController();
    const theirs = await listen(other, abort);
    const reader = (theirs.body as ReadableStream<Uint8Array>).getReader();
    try {
      // Its first message says its socket holds: an empty or refused stream says otherwise.
      const decoder = new TextDecoder();
      let text = "";
      while (!text.includes("\n\n")) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += decoder.decode(chunk.value, { stream: true });
      }
      const data = text.split("\n").find((line) => line.startsWith("data: "));
      expect(JSON.parse(data?.slice(6) ?? "null")).toMatchObject({
        method: "notifications/subscriptions/acknowledged",
        params: {
          notifications: { resourceSubscriptions: [`fyrden://feed/${other.principalId}`] },
        },
      });
    } finally {
      abort.abort();
      await reader.cancel();
    }
  });
});

describe("an opening the ledger cannot fund", () => {
  it("reads at most 25 D1 rows and charges nothing: a listen", async () => {
    const who = await user();
    await closeDebtGate();
    const before = await ledger();
    let answer: Record<string, unknown> | undefined;
    const used = await d1Rows(async () => {
      answer = await refusal(await listen(who));
    });
    expect(answer).toMatchObject({ status: 503, code: "live_temporary" });
    expect(await ledger()).toEqual(before);
    // The token's last use, once a while (authentication's, before this path).
    expect(used.written).toBeLessThanOrEqual(1);
    expect(used.read).toBeLessThanOrEqual(25);
  });

  it("reads at most 25 D1 rows and charges nothing: a ticket", async () => {
    const who = await user();
    await closeDebtGate();
    const before = await ledger();
    let status = 0;
    const used = await d1Rows(async () => {
      const response = await ticket(who);
      status = response.status;
      await response.body?.cancel();
    });
    expect(status).toBe(503);
    expect(await ledger()).toEqual(before);
    // The token's last use and the operation's idempotency key (every write operation's).
    expect(used.written).toBeLessThanOrEqual(5);
    expect(used.read).toBeLessThanOrEqual(25);
  });
});

describe("the listen limit", () => {
  it("stops a listen before any row, keyed by its token, and asks it to wait", async () => {
    const who = await user();
    const keys: string[] = [];
    listenLimit = {
      limit: async ({ key }) => {
        keys.push(key);
        return { success: false };
      },
    };
    let answer: Record<string, unknown> | undefined;
    const used = await d1Rows(async () => {
      answer = await refusal(await listen(who));
    });
    expect(answer).toMatchObject({ status: 429, code: "rate_limited", retry_after: 60 });
    expect(keys).toHaveLength(1);
    expect(ledgerStatements(used)).toEqual([]);
  });

  it("is the binding's own low limit: of 14 asked at once, some are stopped", async () => {
    const key = uniqueId("live-limit");
    const answers: boolean[] = [];
    for (let i = 0; i < 14; i++) answers.push((await env.RATE_LIMIT_LIVE.limit({ key })).success);
    // 6 a window, and at most two windows however slowly this runs: 120 would let all through.
    expect(answers[0]).toBe(true);
    expect(answers).toContain(false);
  });
});

describe("while the ledger's closure is remembered", () => {
  it("a listen and a ticket read no ledger row, then the ledger again a minute on", async () => {
    const who = await user();
    await closeDebtGate();
    await refusal(await listen(who));
    const held = await d1Rows(async () => {
      expect(await refusal(await listen(who))).toMatchObject({
        status: 503,
        code: "live_temporary",
        reason: "debt:d1_rows_written",
      });
    });
    expect(ledgerStatements(held)).toEqual([]);
    const ticketed = await d1Rows(async () => {
      const response = await ticket(who);
      expect(response.status).toBe(503);
      await response.body?.cancel();
    });
    expect(ledgerStatements(ticketed)).toEqual([]);
    // Reopened: at most a minute late.
    await setDebt(0);
    expect(await refusal(await listen(who))).toMatchObject({ code: "live_temporary" });
    vi.setSystemTime(Date.now() + 60_000);
    expect(await listens(who)).toBe(true);
  });

  it("is set by a ticket's refusal too", async () => {
    const who = await user();
    await closeDebtGate();
    await (await ticket(who)).body?.cancel();
    const held = await d1Rows(() => listen(who).then(refusal));
    expect(ledgerStatements(held)).toEqual([]);
  });
});

describe("when the ledger closes after the pre-check", () => {
  it("remembers the transport's refusal", async () => {
    const who = await user();
    racing = 1;
    expect(await refusal(await listen(who))).toMatchObject({
      code: "live_temporary",
      reason: "debt:d1_rows_written",
    });
    expect(liveRefusalMemo.closed(Date.now())?.gate).toBe("debt:d1_rows_written");
    expect(await receiptKinds()).toEqual([]);
  });

  it("does not remember a later grant's, whose price depends on its feed", async () => {
    const who = await user();
    racing = 2;
    expect(await refusal(await listen(who))).toMatchObject({
      code: "live_temporary",
      reason: "debt:d1_rows_written",
    });
    expect(liveRefusalMemo.closed(Date.now())).toBeNull();
    expect(await receiptKinds()).toContain("upgrade_transport");
  });
});

describe("an opening refused for what its own feed needs", () => {
  /** Leaves room for an opening with its feed's blocks held, and not for one needing them. */
  const leaveRoom = async () => {
    const day = (
      await env.DIRECTORY.prepare("SELECT CAST(unixepoch() / 86400 AS INTEGER) AS d").first<{
        d: number;
      }>()
    )?.d as number;
    const room = LIVE_DAILY.do_rows_written - LIVE_PROTECTED.do_rows_written - 200;
    await env.DIRECTORY.prepare(
      `INSERT INTO live_budget_days (day, do_rows_written, retain_until, cleanup_debt)
       VALUES (?1, ?2, ?3, '{"do_requests":0,"do_rows_read":0,"do_rows_written":0,"do_duration_ms":0,"d1_rows_read":0,"d1_rows_written":0,"queue_ops":0}')
       ON CONFLICT (day) DO UPDATE SET do_rows_written = excluded.do_rows_written`,
    )
      .bind(day, room, (day + 4) * DAY)
      .run();
  };

  it("does not keep another feed out, and charges nothing", async () => {
    const [warm, cold] = [await user(), await user()];
    expect(await listens(warm)).toBe(true);
    await leaveRoom();
    const before = await ledger();
    expect(await refusal(await listen(cold))).toMatchObject({
      status: 429,
      code: "live_budget",
      reason: "ordinary_share",
    });
    expect(await ledger()).toEqual(before);
    expect(await listens(warm)).toBe(true);
  });
});

describe("a ticket whose socket could not be funded", () => {
  it("is refused with nothing charged, on the room its feed's socket needs", async () => {
    const [warm, cold] = [await user(), await user()];
    expect(await listens(warm)).toBe(true);
    const day = (
      await env.DIRECTORY.prepare("SELECT CAST(unixepoch() / 86400 AS INTEGER) AS d").first<{
        d: number;
      }>()
    )?.d as number;
    const need = (units: readonly (keyof typeof LIVE_PRICES)[]) =>
      units.reduce(
        (n, unit) => n + (LIVE_PRICES[unit] as LiveManifestEntry).resources.do_rows_written,
        0,
      );
    // Room for the ticket and its transport, and for a socket holding its feed's blocks.
    const room = need(["upgrade_transport", "ticket", "admission", "terminal"]) + 5;
    await env.DIRECTORY.prepare(
      `INSERT INTO live_budget_days (day, do_rows_written, retain_until, cleanup_debt)
       VALUES (?1, ?2, ?3, '{"do_requests":0,"do_rows_read":0,"do_rows_written":0,"do_duration_ms":0,"d1_rows_read":0,"d1_rows_written":0,"queue_ops":0}')
       ON CONFLICT (day) DO UPDATE SET do_rows_written = excluded.do_rows_written`,
    )
      .bind(
        day,
        LIVE_DAILY.do_rows_written - LIVE_PROTECTED.do_rows_written - room,
        (day + 4) * DAY,
      )
      .run();
    const before = await ledger();
    const refused = await ticket(cold);
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({
      code: "live_budget",
      reason: "ordinary_share",
    });
    expect(await ledger()).toEqual(before);
    // One whose feed already holds its blocks has room for its socket: it is issued.
    const issued = await ticket(warm);
    expect(issued.status).toBe(200);
    await issued.body?.cancel();
  });
});

describe("a feed with its own owner places taken", () => {
  const takePlaces = async (who: Who) => {
    for (let i = 0; i < LIVE_OWNER_LIMITS.perObjectOrdinary; i++)
      await env.DIRECTORY.prepare(
        `INSERT INTO live_duration_owners (owner_id, operation_id, object_type, object_id, class,
           epoch, incarnation, dispatch_from, dispatch_until, holds, status, admitted_at)
         VALUES (?1, ?1, 'UserDO', ?2, 'ordinary', 0, ?3, 0, 1, '[]', 'reserved', 0)`,
      )
        .bind(uniqueId("held"), who.principalId, "0".repeat(32))
        .run();
  };

  it("pays nothing for its refusals, however many, and keeps no other feed out", async () => {
    const [full, other] = [await user(), await user()];
    await takePlaces(full);
    const before = await ledger();
    for (let i = 0; i < 3; i++)
      expect(await refusal(await listen(full))).toMatchObject({
        code: "live_temporary",
        reason: "owner:capacity",
      });
    const response = await ticket(full);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ reason: "owner:capacity" });
    expect(await ledger()).toEqual(before);
    expect(liveRefusalMemo.closed(Date.now())).toBeNull();
    expect(await listens(other)).toBe(true);
  });
});

describe("a ticket past its principal's daily admissions", () => {
  it("is refused until tomorrow as today's budget, with nothing charged", async () => {
    const who = await user();
    await pastTheDay(who);
    const before = await ledger();
    const response = await ticket(who);
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ code: "live_budget", reason: "admissions" });
    expect(await ledger()).toEqual(before);
  });
});

describe("a redemption the ledger can no longer fund", () => {
  const issue = async (who: Who) =>
    ((await (await ticket(who)).json()) as { ticket: string }).ticket;

  it("is closed for now, naming why, its transport paying and nothing more granted", async () => {
    const who = await user();
    const issued = await issue(who);
    await closeDebtGate();
    const before = await receiptKinds();
    expect(await upgrade(who, issued)).toEqual({
      code: 4412,
      reason: "try again soon: debt:d1_rows_written",
    });
    expect(await receiptKinds()).toEqual(before);
  });

  it("is closed until tomorrow past its daily admissions, nothing more granted", async () => {
    const who = await user();
    const issued = await issue(who);
    await pastTheDay(who);
    const before = await receiptKinds();
    expect((await upgrade(who, issued)).code).toBe(4413);
    expect(await receiptKinds()).toEqual(before);
  });
});
