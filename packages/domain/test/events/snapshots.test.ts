import { describe, expect, it } from "vitest";
import { parseRepoRow, REPO_ENTITY, type RepoRow } from "../../src/events/snapshots.js";

const row: RepoRow = {
  ownerId: "usr_01K742SG00NAWD8WB4RTMJF8H7",
  name: "fyrden",
  visibility: "private",
  defaultBranch: "refs/heads/main",
  pushedAt: null,
  createdAt: 1_760_000_000_000,
};

describe("repository snapshot rows", () => {
  it("names the entity type the read model projects", () => {
    expect(REPO_ENTITY).toBe("repo");
  });

  it("parse a full row", () => {
    expect(parseRepoRow(JSON.parse(JSON.stringify(row)))).toEqual(row);
    const long = `refs/heads/${"b".repeat(1024 - "refs/heads/".length)}`;
    expect(parseRepoRow({ ...row, defaultBranch: long })?.defaultBranch).toBe(long);
    expect(parseRepoRow({ ...row, defaultBranch: `${long}b` })).toBeUndefined();
    expect(parseRepoRow({ ...row, defaultBranch: null, pushedAt: 1 })).toEqual({
      ...row,
      defaultBranch: null,
      pushedAt: 1,
    });
  });

  it.each<[string, unknown]>([
    ["a missing field", { ...row, name: undefined }],
    ["an unknown visibility", { ...row, visibility: "secret" }],
    ["a bad owner id", { ...row, ownerId: "alice" }],
    ["a default branch outside refs/heads/", { ...row, defaultBranch: "main" }],
    ["a bare refs/heads/", { ...row, defaultBranch: "refs/heads/" }],
    ["a branch with a space", { ...row, defaultBranch: "refs/heads/a b" }],
    ["an owner that is a repository", { ...row, ownerId: "rep_01K742SG0021RA8PP539MVRVBJ" }],
    ["an unknown field", { ...row, stars: 1 }],
  ])("reject a row with %s", (_, value) => {
    expect(parseRepoRow(value)).toBeUndefined();
  });
});
