// Which trigger of a workflow an event matches, and the skip directives.
// GitHub's rules: https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax
// (on.push branches/tags/paths, on.pull_request branches/paths) and
// https://docs.github.com/en/actions/how-tos/manage-workflow-runs/skip-workflow-runs, verified 2026-11-15.
import { describe, expect, it } from "vitest";
import {
  hasSkipDirective,
  matchEvent,
  needsPaths,
  skipDirectiveApplies,
  type TriggerEvent,
} from "../../src/ci/triggers.js";
import type { Filter, Trigger } from "../../src/ci/workflow-schema.js";

const at = { line: 1, column: 1 };
const filter = (mode: Filter["mode"], ...patterns: string[]): Filter => ({
  mode,
  patterns: patterns.map((value) => ({ value, at })),
  at,
});
const include = (...patterns: string[]) => filter("include", ...patterns);
const ignore = (...patterns: string[]) => filter("ignore", ...patterns);

const push = (ref: string, created = false): TriggerEvent => ({ kind: "push", ref, created });
const pull = (
  action: string,
  baseRef = "refs/heads/main",
  kind: "pull_request" | "pull_request_target" = "pull_request",
): TriggerEvent => ({ kind, action, baseRef });
const changed = (...paths: string[]) => ({ paths, complete: true });

describe("matchEvent: push", () => {
  it("matches any branch or tag with no filters", () => {
    const t: Trigger = { event: "push", at };
    expect(matchEvent([t], push("refs/heads/feature/x"))).toBe(t);
    expect(matchEvent([t], push("refs/tags/v1"))).toBe(t);
  });

  it("ignores refs that are neither branches nor tags", () => {
    expect(matchEvent([{ event: "push", at }], push("refs/notes/commits"))).toBeNull();
  });

  it("filters branches by name, and by -ignore", () => {
    const t: Trigger = { event: "push", at, branches: include("main", "releases/**") };
    expect(matchEvent([t], push("refs/heads/main"))).toBe(t);
    expect(matchEvent([t], push("refs/heads/releases/1/x"))).toBe(t);
    expect(matchEvent([t], push("refs/heads/dev"))).toBeNull();
    const i: Trigger = { event: "push", at, branches: ignore("dev") };
    expect(matchEvent([i], push("refs/heads/dev"))).toBeNull();
    expect(matchEvent([i], push("refs/heads/main"))).toBe(i);
  });

  it("filters tags by name, and by -ignore", () => {
    const t: Trigger = { event: "push", at, tags: include("v[0-9]+") };
    expect(matchEvent([t], push("refs/tags/v12"))).toBe(t);
    expect(matchEvent([t], push("refs/tags/beta"))).toBeNull();
    const i: Trigger = { event: "push", at, tags: ignore("beta*") };
    expect(matchEvent([i], push("refs/tags/beta1"))).toBeNull();
    expect(matchEvent([i], push("refs/tags/v1"))).toBe(i);
  });

  it("runs only tags filters for tags and only branches filters for branches", () => {
    const tagsOnly: Trigger = { event: "push", at, tags: include("**") };
    expect(matchEvent([tagsOnly], push("refs/heads/main"))).toBeNull();
    expect(matchEvent([tagsOnly], push("refs/tags/v1"))).toBe(tagsOnly);
    const tagsIgnoreOnly: Trigger = { event: "push", at, tags: ignore("x") };
    expect(matchEvent([tagsIgnoreOnly], push("refs/heads/main"))).toBeNull();
    const branchesOnly: Trigger = { event: "push", at, branches: ignore("x") };
    expect(matchEvent([branchesOnly], push("refs/tags/v1"))).toBeNull();
    expect(matchEvent([branchesOnly], push("refs/heads/main"))).toBe(branchesOnly);
    const both: Trigger = { event: "push", at, branches: include("main"), tags: include("v*") };
    expect(matchEvent([both], push("refs/heads/main"))).toBe(both);
    expect(matchEvent([both], push("refs/tags/v1"))).toBe(both);
  });

  it("filters paths with ordered negation and -ignore", () => {
    const t: Trigger = { event: "push", at, paths: include("src/**", "!src/docs/**") };
    const main = push("refs/heads/main");
    expect(matchEvent([t], main, changed("src/a.ts"))).toBe(t);
    expect(matchEvent([t], main, changed("src/docs/a.md"))).toBeNull();
    expect(matchEvent([t], main, changed("README.md"))).toBeNull();
    expect(matchEvent([t], main, changed())).toBeNull();
    const i: Trigger = { event: "push", at, paths: ignore("docs/**") };
    expect(matchEvent([i], main, changed("docs/a.md"))).toBeNull();
    expect(matchEvent([i], main, changed("docs/a.md", "src/a.ts"))).toBe(i);
  });

  it("needs both the branches and the paths filter to pass", () => {
    const t: Trigger = { event: "push", at, branches: include("main"), paths: include("src/**") };
    expect(matchEvent([t], push("refs/heads/dev"), changed("src/a.ts"))).toBeNull();
    expect(matchEvent([t], push("refs/heads/main"), changed("lib/a.ts"))).toBeNull();
    expect(matchEvent([t], push("refs/heads/main"), changed("src/a.ts"))).toBe(t);
  });

  it("counts paths as matched for an incomplete diff and a new branch", () => {
    const t: Trigger = { event: "push", at, paths: include("src/**") };
    const capped = { paths: ["README.md"], complete: false };
    expect(matchEvent([t], push("refs/heads/main"), capped)).toBe(t);
    expect(matchEvent([t], push("refs/heads/new", true))).toBe(t);
    expect(needsPaths([t], push("refs/heads/new", true))).toBe(false);
  });

  it("ignores paths filters on tag pushes", () => {
    const t: Trigger = { event: "push", at, paths: include("src/**") };
    expect(matchEvent([t], push("refs/tags/v1"))).toBe(t);
    expect(needsPaths([t], push("refs/tags/v1"))).toBe(false);
  });

  it("asks for paths only when a trigger that passed its other filters has a paths filter", () => {
    const paths: Trigger = { event: "push", at, branches: include("main"), paths: include("a") };
    expect(needsPaths([paths], push("refs/heads/main"))).toBe(true);
    expect(needsPaths([paths], push("refs/heads/dev"))).toBe(false);
    expect(needsPaths([{ event: "push", at }], push("refs/heads/main"))).toBe(false);
    expect(needsPaths([paths], pull("opened"))).toBe(false);
  });

  it("refuses to guess when paths are needed and not given", () => {
    const t: Trigger = { event: "push", at, paths: include("a") };
    expect(() => matchEvent([t], push("refs/heads/main"))).toThrow(/changed paths/);
    expect(() => matchEvent([t], push("refs/heads/main"), "not_needed")).toThrow(/changed paths/);
  });
});

