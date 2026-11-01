import { createLogger, type Metrics } from "@fyrden/adapters-cloudflare/obs";
import type { FeedEntry } from "@fyrden/domain";
import { SHOWN_HANDLE } from "../accounts/handles.js";
import { type InboxReason, notifiesThroughUnsubscribe } from "../do/user/inbox.js";
import { Visibility } from "../feed/operations.js";
import { randomSecret, sha256Hex } from "../oauth/params.js";
import type { OpContext } from "../ops/execute.js";
import { emailProvider, emailSending } from "./provider.js";
import { emailLimits, periodsOf, reserving, roomFor, secondsUntilRoom } from "./spending.js";
import { unsubscribeToken } from "./unsubscribe.js";

/*
 * Notification email: one message an event for a recipient, sent by the
 * recipient's `UserDO`.
 *
 * The repository decides which email an event makes for each recipient,
 * from all of its contributions, and marks one of its entries with it
 * (`email`: `direct` or `participating`; watching email is not sent yet).
 * A feed applying a marked entry queues a candidate (`email_queue`), when
 * the recipient has a deliverable address and the category on. Its alarm
 * sends what is due, a few at a time, each candidate:
 *
 * 1. takes one attempt from the deployment's daily attempt allowance
 *    (`email_attempts`, never given back), else waits for the next day;
 * 2. is read as the recipient would read it, now: the repository and the
 *    thread (bound to its conversation and restore generation) through
 *    `Visibility`, the member's text read fresh (a deleted comment has
 *    none); denied or gone, it is dropped; not known, tried again later;
 * 3. passes the directory's fence, one batch in the admission pattern: the
 *    event not past its life (24 hours), the principal active, the
 *    repository not ignored, the conversation not unsubscribed (unless the
 *    email is for what asks something of the recipient), the category on,
 *    an address (the earliest verified one not suppressed; a retry, the
 *    same one), no unsubscribe of it from the category, no outcome yet for
 *    (principal, event) but a retry due, and room in the provider
 *    allowance short of the reserve; it then records the delivery
 *    (`email_deliveries`, `sending`) and reserves the message;
 * 4. is sent, its outcome recorded in the directory: `sent`, `unknown`
 *    (never again), `refused` (the message given back), or `retry` (a
 *    transient refusal: given back, due after a back-off, at most four
 *    attempts, then `exhausted`).
 *
 * The directory's delivery row makes each email go at most once, whichever
 * copy of the object holds the candidate (a restored one included), and
 * its attempts and retry time bound a candidate's retries; candidates
 * expire 24 hours after their event.
 */

export const NOTIFICATION_POLICY = {
  /** Candidates a feed keeps at most. */
  maxQueued: 200,
  /** How long after its event a candidate may still be sent. */
  lifeMs: 24 * 60 * 60_000,
  /** Provider attempts an email gets at most. */
  maxAttempts: 4,
  /** The first back-off after a transient refusal or an unknown access answer; doubled each time. */
  backoffMs: 5 * 60_000,
  /** How long a delivery's outcome is kept after its event. */
  keepMs: 30 * 24 * 60 * 60_000,
} as const;

const DAY = 24 * 60 * 60_000;

/** Candidates one alarm sends at most (`FYRDEN_EMAIL_SENDS_PER_ALARM`, 1 to 5; default 3). */
export function sendsPerAlarm(env: object): number {
  const value = (env as { FYRDEN_EMAIL_SENDS_PER_ALARM?: unknown }).FYRDEN_EMAIL_SENDS_PER_ALARM;
  return typeof value === "string" && /^[1-5]$/.test(value) ? Number(value) : 3;
}

/**
 * Send attempts a UTC day (`FYRDEN_EMAIL_ATTEMPTS_DAILY`; default twice the
 * daily limit); null when email is off by its limits or the value is not
 * a whole number above 0.
 */
