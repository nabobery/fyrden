import { describe, expect, it } from "vitest";
import { createFakeDataset } from "../../src/obs/fake-dataset.js";
import {
  countedD1,
  currentInvocation,
  d1StatementsRun,
  measureInvocation,
} from "../../src/obs/index.js";
import { createMetrics } from "../../src/obs/metrics.js";

/** A D1 binding that answers every statement with no rows. */
function fakeD1(): D1Database {
  const statement = (): D1PreparedStatement =>
    ({
      bind: () => statement(),
      first: async () => null,
      all: async () => ({ results: [], success: true, meta: {} }),
      run: async () => ({ results: [], success: true, meta: {} }),
      raw: async () => [],
    }) as unknown as D1PreparedStatement;
  const db = {
    prepare: () => statement(),
    batch: async (statements: D1PreparedStatement[]) => statements.map(() => ({ results: [] })),
    exec: async () => ({ count: 1, duration: 0 }),
    withSession: () => ({
      prepare: () => statement(),
      batch: async (statements: D1PreparedStatement[]) => statements.map(() => ({ results: [] })),
      getBookmark: () => null,
    }),
  };
  return db as unknown as D1Database;
}

describe("a counted D1 binding", () => {
  it("counts every statement the invocation runs, through sessions, bound statements and batches", async () => {
    const db = countedD1(fakeD1());
    const metrics = createMetrics(createFakeDataset().dataset);
    const seen = await measureInvocation(metrics, { where: "do", op: "test" }, async () => {
      await db.prepare("SELECT 1").first();
      await db.prepare("SELECT ?").bind(1).all();
      const session = db.withSession("first-primary");
      await session.prepare("SELECT ?").bind(2).run();
      await session.batch([session.prepare("SELECT 1"), session.prepare("SELECT 2")]);
      await db.exec("SELECT 1");
      // A statement prepared and bound but never run costs nothing.
      db.prepare("SELECT 3").bind(3);
      return d1StatementsRun();
    });
    expect(seen).toBe(6);
    // Outside any invocation nothing is counted.
    await db.prepare("SELECT 1").first();
    expect(d1StatementsRun()).toBe(0);
  });

  it("writes one point of the platform invocation's statements when it ends", async () => {
    const db = countedD1(fakeD1());
    const { dataset, points } = createFakeDataset();
    const metrics = createMetrics(dataset);
    await measureInvocation(metrics, { where: "do", op: "outer" }, async () => {
      await db.prepare("SELECT 1").first();
      await measureInvocation(metrics, { where: "do", op: "inner" }, () =>
        db.prepare("SELECT 2").first(),
      );
    });
    expect(
      points.filter((p) => p.name === "d1.invocation_statements").map((p) => [p.blobs, p.value]),
    ).toEqual([[["do", "outer"], 2]]);
  });

  it("shares the count with an invocation measured inside another", async () => {
    const db = countedD1(fakeD1());
    const metrics = createMetrics(createFakeDataset().dataset);
    const seen = await measureInvocation(metrics, { where: "do", op: "outer" }, async () => {
      await db.prepare("SELECT 1").first();
      await measureInvocation(metrics, { where: "do", op: "inner" }, () =>
        db.prepare("SELECT 2").first(),
      );
      return d1StatementsRun();
    });
    expect(seen).toBe(2);
  });
});

describe("an invocation counting D1 by its bindings", () => {
  const tallyAfter = (
    work: (db: D1Database, metrics: ReturnType<typeof createMetrics>) => Promise<unknown>,
    d1Counting?: "binding",
  ) => {
    const db = countedD1(fakeD1());
    const metrics = createMetrics(createFakeDataset().dataset);
    return measureInvocation(
      metrics,
      { where: "do", op: "test", ...(d1Counting && { d1Counting }) },
      async () => {
        await work(db, metrics).catch(() => {});
        const tally = currentInvocation()?.tally;
        return { d1: tally?.d1, internal: tally?.internal };
      },
    );
  };

  it("counts a batch as its statements and one internal call, whatever the metric says", async () => {
    expect(
      await tallyAfter(async (db, metrics) => {
        await db.batch([1, 2, 3, 4, 5].map(() => db.prepare("SELECT 1")));
        // The caller's own metric of the same batch adds no internal call.
        metrics.count("d1.query", { db: "directory", op: "test" }, 5);
      }, "binding"),
    ).toEqual({ d1: 5, internal: 1 });
  });

  it("counts one statement as one statement and one internal call", async () => {
    expect(await tallyAfter((db) => db.prepare("SELECT 1").first(), "binding")).toEqual({
      d1: 1,
      internal: 1,
    });
  });

  it("counts an execution that throws, and one made by a helper with no metric", async () => {
    const throwing = {
      prepare: () => ({
        first: async () => {
          throw new Error("D1 unavailable");
        },
      }),
    } as unknown as D1Database;
    const db = countedD1(throwing);
    const metrics = createMetrics(createFakeDataset().dataset);
    const seen = await measureInvocation(
      metrics,
      { where: "do", op: "t", d1Counting: "binding" },
      async () => {
        await db
          .prepare("SELECT 1")
          .first()
          .catch(() => {});
        const tally = currentInvocation()?.tally;
        return { d1: tally?.d1, internal: tally?.internal };
      },
    );
    expect(seen).toEqual({ d1: 1, internal: 1 });
  });

  it("counts each execution once through bindings, sessions and statements wrapped twice", async () => {
    expect(
      await tallyAfter(async (db) => {
        const twice = countedD1(db);
        await twice.prepare("SELECT 1").first();
        const session = countedD1(twice.withSession("first-primary"));
        await session.batch([session.prepare("SELECT 1"), session.prepare("SELECT 2")]);
      }, "binding"),
    ).toEqual({ d1: 3, internal: 2 });
  });

  it("leaves an invocation counting by metrics as it was, and a nested one takes the outer one's way", async () => {
    // By metrics: the binding counts statements only, the metric the internal calls.
    expect(
      await tallyAfter(async (db, metrics) => {
        await db.batch([db.prepare("SELECT 1"), db.prepare("SELECT 2")]);
        metrics.count("d1.query", { db: "directory", op: "test" }, 2);
      }),
    ).toEqual({ d1: 2, internal: 2 });
    const db = countedD1(fakeD1());
    const metrics = createMetrics(createFakeDataset().dataset);
    const nested = await measureInvocation(
      metrics,
      { where: "do", op: "outer", d1Counting: "binding" },
      () =>
        measureInvocation(metrics, { where: "do", op: "inner" }, async () => {
          await db.prepare("SELECT 1").first();
          metrics.count("d1.query", { db: "directory", op: "test" });
          const invocation = currentInvocation();
          return { mode: invocation?.d1Counting, internal: invocation?.tally.internal };
        }),
    );
    expect(nested).toEqual({ mode: "binding", internal: 1 });
  });
});
