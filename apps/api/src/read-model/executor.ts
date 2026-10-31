import { rawReadModel } from "../events/read-model.js";

/*
 * The read model's one way to write (org migrations 0017 and 0018,
 * directory 0034 and 0036).
 * A writer holds a lease in the directory, under the shard's barrier
 * generation, with an absolute deadline; every write batch it sends starts
 * with a statement that opens admission only if the read model's barrier is
 * running at that generation, this executor's protocol is admitted and the
 * lease's deadline has not passed (else the statement fails the whole
 * batch), and ends with one that closes it, in the same transaction. A
 * maintenance pause advances the generation, so a writer of an older one
 * writes nothing more, and waits for its live leases to end.
 *
 * Code receives a database whose batches, and whose statements that write,
 * go through the writer (`withReadModel`); reads go to the database as
 * they are. A lease is taken at the first write and released when the work
 * ends. The read model's triggers refuse any write outside an admission
 * (org migration 0018). The barrier's controller writes as a maintenance
 * writer: under the directory's barrier while it is not running, at the
 * generation the controller decided on (see `WriterOptions.maintenance`).
 */

/** The executor's protocol, carried in every admission (2: writes outside admission refused). */
export const READ_MODEL_PROTOCOL = 2;

/**
 * What admitting a write batch costs, besides its statements: its opening and
 * closing (measured; pinned by the executor's tests). Bookkeeping that is a
 * batch of its own counts it once.
 */
export const READ_MODEL_ADMISSION = { rows: 2, reads: 6 } as const;

/**
 * Rows a lease writes in the directory (its row and its drain index
 * entry): taken and released, and each renewal. Measured; pinned by the
 * executor's tests.
 */
export const READ_MODEL_LEASE = { rows: 3, renewal: 2 } as const;

/**
 * What a batch written under a lease of its own (the shared read model's,
 * `readModelFor`) costs besides its statements: its admission's rows and
 * reads, and its lease's rows in the directory.
 */
export const READ_MODEL_LONE_WRITE = {
  rows: READ_MODEL_ADMISSION.rows + READ_MODEL_LEASE.rows,
  reads: READ_MODEL_ADMISSION.reads,
} as const;

/**
 * What recording a writer's size observation costs (its one row and the
 * reads of its update, its guard's included, and of the look for growth it
 * releases, measured with none to release; and the write's admission):
 * once a piece of work. A release's own rows are charged with the batches
 * whose growth it releases (`RECEIPT_RELEASE_ROWS`).
 */
export const READ_MODEL_OBSERVATION = {
  rows: 1 + READ_MODEL_ADMISSION.rows,
  reads: 9 + READ_MODEL_ADMISSION.reads,
} as const;

/** Receipts one observation releases at most (the oldest first). */
export const RELEASE_LIMIT = 100;

/**
 * Releases the growth reserved by batches an observation of the database's
 * size now covers (their sequences at or before the one held): their bytes
 * are in the size observed. In the observation's own write, after it; the
 * oldest `RELEASE_LIMIT` at most (the next observation releases more).
 */
export function releaseStatements(db: D1Database): D1PreparedStatement[] {
  const covered = `SELECT token FROM search_byte_reservations
    WHERE sequence <= (SELECT observed FROM search_size WHERE id = 1)
    ORDER BY sequence, token LIMIT ${RELEASE_LIMIT}`;
  return [
    db.prepare(
      `UPDATE search_size SET bytes_reserved = bytes_reserved - (
         SELECT sum(bytes) FROM search_byte_reservations WHERE token IN (${covered}))
       WHERE id = 1 AND EXISTS (${covered})`,
    ),
    db.prepare(`DELETE FROM search_byte_reservations WHERE token IN (${covered})`),
  ];
}

/** A lease's life; a writer renews it once less than half is left. */
export const READ_MODEL_LEASE_MS = 900_000;

const NOW = "CAST(unixepoch('subsec') * 1000 AS INTEGER)";

export interface ReadModelLease {
  readonly id: string;
  readonly shard: string;
  readonly generation: number;
  readonly protocolVersion: number;
  readonly until: number;
}

/** A write the barrier or the lease refused: nothing of it was written. */
export class ReadModelRefused extends Error {
  constructor(readonly reason: "barrier" | "lease") {
    super(
      reason === "barrier"
        ? "the read model is not taking writes (maintenance)"
        : "this writer's lease ended",
    );
    this.name = "ReadModelRefused";
  }
}

