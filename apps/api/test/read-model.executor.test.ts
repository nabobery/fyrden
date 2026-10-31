// The read model's executor: writes only under admission (the barrier
// running at the writer's lease's generation, the protocol admitted, the
// lease's deadline ahead), each batch opening and closing admission in its
// own transaction; leases taken at the first write, renewed only while
// live, released at the end; writes outside admission refused. A
// maintenance writer (the barrier's controller) writes while it is not
// running, at its generation.

import { env } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  READ_MODEL_ADMISSION,
  READ_MODEL_LEASE,
  READ_MODEL_LEASE_MS,
  READ_MODEL_OBSERVATION,
  RELEASE_LIMIT,
  ReadModelRefused,
  ReadModelWriter,
  withReadModel,
  writesSql,
} from "../src/read-model/executor.js";
import { pauseReadModel, resumeReadModel } from "../src/read-model/maintenance.js";
import { runningAgain } from "./helpers/read-model.js";

const org = env.ORG_READ;

const admission = () =>
  org
    .prepare("SELECT open, stray, seq FROM read_model_write WHERE id = 1")
    .first<{ open: number; stray: number; seq: number }>();

const leases = () =>
  env.DIRECTORY.prepare("SELECT count(*) AS n FROM read_model_writers").first<{ n: number }>();

/** A row of a guarded table to write: an epoch of a source of its own. */
const epochRow = (source: string, gen: number) =>
  org
    .prepare("INSERT INTO consumer_epochs (source_id, epoch_gen, updated_at) VALUES (?, ?, 0)")
    .bind(source, gen);

const epochOf = (source: string) =>
  org
    .prepare("SELECT epoch_gen FROM consumer_epochs WHERE source_id = ?")
    .bind(source)
    .first<{ epoch_gen: number }>();

afterEach(() => runningAgain(env));

/** A maintenance writer at the directory's generation (paused first). */
async function maintenanceWriter(): Promise<{ writer: ReadModelWriter; generation: number }> {
  let progress = await pauseReadModel(env, "default");
  if (progress.phase !== "paused") progress = await pauseReadModel(env, "default");
  expect(progress.phase).toBe("paused");
  return {
    writer: new ReadModelWriter(env, "default", Date.now, {
      maintenance: { generation: progress.generation },
    }),
    generation: progress.generation,
  };
}

const barrier = () =>
  org
    .prepare("SELECT phase, generation, protocol_version FROM read_model_barrier WHERE id = 1")
    .first<{ phase: string; generation: number; protocol_version: number }>();

describe("the read model's admission", () => {
  it("starts closed and running, with a refusing trigger for every write of every guarded table", async () => {
    expect(await admission()).toMatchObject({ open: 0 });
    const { results } = await org
      .prepare(
        `SELECT count(*) AS n, count(*) FILTER (WHERE sql LIKE '%read_model_admission_required%') AS refusing
         FROM sqlite_schema WHERE type = 'trigger' AND name LIKE 'read_model_%'`,
      )
      .all<{ n: number; refusing: number }>();
    expect(results[0]).toEqual({ n: 78, refusing: 78 });
    expect(await barrier()).toMatchObject({ phase: "running", protocol_version: 2 });
    const directory = await env.DIRECTORY.prepare(
      "SELECT phase, protocol_version, read_model_protocol_since FROM read_model_barriers WHERE shard = 'default'",
    ).first();
    expect(directory).toEqual({
      phase: "running",
      protocol_version: 2,
      read_model_protocol_since: null,
    });
  });

  it("refuses a write made outside it, and keeps nothing of its batch", async () => {
    const before = await admission();
    const [kept, refused] = [uniqueId("kept"), uniqueId("refused")];
    const writer = new ReadModelWriter(env, "default");
    await writer.write([epochRow(kept, 1)]);
    await writer.release();
    const outside = [
      epochRow(refused, 1),
      org.prepare("UPDATE consumer_epochs SET epoch_gen = 2 WHERE source_id = ?").bind(kept),
      org.prepare("DELETE FROM consumer_epochs WHERE source_id = ?").bind(kept),
    ];
    for (const statement of outside)
      await expect(statement.run()).rejects.toThrow(/read_model_admission_required/);
    // A batch: what its statements before the refused one did is undone with it (a change of the
    // admission row's sequence, which no trigger guards, here).
    const sequence = (await admission())?.seq;
    await expect(
      org.batch([
        org.prepare("UPDATE read_model_write SET seq = seq + 1 WHERE id = 1"),
        epochRow(refused, 1),
      ]),
    ).rejects.toThrow(/read_model_admission_required/);
    expect(await admission()).toMatchObject({ open: 0, seq: sequence });
    expect([await epochOf(kept), await epochOf(refused)]).toEqual([{ epoch_gen: 1 }, null]);
    // Nothing counted any more.
    expect((await admission())?.stray).toBe(before?.stray);
  });

  it("never lets an ordinary writer change the barrier, nor anything insert or delete it", async () => {
    const before = await barrier();
    const writer = new ReadModelWriter(env, "default");
    await expect(
      writer.write([org.prepare("UPDATE read_model_barrier SET phase = phase WHERE id = 1")]),
    ).rejects.toBeInstanceOf(ReadModelRefused);
    await writer.release();
    await expect(org.prepare("DELETE FROM read_model_barrier").run()).rejects.toThrow(
      /read_model_admission_required/,
    );
    expect(await barrier()).toEqual(before);
  });
});

