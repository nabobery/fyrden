import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  AUTHENTICATED,
  impliedBy,
  isPermission,
  PERMISSION_NAMES,
  PERMISSIONS,
  type Permission,
  permissionDef,
  scopesAllow,
} from "../../src/authz/permissions.js";
import { atLeast } from "../../src/authz/roles.js";
import type { PrincipalType } from "../../src/principals/principal.js";

const permission = fc.constantFrom(...PERMISSION_NAMES);

describe("the permission table", () => {
  it("names permissions <area>:<action>, as GitHub's fine-grained tokens do", () => {
    for (const name of PERMISSION_NAMES)
      expect(name).toMatch(/^[a-z]+(_[a-z]+)*:(read|write|create|admin)$/);
  });

  it("keeps authenticated out: it is not a grantable permission", () => {
    expect(isPermission(AUTHENTICATED)).toBe(false);
    expect(isPermission("contents:read")).toBe(true);
    expect(isPermission("repo")).toBe(false);
    // Not inherited object keys.
    expect(isPermission("toString")).toBe(false);
    expect(isPermission("__proto__")).toBe(false);
  });

  it("implies only permissions on the same resource that need no more", () => {
    for (const name of PERMISSION_NAMES) {
      const def = permissionDef(name);
      for (const implied of def.implies) {
        expect(isPermission(implied), `${name} implies ${implied}`).toBe(true);
        const other = permissionDef(implied as Permission);
        expect(other.resource, `${name} implies ${implied}`).toBe(def.resource);
        if (def.resource === "repo" && other.resource === "repo")
          expect(atLeast(def.minRole, other.minRole), `${name} implies ${implied}`).toBe(true);
        // Whoever may hold the permission may hold what it implies.
        expect(def.principals.every((p: PrincipalType) => other.principals.includes(p))).toBe(true);
      }
    }
  });

  it("marks the permissions that change state", () => {
    expect(PERMISSIONS["contents:read"].writes).toBe(false);
    expect(PERMISSIONS["metadata:read"].writes).toBe(false);
    expect(PERMISSIONS["contents:write"].writes).toBe(true);
    expect(PERMISSIONS["administration:write"].writes).toBe(true);
    expect(PERMISSIONS["repos:create"].writes).toBe(true);
  });
});

describe("impliedBy", () => {
  it("follows implications transitively and includes the permission itself", () => {
    expect([...impliedBy("contents:write")].sort()).toEqual([
      "contents:read",
      "contents:write",
      "metadata:read",
    ]);
    expect([...impliedBy("metadata:read")]).toEqual(["metadata:read"]);
  });

  it("is closed: whatever an implied permission implies is implied too", () => {
    fc.assert(
      fc.property(permission, (p) => {
        const set = impliedBy(p);
        for (const q of set) for (const r of impliedBy(q)) expect(set.has(r)).toBe(true);
      }),
    );
  });
});

describe("scopesAllow", () => {
  it("does not narrow a token without scopes", () => {
    for (const p of PERMISSION_NAMES) expect(scopesAllow([], p)).toBe(true);
  });

  it("allows a scope and what it implies, nothing else", () => {
    expect(scopesAllow(["contents:write"], "contents:write")).toBe(true);
    expect(scopesAllow(["contents:write"], "contents:read")).toBe(true);
    expect(scopesAllow(["contents:write"], "metadata:read")).toBe(true);
    expect(scopesAllow(["contents:read"], "contents:write")).toBe(false);
    expect(scopesAllow(["contents:read"], "administration:write")).toBe(false);
    expect(scopesAllow(["metadata:read"], "contents:read")).toBe(false);
  });

  it("grants nothing for scopes it does not know", () => {
    for (const p of PERMISSION_NAMES) {
      expect(scopesAllow(["repo"], p)).toBe(false);
      expect(scopesAllow(["admin", "__proto__"], p)).toBe(false);
    }
  });

  it("only ever narrows: more scopes never take a permission away", () => {
    const scope = fc.oneof(permission, fc.string({ maxLength: 12 }));
    fc.assert(
      fc.property(fc.array(scope, { minLength: 1 }), fc.array(scope), permission, (a, b, p) => {
        if (scopesAllow(a, p)) expect(scopesAllow([...a, ...b], p)).toBe(true);
      }),
    );
  });

  it("is exactly membership in the implied sets of the scopes", () => {
    fc.assert(
      fc.property(fc.array(permission, { minLength: 1 }), permission, (scopes, p) => {
        const expected = scopes.some((s: Permission) => impliedBy(s).has(p));
        expect(scopesAllow(scopes, p)).toBe(expected);
      }),
    );
  });
});
