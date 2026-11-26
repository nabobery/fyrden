import { describe, expect, it } from "vitest";
import {
  type CheckRunItem,
  checkCounts,
  checkTarget,
  isRequired,
  statusTarget,
} from "../app/lib/checks.js";

const RUN = "01JD0000000000000000000000";

const check = (more: Partial<CheckRunItem> = {}): CheckRunItem => ({
  name: "build",
  head_sha: "a".repeat(40),
  status: "completed",
  conclusion: "success",
  attempt: 1,
  run: { id: RUN, run_attempt: 2, job_id: 7 },
  details_url: null,
  updated_at: 1,
  ...more,
});

describe("isRequired", () => {
  const required = [
    { context: "Build", integration_id: null },
    { context: "lint", integration_id: "ci" },
    { context: "deploy", integration_id: "usr_bot" },
  ];
  it("matches names as the rulesets fold them, from any source when none is named", () => {
    expect(isRequired("build", "ci", required)).toBe(true);
    expect(isRequired("BUILD", "usr_x", required)).toBe(true);
    expect(isRequired("Build́", "ci", required)).toBe(false);
  });

  it("matches a pinned source only", () => {
    expect(isRequired("lint", "ci", required)).toBe(true);
    expect(isRequired("lint", "usr_x", required)).toBe(false);
    expect(isRequired("deploy", "ci", required)).toBe(false);
    expect(isRequired("deploy", "usr_bot", required)).toBe(true);
  });

  it("folds compatible forms as one name", () => {
    expect(isRequired("Å", "ci", [{ context: "Å", integration_id: null }])).toBe(true);
  });
});

describe("where a check leads", () => {
  it("leads a CI check to its job, or to its run when it has no job", () => {
    expect(checkTarget("acme", "web", check())).toBe(`/acme/web/actions/runs/${RUN}/job/7`);
    expect(
      checkTarget("acme", "web", check({ run: { id: RUN, run_attempt: 2, job_id: null } })),
    ).toBe(`/acme/web/actions/runs/${RUN}?attempt=2`);
    expect(checkTarget("acme", "web", check({ run: null }))).toBeNull();
  });

  it("leads a status only to a web address", () => {
    expect(statusTarget("https://ci.test/1")).toBe("https://ci.test/1");
    expect(statusTarget("http://ci.test/1")).toBe("http://ci.test/1");
    expect(statusTarget("javascript:alert(1)")).toBeNull();
    expect(statusTarget("/relative")).toBeNull();
    expect(statusTarget(null)).toBeNull();
  });
});

describe("checkCounts", () => {
  it("counts checks and statuses by what they mean for the pull request", () => {
    expect(
      checkCounts(
        [
          check(),
          check({ conclusion: "failure" }),
          check({ status: "in_progress", conclusion: null }),
          check({ conclusion: "skipped" }),
        ],
        [{ state: "error" }, { state: "pending" }, { state: "success" }],
      ),
    ).toEqual({ failing: 2, running: 2, passed: 3, total: 7 });
  });
});
