import { describe, expect, it } from "vitest";
import { createFakeDataset } from "../../src/obs/fake-dataset.js";
import { countedD1, d1StatementsRun, measureInvocation } from "../../src/obs/index.js";
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
