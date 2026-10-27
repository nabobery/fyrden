// A user's notification addresses: managed from a web session only; added
// unverified and mailed a link; confirmed once, by the account that added
// it, within a day; a mailbox verified on one account at a time, every
// earlier proof stale once its owner changes; limits per user and per
// mailbox, reserved with the rest of the batch or not at all; and the
// Resend port's classification of its answers.

import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beginUserDeletion } from "../src/accounts/deletion.js";
import { runDeletionSlice } from "../src/accounts/deletion-runner.js";
import { EMAIL_POLICY, emailWriteHooks, reapEmails } from "../src/accounts/emails.js";
import {
  type EmailMessage,
  type EmailProvider,
  emailHooks,
  resendProvider,
} from "../src/email/provider.js";
import { SESSION_COOKIE } from "../src/oauth/session.js";
import { advanceDeletions } from "../src/repos/deletion.js";
import { api, user, type Who } from "./helpers/api.js";
import { ORIGIN } from "./helpers/git-http.js";
import { testSession } from "./helpers/oauth.js";
import { scopedToken } from "./helpers/principals.js";

/** Messages the injected provider was handed. */
let sent: EmailMessage[] = [];

const recording: EmailProvider = {
  name: "test",
  from: "Fyrden <notifications@fyrden.test>",
  async send(message) {
    sent.push(message);
    return { status: "accepted", id: `msg_${sent.length}` };
  },
};

beforeEach(() => {
  sent = [];
  emailHooks.provider = recording;
  emailHooks.sending = true;
});

afterEach(() => {
  delete emailHooks.provider;
  delete emailHooks.sending;
  delete emailWriteHooks.beforeWrite;
});

/** Signed in again (after the clock moved past a session's life). */
async function signedInAgain(who: Signed): Promise<Signed> {
  const { cookie } = await testSession(who.principalId);
  return { ...who, cookie: `${SESSION_COOKIE}=${cookie}` };
}

type Signed = Who & { cookie: string };

async function signedIn(): Promise<Signed> {
  const who = await user();
  const { cookie } = await testSession(who.principalId);
  return { ...who, cookie: `${SESSION_COOKIE}=${cookie}` };
}