export function attemptsDaily(env: object): number | null {
  const limits = emailLimits(env);
  if (!limits) return null;
  const value = (env as { FYRDEN_EMAIL_ATTEMPTS_DAILY?: unknown }).FYRDEN_EMAIL_ATTEMPTS_DAILY;
  if (value === undefined || value === "") return limits.daily * 2;
  return typeof value === "string" && /^[1-9]\d{0,8}$/.test(value) ? Number(value) : null;
}

/**
 * The public origin links point to (`FYRDEN_PUBLIC_ORIGIN`: an `https`
 * origin, no path, query or credentials), canonical; null without one.
 */
export function publicOrigin(env: object): string | null {
  const value = (env as { FYRDEN_PUBLIC_ORIGIN?: unknown }).FYRDEN_PUBLIC_ORIGIN;
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    const bare =
      url.protocol === "https:" &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password;
    return bare ? url.origin : null;
  } catch {
    return null;
  }
}

/** Whether the deployment sends notification email: sending on, an origin, an attempt allowance. */
export function notificationsOn(env: object): boolean {
  return emailSending(env) && publicOrigin(env) !== null && attemptsDaily(env) !== null;
}

export type NotificationCategory = "direct" | "participating";

/**
 * The categories a principal gets notification email for now: none without
 * a verified live address the provider does not suppress; else those on
 * in its settings (direct on, participating off, unless set).
 */
export const ELIGIBILITY = `SELECT
  EXISTS (SELECT 1 FROM user_emails e WHERE e.principal_id = ?1 AND e.removed_at IS NULL
    AND e.verified_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM email_suppressions s
      WHERE s.address_key = e.address_key AND s.suppressed = 1)) AS deliverable,
  coalesce((SELECT direct FROM email_preferences WHERE principal_id = ?1), 1) AS direct,
  coalesce((SELECT participating FROM email_preferences WHERE principal_id = ?1), 0)
    AS participating`;

/** The categories `principal` gets email for now (see `ELIGIBILITY`). */
export async function eligibleCategories(
  env: Env,
  principal: string,
): Promise<ReadonlySet<NotificationCategory>> {
  const row = await env.DIRECTORY.withSession("first-primary")
    .prepare(ELIGIBILITY)
    .bind(principal)
    .first<{ deliverable: number; direct: number; participating: number }>();
  const on = new Set<NotificationCategory>();
  if (!row?.deliverable) return on;
  if (row.direct) on.add("direct");
  if (row.participating) on.add("participating");
  return on;
}

/** A queued candidate. */
export interface Candidate {
  readonly event_key: string;
  readonly repo_id: string;
  readonly thread_key: string;
  readonly conversation: string;
  readonly epoch: number;
  readonly member: string | null;
  readonly actor: string | null;
  readonly action: string;
  readonly category: NotificationCategory;
  readonly reason: string;
  readonly occurred_at: number;
  readonly arrival: number;
  readonly due_at: number;
  readonly tries: number;
}

/**
 * Queues the candidates `entries` make (call within the feed's
 * transaction): a marked entry of a category in `enabled`, of a thread with
 * a conversation, not past its life; a redelivered event changes nothing.
 * Past the cap, expired rows go first, then the newest of the lowest
 * category (the incoming one included), so earlier ones are kept. How many
 * were queued.
 */
export function queueCandidates(
  sql: SqlStorage,
  entries: readonly FeedEntry[],
  enabled: ReadonlySet<NotificationCategory>,
  now: number,
): number {
  let queued = 0;
  for (const entry of entries) {
    const mark = entry.recipient.email;
    const conversation = entry.feed.subject.conversation;
    if (!mark || conversation === undefined || !enabled.has(mark.category)) continue;
    if (entry.occurredAt + NOTIFICATION_POLICY.lifeMs <= now) continue;
    const arrival =
      sql.exec<{ n: number | null }>("SELECT max(arrival) AS n FROM email_queue").one().n ?? 0;
    const inserted = sql.exec(
      `INSERT INTO email_queue (event_key, repo_id, thread_key, conversation, epoch, member, actor,
         action, category, reason, occurred_at, arrival, due_at, tries)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
       ON CONFLICT (event_key) DO NOTHING`,
      entry.eventKey,
      entry.repoId,
      entry.feed.threadKey,
      conversation,
      entry.epochGen,
      entry.feed.member,
      entry.actor,
      entry.feed.action,
      mark.category,
      mark.reason,
      entry.occurredAt,
      arrival + 1,
      now,
    ).rowsWritten;
    if (inserted > 0) queued++;
  }
  if (queued > 0) trim(sql, enabled, now);
  return queued;
}