describe("matchEvent: pull requests", () => {
  it("runs on opened, synchronize and reopened by default", () => {
    const t: Trigger = { event: "pull_request", at };
    for (const action of ["opened", "synchronize", "reopened"])
      expect(matchEvent([t], pull(action))).toBe(t);
    for (const action of ["closed", "edited", "labeled"])
      expect(matchEvent([t], pull(action))).toBeNull();
  });

  it("runs on the listed types only", () => {
    const t: Trigger = { event: "pull_request", at, types: [{ value: "closed", at }] };
    expect(matchEvent([t], pull("closed"))).toBe(t);
    expect(matchEvent([t], pull("opened"))).toBeNull();
  });

  it("filters branches on the base branch", () => {
    const t: Trigger = { event: "pull_request", at, branches: include("main") };
    expect(matchEvent([t], pull("opened", "refs/heads/main"))).toBe(t);
    expect(matchEvent([t], pull("opened", "refs/heads/dev"))).toBeNull();
    const i: Trigger = { event: "pull_request", at, branches: ignore("main") };
    expect(matchEvent([i], pull("opened", "refs/heads/main"))).toBeNull();
  });

  it("filters paths on the given diff", () => {
    const t: Trigger = { event: "pull_request", at, paths: include("src/**") };
    expect(needsPaths([t], pull("opened"))).toBe(true);
    expect(needsPaths([t], pull("closed"))).toBe(false);
    expect(matchEvent([t], pull("opened"), changed("src/a"))).toBe(t);
    expect(matchEvent([t], pull("opened"), changed("lib/a"))).toBeNull();
    expect(matchEvent([t], pull("opened"), { paths: [], complete: false })).toBe(t);
  });

  it("keeps pull_request and pull_request_target apart", () => {
    const head: Trigger = { event: "pull_request", at };
    const target: Trigger = { event: "pull_request_target", at };
    expect(matchEvent([head, target], pull("opened", undefined, "pull_request"))).toBe(head);
    expect(matchEvent([head, target], pull("opened", undefined, "pull_request_target"))).toBe(
      target,
    );
    expect(matchEvent([head], pull("opened", undefined, "pull_request_target"))).toBeNull();
  });
});