/** A request with the user's web session (as the web UI's server makes it). */
async function asSession(
  who: Signed,
  method: string,
  path: string,
  body?: unknown,
  extra: Record<string, string> = {},
) {
  const response = await exports.default.fetch(`${ORIGIN}/api${path}`, {
    method,
    headers: {
      ...extra,
      Cookie: who.cookie,
      "X-Fyrden-Session": "1",
      ...(body !== undefined && { "Content-Type": "application/json" }),
      ...(method !== "GET" && { "Idempotency-Key": crypto.randomUUID() }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: (text ? JSON.parse(text) : null) as Record<string, unknown> & unknown[],
  };
}

const list = (who: Signed) => asSession(who, "GET", "/user/emails");
const add = (who: Signed, emails: string[], headers: Record<string, string> = {}) =>
  asSession(who, "POST", "/user/emails", { emails }, headers);
const remove = (who: Signed, emails: string[]) =>
  asSession(who, "DELETE", "/user/emails", { emails });
const confirm = (who: Signed, token: string) =>
  asSession(who, "POST", "/user/emails/confirm", { token });
const again = (who: Signed, email: string) =>
  asSession(who, "POST", "/user/emails/confirmation", { email });

/** The token of the last confirmation mailed to `address`. */
function tokenFor(address: string): string {
  const message = sent.filter((m) => m.to === address).at(-1);
  const token = /[?&]token=([A-Za-z0-9_-]+)/.exec(message?.text ?? "")?.[1];
  if (!token) throw new Error(`no confirmation was mailed to ${address}`);
  return token;
}

const mailbox = () => `m${crypto.randomUUID().slice(0, 8)}@example.com`;

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

/** Holds the clock a minute into the next day (so no hour or day ends within a test). */
const freshDay = () => vi.setSystemTime((Math.floor(Date.now() / DAY) + 1) * DAY + 60_000);

const count = async (sql: string, ...args: unknown[]) =>
  (
    await env.DIRECTORY.prepare(sql)
      .bind(...args)
      .first<{ n: number }>()
  )?.n;

describe("notification addresses", () => {
  it("are added unverified, mailed a link, confirmed by it, listed and removed", async () => {
    const who = await signedIn();
    const address = mailbox();
    const added = await add(who, [address]);
    expect(added).toMatchObject({
      status: 201,
      body: [{ email: address, primary: false, verified: false, visibility: null }],
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain(`${ORIGIN}/settings/emails/confirm?token=`);
    expect(await confirm(who, tokenFor(address))).toMatchObject({
      status: 200,
      body: { email: address, primary: true, verified: true },
    });
    // Adding it again changes nothing and mails nothing.
    expect((await add(who, [address.toUpperCase()])).body).toEqual([
      { email: address, primary: true, verified: true, visibility: null },
    ]);
    expect(sent).toHaveLength(1);
    expect((await remove(who, [address])).status).toBe(204);
    expect((await list(who)).body).toEqual([]);
  });

  it("are managed from a web session only", async () => {
    const who = await signedIn();
    // The user's full token (which could start a session, not call these), a scoped one: refused
    // first, whatever else is wrong with the request.
    const scoped = await scopedToken(who.principalId, ["metadata:read"]);
    for (const token of [who.token, scoped]) {
      const refused = await api("POST", "/user/emails", token, { emails: "not an array" });
      expect(refused.status).toBe(403);
      expect(((await refused.json()) as { code: string }).code).toBe("session_required");
    }
    // Before the body or its key are looked at.
    const raw = (body: string, key: string) =>
      exports.default.fetch(`${ORIGIN}/api/user/emails`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${who.token}`,
          "Content-Type": "application/json",
          "Idempotency-Key": key,
        },
        body,
      });
    for (const response of [await raw("{", "k1"), await raw("{}", "x".repeat(300))]) {
      expect(response.status).toBe(403);
      expect(((await response.json()) as { code: string }).code).toBe("session_required");
    }
    // No token may carry the permission.
    const minted = await api("POST", "/user/tokens", who.token, { scopes: ["emails:read"] });
    expect(minted.status).toBe(422);
  });

  it("are not added while the deployment sends no email", async () => {
    const who = await signedIn();
    emailHooks.sending = false;
    expect(await add(who, [mailbox()])).toMatchObject({
      status: 503,
      body: { code: "email_unavailable" },
    });
    expect((await list(who)).body).toEqual([]);
  });

  it("are at most ten an account", async () => {
    freshDay();
    const who = await signedIn();
    const ten = Array.from({ length: EMAIL_POLICY.maxAddresses }, mailbox);
    expect((await add(who, ten.slice(0, 5))).status).toBe(201);
    vi.setSystemTime(Date.now() + 61 * 60_000);
    expect((await add(who, ten.slice(5))).status).toBe(201);
    vi.setSystemTime(Date.now() + 61 * 60_000);
    expect(await add(who, [mailbox()])).toMatchObject({
      status: 422,
      body: { code: "too_many_emails" },
    });
  });

  it("are mailed within limits per user and per mailbox, all of a request or none", async () => {
    freshDay();
    const who = await signedIn();
    expect((await add(who, Array.from({ length: 4 }, mailbox))).status).toBe(201);
    // Two more would pass the hour's five: neither is added, nothing counted.
    const refused = await add(who, [mailbox(), mailbox()]);
    expect(refused).toMatchObject({ status: 429, body: { code: "confirmation_rate_limited" } });
    expect(Number(refused.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect((await list(who)).body).toHaveLength(4);
    expect((await add(who, [mailbox()])).status).toBe(201);
    // A mailbox is mailed at most three times a day, whoever asks.
    const shared = mailbox();
    for (let i = 0; i < EMAIL_POLICY.perMailboxDay; i++)
      expect((await add(await signedIn(), [shared])).status).toBe(201);
    expect((await add(await signedIn(), [shared])).status).toBe(429);
  });

  it("are refused whole at the last mailbox over its limit, nothing counted or kept", async () => {
    freshDay();
    const shared = mailbox();
    for (let i = 0; i < EMAIL_POLICY.perMailboxDay; i++) await add(await signedIn(), [shared]);
    const who = await signedIn();
    const sentBefore = sent.length;
    expect((await add(who, [mailbox(), shared])).status).toBe(429);
    expect(
      await count("SELECT count(*) AS n FROM user_emails WHERE principal_id = ?", who.principalId),
    ).toBe(0);
    expect(
      await count(
        "SELECT count(*) AS n FROM email_counters WHERE scope = 'user_hour' AND key = ?",
        who.principalId,
      ),
    ).toBe(0);
    expect(
      await count(
        "SELECT sent AS n FROM email_counters WHERE scope = 'mailbox_day' AND key = ?",
        shared,
      ),
    ).toBe(EMAIL_POLICY.perMailboxDay);
    expect(sent.length).toBe(sentBefore);
    // A request id the caller repeats admits nothing a second time.
    const again = await signedIn();
    const id = { "X-Request-Id": "same-request-id-1" };
    expect(
      (await add(again, [mailbox(), mailbox(), mailbox(), mailbox(), mailbox()], id)).status,
    ).toBe(201);
    expect((await add(again, [mailbox()], id)).status).toBe(429);
  });

  it("are confirmed only by the account that added them, its link unspent otherwise", async () => {
    const [owner, other] = [await signedIn(), await signedIn()];
    const address = mailbox();
    await add(owner, [address]);
    const token = tokenFor(address);
    expect(await confirm(other, token)).toMatchObject({
      status: 404,
      body: { code: "confirmation_not_found" },
    });
    expect((await confirm(owner, token)).status).toBe(200);
    // Once only.
    expect((await confirm(owner, token)).status).toBe(404);
  });

  it("are verified on one account at a time, a mailbox's proofs stale once its owner changes", async () => {
    const [a, b] = [await signedIn(), await signedIn()];
    const address = mailbox();
    await add(a, [address]);
    const tokenA = tokenFor(address);
    await add(b, [address]);
    const tokenB = tokenFor(address);
    expect((await confirm(a, tokenA)).status).toBe(200);
    // B's proof, issued before A verified, is stale.
    expect((await confirm(b, tokenB)).status).toBe(404);
    // A fresh one while A holds it: the mailbox is taken, the proof used up.
    expect((await again(b, address)).status).toBe(204);
    const fresh = tokenFor(address);
    expect(await confirm(b, fresh)).toMatchObject({ status: 409, body: { code: "email_taken" } });
    expect((await confirm(b, fresh)).status).toBe(404);
    // The next day (the mailbox's mail for the day spent), B asks again; A gives the mailbox
    // up: B's outstanding proof goes stale with it.
    vi.setSystemTime(Date.now() + 25 * 60 * 60_000);
    const [a2, b2] = [await signedInAgain(a), await signedInAgain(b)];
    expect((await again(b2, address)).status).toBe(204);
    const beforeRelease = tokenFor(address);
    expect((await remove(a2, [address])).status).toBe(204);
    expect((await confirm(b2, beforeRelease)).status).toBe(404);
    // A new link after the release confirms.
    expect((await again(b2, address)).status).toBe(204);
    expect((await confirm(b2, tokenFor(address))).status).toBe(200);
  });

  it("are confirmed by one account when two race for a mailbox, the other's proof stale", async () => {
    const [a, b] = [await signedIn(), await signedIn()];
    const address = mailbox();
    await add(a, [address]);
    const tokenA = tokenFor(address);
    await add(b, [address]);
    const tokenB = tokenFor(address);
    const answers = await Promise.all([confirm(a, tokenA), confirm(b, tokenB)]);
    expect(answers.map((r) => r.status).sort()).toEqual([200, 404]);
    expect(
      await count(
        "SELECT count(*) AS n FROM user_emails WHERE address_key = ? AND verified_at IS NOT NULL",
        address,
      ),
    ).toBe(1);
  });

  it("are not confirmed once removed, nor by a proof older than its mailbox's row", async () => {
    const who = await signedIn();
    const address = mailbox();
    await add(who, [address]);
    const old = tokenFor(address);
    await remove(who, [address]);
    expect((await confirm(who, old)).status).toBe(404);
    // The idle mailbox reaped a day later; the address added again: the old link still fails.
    await reapEmails(env, { now: Date.now() + DAY + 1 });
    expect(
      await count("SELECT count(*) AS n FROM email_mailboxes WHERE address_key = ?", address),
    ).toBe(0);
    await add(who, [address]);
    expect((await confirm(who, old)).status).toBe(404);
    expect((await confirm(who, tokenFor(address))).status).toBe(200);
  });

  it("are not confirmed past a day, nor by a link a newer one replaced", async () => {
    const who = await signedIn();
    const address = mailbox();
    await add(who, [address]);
    const first = tokenFor(address);
    expect((await again(who, address)).status).toBe(204);
    expect((await confirm(who, first)).status).toBe(404);
    const second = tokenFor(address);
    vi.setSystemTime(Date.now() + EMAIL_POLICY.confirmationMs + 1);
    const { cookie } = await testSession(who.principalId);
    expect((await confirm({ ...who, cookie: `${SESSION_COOKIE}=${cookie}` }, second)).status).toBe(
      404,
    );
  });

  it("are written only while the user holds at the generation it signed in at", async () => {
    const who = await signedIn();
    // A transition between the request's authentication and its write.
    emailWriteHooks.beforeWrite = async () => {
      await env.DIRECTORY.prepare(
        "UPDATE principals SET lifecycle_gen = lifecycle_gen + 1 WHERE id = ?",
      )
        .bind(who.principalId)
        .run();
    };
    const refused = await add(who, [mailbox()]);
    expect(refused.status).toBe(401);
    delete emailWriteHooks.beforeWrite;
    const rows = await env.DIRECTORY.prepare(
      "SELECT count(*) AS n FROM user_emails WHERE principal_id = ?",
    )
      .bind(who.principalId)
      .first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });

  it("confirm, ask again and remove nothing once the user changed after signing in", async () => {
    const who = await signedIn();
    const address = mailbox();
    await add(who, [address]);
    const token = tokenFor(address);
    const bump = async () => {
      await env.DIRECTORY.prepare(
        "UPDATE principals SET lifecycle_gen = lifecycle_gen + 1 WHERE id = ?",
      )
        .bind(who.principalId)
        .run();
    };
    emailWriteHooks.beforeWrite = bump;
    expect((await again(who, address)).status).toBe(401);
    expect((await confirm(who, token)).status).toBe(404);
    expect((await remove(who, [address])).status).toBe(401);
    delete emailWriteHooks.beforeWrite;
    expect(
      await count(
        "SELECT count(*) AS n FROM email_confirmations WHERE email_id IN (SELECT id FROM user_emails WHERE principal_id = ?) AND used_at IS NULL",
        who.principalId,
      ),
    ).toBe(1);
    expect(
      await count(
        "SELECT count(*) AS n FROM user_emails WHERE principal_id = ? AND removed_at IS NULL",
        who.principalId,
      ),
    ).toBe(1);
  });

  it("go with the user's deletion, their verified mailboxes released", async () => {
    const admin = await user(true);
    const [who, other] = [await signedIn(), await signedIn()];
    const address = mailbox();
    await add(who, [address]);
    expect((await confirm(who, tokenFor(address))).status).toBe(200);
    // A backlog of removed addresses, two links each: more than a slice deletes.
    const at = Date.now();
    await env.DIRECTORY.batch(
      Array.from({ length: 251 }, (_, i) => {
        const id = `eml_backlog${String(i).padStart(4, "0")}${who.principalId.slice(-8)}`;
        return [
          env.DIRECTORY.prepare(
            `INSERT INTO user_emails (id, principal_id, address, address_key, verified_at, created_at,
               removed_at) VALUES (?1, ?2, ?3, ?3, NULL, ?4, ?4)`,
          ).bind(id, who.principalId, `old${i}@example.com`, at),
          ...[0, 1].map((n) =>
            env.DIRECTORY.prepare(
              `INSERT INTO email_confirmations (token_hash, email_id, address_key, claim, expires_at,
                 used_at, reap_at) VALUES (?1, ?2, ?3, 'c', ?4, NULL, ?4)`,
            ).bind(
              (`${id}${n}`.repeat(4) + "0".repeat(64)).slice(0, 64).replace(/[^0-9a-f]/g, "a"),
              id,
              `old${i}@example.com`,
              at + DAY,
            ),
          ),
        ];
      }).flat(),
    );
    // Another account's proof issued while the deleted user held the mailbox.
    await add(other, [address]);
    const stale = tokenFor(address);
    const now = await env.DIRECTORY.prepare(
      "SELECT lifecycle_gen AS gen FROM principals WHERE id = ?",
    )
      .bind(who.principalId)
      .first<{ gen: number }>();
    expect(
      await beginUserDeletion(
        env.DIRECTORY,
        { id: who.principalId, lifecycle: "active", gen: now?.gen ?? 0 },
        { principalId: admin.principalId, act: [] },
        Date.now(),
      ),
    ).toBe(true);
    for (let i = 0; i < 20; i++) {
      await env.DIRECTORY.prepare("UPDATE user_deletions SET next_attempt_at = 0 WHERE user_id = ?")
        .bind(who.principalId)
        .run();
      await advanceDeletions(env, { limit: 100 });
      await runDeletionSlice(env, who.principalId);
    }
    expect(
      await count("SELECT count(*) AS n FROM user_emails WHERE principal_id = ?", who.principalId),
    ).toBe(0);
    // No link left behind without its address.
    expect(
      await count(
        `SELECT count(*) AS n FROM email_confirmations c
         WHERE NOT EXISTS (SELECT 1 FROM user_emails e WHERE e.id = c.email_id)`,
      ),
    ).toBe(0);
    // Released: the proof issued before is stale; a new one confirms.
    expect((await confirm(other, stale)).status).toBe(404);
    expect((await again(other, address)).status).toBe(204);
    expect((await confirm(other, tokenFor(address))).status).toBe(200);
  });

  it("leave nothing behind that no longer matters, by their indexes", async () => {
    const who = await signedIn();
    const address = mailbox();
    await add(who, [address]);
    await remove(who, [address]);
    expect(
      await count("SELECT count(*) AS n FROM email_confirmations WHERE address_key = ?", address),
    ).toBeGreaterThan(0);
    await reapEmails(env, { now: Date.now() + 40 * 24 * 60 * 60_000 });
    expect(
      await count("SELECT count(*) AS n FROM email_confirmations WHERE address_key = ?", address),
    ).toBe(0);
    expect(
      await env.DIRECTORY.prepare("SELECT count(*) AS n FROM user_emails WHERE principal_id = ?")
        .bind(who.principalId)
        .first<{ n: number }>(),
    ).toEqual({ n: 0 });
    expect(
      await env.DIRECTORY.prepare("SELECT count(*) AS n FROM email_mailboxes WHERE address_key = ?")
        .bind(address)
        .first<{ n: number }>(),
    ).toEqual({ n: 0 });
  });
});

describe("Resend's answers", () => {
  const answer =
    (status: number, body: unknown, headers: Record<string, string> = {}) =>
    async () =>
      new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
  const message: EmailMessage = {
    to: "a@example.com",
    subject: "s",
    text: "t",
    idempotencyKey: "k",
  };
  const outcome = (fetcher: () => Promise<Response>) =>
    resendProvider("re_test", "Fyrden <n@example.com>", fetcher as typeof fetch).send(message);

  it("are classified so nothing is sent twice", async () => {
    expect(await outcome(answer(200, { id: "abc" }))).toEqual({ status: "accepted", id: "abc" });
    // Accepted without an id, or a body that does not parse: unknown.
    expect(await outcome(answer(200, {}))).toMatchObject({ status: "unknown" });
    expect(await outcome(answer(200, "not json"))).toMatchObject({ status: "unknown" });
    expect(await outcome(answer(422, { name: "validation_error", message: "bad" }))).toMatchObject({
      status: "refused",
      permanent: true,
    });
    expect(
      await outcome(answer(429, { name: "rate_limit_exceeded" }, { "retry-after": "2" })),
    ).toEqual({
      status: "refused",
      permanent: false,
      reason: "429 rate_limit_exceeded",
      retryAfterMs: 2000,
    });
    expect(await outcome(answer(429, { name: "daily_quota_exceeded" }))).toMatchObject({
      status: "refused",
      permanent: false,
    });
    expect(await outcome(answer(409, { name: "concurrent_idempotent_requests" }))).toMatchObject({
      status: "refused",
      permanent: false,
    });
    // A server error, an unlisted error, or no answer at all: unknown, never sent again.
    expect(await outcome(answer(500, { name: "application_error" }))).toMatchObject({
      status: "unknown",
    });
    expect(await outcome(answer(503, { name: "service_unavailable" }))).toMatchObject({
      status: "unknown",
    });
    expect(await outcome(answer(418, { name: "teapot" }))).toMatchObject({ status: "unknown" });
    expect(
      await outcome(async () => {
        throw new TypeError("network");
      }),
    ).toMatchObject({ status: "unknown" });
  });
});
