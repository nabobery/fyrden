import { issuerHolds } from "@fyrden/adapters-cloudflare/auth";
import type { Metrics } from "@fyrden/adapters-cloudflare/obs";
import type {
  addUserEmails,
  confirmUserEmail,
  deleteUserEmails,
  Input,
  listUserEmails,
  Output,
  requestUserEmailConfirmation,
} from "@fyrden/api-contract";
import { emailProvider, emailSending } from "../email/provider.js";
import { randomSecret, sha256Hex } from "../oauth/params.js";
import { type OpContext, OperationError } from "../ops/execute.js";
import { clock, newId } from "../services.js";

/*
 * A user's notification addresses (the directory's `user_emails`), managed
 * from a web session only (the executor refuses any other credential:
 * their permissions are a session's only). An address added is unverified until the link
 * mailed to it is followed by the account that added it; a mailbox is
 * verified on one account at a time, decided then. Every write is one D1
 * batch behind one admission: a row keyed by a nonce made here, inserted
 * only when every check of the batch passes (the user still holds at the
 * generation it was authenticated at, the caps and limits, the proof), and
 * every other statement of the batch is conditioned on that row. A mailbox's
 * `claim` changes whenever its verified owner does, so a confirmation
 * issued before is stale.
 */

/** Proposed values. */
export const EMAIL_POLICY = {
  /** Live addresses a user keeps at most. */
  maxAddresses: 10,
  /** Confirmation emails a user is sent at most an hour, and a mailbox a day. */
  perUserHour: 5,
  perMailboxDay: 3,
  /** How long a confirmation link works. */
  confirmationMs: 24 * 60 * 60_000,
} as const;

/** Hooks into a write, between its checks and its batch. For tests. */
export const emailWriteHooks: { beforeWrite?: () => Promise<void> } = {};

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

type Row = { id: string; address: string; address_key: string; verified_at: number | null };
type Entry = Output<typeof listUserEmails>[number];

const unavailable = () =>
  new OperationError(503, "email_unavailable", "This deployment sends no email.");

const rateLimited = (retryAfter: number) =>
  new OperationError(
    429,
    "confirmation_rate_limited",
    `Too many confirmation emails: try again in ${retryAfter} seconds.`,
    undefined,
    undefined,
    retryAfter,
  );

const tooMany = () =>
  new OperationError(
    422,
    "too_many_emails",
    `An account keeps at most ${EMAIL_POLICY.maxAddresses} email addresses.`,
  );

/** One address as given: trimmed, its syntax checked (nothing more); undefined when not one. */
function addressOf(text: string): { address: string; key: string } | undefined {
  const address = text.trim();
  if (new TextEncoder().encode(address).length > 254) return undefined;
  // One `@`, a domain with a dot, no whitespace or control characters.
  if (!/^[^\s@\p{Cc}]+@[^\s@\p{Cc}]+\.[^\s@\p{Cc}]+$/u.test(address)) return undefined;
  return { address, key: address.toLowerCase() };
}

function addressesOf(texts: readonly string[]): { address: string; key: string }[] {
  const seen = new Map<string, { address: string; key: string }>();
  for (const text of texts) {
    const one = addressOf(text);
    if (!one)
      throw new OperationError(
        422,
        "invalid_email",
        `${JSON.stringify(text)} is not an email address.`,
      );
    if (!seen.has(one.key)) seen.set(one.key, one);
  }
  return [...seen.values()];
}

/** The caller's live addresses, oldest first (from the primary: a write may have just landed). */
async function liveRows(ctx: OpContext): Promise<Row[]> {
  ctx.metrics.count("d1.query", { db: "directory", op: "emails_list" });
  const { results } = await ctx.env.DIRECTORY.withSession("first-primary")
    .prepare(
      `SELECT id, address, address_key, verified_at FROM user_emails
       WHERE principal_id = ? AND removed_at IS NULL ORDER BY created_at, id`,
    )
    .bind(ctx.auth.principalId)
    .all<Row>();
  return results;
}

/** Entries as GitHub shows them; `primary` the earliest verified (then by id). */
function entries(rows: readonly Row[]): Entry[] {
  const primary = rows
    .filter((r) => r.verified_at !== null)
    .sort(
      (a, b) => (a.verified_at as number) - (b.verified_at as number) || (a.id < b.id ? -1 : 1),
    )[0];
  return rows.map((r) => ({
    email: r.address,
    primary: r.id === primary?.id,
    verified: r.verified_at !== null,
    visibility: null,
  }));
}

