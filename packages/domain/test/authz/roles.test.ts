import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  atLeast,
  ORG_ROLES,
  orgRepoRole,
  REPO_ROLES,
  type RepoRole,
  strongestRole,
} from "../../src/authz/roles.js";

const role = fc.constantFrom(...REPO_ROLES);
const maybeRole = fc.option(role, { nil: null });

describe("repository roles", () => {
  it("are GitHub's five, weakest first", () => {
    expect(REPO_ROLES).toEqual(["read", "triage", "write", "maintain", "admin"]);
  });

  it("compare by strength", () => {
    expect(atLeast("write", "write")).toBe(true);
    expect(atLeast("maintain", "write")).toBe(true);
    expect(atLeast("triage", "write")).toBe(false);
    expect(atLeast("admin", "read")).toBe(true);
    expect(atLeast(null, "read")).toBe(false);
  });

  it("orders totally: of two roles, at least one is at least the other", () => {
    fc.assert(
      fc.property(role, role, (a, b) => {
        expect(atLeast(a, b) || atLeast(b, a)).toBe(true);
        expect(atLeast(a, b) && atLeast(b, a)).toBe(a === b);
      }),
    );
  });

  it("takes the strongest of several grants, or none", () => {
    expect(strongestRole([])).toBeNull();
    expect(strongestRole([null, null])).toBeNull();
    expect(strongestRole(["read", null, "maintain", "triage"])).toBe("maintain");
    fc.assert(
      fc.property(fc.array(maybeRole), (roles) => {
        const strongest = strongestRole(roles);
        for (const r of roles) if (r !== null) expect(atLeast(strongest, r)).toBe(true);
        expect(strongest === null || roles.includes(strongest)).toBe(true);
      }),
    );
  });
});

describe("organization roles", () => {
  it("are member and owner", () => {
    expect(ORG_ROLES).toEqual(["member", "owner"]);
  });

  it("make an owner admin of every repository and give members the base role", () => {
    const base: RepoRole = "read";
    expect(orgRepoRole("owner", base)).toBe("admin");
    expect(orgRepoRole("owner", null)).toBe("admin");
    expect(orgRepoRole("member", base)).toBe("read");
    expect(orgRepoRole("member", null)).toBeNull();
    expect(orgRepoRole(null, "write")).toBeNull();
  });
});
