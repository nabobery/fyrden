import { createLogger, type Metrics } from "@fyrden/adapters-cloudflare/obs";
import {
  type DomainEvent,
  type EntitySnapshot,
  eventKey,
  ISSUE_ENTITY,
  isId,
  LABEL_ENTITY,
  MILESTONE_ENTITY,
  PULL_ENTITY,
  parseEnvelope,
  parseRepoRow,
  REPO_ENTITY,
  type RepoRow,
} from "@fyrden/domain";
import { discretionaryAllowance } from "../effects/discretionary.js";
import { deliverEffects } from "../effects/dispatcher.js";
import {
  EFFECT_POLICY,
  type EffectSink,
  INLINE_BATCH_EFFECTS,
  INLINE_RECIPIENTS,
  journalStatements,
  MESSAGE_CALLS,
  planEffects,
} from "../effects/journal.js";
import { type Publish, publisher } from "../effects/queues.js";
import { EFFECT_SINKS, effectQueues } from "../effects/sinks.js";
import { DEFAULT_ORG_SHARD, readModelFor } from "../events/read-model.js";
import { feedSink } from "../feed/sink.js";
import { consumerCalls } from "../invocation-calls.js";
import { READ_MODEL_ADMISSION, withReadModel } from "../read-model/executor.js";
import {
  ADMISSION,
  ADMITTED,
  growthOf,
  RECEIPT_RELEASE,
  receiptStatements,
  TODAY,
} from "../search/admission.js";
import { liveSearch, Settling } from "../search/live.js";
import { repairSql } from "../search/repairs.js";
import { bound, IN_REPO_INDEX } from "../search/statements.js";

/** The queue repository outboxes send to. */
export const EVENTS_QUEUE = "fyrden-events";

/**
 * How long events of a repository the directory does not list are kept
 * waiting, from when the consumer first saw them, before they are dropped.
 * A repository's object is created before its directory row, so its first
 * events can arrive first; a creation that then fails (a lost race for the
 * name) leaves events no one will ever list. Proposed.
 */
export const UNLISTED_GRACE_MS = 10 * 60 * 1000;

/**
 * The first and the longest delay a waiting message is put back for; the
 * delay grows with the time waited in between. Proposed.
 */
export const UNLISTED_DELAY_SECONDS = { first: 30, max: 300 } as const;

/**
 * A message put back to wait: the envelope, unchanged, and when the
 * consumer first saw it. It is sent as a new message, so waiting does not
 * use up the retries meant for failures, and its deadline is the
 * consumer's own clock, not the events' times.
 */
export interface WaitingMessage {
  readonly waitingSince: number;
  readonly envelope: unknown;
}

/**
 * The rest of an envelope's searched snapshots, for search alone (a
 * message of its own, sent before the envelope's is acknowledged): as they
 * travelled (stored ones without their rows), never planning or journaling
 * effects (the envelope's own message did).
 */
export interface SearchContinuation {
  readonly type: "search.continue";
  readonly sourceId: string;
  readonly events: readonly Snapshot[];
}

export function isContinuation(body: unknown): body is SearchContinuation {
  return (
    typeof body === "object" &&
    body !== null &&
    (body as SearchContinuation).type === "search.continue" &&
    typeof (body as SearchContinuation).sourceId === "string" &&
    Array.isArray((body as SearchContinuation).events)
  );
}

/**
 * What one batch projects for search at most: the text it indexes (titles
 * and bodies, names and descriptions, UTF-8) and the snapshots it looks at
 * (deletions and gone payloads included). The rest goes on in a
 * continuation. A snapshot alone is always taken.
 */
export const SEARCH_CHUNK = { bytes: 1_048_576, snapshots: 200 };

export function isWaiting(body: unknown): body is WaitingMessage {
  return (
    typeof body === "object" &&
    body !== null &&
    Number.isSafeInteger((body as WaitingMessage).waitingSince) &&
    "envelope" in body
  );
}

/** Delay before a failed message is delivered again. Proposed. */
export const RETRY_DELAY_SECONDS = 10;

/** `unlisted`: the directory does not list the repository (yet). */
/** `deferred`: the invocation's calls are spent; the message waits for a later one. */
export type ApplyOutcome = "applied" | "dropped" | "unlisted" | "deferred";

/**
 * Calls to internal services (D1, Durable Objects, R2, queues) one
 * consumer invocation makes at most on Free (`consumerCalls`: the
 * deployment's per-invocation limit less a margin; a Paid deployment may
 * set more).
 */
export const INVOCATION_CALLS = consumerCalls({});
/**
 * Calls applying a message costs besides reading its stored events: its
 * lookup, its batch, a send back, and a lookup of the effects a first try
 * left unsent.
 */
const CALLS_PER_MESSAGE = 4;
/**
 * Calls the invocation keeps for sending its messages' effects: a send per
 * sink (three) and marking them sent, with room. Inline deliveries take
 * their own calls from what the messages leave.
 */
const DISPATCH_CALLS = 6;
/** Calls the invocation keeps for settling what its messages reserved of search's allowance. */
const SETTLE_CALLS = 1;

/** The calls applying a message's envelope costs, its deliveries aside. */
function messageCalls(body: unknown): number {
  const events = (body as { events?: unknown } | null)?.events;
  if (!Array.isArray(events)) return CALLS_PER_MESSAGE;
  return (
    CALLS_PER_MESSAGE + events.filter((e) => (e as { stored?: unknown })?.stored === true).length
  );
}

