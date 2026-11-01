import { createLogger, type Metrics } from "@fyrden/adapters-cloudflare/obs";
import { isId, MAX_ENVELOPE_EVENTS, safeParseEnvelope } from "@fyrden/domain";
import { DEFAULT_ORG_SHARD, readModelFor } from "../events/read-model.js";
import { repairStatement } from "../search/repairs.js";
import { isWaiting } from "./events-consumer.js";

/*
 * The events dead-letter queue: envelopes the events consumer gave up on
 * after its retries. Each is stored (`events_failed`) before its dead
 * letter is acknowledged. A repository's also asks for that repository's
 * search projections to be reconciled (in the same batch); an account's
 * waits for an operator to replay it; one that cannot be read is
 * quarantined with why. For a repository whose deletion is in the read
 * model only the record is kept (its rows are being purged).
 */

export const EVENTS_DLQ = "fyrden-events-dlq";

const encoder = new TextEncoder();

/** Proposed values. */
export const FAILED_POLICY = {
  /** How long a failed envelope is kept (its record of the failure stays after). */
  keepMs: 14 * 24 * 60 * 60_000,
  /**
   * The largest envelope kept, as JSON (D1 holds 2,000,000 bytes a row; a
   * queue message's size does not bound its JSON).
   */
  maxEnvelopeBytes: 1_900_000,
  /** Envelopes dropped a maintenance run, once expired. */
  prunePage: 200,
};

export type FailedKind = "repository" | "account" | "malformed";

/** Stores each dead letter, then acknowledges it; one that cannot be stored is retried. */
export async function consumeFailedEvents(
  batch: MessageBatch<unknown>,
  env: Env,
  options: { now?: () => number; metrics?: Metrics } = {},
): Promise<void> {
  const log = createLogger({ op: "events.dead_letters" });
  const db = readModelFor(env, DEFAULT_ORG_SHARD);
  for (const message of batch.messages) {
    try {
      const now = options.now?.() ?? Date.now();
      let built: ReturnType<typeof failedStatements>;
      try {
        built = failedStatements(db, message.id, message.body, now);
      } catch {
        // Reading it failed in a way not foreseen: its record without anything of it, rather
        // than retries that would lose it.
        built = unreadable(db, message.id, now);
      }
      const { kind, statements } = built;
      options.metrics?.count("d1.query", { db: "org", op: "events_failed" });
      await db.batch(statements);
      options.metrics?.count("events.failed", { kind });
      message.ack();
    } catch (error) {
      log.error("storing a failed envelope failed", { error, messageId: message.id });
      message.retry();
    }
  }
}

/**
 * The UTF-8 bytes `value` takes as JSON (as `JSON.stringify` writes it),
 * counted part by part and stopped as soon as they pass `max`;
 * `unserializable` for what JSON cannot hold (a BigInt, a cycle). The
 * properties and items it reads are bounded by `max` too (`too_large`
 * past it): ones JSON leaves out cost no bytes, but a part shared many
 * times over is read at each place it appears.
 */
export function jsonBytes(
  value: unknown,
  max: number,
): number | "too_large" | "too_deep" | "unserializable" {
  let total = 0;
  let reads = 0;
  const read = () => {
    if (++reads > max) throw TOO_LARGE;
  };
  const ancestors = new Set<object>();
  const add = (bytes: number) => {
    total += bytes;
    if (total > max) throw TOO_LARGE;
  };
  // What `JSON.stringify` writes in a value's place: its `toJSON` (a Date's), a boxed
  // primitive unboxed (a boxed BigInt it cannot write).
  const convert = (v: unknown, key: string): unknown => {
    if ((typeof v === "object" && v !== null) || typeof v === "bigint") {
      const toJSON = (v as { toJSON?: unknown }).toJSON;
      if (typeof toJSON === "function") v = toJSON.call(v, key);
    }
    if (typeof v === "object" && v !== null)
      switch (Object.prototype.toString.call(v)) {
        case "[object Number]":
          return Number(v);
        case "[object String]":
          return String(v);
        case "[object Boolean]":
          return (v as { valueOf(): boolean }).valueOf();
        case "[object BigInt]":
          throw UNSERIALIZABLE;
      }
    return v;
  };
  const omitted = (v: unknown) =>
    v === undefined || typeof v === "function" || typeof v === "symbol";
  const walk = (v: unknown, depth: number): void => {
    if (typeof v === "bigint") throw UNSERIALIZABLE;
    if (v === null || typeof v !== "object") {
      add(encoder.encode(JSON.stringify(v)).length);
      return;
    }
    if (ancestors.has(v)) throw UNSERIALIZABLE;
    // Nesting is bounded too (the walk, as JSON.stringify, recurses).
    if (depth >= MAX_DEPTH) throw TOO_DEEP;
    ancestors.add(v);
    if (Array.isArray(v)) {
      add(2 + Math.max(0, v.length - 1));
      for (let i = 0; i < v.length; i++) {
        read();
        const item = convert(v[i], String(i));
        // Written as null in an array.
        if (omitted(item)) add(4);
        else walk(item, depth + 1);
      }
    } else {
      add(2);
      let first = true;
      for (const [key, raw] of Object.entries(v)) {
        read();
        const item = convert(raw, key);
        // Left out of an object.
        if (omitted(item)) continue;
        add((first ? 0 : 1) + encoder.encode(JSON.stringify(key)).length + 1);
        first = false;
        walk(item, depth + 1);
      }
    }
    ancestors.delete(v);
  };
  try {
    const top = convert(value, "");
    if (omitted(top)) return "unserializable";
    walk(top, 0);
    return total;
  } catch (error) {
    if (error === TOO_LARGE) return "too_large";
    if (error === TOO_DEEP) return "too_deep";
    if (error === UNSERIALIZABLE) return "unserializable";
    throw error;
  }
}