export interface ReadModelWrite<T> {
  /** The caller's statements' results, in their order. */
  readonly results: D1Result<T>[];
  /** The commit's place in the read model's write order. */
  readonly sequence: number;
  /** Rows of the whole batch, admission included; the database's size after it. */
  readonly usage: {
    readonly rowsRead: number;
    readonly rowsWritten: number;
    readonly bytes?: number;
  };
}

export interface WriteOptions {
  /** The reservation's UTC day: refused on another of the database's days. */
  readonly reservationDay?: number;
  /** Whether its size after counts as an observation (not for the observation's own write). */
  readonly observe?: boolean;
}

export interface WriterOptions {
  readonly leasePerWrite?: boolean;
  readonly renews?: boolean;
  /**
   * The barrier's controller only (read-model/maintenance.ts): a writer
   * whose every write takes a lease of its own, never renewed, while the
   * directory's barrier is not running and still at `generation` (else
   * refused: another step moved it). Its admission opens while the read
   * model's barrier is at that generation or an older one (a step moving it
   * there in the same batch), and its writes then hold only once the
   * barrier is at that generation and not running.
   */
  readonly maintenance?: { readonly generation: number };
}

/** One piece of work's writer: its lease, taken at its first write. */
export class ReadModelWriter {
  #lease: ReadModelLease | null = null;
  /** When (on this isolate's clock) the lease was taken or last renewed: its age decides renewal. */
  #leasedAt = 0;
  #ended = false;
  /** The lease being taken or renewed: concurrent writes wait for the one. */
  #pending: Promise<ReadModelLease> | null = null;
  /** Writes under way: a release waits for them before its lease goes. */
  readonly #writing = new Set<Promise<unknown>>();
  #directoryWritten = 0;
  #observed: { sequence: number; bytes: number } | null = null;
  /** The sequence of the observation last recorded. */
  #flushed = 0;
  readonly #directory: D1Database;
  readonly #org: D1Database;
  readonly #shard: string;
  readonly #now: () => number;
  /** Each write under a lease of its own, released after it (work that writes rarely). */
  readonly #leasePerWrite: boolean;
  /**
   * Whether its lease is renewed; if not, its writes are refused once the
   * lease's deadline passes (work bounded in calls and rows, as repairs are).
   */
  readonly #renews: boolean;
  readonly #maintenance: { readonly generation: number } | null;

  constructor(
    env: Pick<Env, "DIRECTORY" | "ORG_READ">,
    shard: string,
    now: () => number = Date.now,
    options: WriterOptions = {},
  ) {
    this.#directory = env.DIRECTORY;
    this.#org = rawReadModel(env, shard);
    this.#shard = shard;
    this.#now = now;
    this.#maintenance = options.maintenance ?? null;
    this.#leasePerWrite = this.#maintenance !== null || (options.leasePerWrite ?? false);
    this.#renews = this.#maintenance === null && (options.renews ?? true);
  }

  get lease(): ReadModelLease | null {
    return this.#lease;
  }

  /** Rows its leases have written in the directory so far. */
  get directoryRowsWritten(): number {
    return this.#directoryWritten;
  }

  /**
   * Writes `statements` in one transaction under admission; their results
   * in order. Nothing is written when the barrier or the lease refuses.
   */
  async write<T = Record<string, unknown>>(
    statements: readonly D1PreparedStatement[],
    options: WriteOptions = {},
  ): Promise<ReadModelWrite<T>> {
    if (statements.length === 0)
      return { results: [], sequence: 0, usage: { rowsRead: 0, rowsWritten: 0 } };
    const writing = this.#write<T>(statements, options);
    this.#writing.add(writing);
    try {
      return await writing;
    } finally {
      this.#writing.delete(writing);
    }
  }

