// The blame operation's contract: its route, permission and cost class, what
// its input admits, the answer's shape, and the guidance an agent reads.
import { describe, expect, it } from "vitest";
import { getBlame, UNRESOLVED_REASONS } from "../ops/browse.js";
import { Problem } from "../src/problem.js";

const input = (extra: Record<string, unknown> = {}) =>
  getBlame.input.safeParse({ owner: "octo", repo: "hello", path: "src/a.ts", ...extra });

describe("repos.blame.get", () => {
  const mcp = getBlame.mcp || undefined;

  it("is a read of a repository's contents, costed as expensive, and an MCP tool", () => {
    expect({
      id: getBlame.id,
      method: getBlame.method,
      path: getBlame.path,
      permission: getBlame.permission,
      principals: getBlame.principals,
      rateLimit: getBlame.rateLimit,
      idempotency: getBlame.idempotency,
      tool: mcp?.tool,
      readOnly: mcp?.readOnly,
    }).toEqual({
      id: "repos.blame.get",
      method: "GET",
      path: "/repos/{owner}/{repo}/blame",
      permission: "contents:read",
      principals: ["user", "agent"],
      rateLimit: "expensive",
      idempotency: "none",
      tool: "get_blame",
      readOnly: true,
    });
  });

  it("tells an agent to page to the end, that unresolved isn't failure, and how to wait", () => {
    const told = `${getBlame.description} ${mcp?.description}`;
    for (const phrase of ["next_continuation", "unresolved", "retry_after", "commit"])
      expect([phrase, told.includes(phrase)]).toEqual([phrase, true]);
  });

  it("takes a path, a ref, a continuation and a page size within their bounds", () => {
    expect(input().success).toBe(true);
    expect(input().data).toMatchObject({ per_page: 1000 });
    expect(input({ ref: "main", continuation: "abc", per_page: "5000" }).success).toBe(true);
    for (const bad of [
      { path: "" },
      { path: "a".repeat(4097) },
      { per_page: 0 },
      { per_page: 5001 },
      { continuation: "x".repeat(1025) },
    ])
      expect([bad, input(bad).success]).toEqual([bad, false]);
  });

  it("takes a window of both lines, in order, at most 5,000 apart", () => {
    expect(input({ line_start: "2", line_end: "4" }).success).toBe(true);
    expect(input({ line_start: 1, line_end: 5000 }).success).toBe(true);
    for (const bad of [
      { line_start: 2 },
      { line_end: 4 },
      { line_start: 5, line_end: 4 },
      { line_start: 1, line_end: 5001 },
      { line_start: 0, line_end: 1 },
    ])
      expect([bad, input(bad).success]).toEqual([bad, false]);
  });

  it("answers ranges settled to a commit or refused for a reason, with the commits' facts", () => {
    const answer = {
      commit: "a".repeat(40),
      path: "src/a.ts",
      blob: "b".repeat(40),
      lines: 3,
      state: "partial",
      resolved_lines: 1,
      unresolved_lines: 1,
      pending_lines: 1,
      ranges: [
        { start_line: 1, line_count: 1, commit: "c".repeat(40), source_start_line: 4 },
        { start_line: 2, line_count: 1, unresolved: "step_lost" },
      ],
      commits: {
        ["c".repeat(40)]: {
          summary: "s",
          author: { name: "n", email: "e", date: "1700000000 +0100" },
        },
      },
      next_continuation: "token",
      retry_after_seconds: 1,
    };
    expect(getBlame.output.safeParse(answer).success).toBe(true);
    const unknown = { ...answer, ranges: [{ start_line: 1, line_count: 1, unresolved: "other" }] };
    expect(getBlame.output.safeParse(unknown).success).toBe(false);
  });

  it("names every reason a line can be unresolved for, in the engine's order", () => {
    expect(UNRESOLVED_REASONS).toEqual([
      "parent_too_large",
      "too_many_parents",
      "diff_budget",
      "slide_unsettled",
      "object_limit",
      "work_limit",
      "history_unreadable",
      "history_missing",
      "history_limit",
      "state_limit",
      "commit_info_too_large",
      "rename_possible",
      "step_lost",
    ]);
  });

  it("says a problem's retry_after comes with a 503 too", () => {
    expect(Problem.shape.retry_after.description).toContain("503");
  });
});
