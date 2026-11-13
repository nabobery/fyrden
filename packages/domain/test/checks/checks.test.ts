import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  advanceCheck,
  type CheckSummary,
  checkNameKey,
  checkText,
  countedByDefault,
  FYRDEN_CI_SOURCE,
  isFailing,
  isFullSha,
  MAX_CHECK_NAME_LENGTH,
  MAX_STATUS_DESCRIPTION_LENGTH,
  MAX_TARGET_URL_LENGTH,
  settleStatus,
  summaryOfStatus,
  targetUrl,
} from "../../src/checks/checks.js";

const summary = (over: Partial<CheckSummary>): CheckSummary => ({
  name: "build",
  source: "usr_a",
  kind: "status",
  attempt: null,
  statusId: 1,
  status: "completed",
  conclusion: "success",
  detailsUrl: null,
  updatedAt: 0,
  ...over,
});

describe("check names", () => {
  it("compare ignoring case, in their NFC form", () => {
    expect(checkNameKey("CI/Build")).toBe("ci/build");
    expect(checkNameKey("é")).toBe(checkNameKey("é"));
    expect(checkNameKey("Café")).toBe(checkNameKey("CAFÉ"));
  });

  it("take 1 to 255 characters without control characters", () => {
    expect(checkText("default", MAX_CHECK_NAME_LENGTH)).toEqual({ ok: true, value: "default" });
    expect(checkText("x".repeat(255), MAX_CHECK_NAME_LENGTH).ok).toBe(true);
    expect(checkText("x".repeat(256), MAX_CHECK_NAME_LENGTH)).toEqual({
      ok: false,
      reason: "too_long",
    });
    expect(checkText("", MAX_CHECK_NAME_LENGTH)).toEqual({ ok: false, reason: "empty" });
    expect(checkText("a\nb", MAX_CHECK_NAME_LENGTH)).toEqual({
      ok: false,
      reason: "control_character",
    });
    expect(checkText("a\u0000", MAX_CHECK_NAME_LENGTH).ok).toBe(false);
    expect(checkText("a\u007f", MAX_CHECK_NAME_LENGTH).ok).toBe(false);
  });

  it("count characters as code points, so an emoji is one", () => {
    expect(checkText("😀".repeat(255), MAX_CHECK_NAME_LENGTH).ok).toBe(true);
    expect(checkText("😀".repeat(256), MAX_CHECK_NAME_LENGTH).ok).toBe(false);
  });

  it("key any text the same way twice, and keys equal names equally", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (name) => {
        expect(checkNameKey(checkNameKey(name))).toBe(checkNameKey(name));
        expect(checkNameKey(name.toUpperCase())).toBe(checkNameKey(name.toLowerCase()));
      }),
    );
  });
});

describe("status fields", () => {
  it("bounds a description at 140 characters", () => {
    expect(MAX_STATUS_DESCRIPTION_LENGTH).toBe(140);
    expect(checkText("d".repeat(140), MAX_STATUS_DESCRIPTION_LENGTH).ok).toBe(true);
    expect(checkText("d".repeat(141), MAX_STATUS_DESCRIPTION_LENGTH).ok).toBe(false);
  });

  it("takes an absolute http or https target URL of at most 2,048 characters", () => {
    expect(targetUrl("https://ci.example/run/1")).toEqual({
      ok: true,
      value: "https://ci.example/run/1",
    });
    expect(targetUrl("http://ci.example/1").ok).toBe(true);
    const long = `https://ci.example/${"a".repeat(MAX_TARGET_URL_LENGTH)}`;
    expect(targetUrl(long)).toEqual({ ok: false, reason: "too_long" });
    for (const bad of [
      "javascript:alert(1)",
      "data:text/html,x",
      "ftp://ci.example/",
      "/run/1",
      "ci",
    ])
      expect(targetUrl(bad)).toEqual({ ok: false, reason: "not_http" });
  });

  it("knows a full SHA from anything else", () => {
    expect(isFullSha("a".repeat(40))).toBe(true);
    expect(isFullSha("0123456789abcdef0123456789abcdef01234567")).toBe(true);
    expect(isFullSha("A".repeat(40))).toBe(false);
    expect(isFullSha("a".repeat(39))).toBe(false);
    expect(isFullSha("main")).toBe(false);
  });
});