describe("a maintenance writer", () => {
  it("writes only while the directory's barrier is not running, at the generation it was given", async () => {
    await expect(
      new ReadModelWriter(env, "default", Date.now, {
        maintenance: { generation: (await barrier())?.generation ?? 1 },
      }).write([org.prepare("SELECT 1")]),
    ).rejects.toBeInstanceOf(ReadModelRefused);
    const { writer, generation } = await maintenanceWriter();
    const source = uniqueId("maintained");
    await writer.write([epochRow(source, 1)]);
    expect(await epochOf(source)).toEqual({ epoch_gen: 1 });
    // A lease of its own each write, never kept.
    expect(writer.lease).toBeNull();
    expect(await leases()).toEqual({ n: 0 });
    const stale = new ReadModelWriter(env, "default", Date.now, {
      maintenance: { generation: generation - 1 },
    });
    await expect(stale.write([epochRow(uniqueId("stale"), 1)])).rejects.toBeInstanceOf(
      ReadModelRefused,
    );
    // An ordinary writer, meanwhile, writes nothing.
    await expect(
      withReadModel(env, "default", (db) =>
        db
          .prepare(
            "INSERT INTO consumer_epochs (source_id, epoch_gen, updated_at) VALUES (?, 1, 0)",
          )
          .bind(uniqueId("ordinary"))
          .run(),
      ),
    ).rejects.toBeInstanceOf(ReadModelRefused);
  });

  it("moves the barrier only to its own generation, never back, its protocol as it is", async () => {
    const { writer, generation } = await maintenanceWriter();
    const before = await barrier();
    for (const change of [
      `UPDATE read_model_barrier SET generation = ${generation - 1} WHERE id = 1`,
      `UPDATE read_model_barrier SET generation = ${generation + 1} WHERE id = 1`,
      "UPDATE read_model_barrier SET protocol_version = 3 WHERE id = 1",
    ])
      await expect(writer.write([org.prepare(change)])).rejects.toBeInstanceOf(ReadModelRefused);
    expect(await barrier()).toEqual(before);
    await writer.write([
      org.prepare("UPDATE read_model_barrier SET phase = 'recovering' WHERE id = 1"),
    ]);
    expect(await barrier()).toMatchObject({ phase: "recovering", generation });
  });
});

