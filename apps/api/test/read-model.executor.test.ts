// The read model's executor: writes only under admission (the barrier
// running at the writer's lease's generation, the protocol admitted, the
// lease's deadline ahead), each batch opening and closing admission in its
// own transaction; leases taken at the first write, renewed only while
// live, released at the end; writes outside admission counted, not refused,
// while old and new code run side by side.

import { env } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  READ_MODEL_ADMISSION,
  READ_MODEL_LEASE,
  READ_MODEL_LEASE_MS,
  ReadModelRefused,
  ReadModelWriter,
  withReadModel,
  writesSql,
} from "../src/read-model/executor.js";

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

afterEach(async () => {
  await env.DIRECTORY.batch([
    env.DIRECTORY.prepare("DELETE FROM read_model_writers"),
    env.DIRECTORY.prepare(
      "UPDATE read_model_barriers SET phase = 'running', generation = 1, protocol_version = 1 WHERE shard = 'default'",
    ),
  ]);
  await org
    .prepare(
      "UPDATE read_model_barrier SET phase = 'running', generation = 1, protocol_version = 1 WHERE id = 1",
    )
    .run();
});

describe("the read model's admission", () => {
  it("starts closed and running, with a counting trigger for every write of every guarded table", async () => {
    expect(await admission()).toMatchObject({ open: 0 });
    const { results } = await org
      .prepare(
        "SELECT count(*) AS n FROM sqlite_schema WHERE type = 'trigger' AND name LIKE 'read_model_%'",
      )
      .all<{ n: number }>();
    expect(results[0]?.n).toBe(60);
    const barrier = await env.DIRECTORY.prepare(
      "SELECT phase, generation, protocol_version, read_model_protocol_since FROM read_model_barriers WHERE shard = 'default'",
    ).first();
    expect(barrier).toEqual({
      phase: "running",
      generation: 1,
      protocol_version: 1,
      read_model_protocol_since: null,
    });
  });

  it("counts a write made outside it, and lets it through", async () => {
    const before = (await admission())?.stray ?? 0;
    const source = uniqueId("stray");
    await epochRow(source, 1).run();
    await org
      .prepare("UPDATE consumer_epochs SET epoch_gen = 2 WHERE source_id = ?")
      .bind(source)
      .run();
    await org.prepare("DELETE FROM consumer_epochs WHERE source_id = ?").bind(source).run();
    expect((await admission())?.stray).toBe(before + 3);
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
    ["the barrier paused", "UPDATE read_model_barrier SET phase = 'pausing' WHERE id = 1"],
    ["another generation", "UPDATE read_model_barrier SET generation = 2 WHERE id = 1"],
    [
      "a newer protocol required",
      "UPDATE read_model_barrier SET protocol_version = 2 WHERE id = 1",
    ],
  ])("writes nothing with %s", async (_, change) => {
    const writer = new ReadModelWriter(env, "default");
    await writer.write([org.prepare("SELECT 1")]);
    await org.prepare(change).run();
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
    const alone = await org.batch([epochRow(`${source}-raw`, 1)]);
    const out = await writer.write([epochRow(source, 1)]);
    // The raw write was counted by its trigger (one row more); the writer's is not.
    expect(out.usage.rowsWritten - ((alone[0]?.meta.rows_written ?? 0) - 1)).toBe(
      READ_MODEL_ADMISSION.rows,
    );
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