export interface ConsumerOptions {
  readonly now?: () => number;
  readonly metrics?: Metrics;
  /** The effect sinks (default: the deployment's). */
  readonly sinks?: readonly EffectSink[];
  /**
   * Effects of inline sinks the invocation may still deliver itself, and
   * calls to their recipients (`INLINE_RECIPIENTS` when not said), shared by
   * its messages (default: its own).
   */
  readonly inline?: { batched: number; recipients?: number };
  /** Where effects are sent (default: each sink's queue). */
  readonly publish?: Publish;
  /**
   * Where the invocation's messages leave their effects to send or deliver,
   * all at once after the last one is applied (`dispatchEffects`); without
   * it, an envelope's effects are dispatched as soon as it is applied.
   */
  readonly dispatching?: Dispatching;
  /**
   * Where the invocation's messages leave search's bookkeeping, applied
   * all at once after the last one; without it, each message's right after
   * its batch.
   */
  readonly settling?: Settling;
  /** The default shard's read model the invocation writes through (one writer for all of it). */
  readonly readModel?: D1Database;
  /**
   * Calls the invocation may still make, shared by its messages, how many
   * of them applying the messages after this one needs, and whether one was
   * applied (a message alone is applied whatever it costs).
   */
  readonly calls?: { left: number; reserved: number; applied: boolean };
}

/**
 * The `events` consumer: each message (one envelope from one source) is
 * applied with one directory lookup and one read-model batch, then
 * acknowledged; a failure retries the message, and a message that keeps
 * failing goes to the dead-letter queue. A message for a repository not
 * listed yet is put back to wait (`WaitingMessage`) until the grace ends.
 */
export async function consumeEvents(
  batch: MessageBatch<unknown>,
  env: Env,
  options: ConsumerOptions = {},
): Promise<void> {
  // One writer for the invocation's writes to the read model.
  await withReadModel(env, DEFAULT_ORG_SHARD, (readModel) =>
    consumeWith(batch, env, { ...options, readModel: options.readModel ?? readModel }),
  );
}

async function consumeWith(
  batch: MessageBatch<unknown>,
  env: Env,
  options: ConsumerOptions,
): Promise<void> {
  const log = createLogger({ op: "events.consume" });
  // One share of inline deliveries and of calls for the whole invocation.
  options = {
    ...options,
    inline: options.inline ?? { batched: INLINE_BATCH_EFFECTS, recipients: INLINE_RECIPIENTS },
    calls: options.calls ?? {
      left: consumerCalls(env) - DISPATCH_CALLS - SETTLE_CALLS,
      reserved: 0,
      applied: false,
    },
  };
  const envelopes = batch.messages.map((message) =>
    isWaiting(message.body) ? message.body.envelope : message.body,
  );
  // What applying each message needs, kept for it while the ones before it deliver.
  const needs = envelopes.map(messageCalls);
  // Every message's effects together: one send per sink for the whole invocation (Queues bill
  // per message), then the inline deliveries.
  const dispatching = options.dispatching ?? new Dispatching();
  const settling = options.settling ?? new Settling();
  options = { ...options, dispatching, settling };
  for (const [i, message] of batch.messages.entries()) {
    try {
      const waiting = isWaiting(message.body) ? message.body : undefined;
      const envelope = envelopes[i];
      if (options.calls) options.calls.reserved = needs.slice(i + 1).reduce((a, b) => a + b, 0);
      const outcome = isContinuation(envelope)
        ? await applyContinuation(env, envelope, options)
        : await applyEnvelope(env, envelope, options);
      if (outcome === "deferred") {
        // A new message, not a retry: waiting for budget is no failure.
        await env.EVENTS.send(message.body, { contentType: "json", delaySeconds: 1 });
        options.metrics?.count("queue.send", { queue: "events" });
      } else if (outcome === "unlisted") {
        const now = options.now?.() ?? Date.now();
        const since = Math.min(waiting?.waitingSince ?? now, now);
        const waited = now - since;
        if (waited <= UNLISTED_GRACE_MS) {
          const put: WaitingMessage = { waitingSince: since, envelope };
          await env.EVENTS.send(put, {
            contentType: "json",
            delaySeconds: Math.min(
              Math.max(UNLISTED_DELAY_SECONDS.first, Math.ceil(waited / 1000)),
              UNLISTED_DELAY_SECONDS.max,
            ),
          });
          options.metrics?.count("queue.send", { queue: "events" });
        } else {
          log.warn("dropping events of a repository that was never listed", {
            messageId: message.id,
            waitedMs: waited,
          });
        }
      }
      message.ack();
    } catch (error) {
      log.error("applying events failed", {
        error,
        messageId: message.id,
        attempts: message.attempts,
      });
      message.retry({ delaySeconds: RETRY_DELAY_SECONDS });
    }
  }
  await settling.apply(options.metrics);
  // After the acknowledgements: the effects are journaled, and what this fails to send or
  // deliver the effects cron sends once overdue.
  await dispatchEffects(env, dispatching, options);
}

/**
 * The effects an invocation's applied messages left: by read model, those
 * to send to each sink's queue, and those of inline sinks it delivers
 * itself, with the calls set aside for them.
 */
export class Dispatching {
  readonly #models = new Map<
    D1Database,
    { sending: Map<string, string[]>; own: Map<string, string[]>; calls: number; owned: number }
  >();

  of(db: D1Database) {
    let model = this.#models.get(db);
    if (!model) {
      model = { sending: new Map(), own: new Map(), calls: 0, owned: 0 };
      this.#models.set(db, model);
    }
    return model;
  }

