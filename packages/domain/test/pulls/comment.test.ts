import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { atLeast, REPO_ROLES } from "../../src/authz/roles.js";
import { decideComment } from "../../src/pulls/comment.js";

describe("decideComment", () => {
  it("lets anyone who reads comment, authors change their own, and writers anyone's", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("create", "edit", "delete" as const),
        fc.boolean(),
        fc.constantFrom(null, ...REPO_ROLES),
        (action, isCommentAuthor, role) => {
          const ok =
            atLeast(role, "read") &&
            (action === "create" || isCommentAuthor || atLeast(role, "write"));
          expect(decideComment(action, { isCommentAuthor, role }).ok).toBe(ok);
        },
      ),
    );
  });

  it("refuses a triager editing someone else's comment", () => {
    expect(decideComment("edit", { isCommentAuthor: false, role: "triage" }).ok).toBe(false);
  });
});

describe("decideComment on a locked conversation", () => {
  it("lets only write and above comment, edit or delete, their own comments included", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("create", "edit", "delete" as const),
        fc.boolean(),
        fc.constantFrom(null, ...REPO_ROLES),
        (action, isCommentAuthor, role) => {
          const decision = decideComment(action, { isCommentAuthor, role, locked: true });
          expect(decision.ok).toBe(atLeast(role, "write"));
          if (!decision.ok && atLeast(role, "read") && (action === "create" || isCommentAuthor))
            expect(decision.refusal).toBe("locked");
        },
      ),
    );
  });
});