/** The `users.emails.list` operation. */
export async function listUserEmailsOperation(
  ctx: OpContext,
  _input: Input<typeof listUserEmails>,
): Promise<Output<typeof listUserEmails>> {
  return entries(await liveRows(ctx));
}

/** A confirmation to issue: the address row, and the token (sent) with its hash (kept). */
interface Issue {
  readonly emailId: string;
  readonly address: string;
  readonly key: string;
  readonly token: string;
  readonly hash: string;
}

async function issueFor(emailId: string, address: string, key: string): Promise<Issue> {
  const token = randomSecret(32);
  return { emailId, address, key, token, hash: await sha256Hex(token) };
}

/**
 * The statements reserving `issues`' confirmation emails and recording
 * their tokens, each conditioned on the admission `nonce` (`?1`): the
 * user's hourly and each mailbox's daily count, the mailboxes (made with a
 * fresh claim when absent, no longer idle), and the confirmations, each
 * bound to its mailbox's claim now.
 */
function issuing(
  db: D1Database,
  nonce: string,
  principal: string,
  issues: readonly Issue[],
  now: number,
): D1PreparedStatement[] {
  const admitted = "EXISTS (SELECT 1 FROM email_admissions WHERE nonce = ?1)";
  const keys = JSON.stringify(issues.map((i) => i.key));
  const tokens = JSON.stringify(issues.map((i) => [i.hash, i.emailId, i.key]));
  const hour = Math.floor(now / HOUR);
  const day = Math.floor(now / DAY);
  return [
    db
      .prepare(
        `INSERT INTO email_counters (scope, key, period, sent)
         SELECT 'user_hour', ?2, ?3, ?4 WHERE ${admitted}
         ON CONFLICT (scope, key, period) DO UPDATE SET sent = sent + excluded.sent`,
      )
      .bind(nonce, principal, hour, issues.length),
    db
      .prepare(
        `INSERT INTO email_counters (scope, key, period, sent)
         SELECT 'mailbox_day', k.value, ?3, 1 FROM json_each(?2) k WHERE ${admitted}
         ON CONFLICT (scope, key, period) DO UPDATE SET sent = sent + 1`,
      )
      .bind(nonce, keys, day),
    db
      .prepare(
        `INSERT INTO email_mailboxes (address_key, claim, idle_since)
         SELECT k.value, lower(hex(randomblob(16))), NULL FROM json_each(?2) k WHERE ${admitted}
         ON CONFLICT (address_key) DO UPDATE SET idle_since = NULL`,
      )
      .bind(nonce, keys),
    db
      .prepare(
        `INSERT INTO email_confirmations
           (token_hash, email_id, address_key, claim, expires_at, used_at, reap_at)
         SELECT t.value ->> 0, t.value ->> 1, t.value ->> 2, m.claim, ?3, NULL, ?4
         FROM json_each(?2) t JOIN email_mailboxes m ON m.address_key = t.value ->> 2
         WHERE ${admitted}`,
      )
      .bind(
        nonce,
        tokens,
        now + EMAIL_POLICY.confirmationMs,
        now + EMAIL_POLICY.confirmationMs + DAY,
      ),
  ];
}

/**
 * The condition, beside the user holding, that sending `n` more
 * confirmation emails (to the mailboxes `?<keys>`, JSON) stays within the
 * limits (the user's at `?<user>`, the hour at `?<hour>`, the day at
 * `?<day>`).
 */
const withinLimits = (n: number, keys: string, user: string, hour: string, day: string) =>
  `coalesce((SELECT sent FROM email_counters WHERE scope = 'user_hour' AND key = ${user}
     AND period = ${hour}), 0) + ${n} <= ${EMAIL_POLICY.perUserHour}
   AND NOT EXISTS (SELECT 1 FROM json_each(${keys}) k
     WHERE coalesce((SELECT sent FROM email_counters c WHERE c.scope = 'mailbox_day'
       AND c.key = k.value AND c.period = ${day}), 0) + 1 > ${EMAIL_POLICY.perMailboxDay})`;