  get models() {
    return [...this.#models.entries()];
  }
}

function append(map: Map<string, string[]>, key: string, id: string): void {
  const ids = map.get(key);
  if (ids) ids.push(id);
  else map.set(key, [id]);
}

/**
 * Sends the effects left to send, each sink's in as few messages as their
 * number allows, then delivers the inline ones: a slow delivery holds no
 * send. A failure is logged and counted (`effects.dispatch`), never
 * thrown: the effects are journaled, and the effects cron sends what was
 * left once it is overdue.
 */
export async function dispatchEffects(
  env: Env,
  dispatching: Dispatching,
  options: ConsumerOptions = {},
): Promise<void> {
  const log = createLogger({ op: "effects.dispatch" });
  const now = options.now ?? Date.now;
  let outcome: "ok" | "error" | undefined;
  for (const [db, model] of dispatching.models) {
    const sinks = options.sinks ?? EFFECT_SINKS;
    const publish = options.publish ?? publisher(effectQueues(env), sinks, options.metrics);
    const sent: string[] = [];
    for (const [sink, ids] of model.sending) {
      outcome ??= "ok";
      try {
        await publish(sink, ids);
        sent.push(...ids);
      } catch (error) {
        outcome = "error";
        log.error("sending effects failed", { sink, error });
      }
    }
    if (sent.length > 0) {
      try {
        await markSent(db, sent, now(), options.metrics);
      } catch (error) {
        // Seen as overdue sooner, and sent again (harmless).
        log.warn("marking effects sent failed", { error });
      }
    }
    // One budget for the inline deliveries: what applying the messages set aside for them.
    const budget = {
      calls: model.calls,
      effects: model.owned,
      bytes: EFFECT_POLICY.invocation.bytes,
      deadline: now() + EFFECT_POLICY.invocation.deadlineMs,
      started: true,
    };
    for (const [sink, ids] of model.own) {
      outcome ??= "ok";
      try {
        await deliverEffects(
          {
            db,
            env,
            sinks,
            now,
            publish,
            log,
            ...(options.metrics && { metrics: options.metrics }),
          },
          sink,
          ids,
          budget,
        );
      } catch (error) {
        outcome = "error";
        log.error("dispatching effects failed", { sink, error });
      }
    }
  }
  if (outcome) options.metrics?.count("effects.dispatch", { outcome });
}

/**
 * Applies one envelope to its source's read model. Snapshots are applied
 * with a version guard, so duplicates and any delivery order converge on
 * the newest snapshot of each entity. An account's events (what its access
 * changes mean for activity feeds) project nothing and go to the feed sink
 * only. Throws on a malformed envelope or row.
 */
export async function applyEnvelope(
  env: Env,
  body: unknown,
  options: ConsumerOptions = {},
): Promise<ApplyOutcome> {
  const parsed = parseEnvelope(body);
  if (!parsed.ok) throw new Error(`malformed event envelope: ${parsed.error}`);
  const { sourceId, events } = parsed.envelope;
  const now = options.now?.() ?? Date.now();
  const account = isId(sourceId, "org") || isId(sourceId, "usr");
  if (!account && !isId(sourceId, "rep")) return "dropped";
  const calls = options.calls ?? { left: consumerCalls(env), reserved: 0, applied: false };
  const applying = messageCalls(parsed.envelope);
  // Past what is left of the invocation's calls: a later invocation applies it (one alone always).
  if (calls.applied && applying > calls.left - calls.reserved) return "deferred";
  calls.left -= applying;

  // An account's read model is the deployment's (one organization for now).
  let shard = DEFAULT_ORG_SHARD;
  let indexing = false;
  if (!account) {
    options.metrics?.count("d1.query", { db: "directory", op: "events_route" });
    const listed = await env.DIRECTORY.prepare(
      `SELECT state, org_shard,
         (SELECT value FROM deployment_settings WHERE name = 'search_indexing') AS search
       FROM repos WHERE id = ?`,
    )
      .bind(sourceId)
      .first<{ state: string; org_shard: string; search: string | null }>();
    if (!listed) return "unlisted";
    // Events of a repository being deleted are dropped (purging its rows
    // comes with deletion).
    if (listed.state !== "active") return "dropped";
    shard = listed.org_shard;
    indexing = listed.search === "on";
  }

  const payloads = storedPayloads(env, sourceId);
  const repos = account
    ? { resolved: [], missing: false }
    : await resolveStored(payloads, newestSnapshots(events, REPO_TYPES));
  const snapshots = repos.resolved;
  // The repository's own indexed text is the batch's too.
  const searched = indexing
    ? await resolveChunk(
        payloads,
        newestSnapshots(events, SEARCHED_TYPES),
        snapshots.reduce((n, e) => n + indexedBytes(e.entity.row), 0),
      )
    : undefined;
  const db =
    shard === DEFAULT_ORG_SHARD && options.readModel ? options.readModel : readModelFor(env, shard);
  // The newest epoch any event shows, projected or not: from then on, older
  // epochs are refused.
  const epochGen = Math.max(...events.map((e) => e.id.epochGen));
  const sinks = (options.sinks ?? EFFECT_SINKS).filter(
    (sink) => !account || sink.name === feedSink.name,
  );
  // Sinks see every event whole (stored ones with their row and data).
  const whole = sinks.length > 0 ? await hydrate(payloads, events) : events;
  const plan = planEffects(sinks, whole);
  const allowance = discretionaryAllowance(env);
  const effects = journalStatements(db, sourceId, plan, now, EFFECT_POLICY, allowance);
  // Search's statements, while it indexes (a stored payload gone leaves the repository's own row
  // behind too: its reconciliation covers both).
  const live =
    searched &&
    liveSearch(db, sourceId, searched.resolved, {
      epochGen,
      now,
      missing: repos.missing || searched.missing,
      continued: searched.remaining.length > 0,
    });
  const repoRows = snapshots.flatMap((event) => repoStatements(db, sourceId, event, now, indexing));
  const statements = [
    ...(live?.before ?? []),
    epochStatement(db, sourceId, epochGen, now),
    ...repoRows,
    ...(live?.after ?? []),
    ...effects,
  ];
  calls.applied = true;
  options.metrics?.count("d1.query", { db: "org", op: "events_apply" }, statements.length);
  const results = await db.batch<{ effect_id?: string; sink?: string; admitted?: string }>(
    statements,
  );
  // Search's settlement, and the repository index's (whether or not search indexes: an entry
  // taken out meanwhile is charged too), the batch they are applied in charged with one of them.
  const before = live?.before.length ?? 0;
  const start = before + 1 + repoRows.length;
  const indexed = repoIndexUse(results.slice(before + 1, start), start === results.length);
  const settle = (admitted: boolean) => {
    const search = live
      ? live.settlement(
          results.slice(0, before),
          results.slice(start, start + live.after.length),
          results.at(-1),
          admitted,
        )
      : [];
    return [...search, ...repoIndexStatement(db, indexed, admitted && search.length === 0)];
  };
  if (live || indexed.rows > 0 || indexed.reserved > 0) {
    const settlement = options.settling ? [] : settle(true);
    if (options.settling) options.settling.add(db, settle);
    else if (settlement.length > 0) {
      options.metrics?.count("d1.query", { db: "org", op: "search_settle" });
      await db.batch(settlement);
    }
  }
  const journaled = results.slice(statements.length - effects.length).flatMap((r) => r.results);
  const fresh = journaled.flatMap((row) =>
    row.effect_id !== undefined && row.sink !== undefined
      ? [{ effect_id: row.effect_id, sink: row.sink }]
      : [],
  );
  // Discretionary effects the allowance did not admit are not journaled, and not looked for among
  // the unsent (one an earlier delivery of the envelope journaled is sent by the effects cron once
  // overdue); they are counted (such an earlier one too).
  const admitted = new Set(journaled.flatMap((row) => row.admitted ?? []));
  const refused = allowance ? plan.filter((row) => row.admission && !admitted.has(row.id)) : [];
  for (const row of refused) options.metrics?.count("effects.refused", { sink: row.sink });
  const planned = new Map(plan.filter((row) => !refused.includes(row)).map((row) => [row.id, row]));
  const unsent = await unsentEffects(db, fresh, planned, options.metrics);
  // A share of the inline sinks' effects is delivered by this invocation (a call per recipient, and
  // no queue's wait), within the calls left once the later messages' share is kept and within its
  // recipients' share; the rest go to their sink's queue.
  const inline = options.inline ?? { batched: INLINE_BATCH_EFFECTS };
  inline.recipients ??= INLINE_RECIPIENTS;
  const dispatching = options.dispatching ?? new Dispatching();
  const model = dispatching.of(db);
  const spare = () => Math.max(0, calls.left - calls.reserved);
  for (const row of [...fresh, ...unsent]) {
    const sink = sinks.find((s) => s.name === row.sink);
    const effect = planned.get(row.effect_id);
    const cost = effect?.calls ?? 1;
    // Each inline sink's share costs a message's calls besides its deliveries.
    const extra = model.own.has(row.sink) ? 0 : MESSAGE_CALLS;
    if (
      sink?.inline &&
      effect?.inline !== false &&
      inline.batched > 0 &&
      cost <= inline.recipients &&
      extra + cost <= spare()
    ) {
      append(model.own, row.sink, row.effect_id);
      inline.batched--;
      inline.recipients -= cost;
      model.owned++;
      model.calls += extra + cost;
      calls.left -= extra + cost;
      continue;
    }
    append(model.sending, row.sink, row.effect_id);
  }
  if (!options.dispatching) await dispatchEffects(env, dispatching, options);
  if (searched) await continueSearch(env, sourceId, searched.remaining, options);
  return "applied";
}

/**
 * Sends the rest of an envelope's searched snapshots on, for search alone,
 * before the message they came in is acknowledged (a failure retries it,
 * and its writes stand: their guards make them once).
 */
async function continueSearch(
  env: Env,
  sourceId: string,
  remaining: readonly Snapshot[],
  options: ConsumerOptions,
): Promise<void> {
  if (remaining.length === 0) return;
  const body: SearchContinuation = { type: "search.continue", sourceId, events: remaining };
  await env.EVENTS.send(body, { contentType: "json" });
  options.metrics?.count("queue.send", { queue: "events" });
}

/**
 * Applies a continuation: the next chunk of its snapshots projected for
 * search, while the repository is active and search indexes (else dropped:
 * a reconciliation covers what it carried, asked for when it was sent);
 * the rest sent on.
 */
export async function applyContinuation(
  env: Env,
  body: SearchContinuation,
  options: ConsumerOptions = {},
): Promise<ApplyOutcome> {
  const { sourceId, events } = body;
  if (!isId(sourceId, "rep") || events.some((e) => e.id?.sourceId !== sourceId))
    throw new Error("malformed search continuation");
  const now = options.now?.() ?? Date.now();
  const calls = options.calls ?? { left: consumerCalls(env), reserved: 0, applied: false };
  const applying = messageCalls(body);
  if (calls.applied && applying > calls.left - calls.reserved) return "deferred";
  calls.left -= applying;
  options.metrics?.count("d1.query", { db: "directory", op: "events_route" });
  const listed = await env.DIRECTORY.prepare(
    `SELECT state, org_shard,
       (SELECT value FROM deployment_settings WHERE name = 'search_indexing') AS search
     FROM repos WHERE id = ?`,
  )
    .bind(sourceId)
    .first<{ state: string; org_shard: string; search: string | null }>();
  if (!listed || listed.state !== "active" || listed.search !== "on") return "dropped";
  const db =
    listed.org_shard === DEFAULT_ORG_SHARD && options.readModel
      ? options.readModel
      : readModelFor(env, listed.org_shard);
  const chunk = await resolveChunk(storedPayloads(env, sourceId), events);
  const live = liveSearch(db, sourceId, chunk.resolved, {
    epochGen: Math.max(...events.map((e) => e.id.epochGen)),
    now,
    missing: chunk.missing,
    continued: chunk.remaining.length > 0,
  });
  const statements = [...live.before, ...live.after];
  calls.applied = true;
  options.metrics?.count("d1.query", { db: "org", op: "events_apply" }, statements.length);
  const results = await db.batch(statements);
  const settle = (admitted: boolean) =>
    live.settlement(
      results.slice(0, live.before.length),
      results.slice(live.before.length),
      results.at(-1),
      admitted,
    );
  if (options.settling) options.settling.add(db, settle);
  else {
    const settlement = settle(true);
    if (settlement.length > 0) {
      options.metrics?.count("d1.query", { db: "org", op: "search_settle" });
      await db.batch(settlement);
    }
  }
  await continueSearch(env, sourceId, chunk.remaining, options);
  return "applied";
}

/**
 * Effects of the envelope journaled before and never tried or claimed: a
 * redelivered envelope inserts nothing, and the run that journaled them
 * may have stopped before sending them. Read only when the batch inserted
 * fewer effects than the envelope plans.
 */
async function unsentEffects(
  db: D1Database,
  fresh: readonly { effect_id: string }[],
  planned: Map<string, unknown>,
  metrics?: Metrics,
): Promise<{ effect_id: string; sink: string }[]> {
  if (fresh.length >= planned.size) return [];
  const inserted = new Set(fresh.map((row) => row.effect_id));
  const others = [...planned.keys()].filter((id) => !inserted.has(id));
  metrics?.count("d1.query", { db: "org", op: "effects_unsent" });
  const { results } = await db
    .prepare(
      `SELECT effect_id, sink FROM effects WHERE effect_id IN (SELECT value FROM json_each(?))
         AND state = 'pending' AND attempts = 0 AND lease_until IS NULL`,
    )
    .bind(JSON.stringify(others))
    .all<{ effect_id: string; sink: string }>();
  return results;
}

/**
 * Effects whose message went out: overdue only once a queue's longest
 * expected wait has passed (until then, a lost send is the cron's to see
 * after the journal's shorter grace).
 */
async function markSent(
  db: D1Database,
  ids: readonly string[],
  now: number,
  metrics?: Metrics,
): Promise<void> {
  metrics?.count("d1.query", { db: "org", op: "effects_sent" });
  await db
    .prepare(
      `UPDATE effects SET recover_at = ?2 WHERE effect_id IN (SELECT value FROM json_each(?1))
         AND state = 'pending' AND lease_until IS NULL`,
    )
    .bind(JSON.stringify(ids), now + EFFECT_POLICY.lateMs)
    .run();
}

export type Snapshot = DomainEvent & { entity: EntitySnapshot };

/** Records a source's newest epoch seen; from then on, older epochs are refused. */
export function epochStatement(
  db: D1Database,
  sourceId: string,
  epochGen: number,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO consumer_epochs (source_id, epoch_gen, updated_at) VALUES (?1, ?2, ?3)
       ON CONFLICT (source_id) DO UPDATE SET epoch_gen = excluded.epoch_gen,
         updated_at = excluded.updated_at
       WHERE excluded.epoch_gen > consumer_epochs.epoch_gen`,
    )
    .bind(sourceId, epochGen, now);
}

/** What the repository's own row projects. */
const REPO_TYPES: ReadonlySet<string> = new Set([REPO_ENTITY]);
/** What search projects (`search/live.ts`). */
const SEARCHED_TYPES: ReadonlySet<string> = new Set([
  ISSUE_ENTITY,
  PULL_ENTITY,
  LABEL_ENTITY,
  MILESTONE_ENTITY,
]);

/** The newest snapshot of each entity of `types` in the envelope. */
function newestSnapshots(events: readonly DomainEvent[], types: ReadonlySet<string>): Snapshot[] {
  const newest = new Map<string, Snapshot>();
  for (const event of events) {
    const { entity } = event;
    if (!entity || !types.has(entity.type)) continue;
    const key = `${entity.type}:${entity.id}`;
    const seen = newest.get(key);
    // As the projections' guards order them: by epoch, then ownership (a transfer at one version
    // moves an entity on), then version.
    const later = (a: Snapshot, b: Snapshot) =>
      a.id.epochGen !== b.id.epochGen
        ? a.id.epochGen > b.id.epochGen
        : a.ownerGen !== b.ownerGen
          ? a.ownerGen > b.ownerGen
          : a.entity.version > b.entity.version;
    if (!seen || later(event as Snapshot, seen)) newest.set(key, event as Snapshot);
  }
  return [...newest.values()];
}

/** A stored event's `{ row, data }` by event key, fetched once per envelope; null once gone. */
type Payloads = (event: DomainEvent) => Promise<{ row?: unknown; data?: unknown } | null>;

function storedPayloads(env: Env, sourceId: string): Payloads {
  const fetched = new Map<string, Promise<{ row?: unknown; data?: unknown } | null>>();
  const source = isId(sourceId, "rep") ? env.REPO.getByName(sourceId) : env.ORG.getByName(sourceId);
  return (event) => {
    const key = eventKey(event.id);
    let payload = fetched.get(key);
    if (!payload) {
      payload = source
        .eventPayload(key)
        .then((json) =>
          json === null ? null : (JSON.parse(json) as { row?: unknown; data?: unknown }),
        );
      fetched.set(key, payload);
    }
    return payload;
  };
}

/**
 * The first chunk of `snapshots` (see `SEARCH_CHUNK`) with stored ones'
 * rows filled in, as `resolveStored` fills them, and the rest as they
 * travelled.
 */
async function resolveChunk(
  payloads: Payloads,
  snapshots: readonly Snapshot[],
  /** Text the batch indexes already (its repository's). */
  used = 0,
): Promise<{ resolved: Snapshot[]; missing: boolean; remaining: Snapshot[] }> {
  const resolved: Snapshot[] = [];
  let missing = false;
  let bytes = used;
  let taken = 0;
  for (const event of snapshots) {
    if (taken >= SEARCH_CHUNK.snapshots) break;
    let whole = event;
    if (event.stored && !event.entity.deleted) {
      const payload = await payloads(event);
      if (payload === null) {
        missing = true;
        taken++;
        continue;
      }
      whole = {
        ...event,
        entity: { ...event.entity, row: payload.row as Record<string, unknown> },
      };
    }
    const text = indexedBytes(whole.entity.row);
    // Past the chunk's text: the rest goes on (a snapshot alone is always taken).
    if (taken > 0 && bytes + text > SEARCH_CHUNK.bytes) break;
    bytes += text;
    taken++;
    resolved.push(whole);
  }
  return { resolved, missing, remaining: snapshots.slice(taken) };
}

const textEncoder = new TextEncoder();

/** The bytes of the text a projected row indexes or holds (its title, body, name, description). */
export function indexedBytes(row: Record<string, unknown> | null): number {
  if (!row) return 0;
  let bytes = 0;
  for (const field of ["title", "body", "name", "description"])
    if (typeof row[field] === "string") bytes += textEncoder.encode(row[field] as string).length;
  return bytes;
}

/**
 * Fills in the rows of stored snapshots from the source. A payload already
 * gone (past its retention) leaves the entity to a later snapshot or a
 * reconciliation (`missing`); a payload that is there is used as it is, so
 * a malformed one fails the message.
 */
async function resolveStored(
  payloads: Payloads,
  snapshots: readonly Snapshot[],
): Promise<{ resolved: Snapshot[]; missing: boolean }> {
  const resolved: Snapshot[] = [];
  let missing = false;
  for (const event of snapshots) {
    if (!event.stored || event.entity.deleted) {
      resolved.push(event);
      continue;
    }
    const payload = await payloads(event);
    if (payload === null) {
      missing = true;
      continue;
    }
    resolved.push({
      ...event,
      entity: { ...event.entity, row: payload.row as Record<string, unknown> },
    });
  }
  return { resolved, missing };
}

/**
 * Stored events with their row and data put back, for the sinks; an event
 * whose payload is gone stays as it travelled (`stored`, no data).
 */
async function hydrate(payloads: Payloads, events: readonly DomainEvent[]): Promise<DomainEvent[]> {
  const whole: DomainEvent[] = [];
  for (const event of events) {
    const payload = event.stored ? await payloads(event) : null;
    if (!payload) {
      whole.push(event);
      continue;
    }
    whole.push({
      ...event,
      stored: false,
      entity: event.entity && {
        ...event.entity,
        row: (payload.row ?? null) as Record<string, unknown> | null,
      },
      data: (payload.data ?? null) as Record<string, unknown> | null,
    });
  }
  return whole;
}

/** Statements a repository snapshot writes in (see `repoStatements`), and where its row's is. */
export const REPO_STATEMENTS = 14;
const REPO_ROW = 12;
/** Where its index's reservation is (`RETURNING day` when made). */
const REPO_RESERVED = 1;

/**
 * Rows a repository's index entry reserves of the day's repository index
 * allowance (20 measured for one first indexed, its admission, receipt and
 * settlement included; settled at what it wrote),
 * and repositories the index holds at most (provisional, until search's
 * ranking is measured over it).
 */
export const REPO_INDEX = { rows: 24, capacity: 20_000 };

/**
 * What repository snapshots' groups (`results`, theirs in order) used of
 * the repository index allowance: the rows they wrote for it, all but their
 * rows' own (the read model's; the batch's admission with them when they
 * end the batch, `last`, which the executor counts with its last result, if
 * they wrote any), and what their entries reserved, with its day.
 */
export function repoIndexUse(
  results: readonly D1Result[],
  last: boolean,
): { rows: number; reserved: number; day: number | null } {
  let rows = 0;
  let reserved = 0;
  let day: number | null = null;
  results.forEach((r, i) => {
    if (i % REPO_STATEMENTS !== REPO_ROW) rows += r.meta.rows_written ?? 0;
    const made = i % REPO_STATEMENTS === REPO_RESERVED && r.results[0];
    if (made) {
      reserved += REPO_INDEX.rows;
      // Its receipt's release too, written later by an observation.
      rows += RECEIPT_RELEASE.rows;
      day = (r.results[0] as { day: number }).day;
    }
  });
  // Nothing of their own written: the batch's admission is not theirs either.
  const admission = last && results.length > 0 ? READ_MODEL_ADMISSION.rows : 0;
  if (rows - admission <= 0 && reserved === 0) return { rows: 0, reserved, day };
  return { rows, reserved, day };
}

/** Repository snapshots' groups' results (theirs, in order) of their rows alone. */
export function repoRowsOf(results: readonly D1Result[]): D1Result[] {
  return results.filter((_, i) => i % REPO_STATEMENTS === REPO_ROW);
}

/**
 * Settles what repository groups used of the repository index allowance
 * (see `repoIndexUse`): what they reserved goes back, what they wrote is
 * charged (more than reserved too), with this statement's own row and,
 * when `admitted`, the admission of the batch it is applied in; on the
 * reservation's day, or today. None when they used nothing.
 */
export function repoIndexStatement(
  db: D1Database,
  use: { rows: number; reserved: number; day: number | null },
  admitted = true,
): D1PreparedStatement[] {
  if (use.rows === 0 && use.reserved === 0) return [];
  const rows = use.rows + 1 + (admitted ? READ_MODEL_ADMISSION.rows : 0);
  return [
    db
      .prepare(
        `INSERT INTO search_budget (day, repo_rows) VALUES (coalesce(?1, ${TODAY}), ?2)
         ON CONFLICT (day) DO UPDATE SET repo_rows = max(0, repo_rows - ?3 + ?2)`,
      )
      .bind(use.day, rows, use.reserved),
  ];
}

/**
 * The statements that write one repository snapshot (one batch): its row,
 * written only if its epoch is not older than the source's newest, its
 * ownership generation is current, and it is newer than the row it
 * replaces (by epoch, ownership, version: a transfer at one version moves
 * it), and its repository index entry (name, description and a token of its
 * owner) with it. Every statement takes that decision over the row as it
 * was:
 *
 * 1. its entry's admission, when its live tuple changes while search
 *    indexes: rows of the day's repository index allowance, room in the
 *    index (`REPO_INDEX`) and the growth it may make, its receipt with them
 *    (the receipt is what lets it in); refused, a reconciliation asked for;
 * 2. the repository's and its owner's numbers, allocated when a live tuple
 *    is to be indexed and they have none, and the counters moved past them;
 * 3. the count of indexed repositories, by what the write changes;
 * 4. the old indexed tuple deleted from the index while the row still has
 *    it, when the row is deleted or its tuple changes;
 * 5. its membership: indexed (marked with this group's token) when its
 *    tuple changes and its entry was admitted, kept as it was when only
 *    other fields change, cleared otherwise;
 * 6. the row upserted;
 * 7. the tuple marked with the token indexed.
 *
 * The row is written whether or not search indexes: it is the read model's.
 * With `repairIndex` (a reconciliation's last step), an entry missing from
 * the index is put back too: of a row at the snapshot's own version (as it
 * is), or of a newer one whatever changed.
 */
export function repoStatements(
  db: D1Database,
  sourceId: string,
  event: Snapshot,
  now: number,
  indexing: boolean,
  admit?: Admission,
  repairIndex = false,
): D1PreparedStatement[] {
  const { entity } = event;
  if (entity.id !== sourceId)
    throw new Error(`a repository event for another repository: ${entity.id}`);
  let row: RepoRow | undefined;
  if (!entity.deleted) {
    row = parseRepoRow(entity.row);
    if (!row) throw new Error(`malformed repository row in ${eventKey(event.id)}`);
  } else if (entity.row !== null) {
    // A tombstone a deletion kept (never an event's) carries the row it ended with.
    row = parseRepoRow(entity.row);
  }
  const params = [
    sourceId,
    row?.ownerId ?? null,
    row?.name ?? null,
    row?.visibility ?? null,
    row?.defaultBranch ?? null,
    row?.pushedAt ?? null,
    row?.createdAt ?? null,
    entity.deleted ? 1 : 0,
    event.id.epochGen,
    entity.version,
    event.ownerGen,
    event.id.sourceSeq,
    now,
    row?.description ?? null,
    entity.deleted && row === undefined ? 1 : 0,
    crypto.randomUUID(),
    indexing ? 1 : 0,
    ...(admit?.params ?? []),
  ];
  // ?1–?15 the row's, ?16 this group's token, ?17 whether search indexes, the writer's from ?18.
  const fences = `?9 >= (SELECT epoch_gen FROM consumer_epochs WHERE source_id = ?1)
    AND ?11 >= coalesce((SELECT owner_gen FROM source_owner WHERE source_id = ?1), 0)
    ${admit ? `AND ${admit.where(18)}` : ""}`;
  // The write is taken: the fences hold, and no row is there or it is newer than the row.
  const newer = `${fences} AND NOT EXISTS (SELECT 1 FROM repos r WHERE r.repo_id = ?1
    AND (?9, ?11, ?10) <= (r.epoch_gen, r.owner_gen, r.version))`;
  // Its entry is not in the index (not a member, or a member whose entry is gone).
  const missing = `NOT EXISTS (SELECT 1 FROM search_repo_nums n WHERE n.repo_id = ?1
    AND n.indexed = 1 AND n.fts_token IS NOT NULL AND ${IN_REPO_INDEX()})`;
  // A repair of the entry of the row as it is: at the snapshot's version, live, its tuple the
  // snapshot's, its entry missing.
  const repair = repairIndex
    ? `(${fences} AND ?8 = 0 AND ${missing} AND EXISTS (SELECT 1 FROM repos r
        WHERE r.repo_id = ?1 AND r.deleted = 0 AND (r.epoch_gen, r.owner_gen, r.version) = (?9, ?11, ?10)
          AND r.owner_id IS ?2 AND r.name IS ?3 AND r.description IS ?14))`
    : "0";
  // What the entry's statements go by: the row's write, or a repair of the entry alone.
  const taken = `(${newer} OR ${repair})`;
  // Its indexed tuple changes (an event's tombstone carries no row: its fields stay), or its entry,
  // missing, is put back.
  const changes = `(NOT EXISTS (SELECT 1 FROM repos r WHERE r.repo_id = ?1
    AND r.deleted IS ?8 AND (?8 = 1 OR ?15 = 1 OR (r.name IS ?3 AND r.description IS ?14
      AND r.owner_id IS ?2))) OR ${repair}${repairIndex ? ` OR (${newer} AND ${missing})` : ""})`;
  const member = "coalesce((SELECT indexed FROM search_repo_nums WHERE repo_id = ?1), 0)";
  // Its entry is wanted: a live tuple that changes, while search indexes.
  const wanted = `(?8 = 0 AND ?17 = 1 AND ?2 IS NOT NULL AND ${changes} AND ${taken})`;
  const insert = `(?8 = 0 AND ?2 IS NOT NULL AND ${changes} AND ${ADMITTED(16)})`;
  const bytes = growthOf([row ?? null]);
  const remove = `(${member} = 1 AND (?8 = 1 OR ${changes}))`;
  const after = `(CASE WHEN ${insert} THEN 1 WHEN ${remove} THEN 0 ELSE ${member} END)`;
  return [
    bound(
      db,
      `INSERT INTO search_budget (day) SELECT ${TODAY} WHERE ${wanted}
       ON CONFLICT (day) DO NOTHING`,
      params,
    ),
    bound(
      db,
      `UPDATE search_budget SET repo_rows = repo_rows + ${REPO_INDEX.rows}, admitted = ?16
       WHERE day = ${TODAY} AND ${wanted}
         AND repo_rows + ${REPO_INDEX.rows} <= ${ADMISSION.repoDailyRows}
         AND EXISTS (SELECT 1 FROM search_size
           WHERE id = 1 AND bytes + bytes_reserved + ${bytes} <= ${ADMISSION.maxBytes})
         AND (SELECT indexed_repos FROM search_index_state WHERE id = 1) + 1 - ${member}
           <= ${REPO_INDEX.capacity}
       RETURNING day`,
      params,
    ),
    ...receiptStatements(db, params[15] as string, bytes),
    bound(
      db,
      repairSql(
        { repo: "?1", reason: "'repository_index_refused'", now: "?13" },
        `${wanted} AND NOT ${ADMITTED(16)}`,
      ),
      params,
    ),
    bound(
      db,
      `INSERT INTO search_repo_nums (repo_id, num)
       SELECT ?1, next_repo_num FROM search_index_state
       WHERE id = 1 AND NOT EXISTS (SELECT 1 FROM search_repo_nums WHERE repo_id = ?1)
         AND ${insert} AND ${taken}`,
      params,
    ),
    db
      .prepare(
        `UPDATE search_index_state SET next_repo_num = next_repo_num + 1
       WHERE id = 1 AND EXISTS (SELECT 1 FROM search_repo_nums
         WHERE repo_id = ?1 AND num = search_index_state.next_repo_num)`,
      )
      .bind(sourceId),
    bound(
      db,
      `INSERT INTO search_owner_nums (owner_id, num)
       SELECT ?2, next_owner_num FROM search_index_state
       WHERE id = 1 AND NOT EXISTS (SELECT 1 FROM search_owner_nums WHERE owner_id = ?2)
         AND ${insert} AND ${taken}`,
      params,
    ),
    db
      .prepare(
        `UPDATE search_index_state SET next_owner_num = next_owner_num + 1
       WHERE id = 1 AND EXISTS (SELECT 1 FROM search_owner_nums
         WHERE owner_id = ?1 AND num = search_index_state.next_owner_num)`,
      )
      .bind(row?.ownerId ?? null),
    bound(
      db,
      `UPDATE search_index_state SET indexed_repos = indexed_repos + ${after} - ${member}
       WHERE id = 1 AND ${after} <> ${member} AND ${taken}`,
      params,
    ),
    bound(
      db,
      `INSERT INTO search_repos_fts (search_repos_fts, rowid, name, description, owner)
       SELECT 'delete', n.num, r.name, r.description, 'o' || o.num
       FROM repos r JOIN search_repo_nums n ON n.repo_id = r.repo_id
       JOIN search_owner_nums o ON o.owner_id = r.owner_id
       WHERE r.repo_id = ?1 AND n.indexed = 1 AND ${IN_REPO_INDEX()} AND ${remove} AND ${taken}`,
      params,
    ),
    bound(
      db,
      `UPDATE search_repo_nums SET
         fts_token = CASE WHEN ${insert} THEN ?16 WHEN ${after} = 1 THEN fts_token END,
         indexed_epoch = CASE WHEN ${after} = 1 THEN ?9 END,
         indexed_owner_gen = CASE WHEN ${after} = 1 THEN ?11 END,
         indexed_version = CASE WHEN ${after} = 1 THEN ?10 END,
         indexed = ${after}
       WHERE repo_id = ?1 AND ${taken}`,
      params,
    ),
    bound(
      db,
      `INSERT INTO repos (repo_id, owner_id, name, visibility, default_branch, pushed_at, created_at,
         deleted, epoch_gen, version, owner_gen, updated_seq, updated_at, description)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14
       WHERE ${fences}
       -- An event's tombstone carries no row: the row's fields stay as they were.
       ON CONFLICT (repo_id) DO UPDATE SET
         owner_id = CASE WHEN ?15 = 1 THEN repos.owner_id ELSE excluded.owner_id END,
         name = CASE WHEN ?15 = 1 THEN repos.name ELSE excluded.name END,
         visibility = CASE WHEN ?15 = 1 THEN repos.visibility ELSE excluded.visibility END,
         default_branch = CASE WHEN ?15 = 1 THEN repos.default_branch
           ELSE excluded.default_branch END,
         pushed_at = CASE WHEN ?15 = 1 THEN repos.pushed_at ELSE excluded.pushed_at END,
         created_at = CASE WHEN ?15 = 1 THEN repos.created_at ELSE excluded.created_at END,
         description = CASE WHEN ?15 = 1 THEN repos.description
           ELSE excluded.description END,
         deleted = excluded.deleted,
         epoch_gen = excluded.epoch_gen,
         version = excluded.version,
         owner_gen = excluded.owner_gen,
         updated_seq = excluded.updated_seq,
         updated_at = excluded.updated_at
       WHERE (excluded.epoch_gen, excluded.owner_gen, excluded.version)
         > (repos.epoch_gen, repos.owner_gen, repos.version)`,
      params,
    ),
    bound(
      db,
      `INSERT INTO search_repos_fts (rowid, name, description, owner)
       SELECT n.num, r.name, r.description, 'o' || o.num
       FROM repos r JOIN search_repo_nums n ON n.repo_id = r.repo_id
       JOIN search_owner_nums o ON o.owner_id = r.owner_id
       WHERE r.repo_id = ?1 AND r.deleted = 0 AND n.indexed = 1 AND n.fts_token = ?16`,
      params,
    ),
  ];
}

/**
 * A further condition a writer puts on a read-model statement: SQL over
 * parameters numbered from the one it is given, and their values.
 */
export interface Admission {
  where(first: number): string;
  readonly params: readonly (string | number | null)[];
}