describe("a status as a summary", () => {
  it("reads pending as in progress and the rest as a conclusion", () => {
    expect(summaryOfStatus("pending")).toEqual({ status: "in_progress", conclusion: null });
    expect(summaryOfStatus("success")).toEqual({ status: "completed", conclusion: "success" });
    expect(summaryOfStatus("failure")).toEqual({ status: "completed", conclusion: "failure" });
    expect(summaryOfStatus("error")).toEqual({ status: "completed", conclusion: "error" });
  });

  it("keeps the last non-pending state settled, so a pending re-run keeps a failure known", () => {
    expect(settleStatus(null, "pending")).toBeNull();
    expect(settleStatus(null, "failure")).toBe("failure");
    expect(settleStatus("failure", "pending")).toBe("failure");
    expect(settleStatus("failure", "success")).toBe("success");
    expect(settleStatus("success", "error")).toBe("error");
  });
});

describe("a check attempt's transitions", () => {
  const at = (status: CheckSummary["status"], conclusion: CheckSummary["conclusion"] = null) => ({
    status,
    conclusion,
  });

  it("move forward only, skipping allowed", () => {
    expect(advanceCheck(at("queued"), at("in_progress"))).toBe("applied");
    expect(advanceCheck(at("queued"), at("completed", "success"))).toBe("applied");
    expect(advanceCheck(at("in_progress"), at("completed", "failure"))).toBe("applied");
    expect(advanceCheck(at("in_progress"), at("queued"))).toBe("invalid_transition");
    expect(advanceCheck(at("completed", "success"), at("in_progress"))).toBe("invalid_transition");
  });

  it("repeat harmlessly, and never change a conclusion", () => {
    expect(advanceCheck(at("queued"), at("queued"))).toBe("unchanged");
    expect(advanceCheck(at("in_progress"), at("in_progress"))).toBe("unchanged");
    expect(advanceCheck(at("completed", "failure"), at("completed", "failure"))).toBe("unchanged");
    expect(advanceCheck(at("completed", "failure"), at("completed", "success"))).toBe(
      "invalid_transition",
    );
  });

  it("refuse a conclusion without completion, or completion without one", () => {
    expect(advanceCheck(at("queued"), at("in_progress", "success"))).toBe("invalid_update");
    expect(advanceCheck(at("queued"), at("completed", null))).toBe("invalid_update");
  });
});

describe("failing", () => {
  it("is failure, error and a timeout; not cancelled, skipped or waiting for approval", () => {
    for (const c of ["failure", "error", "timed_out"] as const) expect(isFailing(c)).toBe(true);
    for (const c of [
      "success",
      "neutral",
      "skipped",
      "cancelled",
      "action_required",
      null,
    ] as const)
      expect(isFailing(c)).toBe(false);
  });
});

describe("counted by default", () => {
  it("takes the latest status of each name across publishers, and every check row", () => {
    const older = summary({ source: "usr_a", statusId: 1, conclusion: "failure" });
    const newer = summary({ source: "agt_b", name: "BUILD", statusId: 7, conclusion: "success" });
    const other = summary({ source: "usr_a", name: "lint", statusId: 3, conclusion: "failure" });
    const check = summary({
      source: FYRDEN_CI_SOURCE,
      kind: "check",
      attempt: 2,
      statusId: null,
      conclusion: "failure",
    });
    expect(countedByDefault([older, newer, other, check])).toEqual([newer, other, check]);
  });

  it("is empty for no rows and keeps a lone status", () => {
    expect(countedByDefault([])).toEqual([]);
    const only = summary({});
    expect(countedByDefault([only])).toEqual([only]);
  });
});
