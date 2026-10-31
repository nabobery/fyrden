import { describe, expect, it } from "vitest";
import { decideReaction } from "../../src/issues/reactions.js";

describe("decideReaction", () => {
  it("lets anyone who reads react, and only write access and above while locked", () => {
    expect(decideReaction({ role: "read", locked: false })).toEqual({ ok: true });
    expect(decideReaction({ role: null, locked: false })).toEqual({
      ok: false,
      refusal: "forbidden",
    });
    expect(decideReaction({ role: "triage", locked: true })).toEqual({
      ok: false,
      refusal: "locked",
    });
    expect(decideReaction({ role: "write", locked: true })).toEqual({ ok: true });
  });
});
