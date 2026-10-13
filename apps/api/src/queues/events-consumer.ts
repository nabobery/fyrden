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
import { readModelFor } from "../events/read-model.js";

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

function isWaiting(body: unknown): body is WaitingMessage {
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
export type ApplyOutcome = "applied" | "dropped" | "unlisted";

export interface ConsumerOptions {
  readonly now?: () => number;
  readonly metrics?: Metrics;
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
  for (const message of batch.messages) {
    try {
      const waiting = isWaiting(message.body) ? message.body : undefined;
      const envelope = waiting ? waiting.envelope : message.body;
      const outcome = await applyEnvelope(env, envelope, options);
      if (outcome === "unlisted") {
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
}

/**
 * Applies one envelope to its source's read model. Snapshots are applied
 * with a version guard, so duplicates and any delivery order converge on
 * the newest snapshot of each entity. Throws on a malformed envelope or row.
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
  // Only repositories produce events so far.
  if (!isId(sourceId, "rep")) return "dropped";

  options.metrics?.count("d1.query", { db: "directory", op: "events_route" });
  const listed = await env.DIRECTORY.prepare("SELECT state, org_shard FROM repos WHERE id = ?")
    .bind(sourceId)
    .first<{ state: string; org_shard: string }>();
  if (!listed) return "unlisted";
  // Events of a repository being deleted are dropped (purging its rows
  // comes with deletion).
  if (listed.state !== "active") return "dropped";

  const snapshots = await resolveStored(env, sourceId, newestSnapshots(events));
  const db = readModelFor(env, listed.org_shard);
  // The newest epoch any event shows, projected or not: from then on, older
  // epochs are refused.
  const epochGen = Math.max(...events.map((e) => e.id.epochGen));
  const statements = [
    db
      .prepare(
        `INSERT INTO consumer_epochs (source_id, epoch_gen, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT (source_id) DO UPDATE SET epoch_gen = excluded.epoch_gen,
           updated_at = excluded.updated_at
         WHERE excluded.epoch_gen > consumer_epochs.epoch_gen`,
      )
      .bind(sourceId, epochGen, now),
    ...snapshots.map((event) => repoStatement(db, sourceId, event, now)),
  ];
  options.metrics?.count("d1.query", { db: "org", op: "events_apply" }, statements.length);
  await db.batch(statements);
  return "applied";
}

type Snapshot = DomainEvent & { entity: EntitySnapshot };

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

/**
 * Fills in the rows of stored snapshots from the source. A payload already
 * gone (past its retention) leaves the entity to a later snapshot or a
 * rebuild; a payload that is there is used as it is, so a malformed one
 * fails the message.
 */
async function resolveStored(
  env: Env,
  sourceId: string,
  snapshots: readonly Snapshot[],
): Promise<Snapshot[]> {
  const resolved: Snapshot[] = [];
  for (const event of snapshots) {
    if (!event.stored || event.entity.deleted) {
      resolved.push(event);
      continue;
    }
    const payload = await env.REPO.getByName(sourceId).eventPayload(eventKey(event.id));
    if (payload === null) continue;
    const { row } = JSON.parse(payload) as { row?: unknown };
    resolved.push({ ...event, entity: { ...event.entity, row: row as Record<string, unknown> } });
  }
  return resolved;
}

/**
 * The guarded upsert of one repository snapshot: written only if its epoch
 * is not older than the source's newest, its ownership generation is
 * current, and it is newer than the row it replaces.
 */
function repoStatement(
  db: D1Database,
  sourceId: string,
  event: Snapshot,
  now: number,
): D1PreparedStatement {
  const { entity } = event;
  if (entity.id !== sourceId)
    throw new Error(`a repository event for another repository: ${entity.id}`);
  let row: RepoRow | undefined;
  if (!entity.deleted) {
    row = parseRepoRow(entity.row);
    if (!row) throw new Error(`malformed repository row in ${eventKey(event.id)}`);
  }
  return db
    .prepare(
      `INSERT INTO repos (repo_id, owner_id, name, visibility, default_branch, pushed_at, created_at,
         deleted, epoch_gen, version, owner_gen, updated_seq, updated_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13
       WHERE ?9 >= (SELECT epoch_gen FROM consumer_epochs WHERE source_id = ?1)
         AND ?11 >= coalesce((SELECT owner_gen FROM source_owner WHERE source_id = ?1), 0)
       ON CONFLICT (repo_id) DO UPDATE SET
         owner_id = CASE WHEN excluded.deleted = 1 THEN repos.owner_id ELSE excluded.owner_id END,
         name = CASE WHEN excluded.deleted = 1 THEN repos.name ELSE excluded.name END,
         visibility = CASE WHEN excluded.deleted = 1 THEN repos.visibility ELSE excluded.visibility END,
         default_branch = CASE WHEN excluded.deleted = 1 THEN repos.default_branch
           ELSE excluded.default_branch END,
         pushed_at = CASE WHEN excluded.deleted = 1 THEN repos.pushed_at ELSE excluded.pushed_at END,
         created_at = CASE WHEN excluded.deleted = 1 THEN repos.created_at ELSE excluded.created_at END,
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
    );
}