  async #write<T>(
    statements: readonly D1PreparedStatement[],
    options: WriteOptions,
  ): Promise<ReadModelWrite<T>> {
    // A writer of rare writes takes a lease of each write's own (concurrent writes never share one).
    const lease = this.#leasePerWrite ? await this.#take() : await this.#current();
    const open = this.#org
      .prepare(
        `INSERT INTO read_model_write
           (id, open, stray, seq, lease_id, generation, protocol_version, until, mode)
         VALUES (1,
           CASE WHEN EXISTS (
               SELECT 1 FROM read_model_barrier
               WHERE id = 1 AND ?3 >= protocol_version AND (
                 (?6 = 'ordinary' AND phase = 'running' AND generation = ?2)
                 OR (?6 = 'maintenance' AND generation <= ?2)))
             AND ?4 > ${NOW}
             AND (?5 IS NULL OR ?5 = CAST(unixepoch() / 86400 AS INTEGER))
           THEN 1 ELSE -1 END,
           0, 1, ?1, ?2, ?3, ?4, ?6)
         ON CONFLICT (id) DO UPDATE SET
           open = excluded.open,
           seq = max(read_model_write.seq,
             coalesce((SELECT clock FROM search_size WHERE id = 1), 0),
             coalesce((SELECT observed FROM search_size WHERE id = 1), 0)) + 1,
           lease_id = excluded.lease_id, generation = excluded.generation,
           protocol_version = excluded.protocol_version, until = excluded.until,
           mode = excluded.mode
         RETURNING seq`,
      )
      .bind(
        lease.id,
        lease.generation,
        lease.protocolVersion,
        lease.until,
        options.reservationDay ?? null,
        this.#maintenance ? "maintenance" : "ordinary",
      );
    const close = this.#org.prepare(
      `UPDATE read_model_write SET open = 0, lease_id = NULL, generation = NULL,
         protocol_version = NULL, until = NULL, mode = NULL WHERE id = 1`,
    );
    let out: D1Result<unknown>[];
    try {
      out = await this.#org.batch([open, ...statements, close]);
    } catch (error) {
      // The admission statement failing (its CHECK), or a write the read model's triggers refused
      // (a deadline passing within the batch), is a refusal; anything else is the caller's.
      if (
        /read_model_write|CHECK constraint failed: open|read_model_admission_required/i.test(
          String(error),
        )
      )
        throw new ReadModelRefused("barrier");
      throw error;
    } finally {
      if (this.#leasePerWrite) await this.#drop(lease);
    }
    const rowsRead = out.reduce((n, r) => n + (r.meta?.rows_read ?? 0), 0);
    const rowsWritten = out.reduce((n, r) => n + (r.meta?.rows_written ?? 0), 0);
    const bytes = out.at(-1)?.meta?.size_after;
    // The admission's own rows (its opening and closing) are counted with the caller's last
    // statement, so whoever sums a batch's rows charges them once.
    const admission = [out[0], out.at(-1)];
    const last = out.at(-2);
    if (last && out.length > 2)
      last.meta = {
        ...last.meta,
        rows_read:
          (last.meta?.rows_read ?? 0) +
          admission.reduce((n, r) => n + (r?.meta?.rows_read ?? 0), 0),
        rows_written:
          (last.meta?.rows_written ?? 0) +
          admission.reduce((n, r) => n + (r?.meta?.rows_written ?? 0), 0),
      };
    const sequence = (out[0]?.results[0] as { seq: number } | undefined)?.seq ?? 0;
    // The database's size after the latest commit this writer made (the highest sequence wins).
    if (
      options.observe !== false &&
      bytes !== undefined &&
      sequence > (this.#observed?.sequence ?? 0)
    )
      this.#observed = { sequence, bytes };
    return {
      results: out.slice(1, -1) as D1Result<T>[],
      sequence,
      usage: { rowsRead, rowsWritten, ...(bytes !== undefined && { bytes }) },
    };
  }

  /** The database's size its latest commit left, with that commit's sequence (none yet: null). */
  get observation(): { readonly sequence: number; readonly bytes: number } | null {
    return this.#observed;
  }

  /**
   * Records its latest observation in the read model (`search_size`, held
   * unless a later commit's is already there), once: the write records
   * nothing of its own, so accounting never observes itself. What it used
   * (none recorded: null).
   */
  async flushObservation(): Promise<ReadModelWrite<unknown>["usage"] | null> {
    const observed = this.#observed;
    if (!observed || observed.sequence <= this.#flushed) return null;
    const { usage } = await this.write(
      [
        this.#org
          .prepare(
            "UPDATE search_size SET observed = ?1, bytes = ?2 WHERE id = 1 AND observed < ?1",
          )
          .bind(observed.sequence, observed.bytes),
        // The growth search reserved that this observation (or a later one held) covers.
        ...releaseStatements(this.#org),
      ],
      { observe: false },
    );
    this.#flushed = observed.sequence;
    return usage;
  }

  /**
   * A newly taken lease, refused unless the shard's barrier admits this
   * protocol and is running (a maintenance writer's: not running, at its
   * generation).
   */
  async #take(): Promise<ReadModelLease> {
    const taken = await this.#directory
      .prepare(
        `INSERT INTO read_model_writers (lease_id, shard, generation, protocol_version, mode, until)
           SELECT ?1, shard, generation, ?3, ?4, ${NOW} + ${READ_MODEL_LEASE_MS}
           FROM read_model_barriers
           WHERE shard = ?2 AND ?3 >= protocol_version AND CASE ?4
             WHEN 'ordinary' THEN phase = 'running'
             ELSE phase <> 'running' AND generation = ?5 END
           RETURNING lease_id, generation, protocol_version, until`,
      )
      .bind(
        crypto.randomUUID(),
        this.#shard,
        READ_MODEL_PROTOCOL,
        this.#maintenance ? "maintenance" : "ordinary",
        this.#maintenance?.generation ?? null,
      )
      .run<{ lease_id: string; generation: number; protocol_version: number; until: number }>();
    this.#directoryWritten += taken.meta.rows_written ?? 0;
    const row = taken.results[0];
    if (!row) throw new ReadModelRefused("barrier");
    return {
      id: row.lease_id,
      shard: this.#shard,
      generation: row.generation,
      protocolVersion: row.protocol_version,
      until: row.until,
    };
  }

  /** The lease, taken or renewed as needed (one at a time: concurrent writes share it). */
  async #current(): Promise<ReadModelLease> {
    if (this.#ended) throw new ReadModelRefused("lease");
    if (this.#pending) return this.#pending;
    // By its age on this clock (the deadline is the database's: the two clocks may differ).
    if (
      this.#lease !== null &&
      (!this.#renews || this.#now() - this.#leasedAt < READ_MODEL_LEASE_MS / 2)
    )
      return this.#lease;
    return this.#lifecycle(this.#lease === null ? () => this.#first() : () => this.#renewed());
  }

  #lifecycle(step: () => Promise<ReadModelLease>): Promise<ReadModelLease> {
    this.#pending = step().finally(() => {
      this.#pending = null;
    });
    return this.#pending;
  }

  async #first(): Promise<ReadModelLease> {
    const lease = await this.#take();
    this.#lease = lease;
    this.#leasedAt = this.#now();
    return lease;
  }

  /**
   * Takes its lease now, before work that must be seen by a pause before it
   * writes (a pause waits for the lease); the writes then use it.
   */
  async acquire(): Promise<void> {
    await this.#current();
  }

  /** Extends the lease (only the same one, still live, under a running barrier); else it is over. */
  async renew(): Promise<void> {
    if (this.#ended) throw new ReadModelRefused("lease");
    if (this.#pending) {
      await this.#pending;
      return;
    }
    if (this.#lease === null) return;
    await this.#lifecycle(() => this.#renewed());
  }

  async #renewed(): Promise<ReadModelLease> {
    const lease = this.#lease as ReadModelLease;
    const renewed = await this.#directory
      .prepare(
        `UPDATE read_model_writers SET until = ${NOW} + ${READ_MODEL_LEASE_MS}
         WHERE lease_id = ?1 AND shard = ?2 AND generation = ?3 AND protocol_version = ?4
           AND until = ?5 AND until > ${NOW}
           AND EXISTS (SELECT 1 FROM read_model_barriers b
             WHERE b.shard = read_model_writers.shard AND b.generation = read_model_writers.generation
               AND b.phase = 'running' AND read_model_writers.protocol_version >= b.protocol_version)
         RETURNING until`,
      )
      .bind(lease.id, lease.shard, lease.generation, lease.protocolVersion, lease.until)
      .run<{ until: number }>();
    this.#directoryWritten += renewed.meta.rows_written ?? 0;
    const row = renewed.results[0];
    if (!row) {
      this.#ended = true;
      throw new ReadModelRefused("lease");
    }
    this.#lease = { ...lease, until: row.until };
    this.#leasedAt = this.#now();
    return this.#lease;
  }

  /** Releases the lease and ends the writer (idempotent; a lost release expires by itself). */
  async release(): Promise<void> {
    this.#ended = true;
    // A lease being taken or renewed, and the writes already under way, end first.
    await this.#pending?.catch(() => {});
    await Promise.allSettled(this.#writing);
    await this.#releaseLease();
  }

  async #releaseLease(): Promise<void> {
    const lease = this.#lease;
    if (lease === null) return;
    this.#lease = null;
    await this.#drop(lease);
  }

  async #drop(lease: ReadModelLease): Promise<void> {
    const dropped = await this.#directory
      .prepare(
        "DELETE FROM read_model_writers WHERE lease_id = ? AND shard = ? AND generation = ? AND until = ?",
      )
      .bind(lease.id, lease.shard, lease.generation, lease.until)
      .run()
      .catch(() => null);
    this.#directoryWritten += dropped?.meta.rows_written ?? 0;
  }
}

