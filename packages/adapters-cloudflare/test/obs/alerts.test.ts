import { generateToken, mentionsToken, secureRandomBytes } from "@fyrden/domain";
import { describe, expect, it } from "vitest";
import { reportTailAlerts } from "../../src/obs/alerts.js";
import { createLogger } from "../../src/obs/logger.js";

function trace(outcome: string, exceptionNames: string[] = []): TraceItem {
  return {
    outcome,
    scriptName: "fyrden-api",
    exceptions: exceptionNames.map((name) => ({ name, message: "boom", timestamp: 0 })),
  } as unknown as TraceItem;
}

function capture() {
  const lines: string[] = [];
  return { lines, log: createLogger({}, (_, line) => lines.push(line)) };
}

describe("reportTailAlerts", () => {
  it("alerts on failed outcomes and exceptions only", () => {
    const { lines, log } = capture();
    reportTailAlerts(
      [trace("ok"), trace("exceededCpu"), trace("ok", ["TypeError"]), trace("exception")],
      log,
    );
    expect(lines.map((l) => JSON.parse(l).alert)).toEqual([
      "cpu_limit",
      "worker_error",
      "worker_error",
    ]);
  });

  it("never logs exception messages, and redacts a token in an exception name", () => {
    const token = generateToken("pat", secureRandomBytes);
    const { lines, log } = capture();
    reportTailAlerts([trace("exception", [`Error ${token}`])], log);
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("boom");
    expect(mentionsToken(lines[0] as string)).toBe(false);
    expect(lines[0]).not.toContain(token);
  });
});
