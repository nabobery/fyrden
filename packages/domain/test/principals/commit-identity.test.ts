import { describe, expect, it } from "vitest";
import { coAuthorTrailers, serverCommitIdentity } from "../../src/principals/commit-identity.js";

const host = "fyrden.test";
const ada = { id: "usr_ada", handle: "ada" };
const bot = { id: "agt_bot", handle: "bot" };

describe("serverCommitIdentity", () => {
  it("makes the platform the committer and the person the author when no agent acts", () => {
    expect(serverCommitIdentity({ host, principal: ada, actingAgent: null })).toEqual({
      author: { name: "ada", email: "usr_ada@users.noreply.fyrden.test" },
      committer: { name: "Fyrden", email: "noreply@fyrden.test" },
      coAuthors: [],
    });
  });

  it("makes an agent acting for a person the author, naming the person as co-author", () => {
    const identity = serverCommitIdentity({ host, principal: ada, actingAgent: bot });
    expect(identity.author).toEqual({ name: "bot", email: "agt_bot@users.noreply.fyrden.test" });
    expect(identity.coAuthors).toEqual([
      { name: "ada", email: "usr_ada@users.noreply.fyrden.test" },
    ]);
  });

  it("names no one for an agent using its own token, and uses the id without a handle", () => {
    const identity = serverCommitIdentity({
      host,
      principal: { id: "agt_x", handle: null },
      actingAgent: null,
    });
    expect(identity.author.name).toBe("agt_x");
    expect(identity.coAuthors).toEqual([]);
  });
});

describe("coAuthorTrailers", () => {
  const ada = { name: "ada", email: "usr_ada@users.noreply.fyrden.test" };

  it("names each person not yet named, by email whatever its case", () => {
    expect(coAuthorTrailers("Fix", [ada])).toEqual([
      "Co-authored-by: ada <usr_ada@users.noreply.fyrden.test>",
    ]);
    expect(
      coAuthorTrailers("Fix\n\nCo-authored-by: Ada <USR_ADA@users.noreply.fyrden.test>", [ada]),
    ).toEqual([]);
    expect(coAuthorTrailers("Fix", [])).toEqual([]);
  });
});