const TOO_LARGE = Symbol("too large");
const TOO_DEEP = Symbol("too deep");

/** Nesting an envelope is read to, at most (an outbox envelope's is a handful of levels). */
const MAX_DEPTH = 64;
const UNSERIALIZABLE = Symbol("unserializable");

/**
 * Its events' positions and types, read without validating them, when its
 * `events` is a short array of events that say them plainly.
 */
function cheapEvents(
  value: unknown,
): { epoch: number | null; first: number; last: number; types: string } | undefined {
  const events = (value as { events?: unknown } | null)?.events;
  if (!Array.isArray(events) || events.length === 0 || events.length > MAX_ENVELOPE_EVENTS)
    return undefined;
  const seqs: number[] = [];
  const types = new Set<string>();
  let epoch: number | null = null;
  for (const item of events) {
    const event = item as { id?: { epochGen?: unknown; sourceSeq?: unknown }; type?: unknown };
    if (!Number.isSafeInteger(event?.id?.sourceSeq) || typeof event?.type !== "string")
      return undefined;
    seqs.push(event.id?.sourceSeq as number);
    // Only what an event type looks like (never other text: the record outlives the envelope).
    if (EVENT_TYPE.test(event.type)) types.add(event.type);
    if (epoch === null && Number.isSafeInteger(event.id?.epochGen))
      epoch = event.id?.epochGen as number;
  }
  return {
    epoch,
    first: Math.min(...seqs),
    last: Math.max(...seqs),
    types: JSON.stringify([...types]),
  };
}

/** An event type's form (as the envelope schema has it), at most 64 characters. */
const EVENT_TYPE = /^(?=.{1,64}$)[a-z][a-z_]*(\.[a-z][a-z_]*)*$/;

/** A dead letter's source id, when it names a repository's or an account's plainly. */
function sourceOf(value: unknown): string | null {
  const id = (value as { sourceId?: unknown } | null)?.sourceId;
  return typeof id === "string" && (isId(id, "rep") || isId(id, "org") || isId(id, "usr"))
    ? id
    : null;
}

/** The record of a dead letter nothing could be read of. */
function unreadable(db: D1Database, id: string, now: number): ReturnType<typeof failedStatements> {
  return {
    kind: "malformed",
    statements: [
      insert(db, {
        id,
        source: null,
        kind: "malformed",
        raw: null,
        reason: "unreadable",
        now,
        expires: now + FAILED_POLICY.keepMs,
      }),
    ],
  };
}

