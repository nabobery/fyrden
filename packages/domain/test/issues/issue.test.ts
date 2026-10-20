import { describe, expect, it } from "vitest";
import { IssueRowSchema, MAX_ISSUE_TITLE_LENGTH } from "../../src/issues/issue.js";

const row = {
  number: 3,
  title: "Crash on start",
  body: null,
  state: "open",
  stateReason: null,
  duplicateOf: null,
  locked: false,
  lockReason: null,
  authorId: "usr_a",
  authorRoot: "usr_a",
  closedAt: null,
  closedBy: null,
  createdAt: 1,
  updatedAt: 2,
};

describe("IssueRowSchema", () => {
  it("takes an issue as events carry it", () => {
    expect(IssueRowSchema.parse(row)).toEqual(row);
  });

  it("refuses unknown fields, empty or overlong titles and unknown reasons", () => {
    expect(IssueRowSchema.safeParse({ ...row, extra: 1 }).success).toBe(false);
    expect(IssueRowSchema.safeParse({ ...row, title: "" }).success).toBe(false);
    expect(
      IssueRowSchema.safeParse({ ...row, title: "x".repeat(MAX_ISSUE_TITLE_LENGTH + 1) }).success,
    ).toBe(false);
    expect(IssueRowSchema.safeParse({ ...row, stateReason: "wontfix" }).success).toBe(false);
    expect(IssueRowSchema.safeParse({ ...row, lockReason: "boring" }).success).toBe(false);
  });
});