describe("a read model writer", () => {
  it("writes a batch under admission: the caller's results in order, admission closed, the sequence advanced", async () => {
    const before = await admission();
    const writer = new ReadModelWriter(env, "default");
    const [a, b] = [uniqueId("a"), uniqueId("b")];
    const out = await writer.write([
      epochRow(a, 1),
      org.prepare("SELECT ? AS marker").bind("second"),
      epochRow(b, 2),
    ]);
    await writer.release();
    expect(out.results).toHaveLength(3);
    expect(out.results[1]?.results).toEqual([{ marker: "second" }]);
    expect(out.sequence).toBeGreaterThan(before?.seq ?? 0);
    expect(await epochOf(a)).toEqual({ epoch_gen: 1 });
    const after = await admission();
    expect([after?.open, after?.stray]).toEqual([0, before?.stray]);
    expect(out.usage.rowsWritten).toBeGreaterThan(0);
  });

  it.each([
    [
      "the barrier paused",
      async () => {
        await pauseReadModel(env, "default");
      },
    ],
    [
      "another generation",
      async () => {
        await pauseReadModel(env, "default");
        await resumeReadModel(env, "default");
      },
    ],
    [
      "an older protocol than the read model's",
      async (writer: ReadModelWriter) => {
        Object.assign(writer.lease as object, { protocolVersion: 1 });
      },
    ],
  ])("writes nothing with %s", async (_, change) => {
    const writer = new ReadModelWriter(env, "default");
    await writer.write([org.prepare("SELECT 1")]);
    await change(writer);
    const before = await admission();
    const source = uniqueId("refused");
    await expect(writer.write([epochRow(source, 1)])).rejects.toBeInstanceOf(ReadModelRefused);
    await writer.release();
    expect(await epochOf(source)).toBeNull();
    expect(await admission()).toEqual(before);
  });

  it("writes nothing past its lease's deadline", async () => {
    const writer = new ReadModelWriter(env, "default", () => 0);
    await writer.write([org.prepare("SELECT 1")]);
    // Its lease as if it had run out (the database's clock decides, in the write itself).
    const lease = writer.lease;
    await env.DIRECTORY.prepare("UPDATE read_model_writers SET until = 1 WHERE lease_id = ?")
      .bind(lease?.id)
      .run();
    Object.assign(lease as object, { until: 1 });
    const source = uniqueId("late");
    await expect(writer.write([epochRow(source, 1)])).rejects.toBeInstanceOf(ReadModelRefused);
    await writer.release();
    expect(await epochOf(source)).toBeNull();
  });

  it("rolls the whole batch back when a statement of the caller's fails", async () => {
    const before = await admission();
    const writer = new ReadModelWriter(env, "default");
    const source = uniqueId("rollback");
    await expect(writer.write([epochRow(source, 1), epochRow(source, 2)])).rejects.toThrow();
    await writer.release();
    expect(await epochOf(source)).toBeNull();
    expect(await admission()).toEqual(before);
  });

  it("takes no lease until it writes, and none when it is refused by a pause", async () => {
    await withReadModel(env, "default", async (db) => {
      await db.prepare("SELECT 1").first();
      expect(await leases()).toEqual({ n: 0 });
    });
    await env.DIRECTORY.prepare(
      "UPDATE read_model_barriers SET phase = 'pausing' WHERE shard = 'default'",
    ).run();
    await expect(
      withReadModel(env, "default", (db) =>
        db
          .prepare(
            "INSERT INTO consumer_epochs (source_id, epoch_gen, updated_at) VALUES (?, 1, 0)",
          )
          .bind(uniqueId("p"))
          .run(),
      ),
    ).rejects.toBeInstanceOf(ReadModelRefused);
    expect(await leases()).toEqual({ n: 0 });
  });

  it("renews only its own live lease, and is over once that fails", async () => {
    let now = Date.now();
    const writer = new ReadModelWriter(env, "default", () => now);
    await writer.write([org.prepare("SELECT 1")]);
    const first = writer.lease?.until as number;
    await writer.renew();
    expect(writer.lease?.until).toBeGreaterThanOrEqual(first);
    // Another writer's change of its row (or a pause) makes the next renewal fail for good.
    await env.DIRECTORY.prepare("UPDATE read_model_writers SET until = until + 1").run();
    now += READ_MODEL_LEASE_MS;
    await expect(writer.write([org.prepare("SELECT 1")])).rejects.toBeInstanceOf(ReadModelRefused);
    await expect(writer.write([org.prepare("SELECT 1")])).rejects.toBeInstanceOf(ReadModelRefused);
    await writer.release();
  });

  it("takes one lease for concurrent first writes, and renews it once for concurrent renewals", async () => {
    let now = Date.now();
    const writer = new ReadModelWriter(env, "default", () => now);
    await Promise.all([1, 2, 3].map(() => writer.write([org.prepare("SELECT 1")])));
    expect(await leases()).toEqual({ n: 1 });
    now += READ_MODEL_LEASE_MS / 2;
    const until = writer.lease?.until as number;
    await Promise.all([1, 2, 3].map(() => writer.write([org.prepare("SELECT 1")])));
    expect(writer.lease?.until).toBeGreaterThanOrEqual(until);
    await writer.write([org.prepare("SELECT 1")]);
    await writer.release();
    expect(await leases()).toEqual({ n: 0 });
  });

  it("releases its lease only after the writes under way, and takes or renews none after", async () => {
    const order: string[] = [];
    const watched = {
      ORG_READ: new Proxy(org, {
        get(target, prop) {
          if (prop === "batch")
            return async (statements: D1PreparedStatement[]) => {
              const out = await target.batch(statements);
              order.push("written");
              return out;
            };
          const value = Reflect.get(target, prop);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
      DIRECTORY: new Proxy(env.DIRECTORY, {
        get(target, prop) {
          if (prop === "prepare")
            return (sql: string) => {
              if (sql.startsWith("DELETE")) order.push("released");
              return target.prepare(sql);
            };
          const value = Reflect.get(target, prop);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    };
    const writer = new ReadModelWriter(watched, "default");
    await writer.write([org.prepare("SELECT 1")]);
    order.length = 0;
    const writing = writer.write([org.prepare("SELECT 1")]);
    await writer.release();
    await writing;
    expect(order).toEqual(["written", "released"]);
    await expect(writer.renew()).rejects.toBeInstanceOf(ReadModelRefused);
    await expect(writer.write([org.prepare("SELECT 1")])).rejects.toBeInstanceOf(ReadModelRefused);
    expect(await leases()).toEqual({ n: 0 });
  });

  it("keeps its lease as taken when it does not renew, until the deadline refuses its writes", async () => {
    let now = Date.now();
    const writer = new ReadModelWriter(env, "default", () => now, { renews: false });
    await writer.write([org.prepare("SELECT 1")]);
    const { until } = writer.lease as { until: number };
    const written = writer.directoryRowsWritten;
    now += READ_MODEL_LEASE_MS;
    await writer.write([org.prepare("SELECT 1")]);
    expect([writer.lease?.until, writer.directoryRowsWritten]).toEqual([until, written]);
    await writer.release();
  });

  it("releases a lease still being taken once it is", async () => {
    const writer = new ReadModelWriter(env, "default");
    const writing = writer.write([org.prepare("SELECT 1")]);
    await writer.release();
    await writing.catch(() => {});
    await writer.release();
    expect(await leases()).toEqual({ n: 0 });
  });

  it("costs what its constants say: the admission's rows, the lease's in the directory", async () => {
    let now = Date.now();
    const writer = new ReadModelWriter(env, "default", () => now);
    const source = uniqueId("cost");
    const one = await writer.write([epochRow(source, 1)]);
    const two = await writer.write([epochRow(`${source}-a`, 1), epochRow(`${source}-b`, 1)]);
    // A row's own cost twice less one batch's: what admitting a batch costs besides.
    expect({
      rows: 2 * one.usage.rowsWritten - two.usage.rowsWritten,
      reads: 2 * one.usage.rowsRead - two.usage.rowsRead,
    }).toEqual(READ_MODEL_ADMISSION);
    const taken = writer.directoryRowsWritten;
    now += READ_MODEL_LEASE_MS / 2;
    await writer.write([org.prepare("SELECT 1")]);
    const renewed = writer.directoryRowsWritten - taken;
    await writer.release();
    const released = writer.directoryRowsWritten - taken - renewed;
    expect({ lease: taken + released, renewed }).toEqual({
      lease: READ_MODEL_LEASE.rows,
      renewed: READ_MODEL_LEASE.renewal,
    });
  });

  it("keeps the size its latest commit left, records it once, and its own write observes nothing", async () => {
    const writer = new ReadModelWriter(env, "default");
    await writer.write([epochRow(uniqueId("obs1"), 1)]);
    const first = writer.observation;
    await writer.write([epochRow(uniqueId("obs2"), 1)]);
    const latest = writer.observation;
    expect(latest?.sequence).toBeGreaterThan(first?.sequence ?? 0);
    expect(latest?.bytes).toBeGreaterThan(0);
    // What recording it costs, as charged.
    const usage = await writer.flushObservation();
    expect({ rows: usage?.rowsWritten, reads: usage?.rowsRead }).toEqual(READ_MODEL_OBSERVATION);
    const size = () =>
      org.prepare("SELECT observed, bytes FROM search_size WHERE id = 1").first<{
        observed: number;
        bytes: number;
      }>();
    expect(await size()).toEqual({ observed: latest?.sequence, bytes: latest?.bytes });
    // Its recording was a commit of its own, not observed; nothing new to record again.
    expect(writer.observation).toEqual(latest);
    const sequence = (await admission())?.seq;
    expect(await writer.flushObservation()).toBeNull();
    expect((await admission())?.seq).toBe(sequence);
    await writer.release();
  });

  it("releases the growth reserved that its observation covers, the oldest first, a bounded number at once", async () => {
    // Receipts of batches before the observation (made by a writer that recorded none), and one
    // of a later batch.
    const reserving = new ReadModelWriter(env, "default");
    const statements = (count: number, ahead = 0) => [
      org
        .prepare(
          `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
           INSERT INTO search_byte_reservations (token, day, sequence, bytes)
           SELECT ?2 || '-' || i, 1, (SELECT seq FROM read_model_write WHERE id = 1) + ?3, 10 FROM n`,
        )
        .bind(count, uniqueId("receipt"), ahead),
      org
        .prepare("UPDATE search_size SET bytes_reserved = bytes_reserved + 10 * ?1 WHERE id = 1")
        .bind(count),
    ];
    await reserving.write(statements(RELEASE_LIMIT + 1));
    await reserving.write(statements(1, 1_000_000));
    await reserving.release();
    const held = () =>
      org
        .prepare(
          `SELECT (SELECT count(*) FROM search_byte_reservations) AS receipts,
             (SELECT bytes_reserved FROM search_size WHERE id = 1) AS bytes`,
        )
        .first<{ receipts: number; bytes: number }>();
    const before = await held();
    const observe = async () => {
      const writer = new ReadModelWriter(env, "default");
      await writer.write([epochRow(uniqueId("observed"), 1)]);
      await writer.flushObservation();
      await writer.release();
    };
    await observe();
    expect(await held()).toEqual({
      receipts: (before?.receipts ?? 0) - RELEASE_LIMIT,
      bytes: (before?.bytes ?? 0) - 10 * RELEASE_LIMIT,
    });
    // The next releases the rest it covers; the later batch's stays reserved.
    await observe();
    const left = await org
      .prepare(
        "SELECT sequence > (SELECT observed FROM search_size WHERE id = 1) AS later FROM search_byte_reservations",
      )
      .all<{ later: number }>();
    expect(left.results).toEqual([{ later: 1 }]);
    expect((await held())?.bytes).toBe(10);
    const cleaning = new ReadModelWriter(env, "default");
    await cleaning.write([
      org.prepare("DELETE FROM search_byte_reservations"),
      org.prepare("UPDATE search_size SET bytes_reserved = 0 WHERE id = 1"),
    ]);
    await cleaning.release();
  });

  it("records the size a piece of work left as it ends", async () => {
    const before = await org.prepare("SELECT observed FROM search_size WHERE id = 1").first<{
      observed: number;
    }>();
    await withReadModel(env, "default", (db) =>
      db
        .prepare("INSERT INTO consumer_epochs (source_id, epoch_gen, updated_at) VALUES (?, 1, 0)")
        .bind(uniqueId("work"))
        .run(),
    );
    const after = await org.prepare("SELECT observed FROM search_size WHERE id = 1").first<{
      observed: number;
    }>();
    expect(after?.observed).toBeGreaterThan(before?.observed ?? 0);
  });

  it("releases its lease when the work ends, whether it returns or throws", async () => {
    await withReadModel(env, "default", (db) =>
      db
        .prepare("INSERT INTO consumer_epochs (source_id, epoch_gen, updated_at) VALUES (?, 1, 0)")
        .bind(uniqueId("r"))
        .run(),
    );
    expect(await leases()).toEqual({ n: 0 });
    await expect(
      withReadModel(env, "default", async (db) => {
        await db
          .prepare(
            "INSERT INTO consumer_epochs (source_id, epoch_gen, updated_at) VALUES (?, 1, 0)",
          )
          .bind(uniqueId("t"))
          .run();
        throw new Error("work failed");
      }),
    ).rejects.toThrow("work failed");
    expect(await leases()).toEqual({ n: 0 });
  });
});

describe("the read model as code uses it", () => {
  it("sends writes through the writer, whether run, first, all or batched, and reads as they are", async () => {
    const before = (await admission())?.stray ?? 0;
    const [a, b, c] = [uniqueId("run"), uniqueId("first"), uniqueId("batch")];
    await withReadModel(env, "default", async (db) => {
      await db
        .prepare("INSERT INTO consumer_epochs (source_id, epoch_gen, updated_at) VALUES (?, 1, 0)")
        .bind(a)
        .run();
      const returned = await db
        .prepare(
          "INSERT INTO consumer_epochs (source_id, epoch_gen, updated_at) VALUES (?, 2, 0) RETURNING epoch_gen",
        )
        .bind(b)
        .first<{ epoch_gen: number }>();
      expect(returned).toEqual({ epoch_gen: 2 });
      const all = await db
        .prepare(
          "UPDATE consumer_epochs SET epoch_gen = epoch_gen + 1 WHERE source_id IN (?, ?) RETURNING source_id",
        )
        .bind(a, b)
        .all<{ source_id: string }>();
      expect(all.results.map((r) => r.source_id).sort()).toEqual([a, b].sort());
      const batch = await db.batch([
        db
          .prepare(
            "INSERT INTO consumer_epochs (source_id, epoch_gen, updated_at) VALUES (?, 5, 0)",
          )
          .bind(c),
        db.prepare("SELECT epoch_gen FROM consumer_epochs WHERE source_id = ?").bind(c),
      ]);
      expect(batch[1]?.results).toEqual([{ epoch_gen: 5 }]);
      expect(
        await db
          .prepare("SELECT epoch_gen FROM consumer_epochs WHERE source_id = ?")
          .bind(a)
          .first(),
      ).toEqual({
        epoch_gen: 2,
      });
    });
    expect((await admission())?.stray).toBe(before);
  });

  it("tells writing SQL from reading SQL, past comments, quoted text and quoted names", () => {
    expect(writesSql("INSERT INTO t VALUES (1)")).toBe(true);
    expect(writesSql("WITH x AS (SELECT 1) UPDATE t SET a = 1")).toBe(true);
    expect(writesSql("SELECT 'DELETE' AS word, deleted FROM t -- UPDATE")).toBe(false);
    expect(writesSql("SELECT 1 /* INSERT */")).toBe(false);
    expect(writesSql(`SELECT "update" FROM t`)).toBe(false);
    // A comment's delimiter inside quoted text, and a quote inside a comment, are neither.
    expect(writesSql("WITH x AS (SELECT '--') UPDATE t SET a = 1")).toBe(true);
    expect(writesSql("WITH x AS (SELECT '/*') DELETE FROM t")).toBe(true);
    expect(writesSql("SELECT 1 -- it's\nUPDATE t SET a = 1")).toBe(true);
    expect(writesSql("SELECT 1 /* it's */ ; DELETE FROM t")).toBe(true);
  });

  it("offers no way to write past the writer", async () => {
    await withReadModel(env, "default", async (db) => {
      expect(() => db.withSession("first-primary")).toThrow();
      expect(() => db.exec("DELETE FROM consumer_epochs")).toThrow();
    });
  });
});