/** Why a batch's admission held back (read again: the limits, or the user not holding). */
async function refusal(ctx: OpContext, keys: readonly string[], adding: number): Promise<never> {
  const now = clock();
  const hour = Math.floor(now / HOUR);
  const day = Math.floor(now / DAY);
  const db = ctx.env.DIRECTORY.withSession("first-primary");
  ctx.metrics.count("d1.query", { db: "directory", op: "emails_refusal" });
  const row = await db
    .prepare(
      `SELECT
         (SELECT count(*) FROM user_emails WHERE principal_id = ?1 AND removed_at IS NULL) AS live,
         coalesce((SELECT sent FROM email_counters WHERE scope = 'user_hour' AND key = ?1
           AND period = ?2), 0) AS hourly,
         (SELECT max((SELECT sent FROM email_counters c WHERE c.scope = 'mailbox_day'
           AND c.key = k.value AND c.period = ?4)) FROM json_each(?3) k) AS daily,
         ${issuerHolds("?1", "?5")} AS holds`,
    )
    .bind(ctx.auth.principalId, hour, JSON.stringify(keys), day, ctx.auth.lifecycleGen)
    .first<{ live: number; hourly: number; daily: number | null; holds: number }>();
  if (!row?.holds)
    throw new OperationError(401, "invalid_token", "The session is no longer valid.");
  if (adding > 0 && row.live + adding > EMAIL_POLICY.maxAddresses) throw tooMany();
  if (row.hourly + keys.length > EMAIL_POLICY.perUserHour)
    throw rateLimited(Math.ceil(((hour + 1) * HOUR - now) / 1000));
  if ((row.daily ?? 0) + 1 > EMAIL_POLICY.perMailboxDay)
    throw rateLimited(Math.ceil(((day + 1) * DAY - now) / 1000));
  // Something changed between: the caller tries again.
  throw new OperationError(409, "conflict", "The addresses changed meanwhile: try again.");
}

/** Mails each confirmation (after its batch committed); an outcome lost is never sent again. */
async function mail(ctx: OpContext, issues: readonly Issue[]): Promise<void> {
  const provider = emailProvider(ctx.env);
  if (!provider) return;
  for (const issue of issues) {
    const link = `${ctx.requestOrigin}/settings/emails/confirm?token=${issue.token}`;
    ctx.metrics.count("email.send", { kind: "confirmation" });
    const outcome = await provider.send({
      to: issue.address,
      subject: "Confirm your email address for Fyrden",
      text: `Someone added ${issue.address} to a Fyrden account. To have its notifications sent here, open this link within a day, signed in to that account:\n\n${link}\n\nIf it was not you, ignore this email: nothing is sent here unless the address is confirmed.`,
      idempotencyKey: `confirmation-${issue.hash}`,
    });
    if (outcome.status !== "accepted")
      ctx.metrics.count("email.not_sent", { kind: "confirmation", status: outcome.status });
  }
}

/** The `users.emails.add` operation. */
export async function addUserEmailsOperation(
  ctx: OpContext,
  input: Input<typeof addUserEmails>,
): Promise<Output<typeof addUserEmails>> {
  const asked = addressesOf(input.emails);
  if (!emailSending(ctx.env)) throw unavailable();
  const present = new Set((await liveRows(ctx)).map((r) => r.address_key));
  const now = clock();
  const added = asked.filter((a) => !present.has(a.key));
  if (added.length > 0) {
    const nonce = randomSecret(32);
    const rows = added.map((a) => ({ ...a, id: newId("eml") }));
    const issues = await Promise.all(rows.map((r) => issueFor(r.id, r.address, r.key)));
    const keys = JSON.stringify(rows.map((r) => r.key));
    const db = ctx.env.DIRECTORY;
    const admitted = "EXISTS (SELECT 1 FROM email_admissions WHERE nonce = ?1)";
    await emailWriteHooks.beforeWrite?.();
    ctx.metrics.count("d1.query", { db: "directory", op: "emails_add" }, 7);
    const [admission] = await db.batch([
      db
        .prepare(
          `INSERT INTO email_admissions (nonce, at)
           SELECT ?1, ?2 WHERE ${issuerHolds("?3", "?4")}
             AND (SELECT count(*) FROM user_emails WHERE principal_id = ?3 AND removed_at IS NULL)
               + ?5 <= ${EMAIL_POLICY.maxAddresses}
             AND NOT EXISTS (SELECT 1 FROM user_emails WHERE principal_id = ?3
               AND removed_at IS NULL AND address_key IN (SELECT value FROM json_each(?6)))
             AND ${withinLimits(rows.length, "?6", "?3", "?7", "?8")}`,
        )
        .bind(
          nonce,
          now,
          ctx.auth.principalId,
          ctx.auth.lifecycleGen,
          rows.length,
          keys,
          Math.floor(now / HOUR),
          Math.floor(now / DAY),
        ),
      db
        .prepare(
          `INSERT INTO user_emails (id, principal_id, address, address_key, verified_at, created_at,
             removed_at)
           SELECT r.value ->> 0, ?2, r.value ->> 1, r.value ->> 2, NULL, ?3, NULL
           FROM json_each(?4) r WHERE ${admitted}`,
        )
        .bind(
          nonce,
          ctx.auth.principalId,
          now,
          JSON.stringify(rows.map((r) => [r.id, r.address, r.key])),
        ),
      ...issuing(db, nonce, ctx.auth.principalId, issues, now),
      db
        .prepare(
          `INSERT INTO audit_log (at, actor_id, action, target_id, details, request_id)
           SELECT ?2, ?3, 'email.add', ?3, json_object('emails', json(?4)), ?5 WHERE ${admitted}`,
        )
        .bind(nonce, now, ctx.auth.principalId, keys, ctx.requestId ?? null),
    ]);
    if ((admission?.meta.changes ?? 0) === 0)
      return refusal(
        ctx,
        rows.map((r) => r.key),
        rows.length,
      );
    await mail(ctx, issues);
  }
  const keys = new Set(asked.map((a) => a.key));
  return entries(await liveRows(ctx)).filter((e) => keys.has(e.email.toLowerCase()));
}