/**
 * Keeps the queue within its cap (see `queueCandidates`): expired rows and
 * those of a category now off go first.
 */
function trim(sql: SqlStorage, enabled: ReadonlySet<NotificationCategory>, now: number): void {
  const count = () => sql.exec<{ n: number }>("SELECT count(*) AS n FROM email_queue").one().n;
  if (count() <= NOTIFICATION_POLICY.maxQueued) return;
  sql.exec(
    `DELETE FROM email_queue WHERE occurred_at <= ?
       OR category NOT IN (SELECT value FROM json_each(?))`,
    now - NOTIFICATION_POLICY.lifeMs,
    JSON.stringify([...enabled]),
  );
  const over = count() - NOTIFICATION_POLICY.maxQueued;
  if (over > 0)
    sql.exec(
      `DELETE FROM email_queue WHERE event_key IN (SELECT event_key FROM email_queue
         ORDER BY category = 'direct', arrival DESC, event_key DESC LIMIT ?)`,
      over,
    );
}

/** When the queue is next due; null when it is empty. */
export function nextDue(sql: SqlStorage): number | null {
  return sql.exec<{ at: number | null }>("SELECT min(due_at) AS at FROM email_queue").one().at;
}

/** Forgets queued candidates of repositories up to `until` (as a purge forgets their items). */
export function forgetQueuedRepos(
  sql: SqlStorage,
  repoIds: readonly string[],
  until: number,
): void {
  for (const repoId of repoIds)
    sql.exec("DELETE FROM email_queue WHERE repo_id = ? AND occurred_at <= ?", repoId, until);
}

/** Forgets queued candidates of threads gone, up to the restore generation they went in. */
export function forgetQueuedGone(
  sql: SqlStorage,
  threads: readonly { repoId: string; threadKey: string; epoch: number }[],
): void {
  for (const { repoId, threadKey, epoch } of threads)
    sql.exec(
      "DELETE FROM email_queue WHERE repo_id = ? AND thread_key = ? AND epoch <= ?",
      repoId,
      threadKey,
      epoch,
    );
}

/** Forgets queued candidates of conversations, up to a restore generation each. */
export function forgetQueuedConversations(
  sql: SqlStorage,
  threads: readonly { repoId: string; conversation: string; epoch: number }[],
): void {
  for (const { repoId, conversation, epoch } of threads)
    sql.exec(
      "DELETE FROM email_queue WHERE repo_id = ? AND conversation = ? AND epoch <= ?",
      repoId,
      conversation,
      epoch,
    );
}

/** What became of a candidate's turn: done with (sent, dropped), or due again at a time. */
export type Turn =
  | { readonly done: true }
  /** `tried`: it failed (an access answer not known, an error), and counts toward its tries. */
  | { readonly done: false; readonly due: number; readonly tried?: boolean };

const DONE: Turn = { done: true };

/** Hooks into a send, between its steps. For tests. */
export const sendHooks: {
  beforeFence?: (candidate: Candidate) => Promise<void>;
} = {};

/**
 * One candidate's turn (see the module comment): its outcome recorded in
 * the directory; what the caller does with the queued row returned.
 */