/**
 * Quoted text, quoted names and comments, in one pass (so a comment's
 * delimiter inside a string, or a quote inside a comment, is not taken for one).
 */
const QUOTED_OR_COMMENT =
  /'(?:[^']|'')*'|"(?:[^"]|"")*"|`[^`]*`|\[[^\]]*\]|--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/g;

/** Whether a statement's SQL writes (outside quoted text, quoted names and comments). */
export function writesSql(sql: string): boolean {
  return /\b(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql.replace(QUOTED_OR_COMMENT, " "));
}

const SQL = new WeakMap<D1PreparedStatement, string>();

/** A statement remembering its SQL (through `bind` too). */
function remembered(statement: D1PreparedStatement, sql: string): D1PreparedStatement {
  const bind = statement.bind.bind(statement);
  const proxy = new Proxy(statement, {
    get(target, prop) {
      if (prop === "bind") return (...values: unknown[]) => remembered(bind(...values), sql);
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  SQL.set(statement, sql);
  SQL.set(proxy, sql);
  return proxy;
}

/**
 * The read model as code uses it within one piece of work: reads go to the
 * database; batches, and single statements that write, go through `writer`.
 */
export function writerDatabase(db: D1Database, writer: ReadModelWriter): D1Database {
  const routed = (statement: D1PreparedStatement): D1PreparedStatement => {
    const sql = SQL.get(statement) ?? "";
    if (!writesSql(sql)) return statement;
    const proxy = new Proxy(statement, handler(sql));
    SQL.set(proxy, sql);
    return proxy;
  };
  const handler = (sql: string): ProxyHandler<D1PreparedStatement> => {
    return {
      get(target, prop) {
        const one = async () =>
          (await writer.write([target])).results[0] as D1Result<Record<string, unknown>>;
        if (prop === "bind")
          return (...values: unknown[]) => {
            const bound = routed(remembered(target.bind(...values), sql));
            SQL.set(bound, sql);
            return bound;
          };
        if (prop === "run") return () => one();
        if (prop === "all") return () => one();
        if (prop === "first")
          return async (column?: string) => {
            const row = (await one()).results[0] as Record<string, unknown> | undefined;
            if (row === undefined) return null;
            return column === undefined ? row : (row[column] ?? null);
          };
        if (prop === "raw")
          return async () => (await one()).results.map((r) => Object.values(r as object));
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    };
  };
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare") return (sql: string) => routed(remembered(target.prepare(sql), sql));
      if (prop === "batch")
        return async (statements: D1PreparedStatement[]) =>
          statements.some((s) => writesSql(SQL.get(s) ?? ""))
            ? (await writer.write(statements)).results
            : target.batch(statements);
      // Neither is used on the read model; either would write past the writer.
      if (prop === "exec" || prop === "withSession")
        throw new Error(`${String(prop)} is not used on the read model`);
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as D1Database;
}

/**
 * Runs `work` with the shard's read model, its writes through one writer
 * whose lease (taken at the first write) is released when the work ends.
 */
export async function withReadModel<T>(
  env: Pick<Env, "DIRECTORY" | "ORG_READ">,
  shard: string,
  work: (db: D1Database, writer: ReadModelWriter) => Promise<T>,
  options: WriterOptions = {},
): Promise<T> {
  const writer = new ReadModelWriter(env, shard, Date.now, options);
  try {
    return await work(writerDatabase(rawReadModel(env, shard), writer), writer);
  } finally {
    // The size its work left, once for all of it (a failure leaves it to a later one).
    await writer.flushObservation().catch(() => {});
    await writer.release();
  }
}
