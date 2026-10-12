import { beforeEach, describe, expect, it } from "vitest";
import {
  createFakeDataset,
  type RecordedPoint,
  WRITE_LIMIT_MESSAGE,
} from "../../src/obs/fake-dataset.js";
import {
  ANALYTICS_ENGINE_POINTS_PER_INVOCATION,
  atInvocationEnd,
  createMetrics,
  currentInvocation,
  Invocation,
  METRIC_POINT_BUDGET,
  METRICS,
  type MetricName,
  measureInvocation,
  recordTailMetrics,
  SUBREQUEST_BUDGETS,
} from "../../src/obs/index.js";

type Point = RecordedPoint;

/** Metrics over the fake dataset, which throws past 250 points per invocation as the platform does. */
function recording() {
  const { dataset, points } = createFakeDataset();
  return { metrics: createMetrics(dataset), points, dataset };
}

const named = (points: Point[], name: string) => points.filter((p) => p.name === name);

// A write refused outside any invocation is counted per isolate and reported
// by the next invocation that ends (by design). A test that leaves one behind
// would add it to another test's `metrics.dropped`: hand it to a throwaway
// invocation first.
beforeEach(async () => {
  await measureInvocation(recording().metrics, { where: "worker", op: "drain" }, () => {});
});

describe("metric catalogue", () => {
  const names = Object.keys(METRICS) as MetricName[];

  it("has short dotted names that fit an Analytics Engine index (96 bytes)", () => {
    for (const name of names) {
      expect(name).toMatch(/^[a-z0-9_]+(\.[a-z0-9_]+)*$/);
      expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(96);
    }
  });

  it("has at most 20 dimensions per metric (Analytics Engine's blob limit), each named once", () => {
    for (const name of names) {
      const dims = METRICS[name] as readonly string[];
      expect(dims.length).toBeLessThanOrEqual(20);
      expect(new Set(dims).size).toBe(dims.length);
    }
  });

  it("has no dimension that could carry a secret or free text from a request", () => {
    const forbidden =
      /token|secret|password|auth|cookie|email|url|path|query|header|message|address|^ip$/i;
    for (const name of names) {
      for (const dim of METRICS[name]) expect(dim, `${name}.${dim}`).not.toMatch(forbidden);
    }
  });

  it("names the engine metrics the operator docs describe", () => {
    expect(METRICS["git.repo.packs"]).toEqual(["repo", "group"]);
    expect(METRICS["git.repo.bytes"]).toEqual(["repo", "group"]);
    expect(METRICS.subrequests).toEqual(["where", "budget", "op"]);
    expect(METRICS["do.active_ms"]).toEqual(["class", "method"]);
    expect(METRICS["worker.cpu_ms"]).toEqual([
      "script",
      "entrypoint",
      "event",
      "method",
      "outcome",
    ]);
  });

  it("writes only the metric name as the index, whatever the dimensions hold", () => {
    const { metrics, points } = recording();
    metrics.count("git.repo.packs", { repo: "rep_1", group: "live_own" });
    metrics.count("subrequests", { where: "do", budget: "internal", op: "planFetch" }, 3);
    expect(points.map((p) => p.name)).toEqual(["git.repo.packs", "subrequests"]);
    expect(points[0]?.blobs).toEqual(["rep_1", "live_own"]);
    expect(points[1]?.value).toBe(3);
  });

  it("assigns R2, D1 and Durable Object calls to the internal budget", () => {
    expect(SUBREQUEST_BUDGETS).toEqual({
      "r2.class_a": "internal",
      "r2.class_b": "internal",
      "d1.query": "internal",
      "do.request": "internal",
    });
  });
});