/** The `users.emails.delete` operation. */
export async function deleteUserEmailsOperation(
  ctx: OpContext,
  input: Input<typeof deleteUserEmails>,
): Promise<Output<typeof deleteUserEmails>> {
  const keys = JSON.stringify(addressesOf(input.emails).map((a) => a.key));
  const nonce = randomSecret(32);
  const now = clock();
  const db = ctx.env.DIRECTORY;
  const admitted = "EXISTS (SELECT 1 FROM email_admissions WHERE nonce = ?1)";
  const mine = `principal_id = ?2 AND removed_at IS NULL
    AND address_key IN (SELECT value FROM json_each(?3))`;
  await emailWriteHooks.beforeWrite?.();
  ctx.metrics.count("d1.query", { db: "directory", op: "emails_delete" }, 5);
  const [admission] = await db.batch([
    db
      .prepare(
        `INSERT INTO email_admissions (nonce, at) SELECT ?1, ?4 WHERE ${issuerHolds("?2", "?5")}`,
      )
      .bind(nonce, ctx.auth.principalId, keys, now, ctx.auth.lifecycleGen),
    // A verified claim given up: every proof of its mailbox outstanding goes stale.
    db
      .prepare(
        `UPDATE email_mailboxes SET claim = lower(hex(randomblob(16)))
         WHERE address_key IN (SELECT address_key FROM user_emails WHERE ${mine}
           AND verified_at IS NOT NULL) AND ${admitted}`,
      )
      .bind(nonce, ctx.auth.principalId, keys),
    db
      .prepare(`UPDATE user_emails SET removed_at = ?4 WHERE ${mine} AND ${admitted}`)
      .bind(nonce, ctx.auth.principalId, keys, now),
    // A mailbox no live address names any more is idle (reaped after a day).
    db
      .prepare(
        `UPDATE email_mailboxes SET idle_since = ?3
         WHERE address_key IN (SELECT value FROM json_each(?2)) AND idle_since IS NULL
           AND NOT EXISTS (SELECT 1 FROM user_emails e WHERE e.address_key = email_mailboxes.address_key
             AND e.removed_at IS NULL)
           AND ${admitted}`,
      )
      .bind(nonce, keys, now),
    db
      .prepare(
        `INSERT INTO audit_log (at, actor_id, action, target_id, details, request_id)
         SELECT ?2, ?3, 'email.remove', ?3, json_object('emails', json(?4)), ?5 WHERE ${admitted}`,
      )
      .bind(nonce, now, ctx.auth.principalId, keys, ctx.requestId ?? null),
  ]);
  if ((admission?.meta.changes ?? 0) === 0)
    throw new OperationError(401, "invalid_token", "The session is no longer valid.");
  return null;
}

const notFound = () =>
  new OperationError(404, "confirmation_not_found", "No such confirmation link works now.");