export async function sendCandidate(
  env: Env,
  principal: string,
  candidate: Candidate,
  metrics: Metrics,
  /** Whether the candidate is still queued (read after the awaited reads, before the fence). */
  still: () => boolean = () => true,
): Promise<Turn> {
  const now = Date.now();
  const expires = candidate.occurred_at + NOTIFICATION_POLICY.lifeMs;
  if (now >= expires) return dropped(metrics, "expired");
  const provider = emailProvider(env);
  const limits = emailLimits(env);
  const origin = publicOrigin(env);
  const allowance = attemptsDaily(env);
  if (!notificationsOn(env) || !provider || !limits || !origin || allowance === null)
    return dropped(metrics, "off");
  // A link to leave the category, or nothing is sent (the key's absence is logged where read).
  if ((await unsubscribeToken(env, "eml_00000000000000000000000000", candidate.category)) === null)
    return dropped(metrics, "no_unsubscribe_key");
  if (!(await takeAttempt(env, allowance, now, metrics)))
    return { done: false, due: Math.min(expires, (Math.floor(now / DAY) + 1) * DAY) };

  const view = await viewOf(env, principal, candidate, metrics);
  if (view === "denied") return dropped(metrics, "denied");
  if (view === "unknown") {
    if (candidate.tries + 1 >= NOTIFICATION_POLICY.maxAttempts) return dropped(metrics, "unknown");
    return { done: false, due: Math.min(expires, now + backoff(candidate.tries)), tried: true };
  }

  await sendHooks.beforeFence?.(candidate);
  // Forgotten meanwhile (a purge, a forgetting, the retirement): not sent.
  if (!still()) return dropped(metrics, "forgotten");
  const fenced = await fence(env, principal, candidate, limits, metrics);
  if (!("address" in fenced)) return fenced;

  const message = messageFor(origin, candidate, view, fenced.actorHandle);
  const token = await unsubscribeToken(env, fenced.addressId, candidate.category);
  const unsubscribe = `${origin}/unsubscribe?t=${encodeURIComponent(token ?? "")}`;
  metrics.count("email.send", { kind: "notification" });
  const outcome = await provider.send({
    to: fenced.address,
    subject: message.subject,
    text: `${message.text}\n\nUnsubscribe from these emails: ${unsubscribe}\nChange what Fyrden emails you: ${origin}/settings/notifications\n`,
    headers: {
      "List-Unsubscribe": `<${unsubscribe}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
    tags: { fyrden_kind: "notification", fyrden_address: fenced.addressId },
    idempotencyKey: `notification-${await sha256Hex(`${principal}\n${candidate.event_key}`)}-${fenced.attempts}`,
  });
  return settle(env, principal, candidate, fenced, outcome, metrics);
}

const dropped = (metrics: Metrics, why: string): Turn => {
  metrics.count("email.not_sent", { kind: "notification", status: why });
  return DONE;
};

/** The back-off after `tries` failures: 5 minutes, doubling. */
const backoff = (tries: number) => NOTIFICATION_POLICY.backoffMs * 2 ** tries;

/** Takes one attempt from the day's allowance; false when it is spent. */
async function takeAttempt(
  env: Env,
  allowance: number,
  now: number,
  metrics: Metrics,
): Promise<boolean> {
  metrics.count("d1.query", { db: "directory", op: "email_attempt" });
  const row = await env.DIRECTORY.prepare(
    `INSERT INTO email_attempts (day, used) VALUES (?1, 1)
     ON CONFLICT (day) DO UPDATE SET used = used + 1 WHERE used < ?2
     RETURNING used`,
  )
    .bind(Math.floor(now / DAY), allowance)
    .first<{ used: number }>();
  if (row) return true;
  metrics.count("email.not_sent", { kind: "notification", status: "attempts" });
  return false;
}

/** What the recipient reads of the candidate now. */
interface View {
  readonly owner: string;
  readonly name: string;
  readonly title: string;
  readonly excerpt: string | null;
}

/**
 * The candidate as `principal` reads it now, through `Visibility` (the
 * principal as itself: a session's authority): its repository's name, the
 * thread's title while its number still names the candidate's
 * conversation, and the member's text (fresh: none once deleted).
 */
async function viewOf(
  env: Env,
  principal: string,
  candidate: Candidate,
  metrics: Metrics,
): Promise<View | "denied" | "unknown"> {
  const self = {
    id: `email:${principal}`,
    type: "ses",
    principalId: principal,
    principalType: "user",
    principalHandle: null,
    isInstanceAdmin: false,
    lifecycleGen: 0,
    scopes: [],
    repoIds: null,
    expiresAt: Number.MAX_SAFE_INTEGER,
    lastUsedAt: null,
    act: [],
    grantId: null,
    ceilingIds: [],
    audience: null,
    dpopJkt: null,
    requiresDpop: false,
  };
  const visibility = new Visibility({ env, metrics, auth: self } as unknown as OpContext);
  const item = {
    repoId: candidate.repo_id,
    threadKey: candidate.thread_key,
    member: candidate.member,
    epoch: candidate.epoch,
    conversation: candidate.conversation,
  };
  try {
    await visibility.decide([item]);
    await visibility.read([item]);
  } catch {
    return "unknown";
  }
  const repo = visibility.of(item);
  if (repo === undefined) return "unknown";
  if (repo === "hidden") return "denied";
  const now = visibility.identity(item.repoId, item.threadKey);
  if (now === undefined) return "unknown";
  if (now.conversation !== candidate.conversation) return "denied";
  return {
    owner: repo.ownerHandle,
    name: repo.name,
    title: now.title,
    excerpt: visibility.excerpt(item),
  };
}

/** What the fence admitted: the address, its attempt, and the actor's handle. */
interface Fenced {
  readonly address: string;
  readonly addressId: string;
  readonly attempts: number;
  readonly actorHandle: string | null;
  readonly periods: { day: number; month: number };
}

/**
 * The address a candidate goes to (the fence's parameters: `?3` the
 * principal, `?4` the event): the earliest verified one not suppressed; a
 * retry, the same one.
 */
const ADDRESS = `(SELECT e.id FROM user_emails e WHERE e.principal_id = ?3
    AND e.removed_at IS NULL AND e.verified_at IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM email_suppressions s WHERE s.address_key = e.address_key
      AND s.suppressed = 1)
    AND (NOT EXISTS (SELECT 1 FROM email_deliveries d WHERE d.principal_id = ?3
      AND d.event_key = ?4) OR e.id = (SELECT d.address_id FROM email_deliveries d
      WHERE d.principal_id = ?3 AND d.event_key = ?4))
    ORDER BY e.verified_at, e.id LIMIT 1)`;

/**
 * Whether a candidate is to be sent at all, apart from its timing and the
 * allowance (`?3` the principal, `?4` the event, `?5` the repository, `?6`
 * the conversation, `?7` whether an unsubscribe lets it through, `?8` the
 * category): the principal active, the repository not ignored, the
 * conversation not unsubscribed, the category on, an address, no
 * unsubscribe of it from the category.
 */
const ELIGIBLE = `EXISTS (SELECT 1 FROM principals WHERE id = ?3 AND lifecycle = 'active')
  AND NOT EXISTS (SELECT 1 FROM watch_preferences WHERE principal_id = ?3
    AND repo_id = ?5 AND level = 'ignoring')
  AND (?7 = 1 OR NOT EXISTS (SELECT 1 FROM thread_preferences WHERE principal_id = ?3
    AND repo_id = ?5 AND conversation = ?6 AND state = 'unsubscribed'))
  AND coalesce((SELECT CASE ?8 WHEN 'direct' THEN direct ELSE participating END
    FROM email_preferences WHERE principal_id = ?3), ?8 = 'direct') = 1
  AND ${ADDRESS} IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM email_unsubscribes WHERE email_id = ${ADDRESS} AND scope = ?8)`;

/**
 * The directory's fence (see the module comment): the delivery recorded
 * and the message reserved, with the address, when every check holds;
 * else what to do with the candidate, from why it was held back.
 */
async function fence(
  env: Env,
  principal: string,
  candidate: Candidate,
  limits: NonNullable<ReturnType<typeof emailLimits>>,
  metrics: Metrics,
): Promise<Fenced | Turn> {
  const db = env.DIRECTORY;
  const nonce = randomSecret(32);
  // Read here, after the awaited reads: the fence is when the email is decided.
  const now = Date.now();
  const periods = periodsOf(now);
  const exempt = notifiesThroughUnsubscribe(candidate.reason as InboxReason) ? 1 : 0;
  const admitted = "EXISTS (SELECT 1 FROM email_admissions WHERE nonce = ?1)";
  const address = ADDRESS;
  metrics.count("d1.query", { db: "directory", op: "email_notification_fence" }, 5);
  const [admission, , , , picked] = await db.batch([
    db
      .prepare(
        `INSERT INTO email_admissions (nonce, at)
         SELECT ?1, ?2 WHERE ?2 < ?9 AND ${ELIGIBLE}
           AND NOT EXISTS (SELECT 1 FROM email_deliveries d WHERE d.principal_id = ?3
             AND d.event_key = ?4 AND NOT (d.state = 'retry' AND d.attempts < ?12
               AND d.next_attempt_at <= ?2))
           AND ${roomFor(limits, true, "?10", "?11")}`,
      )
      .bind(
        nonce,
        now,
        principal,
        candidate.event_key,
        candidate.repo_id,
        candidate.conversation,
        exempt,
        candidate.category,
        candidate.occurred_at + NOTIFICATION_POLICY.lifeMs,
        periods.day,
        periods.month,
        NOTIFICATION_POLICY.maxAttempts,
      ),
    db
      .prepare(
        `INSERT INTO email_deliveries (principal_id, event_key, state, attempts, address_id,
           provider_id, next_attempt_at, at)
         SELECT ?3, ?4, 'sending', 0, ${address}, NULL, NULL, ?5 WHERE ${admitted}
         ON CONFLICT (principal_id, event_key) DO UPDATE SET state = 'sending'`,
      )
      .bind(nonce, now, principal, candidate.event_key, candidate.occurred_at),
    ...reserving(db, nonce, periods),
    db
      .prepare(
        `SELECT e.id, e.address, d.attempts,
           (SELECT ${SHOWN_HANDLE} FROM principals p WHERE p.id = ?4) AS actor
         FROM email_deliveries d JOIN user_emails e ON e.id = d.address_id
         WHERE d.principal_id = ?2 AND d.event_key = ?3 AND ${admitted}`,
      )
      .bind(nonce, principal, candidate.event_key, candidate.actor),
  ]);
  const row = picked?.results[0] as
    | { id: string; address: string; attempts: number; actor: string | null }
    | undefined;
  if ((admission?.meta.changes ?? 0) > 0 && row)
    return {
      address: row.address,
      addressId: row.id,
      attempts: row.attempts,
      actorHandle: row.actor,
      periods,
    };
  return heldBack(env, principal, candidate, limits, now, metrics);
}

/**
 * What to do with a candidate the fence held back (read again from the
 * primary): due at its retry time or when the allowance has room (within
 * its life); else dropped (sent already, or no longer to be sent).
 */
async function heldBack(
  env: Env,
  principal: string,
  candidate: Candidate,
  limits: NonNullable<ReturnType<typeof emailLimits>>,
  now: number,
  metrics: Metrics,
): Promise<Turn> {
  const { day, month } = periodsOf(now);
  metrics.count("d1.query", { db: "directory", op: "email_held_back" });
  const row = await env.DIRECTORY.withSession("first-primary")
    .prepare(
      `SELECT ${ELIGIBLE} AS eligible,
         (SELECT state FROM email_deliveries WHERE principal_id = ?3 AND event_key = ?4) AS state,
         (SELECT attempts FROM email_deliveries WHERE principal_id = ?3 AND event_key = ?4)
           AS attempts,
         (SELECT next_attempt_at FROM email_deliveries WHERE principal_id = ?3
           AND event_key = ?4) AS next_attempt_at,
         coalesce((SELECT used FROM email_spend WHERE scope = 'day' AND period = ?9), 0) AS day,
         coalesce((SELECT used FROM email_spend WHERE scope = 'month' AND period = ?10), 0)
           AS month`,
    )
    .bind(
      null,
      now,
      principal,
      candidate.event_key,
      candidate.repo_id,
      candidate.conversation,
      notifiesThroughUnsubscribe(candidate.reason as InboxReason) ? 1 : 0,
      candidate.category,
      day,
      month,
    )
    .first<{
      eligible: number;
      state: string | null;
      attempts: number | null;
      next_attempt_at: number | null;
      day: number;
      month: number;
    }>();
  const expires = candidate.occurred_at + NOTIFICATION_POLICY.lifeMs;
  if (now >= expires) return dropped(metrics, "expired");
  // No longer to be sent (ignored, unsubscribed, no address, the category off): dropped, not kept.
  if (!row?.eligible) return dropped(metrics, "ineligible");
  if (row?.state === "retry" && (row.attempts ?? 0) < NOTIFICATION_POLICY.maxAttempts) {
    if ((row.next_attempt_at ?? 0) > now)
      return { done: false, due: Math.min(expires, row.next_attempt_at as number) };
  } else if (row?.state) return dropped(metrics, "delivered");
  if ((row?.month ?? 0) >= limits.monthly - limits.reserve)
    return { done: false, due: Math.min(expires, now + secondsUntilRoom(now, "month") * 1000) };
  if ((row?.day ?? 0) >= limits.daily - limits.reserve)
    return { done: false, due: Math.min(expires, now + secondsUntilRoom(now, "day") * 1000) };
  return dropped(metrics, "ineligible");
}

/** Records a call's outcome (the reservation given back on a refusal); the candidate's turn. */
async function settle(
  env: Env,
  principal: string,
  candidate: Candidate,
  fenced: Fenced,
  outcome: Awaited<ReturnType<NonNullable<ReturnType<typeof emailProvider>>["send"]>>,
  metrics: Metrics,
): Promise<Turn> {
  // The provider's delay counts from its answer.
  const now = Date.now();
  const db = env.DIRECTORY;
  const row = (state: string) =>
    db
      .prepare(
        `UPDATE email_deliveries SET state = ?3
         WHERE principal_id = ?1 AND event_key = ?2 AND state = 'sending'`,
      )
      .bind(principal, candidate.event_key, state);
  if (outcome.status === "accepted") {
    metrics.count("d1.query", { db: "directory", op: "email_delivered" });
    await db
      .prepare(
        `UPDATE email_deliveries SET state = 'sent', provider_id = ?3
         WHERE principal_id = ?1 AND event_key = ?2 AND state = 'sending'`,
      )
      .bind(principal, candidate.event_key, outcome.id)
      .run();
    return DONE;
  }
  metrics.count("email.not_sent", { kind: "notification", status: outcome.status });
  if (outcome.status === "unknown") {
    metrics.count("d1.query", { db: "directory", op: "email_delivered" });
    await row("unknown").run();
    return DONE;
  }
  // Refused: it sent nothing, so the periods it took have the message back.
  const giving = (["day", "month"] as const).map((scope) =>
    db
      .prepare("UPDATE email_spend SET used = used - 1 WHERE scope = ? AND period = ? AND used > 0")
      .bind(scope, fenced.periods[scope]),
  );
  const attempt = fenced.attempts + 1;
  if (outcome.permanent || attempt >= NOTIFICATION_POLICY.maxAttempts) {
    metrics.count("d1.query", { db: "directory", op: "email_refused" }, 3);
    await db.batch([
      outcome.permanent
        ? row("refused")
        : db
            .prepare(
              `UPDATE email_deliveries SET state = 'exhausted', attempts = ?3
               WHERE principal_id = ?1 AND event_key = ?2 AND state = 'sending'`,
            )
            .bind(principal, candidate.event_key, attempt),
      ...giving,
    ]);
    return DONE;
  }
  const next = now + Math.max(backoff(fenced.attempts), outcome.retryAfterMs ?? 0);
  metrics.count("d1.query", { db: "directory", op: "email_refused" }, 3);
  await db.batch([
    db
      .prepare(
        `UPDATE email_deliveries SET state = 'retry', attempts = ?3, next_attempt_at = ?4
         WHERE principal_id = ?1 AND event_key = ?2 AND state = 'sending'`,
      )
      .bind(principal, candidate.event_key, attempt, next),
    ...giving,
  ]);
  const expires = candidate.occurred_at + NOTIFICATION_POLICY.lifeMs;
  return next >= expires ? DONE : { done: false, due: next };
}

/** The phrase for what happened, by the reason the email is for and the event's action. */
function phrase(candidate: Candidate): string {
  switch (candidate.reason) {
    case "mention":
    case "team_mention":
      return "mentioned you in";
    case "review_requested":
      return "requested your review on";
    case "assign":
      return "assigned you to";
  }
  switch (candidate.action) {
    case "comment":
      return "commented on";
    case "review_comment":
      return "commented on a change in";
    case "comment_edited":
      return "edited a comment on";
    case "edited":
      return "edited";
    case "opened":
      return "opened";
    case "closed":
      return "closed";
    case "reopened":
      return "reopened";
    case "merged":
      return "merged";
    case "review":
      return "reviewed";
    case "review_dismissed":
      return "dismissed a review on";
    case "review_requested":
      return "requested a review on";
    case "assigned":
      return "assigned someone to";
    case "unassigned":
      return "unassigned someone from";
    default:
      return `${candidate.action.replace(/_/g, " ")}:`;
  }
}

const WHY: Record<NotificationCategory, string> = {
  direct: "it asks something of you, or is about your own issue or pull request",
  participating: "you take part in this thread or subscribed to it",
};

/** A notification's subject and text (plain), the unsubscribe links added by the caller. */
export function messageFor(
  origin: string,
  candidate: Candidate,
  view: View,
  actorHandle: string | null,
): { subject: string; text: string } {
  const [subject, number] = candidate.thread_key.split("/") as [string, string];
  const link = `${origin}/${view.owner}/${view.name}/${subject === "pull" ? "pull" : "issues"}/${number}`;
  const what = subject === "pull" ? "pull request" : "issue";
  const lines =
    candidate.action === "merge_conflict"
      ? [`Your ${what} ${view.owner}/${view.name}#${number} now has a merge conflict.`]
      : [
          `${actorHandle ?? "Someone"} ${phrase(candidate)} ${what} ${view.owner}/${view.name}#${number}.`,
        ];
  if (view.excerpt) lines.push("", view.excerpt);
  lines.push(
    "",
    `View it on Fyrden: ${link}`,
    "",
    `You are receiving this because ${WHY[candidate.category]}.`,
  );
  return {
    subject: `[${view.owner}/${view.name}] ${view.title} (#${number})`,
    text: lines.join("\n"),
  };
}

/** Logs a candidate's turn that threw (it is due again after a back-off). */
export function logSendFailure(error: unknown): void {
  createLogger({ op: "email.notifications" }).warn("a notification send failed", { error });
}

/** Reaps delivery outcomes past their keep, and attempt days before yesterday. */
export function reapingDeliveries(
  db: D1Database,
  now: number,
  rows: number,
): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `DELETE FROM email_deliveries WHERE (principal_id, event_key) IN (
           SELECT principal_id, event_key FROM email_deliveries INDEXED BY email_deliveries_at
           WHERE at < ?1 ORDER BY at LIMIT ?2)`,
      )
      .bind(now - NOTIFICATION_POLICY.keepMs, rows),
    db.prepare("DELETE FROM email_attempts WHERE day < ?").bind(Math.floor(now / DAY) - 1),
  ];
}
