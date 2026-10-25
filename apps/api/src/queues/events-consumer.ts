import { createLogger, type Metrics } from "@fyrden/adapters-cloudflare/obs";
import {
  compareVersion,
  type DomainEvent,
  type EntitySnapshot,
  eventKey,
  isId,
  parseEnvelope,
  parseRepoRow,
  REPO_ENTITY,
  type RepoRow,
} from "@fyrden/domain";
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
 * consumer invocation makes at most: Free allows 1,000 an invocation, D1
 * queries included (a batch counts once; measured, see
 * docs/operations/limits.md); some are left for the rest. Proposed.
 */
export const INVOCATION_CALLS = 900;
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
  const log = createLogger({ op: "events.consume" });
  // One share of inline deliveries and of calls for the whole invocation.
  options = {
    ...options,
    inline: options.inline ?? { batched: INLINE_BATCH_EFFECTS, recipients: INLINE_RECIPIENTS },
    calls: options.calls ?? {
      left: INVOCATION_CALLS - DISPATCH_CALLS,
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
  options = { ...options, dispatching };
  for (const [i, message] of batch.messages.entries()) {
    try {
      const waiting = isWaiting(message.body) ? message.body : undefined;
      const envelope = envelopes[i];
      if (options.calls) options.calls.reserved = needs.slice(i + 1).reduce((a, b) => a + b, 0);
      const outcome = await applyEnvelope(env, envelope, options);
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
  const calls = options.calls ?? { left: INVOCATION_CALLS, reserved: 0, applied: false };
  const applying = messageCalls(parsed.envelope);
  // Past what is left of the invocation's calls: a later invocation applies it (one alone always).
  if (calls.applied && applying > calls.left - calls.reserved) return "deferred";
  calls.left -= applying;

  // An account's read model is the deployment's (one organization for now).
  let shard = DEFAULT_ORG_SHARD;
  if (!account) {
    options.metrics?.count("d1.query", { db: "directory", op: "events_route" });
    const listed = await env.DIRECTORY.prepare("SELECT state, org_shard FROM repos WHERE id = ?")
      .bind(sourceId)
      .first<{ state: string; org_shard: string }>();
    if (!listed) return "unlisted";
    // Events of a repository being deleted are dropped (purging its rows
    // comes with deletion).
    if (listed.state !== "active") return "dropped";
    shard = listed.org_shard;
  }

  const payloads = storedPayloads(env, sourceId);
  const snapshots = account ? [] : await resolveStored(payloads, newestSnapshots(events));
  const db = readModelFor(env, shard);
  // The newest epoch any event shows, projected or not: from then on, older
  // epochs are refused.
  const epochGen = Math.max(...events.map((e) => e.id.epochGen));
  const sinks = (options.sinks ?? EFFECT_SINKS).filter(
    (sink) => !account || sink.name === feedSink.name,
  );
  // Sinks see every event whole (stored ones with their row and data).
  const whole = sinks.length > 0 ? await hydrate(payloads, events) : events;
  const plan = planEffects(sinks, whole);
  const effects = journalStatements(db, sourceId, plan, now);
  const statements = [
    epochStatement(db, sourceId, epochGen, now),
    ...snapshots.map((event) => repoStatement(db, sourceId, event, now)),
    ...effects,
  ];
  calls.applied = true;
  options.metrics?.count("d1.query", { db: "org", op: "events_apply" }, statements.length);
  const results = await db.batch<{ effect_id: string; sink: string }>(statements);
  const fresh = results
    .slice(statements.length - effects.length)
    .flatMap((result) => result.results);
  const planned = new Map(plan.map((row) => [row.id, row]));
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

/** The newest snapshot of each entity in the envelope (activity events have no projection yet). */
function newestSnapshots(events: readonly DomainEvent[]): Snapshot[] {
  const newest = new Map<string, Snapshot>();
  for (const event of events) {
    const { entity } = event;
    if (!entity || entity.type !== REPO_ENTITY) continue;
    const key = `${entity.type}:${entity.id}`;
    const seen = newest.get(key);
    const position = (e: Snapshot) => ({ epochGen: e.id.epochGen, version: e.entity.version });
    if (!seen || compareVersion(position(event as Snapshot), position(seen)) > 0)
      newest.set(key, event as Snapshot);
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
 * Fills in the rows of stored snapshots from the source. A payload already
 * gone (past its retention) leaves the entity to a later snapshot or a
 * rebuild; a payload that is there is used as it is, so a malformed one
 * fails the message.
 */
async function resolveStored(
  payloads: Payloads,
  snapshots: readonly Snapshot[],
): Promise<Snapshot[]> {
  const resolved: Snapshot[] = [];
  for (const event of snapshots) {
    if (!event.stored || event.entity.deleted) {
      resolved.push(event);
      continue;
    }
    const payload = await payloads(event);
    if (payload === null) continue;
    resolved.push({
      ...event,
      entity: { ...event.entity, row: payload.row as Record<string, unknown> },
    });
  }
  return resolved;
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

/**
 * The guarded upsert of one repository snapshot: written only if its epoch
 * is not older than the source's newest, its ownership generation is
 * current, and it is newer than the row it replaces.
 */
export function repoStatement(
  db: D1Database,
  sourceId: string,
  event: Snapshot,
  now: number,
  admit?: Admission,
): D1PreparedStatement {
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
  return db
    .prepare(
      `INSERT INTO repos (repo_id, owner_id, name, visibility, default_branch, pushed_at, created_at,
         deleted, epoch_gen, version, owner_gen, updated_seq, updated_at, description)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14
       WHERE ?9 >= (SELECT epoch_gen FROM consumer_epochs WHERE source_id = ?1)
         AND ?11 >= coalesce((SELECT owner_gen FROM source_owner WHERE source_id = ?1), 0)
         ${admit ? `AND ${admit.where(16)}` : ""}
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
       WHERE (excluded.epoch_gen, excluded.version) > (repos.epoch_gen, repos.version)`,
    )
    .bind(
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
      ...(admit?.params ?? []),
    );
}

/**
 * A further condition a writer puts on a read-model statement: SQL over
 * parameters numbered from the one it is given, and their values.
 */
export interface Admission {
  where(first: number): string;
  readonly params: readonly (string | number | null)[];
}