/** The statements that store one dead letter (and ask for its repository's repair). */
export function failedStatements(
  db: D1Database,
  id: string,
  body: unknown,
  now: number,
): { kind: FailedKind; statements: D1PreparedStatement[] } {
  const value = isWaiting(body) ? body.envelope : body;
  // The envelope as JSON, when JSON can hold it and a row can too; else why not. Measured
  // first, stopping at the bound: shared parts of a small message can make huge JSON.
  const size = jsonBytes(value, FAILED_POLICY.maxEnvelopeBytes);
  let unkept: string | null =
    size === "unserializable"
      ? size
      : size === "too_large"
        ? "envelope_too_large"
        : size === "too_deep"
          ? "envelope_too_deep"
          : null;
  let raw: string | null = null;
  if (unkept === null) {
    // The measure follows JSON.stringify; what it may still miss is caught here.
    try {
      raw = JSON.stringify(value) ?? null;
    } catch {
      unkept = "unserializable";
    }
    if (raw !== null && encoder.encode(raw).length > FAILED_POLICY.maxEnvelopeBytes) {
      raw = null;
      unkept = "envelope_too_large";
    }
  }
  const expires = now + FAILED_POLICY.keepMs;
  if (typeof size !== "number") {
    // Not read further: an envelope past the bound (or that JSON cannot hold) may be far
    // larger to walk than its message, sparse arrays included. Kept by the source it names,
    // with what can be read of its events cheaply.
    const source = sourceOf(value);
    const kind: FailedKind =
      source === null ? "malformed" : isId(source, "rep") ? "repository" : "account";
    const events = cheapEvents(value);
    const record = insert(db, {
      id,
      source,
      kind,
      raw: null,
      reason: unkept,
      now,
      expires,
      ...(events && {
        epoch: events.epoch,
        first: events.first,
        last: events.last,
        types: events.types,
      }),
    });
    return {
      kind,
      statements:
        source !== null && isId(source, "rep")
          ? [record, repairStatement(db, source, "events_failed", now)]
          : [record],
    };
  }
  const parsed = safeParseEnvelope(value);
  if (!parsed.success) {
    // The source it names, when it names one plainly: a deleted repository's is fenced and
    // purged as any other, and a repository's asks for its repair too.
    const source = sourceOf(value);
    const record = insert(db, {
      id,
      source,
      kind: "malformed",
      raw,
      // What was wrong, by kind only: never text from the envelope (it outlives the envelope).
      reason: [unkept, ...new Set(parsed.error.issues.map((issue) => issue.code))]
        .filter((r) => r !== null)
        .join(", "),
      now,
      expires,
    });
    return {
      kind: "malformed",
      statements:
        source !== null && isId(source, "rep")
          ? [record, repairStatement(db, source, "events_failed", now)]
          : [record],
    };
  }
  const envelope = parsed.data;
  const kind: FailedKind = isId(envelope.sourceId, "rep") ? "repository" : "account";
  const seqs = envelope.events.map((e) => e.id.sourceSeq);
  const record = insert(db, {
    id,
    source: envelope.sourceId,
    kind,
    raw,
    reason: unkept,
    now,
    expires,
    epoch: envelope.events[0]?.id.epochGen ?? null,
    first: Math.min(...seqs),
    last: Math.max(...seqs),
    types: JSON.stringify([...new Set(envelope.events.map((e) => e.type))]),
  });
  return {
    kind,
    statements:
      kind === "repository"
        ? [record, repairStatement(db, envelope.sourceId, "events_failed", now)]
        : [record],
  };
}

function insert(
  db: D1Database,
  row: {
    id: string;
    source: string | null;
    kind: FailedKind;
    raw: string | null;
    reason: string | null;
    now: number;
    expires: number;
    epoch?: number | null;
    first?: number;
    last?: number;
    types?: string;
  },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO events_failed (id, source_id, kind, epoch_gen, first_seq, last_seq, types,
         envelope, reason, at, expires_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7,
         -- A deleted repository's envelope is not kept (its rows are being purged).
         CASE WHEN EXISTS (SELECT 1 FROM repos WHERE repo_id = ?2 AND deleted = 1) THEN NULL
           ELSE ?8 END,
         ?9, ?10, ?11)
       ON CONFLICT (id) DO NOTHING`,
    )
    .bind(
      row.id,
      row.source,
      row.kind,
      row.epoch ?? null,
      row.first ?? null,
      row.last ?? null,
      row.types ?? null,
      row.raw,
      row.reason,
      row.now,
      row.expires,
    );
}

/**
 * Drops the envelopes of failures kept their time (their records stay), a
 * page a maintenance run.
 */
export async function pruneFailedEvents(
  env: Env,
  options: { now: number; metrics?: Metrics },
): Promise<number> {
  options.metrics?.count("d1.query", { db: "org", op: "events_failed_prune" });
  const { meta } = await readModelFor(env, DEFAULT_ORG_SHARD)
    .prepare(
      `UPDATE events_failed SET envelope = NULL WHERE id IN (SELECT id FROM events_failed
         WHERE envelope IS NOT NULL AND expires_at <= ? ORDER BY expires_at LIMIT ?)`,
    )
    .bind(options.now, FAILED_POLICY.prunePage)
    .run();
  return meta.changes;
}