/** The `users.emails.confirm` operation. */
export async function confirmUserEmailOperation(
  ctx: OpContext,
  input: Input<typeof confirmUserEmail>,
): Promise<Output<typeof confirmUserEmail>> {
  const hash = await sha256Hex(input.token);
  const nonce = randomSecret(32);
  const now = clock();
  const db = ctx.env.DIRECTORY;
  const admitted = "EXISTS (SELECT 1 FROM email_admissions WHERE nonce = ?1)";
  const email = "(SELECT email_id FROM email_confirmations WHERE token_hash = ?2)";
  await emailWriteHooks.beforeWrite?.();
  ctx.metrics.count("d1.query", { db: "directory", op: "emails_confirm" }, 5);
  const [admission, , verified] = await db.batch([
    // The proof: unused, unexpired, of the caller's live unverified address, its mailbox's claim
    // current, the caller holding.
    db
      .prepare(
        `INSERT INTO email_admissions (nonce, at)
         SELECT ?1, ?3 WHERE ${issuerHolds("?4", "?5")} AND EXISTS (
           SELECT 1 FROM email_confirmations c
             JOIN user_emails e ON e.id = c.email_id
             JOIN email_mailboxes m ON m.address_key = c.address_key
           WHERE c.token_hash = ?2 AND c.used_at IS NULL AND c.expires_at > ?3
             AND e.principal_id = ?4 AND e.removed_at IS NULL AND e.verified_at IS NULL
             AND m.claim = c.claim)`,
      )
      .bind(nonce, hash, now, ctx.auth.principalId, ctx.auth.lifecycleGen),
    db
      .prepare(
        `UPDATE email_confirmations SET used_at = ?3, reap_at = ?4
         WHERE token_hash = ?2 AND ${admitted}`,
      )
      .bind(nonce, hash, now, now + DAY),
    // Verified only while no other account holds the mailbox verified.
    db
      .prepare(
        `UPDATE user_emails SET verified_at = ?3
         WHERE id = ${email} AND ${admitted} AND NOT EXISTS (
           SELECT 1 FROM user_emails o WHERE o.address_key = user_emails.address_key
             AND o.removed_at IS NULL AND o.verified_at IS NOT NULL
             AND o.principal_id <> user_emails.principal_id)`,
      )
      .bind(nonce, hash, now),
    // A new owner: every other proof of the mailbox outstanding goes stale.
    db
      .prepare(
        `UPDATE email_mailboxes SET claim = lower(hex(randomblob(16)))
         WHERE address_key = (SELECT address_key FROM email_confirmations WHERE token_hash = ?2)
           AND EXISTS (SELECT 1 FROM user_emails WHERE id = ${email} AND verified_at = ?3)
           AND ${admitted}`,
      )
      .bind(nonce, hash, now),
    db
      .prepare(
        `INSERT INTO audit_log (at, actor_id, action, target_id, details, request_id)
         SELECT ?3, ?4, 'email.verify', ?4, json_object('email', e.address_key), ?5
         FROM user_emails e WHERE e.id = ${email} AND e.verified_at = ?3 AND ${admitted}`,
      )
      .bind(nonce, hash, now, ctx.auth.principalId, ctx.requestId ?? null),
  ]);
  if ((admission?.meta.changes ?? 0) === 0) throw notFound();
  if ((verified?.meta.changes ?? 0) === 0)
    throw new OperationError(
      409,
      "email_taken",
      "Another account has confirmed this mailbox: its link is used up.",
    );
  const confirmed = await db
    .withSession("first-primary")
    .prepare("SELECT email_id FROM email_confirmations WHERE token_hash = ?")
    .bind(hash)
    .first<{ email_id: string }>();
  const rows = await liveRows(ctx);
  const entry = entries(rows)[rows.findIndex((r) => r.id === confirmed?.email_id)];
  if (!entry) throw notFound();
  return entry;
}