describe("matchEvent: schedule and dispatch", () => {
  const schedule: Trigger = {
    event: "schedule",
    at,
    crons: [
      { value: "0 5 * * *", at },
      { value: "*/15 * * * *", at },
    ],
  };
  const dispatch: Trigger = { event: "workflow_dispatch", at, inputs: [] };

  it("matches a schedule by its cron text", () => {
    expect(matchEvent([schedule], { kind: "schedule", cron: "*/15 * * * *" })).toBe(schedule);
    expect(matchEvent([schedule], { kind: "schedule", cron: "0 6 * * *" })).toBeNull();
  });

  it("matches each only by its own event", () => {
    expect(matchEvent([schedule, dispatch], { kind: "workflow_dispatch" })).toBe(dispatch);
    expect(matchEvent([schedule], { kind: "workflow_dispatch" })).toBeNull();
    expect(matchEvent([schedule, dispatch], push("refs/heads/main"))).toBeNull();
    expect(matchEvent([schedule, dispatch], pull("opened"))).toBeNull();
    expect(matchEvent([{ event: "push", at }], { kind: "schedule", cron: "0 5 * * *" })).toBeNull();
  });
});

describe("hasSkipDirective", () => {
  it.each(["[skip ci]", "[ci skip]", "[no ci]", "[skip actions]", "[actions skip]"])(
    "finds %s anywhere in the message",
    (directive) => {
      expect(hasSkipDirective(`${directive} fix`)).toBe(true);
      expect(hasSkipDirective(`fix the build\n\nsome text ${directive} more`)).toBe(true);
    },
  );

  it("finds a final skip-checks trailer", () => {
    expect(hasSkipDirective("fix\n\n\nskip-checks: true")).toBe(true);
    expect(hasSkipDirective("fix\n\nbody text\n\nskip-checks: true")).toBe(true);
    expect(hasSkipDirective("fix\n\nSigned-off-by:  A <a@b>\nskip-checks: true")).toBe(true);
    expect(hasSkipDirective("fix\n\nSigned-off-by:\tA <a@b>\nskip-checks: true")).toBe(true);
    expect(hasSkipDirective("fix\n\nSigned-off-by: A <a@b>\nskip-checks:true\n")).toBe(true);
    expect(hasSkipDirective("fix\r\n\r\nskip-checks: true\r\n")).toBe(true);
  });

  it("ignores near misses", () => {
    expect(hasSkipDirective("fix [skip-ci]")).toBe(false);
    expect(hasSkipDirective("skip ci")).toBe(false);
    expect(hasSkipDirective("fix\n\nskip-checks: true\nSigned-off-by: A <a@b>")).toBe(false);
    expect(hasSkipDirective("fix\n\nskip-checks: false")).toBe(false);
    // Not a trailer section: the line is part of the subject or the body paragraph.
    expect(hasSkipDirective("fix\nskip-checks: true")).toBe(false);
    expect(hasSkipDirective("fix\n\nwe should not\nskip-checks: true")).toBe(false);
    expect(hasSkipDirective("")).toBe(false);
  });
});

describe("skipDirectiveApplies", () => {
  it("is true for push and pull_request only", () => {
    expect(skipDirectiveApplies("push")).toBe(true);
    expect(skipDirectiveApplies("pull_request")).toBe(true);
    expect(skipDirectiveApplies("pull_request_target")).toBe(false);
    expect(skipDirectiveApplies("schedule")).toBe(false);
    expect(skipDirectiveApplies("workflow_dispatch")).toBe(false);
  });
});