describe("invocations", () => {
  it("counts cost counters made inside an invocation, across awaits, and writes them at the end", async () => {
    const { metrics, points } = recording();
    let clock = 1_000;
    await measureInvocation(
      metrics,
      { where: "do", op: "planFetch", doClass: "RepoDO", now: () => clock },
      async () => {
        metrics.count("r2.class_b", { bucket: "fyrden-git", op: "get" }, 2);
        await new Promise((resolve) => setTimeout(resolve, 1));
        metrics.count("do.rows_written", { class: "RepoDO", op: "x" }, 7);
        metrics.count("r2.class_a", { bucket: "fyrden-git", op: "put" });
        currentInvocation()?.add("external", 4);
        clock = 1_250;
      },
    );
    expect(named(points, "subrequests").map((p) => [p.blobs, [p.value]])).toEqual([
      [["do", "internal", "planFetch"], [3]],
      [["do", "external", "planFetch"], [4]],
    ]);
    expect(named(points, "do.active_ms").map((p) => [p.blobs, [p.value]])).toEqual([
      [["RepoDO", "planFetch"], [250]],
    ]);
  });

  it("keeps concurrent invocations apart", async () => {
    const { metrics, points } = recording();
    const one = (op: string, calls: number) =>
      measureInvocation(metrics, { where: "do", op }, async () => {
        for (let i = 0; i < calls; i++) {
          await new Promise((resolve) => setTimeout(resolve, 1));
          metrics.count("r2.class_b", { bucket: "b", op: "get" });
        }
      });
    await Promise.all([one("a", 3), one("b", 5)]);
    const totals = Object.fromEntries(
      named(points, "subrequests").map((p) => [p.blobs[2], p.value]),
    );
    expect(totals).toEqual({ a: 3, b: 5 });
  });

  it("does not count calls made outside any invocation", () => {
    const { metrics, points } = recording();
    metrics.count("r2.class_b", { bucket: "b", op: "get" });
    expect(currentInvocation()).toBeUndefined();
    expect(named(points, "subrequests")).toEqual([]);
  });

  it("writes nothing for a budget it did not use, and still records the wall time", async () => {
    const { metrics, points } = recording();
    await measureInvocation(metrics, { where: "do", op: "alarm", doClass: "RepoDO" }, () => 1);
    expect(named(points, "subrequests")).toEqual([]);
    expect(named(points, "do.active_ms")).toHaveLength(1);
  });

  it("writes on the last release when background work holds it open, once", async () => {
    const { metrics, points } = recording();
    const invocation = new Invocation(metrics, { where: "worker", op: "unmatched" });
    let release: () => void = () => {};
    invocation.run(() => {
      metrics.count("do.request", { class: "RepoDO", method: "planFetch" });
      release = invocation.hold();
    });
    invocation.op = "/:owner/:repo/git-upload-pack";
    invocation.end();
    expect(named(points, "subrequests")).toEqual([]);
    invocation.run(() => metrics.count("r2.class_b", { bucket: "b", op: "get" }, 2));
    release();
    release();
    invocation.end();
    expect(named(points, "subrequests").map((p) => [p.blobs, [p.value]])).toEqual([
      [["worker", "internal", "/:owner/:repo/git-upload-pack"], [3]],
    ]);
    // Counted after the end: ignored.
    invocation.run(() => metrics.count("r2.class_b", { bucket: "b", op: "get" }));
    expect(named(points, "subrequests")).toHaveLength(1);
  });

  it("writes its counts when the work throws", async () => {
    const { metrics, points } = recording();
    await expect(
      measureInvocation(metrics, { where: "do", op: "runPush" }, async () => {
        metrics.count("r2.class_b", { bucket: "b", op: "get" });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(named(points, "subrequests").map((p) => p.value)).toEqual([1]);
  });
});

describe("the per-invocation data point limit", () => {
  const throwing: AnalyticsEngineDataset = {
    writeDataPoint() {
      throw new Error(WRITE_LIMIT_MESSAGE);
    },
  };

  it("the fake dataset throws past 250 points in one invocation, as the platform does", async () => {
    const { dataset } = createFakeDataset();
    const write = (i: number) =>
      dataset.writeDataPoint({ indexes: ["x"], blobs: [String(i)], doubles: [1] });
    await measureInvocation(createMetrics(dataset), { where: "do", op: "a" }, () => {
      for (let i = 0; i < ANALYTICS_ENGINE_POINTS_PER_INVOCATION; i++) write(i);
      expect(() => write(250)).toThrow(WRITE_LIMIT_MESSAGE);
    });
    // A new invocation starts a new count.
    await measureInvocation(createMetrics(dataset), { where: "do", op: "b" }, () => write(0));
  });

  it("never throws into the operation when the dataset throws, inside or outside an invocation", async () => {
    const metrics = createMetrics(throwing);
    expect(() => metrics.count("do.request", { class: "RepoDO", method: "x" })).not.toThrow();
    await expect(
      measureInvocation(metrics, { where: "do", op: "alarm", doClass: "RepoDO" }, () => {
        metrics.count("r2.class_b", { bucket: "b", op: "get" });
        return 7;
      }),
    ).resolves.toBe(7);
  });

  it("sums a counter's points per name and dimensions, written once when the invocation ends", async () => {
    const { metrics, points } = recording();
    await measureInvocation(metrics, { where: "do", op: "lsRefs" }, async () => {
      for (let i = 0; i < 1_000; i++) {
        metrics.count("r2.class_b", { bucket: "fyrden-git", op: "get" });
        if (i % 100 === 0) await Promise.resolve();
      }
      metrics.count("r2.class_b", { bucket: "fyrden-git", op: "head" }, 2);
      expect(named(points, "r2.class_b")).toEqual([]);
    });
    expect(named(points, "r2.class_b").map((p) => [p.blobs, p.value])).toEqual([
      [["fyrden-git", "get"], 1_000],
      [["fyrden-git", "head"], 2],
    ]);
    expect(named(points, "subrequests").map((p) => p.value)).toEqual([1_002]);
  });

  it("writes a gauge once per invocation with its last value", async () => {
    const { metrics, points } = recording();
    await measureInvocation(metrics, { where: "do", op: "finalizePush" }, () => {
      for (let commit = 1; commit <= 30; commit++) {
        metrics.count("git.repo.packs", { repo: "rep_1", group: "live_own" }, commit);
        metrics.count("git.repo.packs", { repo: "rep_1", group: "pending" }, 0);
      }
    });
    expect(named(points, "git.repo.packs").map((p) => [p.blobs[1], p.value])).toEqual([
      ["live_own", 30],
      ["pending", 0],
    ]);
  });

  it("keeps a budget below the platform's limit and counts the points it drops", async () => {
    const { metrics, points } = recording();
    await measureInvocation(metrics, { where: "do", op: "alarm", doClass: "RepoDO" }, () => {
      for (let i = 0; i < 600; i++) metrics.count("git.reaped", { what: `kind_${i}` });
    });
    expect(points.length).toBe(METRIC_POINT_BUDGET);
    expect(METRIC_POINT_BUDGET).toBeLessThan(ANALYTICS_ENGINE_POINTS_PER_INVOCATION);
    // The invocation's own points come first; the dropped count is the last point.
    expect(named(points, "do.active_ms")).toHaveLength(1);
    const dropped = named(points, "metrics.dropped");
    expect(dropped.map((p) => p.blobs)).toEqual([["do", "alarm"]]);
    const written = named(points, "git.reaped").length;
    expect(dropped[0]?.value).toBe(600 - written);
  });

  it("drops the rest once the platform refuses a write, and the invocation still ends cleanly", async () => {
    let calls = 0;
    const dataset: AnalyticsEngineDataset = {
      writeDataPoint() {
        if (++calls > 3) throw new Error(WRITE_LIMIT_MESSAGE);
      },
    };
    const metrics = createMetrics(dataset);
    await measureInvocation(metrics, { where: "worker", op: "x" }, () => {
      for (let i = 0; i < 10; i++) metrics.count("git.reaped", { what: `k${i}` });
    });
    // Three written, one refused; nothing more is tried, not even the dropped count.
    expect(calls).toBe(4);
  });

  it("writes each per-invocation sample apart (Tail CPU times), within the budget", async () => {
    const { metrics, points } = recording();
    const events = Array.from(
      { length: 300 },
      (_, i) =>
        ({
          event: null,
          scriptName: "fyrden-api",
          outcome: "ok",
          cpuTime: i,
          wallTime: i,
        }) as unknown as TraceItem,
    );
    await measureInvocation(metrics, { where: "worker", op: "tail" }, () =>
      recordTailMetrics(events, metrics),
    );
    expect(points.length).toBe(METRIC_POINT_BUDGET);
    expect(
      named(points, "worker.cpu_ms")
        .slice(0, 3)
        .map((p) => p.value),
    ).toEqual([0, 1, 2]);
    expect(named(points, "metrics.dropped")[0]?.value).toBe(
      600 - named(points, "worker.cpu_ms").length - named(points, "worker.wall_ms").length,
    );
  });

  it("shares one budget between nested invocations", async () => {
    const { metrics, points } = recording();
    await measureInvocation(metrics, { where: "do", op: "outer" }, async () => {
      for (let i = 0; i < 150; i++) metrics.count("git.reaped", { what: `outer_${i}` });
      await measureInvocation(metrics, { where: "do", op: "inner" }, () => {
        for (let i = 0; i < 150; i++) metrics.count("git.reaped", { what: `inner_${i}` });
      });
    });
    expect(points.length).toBeLessThanOrEqual(METRIC_POINT_BUDGET);
    expect(named(points, "metrics.dropped")).toHaveLength(1);
  });

  it("runs work deferred to the end of the invocation once per key, and at once outside one", async () => {
    const { metrics, points } = recording();
    let runs = 0;
    const gauge = () => {
      runs++;
      metrics.count("git.repo.packs", { repo: "rep_1", group: "live_own" }, runs);
    };
    await measureInvocation(metrics, { where: "do", op: "finalizePush" }, () => {
      for (let i = 0; i < 30; i++) atInvocationEnd("storage", gauge);
      atInvocationEnd("failing", () => {
        throw new Error("ignored");
      });
      expect(runs).toBe(0);
    });
    expect(runs).toBe(1);
    expect(named(points, "git.repo.packs").map((p) => p.value)).toEqual([1]);
    atInvocationEnd("storage", gauge);
    expect(runs).toBe(2);
  });

  it("writes points counted after the end at once, still within the budget", async () => {
    const { metrics, points } = recording();
    const invocation = new Invocation(metrics, { where: "worker", op: "late" });
    invocation.end();
    for (let i = 0; i < 300; i++) {
      invocation.run(() => metrics.count("git.reaped", { what: `late_${i}` }));
    }
    expect(points.length).toBeLessThan(ANALYTICS_ENGINE_POINTS_PER_INVOCATION);
  });
});

describe("recordTailMetrics", () => {
  const item = (overrides: Partial<TraceItem>): TraceItem =>
    ({
      event: null,
      eventTimestamp: 1,
      logs: [],
      exceptions: [],
      diagnosticsChannelEvents: [],
      scriptName: "fyrden-api",
      outcome: "ok",
      executionModel: "stateless",
      truncated: false,
      cpuTime: 0,
      wallTime: 0,
      ...overrides,
    }) as TraceItem;

  it("writes CPU and wall time by script, entrypoint, event kind, method and outcome", () => {
    const { metrics, points } = recording();
    recordTailMetrics(
      [
        item({
          event: {
            request: { url: "https://x.example/secret?token=abc", headers: {}, method: "POST" },
          } as unknown as TraceItemFetchEventInfo,
          cpuTime: 12,
          wallTime: 340,
        }),
        item({
          entrypoint: "RepoDO",
          event: { rpcMethod: "planFetch" } as TraceItemJsRpcEventInfo,
          cpuTime: 85,
          wallTime: 900,
        }),
        item({
          entrypoint: "RepoDO",
          event: { scheduledTime: new Date(0) } as TraceItemAlarmEventInfo,
          outcome: "exceededCpu",
          cpuTime: 30_001,
          wallTime: 31_000,
        }),
      ],
      metrics,
    );
    expect(named(points, "worker.cpu_ms").map((p) => [p.blobs, p.value])).toEqual([
      [["fyrden-api", "", "fetch", "", "ok"], 12],
      [["fyrden-api", "RepoDO", "rpc", "planFetch", "ok"], 85],
      [["fyrden-api", "RepoDO", "alarm", "", "exceededCpu"], 30_001],
    ]);
    expect(named(points, "worker.wall_ms").map((p) => p.value)).toEqual([340, 900, 31_000]);
    // Nothing from the request (URL, query, headers) reaches a data point.
    expect(JSON.stringify(points)).not.toMatch(/secret|token|x\.example/);
  });

  it("records names that are not plain code names as other", () => {
    const { metrics, points } = recording();
    recordTailMetrics(
      [
        item({
          scriptName: null,
          entrypoint: "Repo DO with spaces",
          event: { rpcMethod: "x".repeat(65) } as TraceItemJsRpcEventInfo,
        }),
      ],
      metrics,
    );
    expect(named(points, "worker.cpu_ms")[0]?.blobs).toEqual([
      "other",
      "other",
      "rpc",
      "other",
      "ok",
    ]);
  });
});