/** The `users.emails.confirmation` operation. */
export async function requestUserEmailConfirmationOperation(
  ctx: OpContext,
  input: Input<typeof requestUserEmailConfirmation>,
): Promise<Output<typeof requestUserEmailConfirmation>> {
  const [asked] = addressesOf([input.email]);
  if (!asked) throw new OperationError(422, "invalid_email", "Not an email address.");
  if (!emailSending(ctx.env)) throw unavailable();
  const row = (await liveRows(ctx)).find((r) => r.address_key === asked.key);
  const absent = () =>
    new OperationError(404, "email_not_found", "No unverified address of yours is that one.");
  if (!row || row.verified_at !== null) throw absent();
  const nonce = randomSecret(32);
  const now = clock();
  const issue = await issueFor(row.id, row.address, row.address_key);
  const keys = JSON.stringify([row.address_key]);
  const db = ctx.env.DIRECTORY;
  const admitted = "EXISTS (SELECT 1 FROM email_admissions WHERE nonce = ?1)";
  await emailWriteHooks.beforeWrite?.();
  ctx.metrics.count("d1.query", { db: "directory", op: "emails_confirmation" }, 6);
  const [admission] = await db.batch([
    db
      .prepare(
        `INSERT INTO email_admissions (nonce, at)
         SELECT ?1, ?2 WHERE ${issuerHolds("?3", "?4")}
           AND EXISTS (SELECT 1 FROM user_emails WHERE id = ?5 AND principal_id = ?3
             AND removed_at IS NULL AND verified_at IS NULL)
           AND ${withinLimits(1, "?6", "?3", "?7", "?8")}`,
      )
      .bind(
        nonce,
        now,
        ctx.auth.principalId,
        ctx.auth.lifecycleGen,
        row.id,
        keys,
        Math.floor(now / HOUR),
        Math.floor(now / DAY),
      ),
    // Earlier links stop working.
    db
      .prepare(
        `UPDATE email_confirmations SET used_at = ?3, reap_at = ?4
         WHERE email_id = ?2 AND used_at IS NULL AND ${admitted}`,
      )
      .bind(nonce, row.id, now, now + DAY),
    ...issuing(db, nonce, ctx.auth.principalId, [issue], now),
  ]);
  if ((admission?.meta.changes ?? 0) === 0) {
    // Removed or verified meanwhile: as absent; else the limits, or the session.
    const still = (await liveRows(ctx)).find((r) => r.id === row.id);
    if (!still || still.verified_at !== null) throw absent();
    return refusal(ctx, [row.address_key], 0);
  }
  await mail(ctx, [issue]);
  return null;
}

/** Rows one reaping step deletes at most, of each kind. */
const REAP_ROWS = 1_000;

/**
 * Deletes what no longer matters, by indexes, at most `REAP_ROWS` of each
 * kind a run: confirmations a day past their expiry or use, counters past
 * their period, admissions a day old, addresses removed 30 days ago, and
 * mailboxes idle for a day with no live address (checked as each goes).
 */
export async function reapEmails(
  env: Env,
  deps: { now: number; metrics?: Metrics },
): Promise<void> {
  const { now } = deps;
  const db = env.DIRECTORY;
  deps.metrics?.count("d1.query", { db: "directory", op: "emails_reap" }, 6);
  await db.batch([
    db
      .prepare(
        `DELETE FROM email_confirmations WHERE token_hash IN (SELECT token_hash
           FROM email_confirmations INDEXED BY email_confirmations_reap
           WHERE reap_at < ?1 ORDER BY reap_at LIMIT ?2)`,
      )
      .bind(now, REAP_ROWS),
    db
      .prepare(
        `DELETE FROM email_counters WHERE (scope, key, period) IN (SELECT scope, key, period
           FROM email_counters INDEXED BY email_counters_period
           WHERE scope = 'user_hour' AND period < ?1 LIMIT ?2)`,
      )
      .bind(Math.floor(now / HOUR) - 1, REAP_ROWS),
    db
      .prepare(
        `DELETE FROM email_counters WHERE (scope, key, period) IN (SELECT scope, key, period
           FROM email_counters INDEXED BY email_counters_period
           WHERE scope = 'mailbox_day' AND period < ?1 LIMIT ?2)`,
      )
      .bind(Math.floor(now / DAY) - 1, REAP_ROWS),
    db
      .prepare(
        `DELETE FROM email_admissions WHERE nonce IN (SELECT nonce
           FROM email_admissions INDEXED BY email_admissions_at
           WHERE at < ?1 ORDER BY at LIMIT ?2)`,
      )
      .bind(now - DAY, REAP_ROWS),
    db
      .prepare(
        `DELETE FROM user_emails WHERE id IN (SELECT id FROM user_emails INDEXED BY user_emails_removed
           WHERE removed_at IS NOT NULL AND removed_at < ?1 ORDER BY removed_at LIMIT ?2)`,
      )
      .bind(now - 30 * DAY, REAP_ROWS),
    db
      .prepare(
        `DELETE FROM email_mailboxes WHERE address_key IN (SELECT address_key
           FROM email_mailboxes INDEXED BY email_mailboxes_idle
           WHERE idle_since IS NOT NULL AND idle_since < ?1 ORDER BY idle_since LIMIT ?2)
         AND NOT EXISTS (SELECT 1 FROM user_emails e WHERE e.address_key = email_mailboxes.address_key
           AND e.removed_at IS NULL)`,
      )
      .bind(now - DAY, REAP_ROWS),
  ]);
}
