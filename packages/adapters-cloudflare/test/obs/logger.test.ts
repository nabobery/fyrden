import { describe, expect, it } from "vitest";
import { createFakeDataset } from "../../src/obs/fake-dataset.js";
import { createLogger, type LogLevel, requestMeta } from "../../src/obs/logger.js";
import { createMetrics } from "../../src/obs/metrics.js";

function capture() {
  const lines: { level: LogLevel; entry: Record<string, unknown> }[] = [];
  const logger = createLogger({ requestId: "req-1", principalId: "usr_1" }, (level, line) =>
    lines.push({ level, entry: JSON.parse(line) }),
  );
  return { lines, logger };
}

describe("createLogger", () => {
  it("writes one JSON object per line with the context fields", () => {
    const { lines, logger } = capture();
    logger.child({ route: "/healthz" }).info("done", { status: 200 });
    expect(lines).toEqual([
      {
        level: "info",
        entry: {
          level: "info",
          msg: "done",
          requestId: "req-1",
          principalId: "usr_1",
          route: "/healthz",
          status: 200,
        },
      },
    ]);
  });

  it("redacts every line", () => {
    const { lines, logger } = capture();
    logger.error("auth failed", { headers: { authorization: "Bearer abc" } });
    expect(lines[0]?.entry.headers).toEqual({ authorization: "[REDACTED]" });
  });

  it("passes request metadata on for the next hop", () => {
    const { logger } = capture();
    expect(requestMeta(logger.child({ act: ["agt_1"], route: "/x" }))).toEqual({
      requestId: "req-1",
      principalId: "usr_1",
      act: ["agt_1"],
    });
  });
});

describe("createMetrics", () => {
  it("writes the name as the index and dimensions in their declared order", () => {
    const { dataset, points } = createFakeDataset();
    createMetrics(dataset).count("r2.class_a", { op: "put", bucket: "fyrden-git" }, 2);
    expect(points).toEqual([{ name: "r2.class_a", blobs: ["fyrden-git", "put"], value: 2 }]);
  });
});
