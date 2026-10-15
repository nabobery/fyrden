import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type AuthzRequest,
  checkOperation,
  evaluate,
  NO_RIGHTS,
  type Rights,
} from "../../src/authz/evaluate.js";
import { AUTHENTICATED, PERMISSION_NAMES, type Permission } from "../../src/authz/permissions.js";
import { REPO_ROLES, type RepoRole } from "../../src/authz/roles.js";
import { PRINCIPAL_TYPES } from "../../src/principals/principal.js";

const REPO = "rep_1";
const role = (repoRole: RepoRole | null): Rights => ({ ...NO_RIGHTS, repoRole });
const unrestricted = { scopes: [], repoIds: null };

function request(permission: Permission, rights: Rights, extra: Partial<AuthzRequest> = {}) {
  return evaluate({
    permission,
    actorType: "user",
    rights,
    token: unrestricted,
    repoId: REPO,
    ...extra,
  });
}

describe("evaluate: roles", () => {
  it("lets each repository role do what GitHub's role of that name can", () => {
    const allowed = (r: RepoRole | null) =>
      PERMISSION_NAMES.filter((p) => request(p, role(r)).allow);
    expect(allowed(null)).toEqual([]);
    const pulls = ["pull_requests:read", "pull_requests:write"];
    const reads = ["contents:read", "metadata:read", ...pulls].sort();
    const writes = ["contents:read", "contents:write", "metadata:read", ...pulls].sort();
    expect(allowed("read").sort()).toEqual(reads);
    expect(allowed("triage").sort()).toEqual(reads);
    expect(allowed("write").sort()).toEqual(writes);
    expect(allowed("maintain").sort()).toEqual(writes);
    expect(allowed("admin").sort()).toEqual(["administration:write", ...writes].sort());
  });

  it("names why it denies", () => {
    expect(request("contents:write", role("read"))).toEqual({ allow: false, reason: "rights" });
  });

  it("gives account permissions to the account's owner only", () => {
    expect(request("repos:create", { ...NO_RIGHTS, accountRole: "owner" }).allow).toBe(true);
    expect(request("repos:create", { ...NO_RIGHTS, accountRole: "member" }).allow).toBe(true);
    expect(request("members:write", { ...NO_RIGHTS, accountRole: "member" }).allow).toBe(false);
    expect(request("repos:create", role("admin")).allow).toBe(false);
  });

  it("gives instance administration to instance administrators only", () => {
    expect(request("instance:admin", { ...NO_RIGHTS, isInstanceAdmin: true }).allow).toBe(true);
    expect(
      request("instance:admin", { ...NO_RIGHTS, accountRole: "owner", repoRole: "admin" }).allow,
    ).toBe(false);
  });

  it("does not make an instance administrator a member of every repository", () => {
    expect(request("contents:read", { ...NO_RIGHTS, isInstanceAdmin: true }).allow).toBe(false);
  });

  it("fails closed on a permission it does not know", () => {
    expect(request("repo:read" as Permission, role("admin"))).toEqual({
      allow: false,
      reason: "unknown_permission",
    });
  });
});

describe("evaluate: token narrowing", () => {
  it("applies the token's scopes on top of the role", () => {
    const scoped = (scopes: string[]) => ({ token: { scopes, repoIds: null } });
    expect(request("contents:read", role("admin"), scoped(["contents:read"])).allow).toBe(true);
    expect(request("contents:write", role("admin"), scoped(["contents:read"]))).toEqual({
      allow: false,
      reason: "scope",
    });
    // A scope never adds to the role.
    expect(request("contents:write", role("read"), scoped(["contents:write"]))).toEqual({
      allow: false,
      reason: "rights",
    });
  });

  it("limits a token to its repositories", () => {
    const limited = { token: { scopes: [], repoIds: ["rep_other"] } };
    expect(request("contents:read", role("admin"), limited)).toEqual({
      allow: false,
      reason: "repo_not_in_token",
    });
    expect(
      request("contents:read", role("admin"), { token: { scopes: [], repoIds: [REPO] } }).allow,
    ).toBe(true);
  });

  it("needs the repository for a repository permission", () => {
    const { repoId: _, ...noRepo } = {
      permission: "contents:read" as const,
      actorType: "user" as const,
      rights: role("admin"),
      token: unrestricted,
      repoId: REPO,
    };
    expect(evaluate(noRepo)).toEqual({
      allow: false,
      reason: "no_repo",
    });
  });
});

describe("evaluate: principal types and ceilings", () => {
  it("lets only users administer the instance", () => {
    const admin = { ...NO_RIGHTS, isInstanceAdmin: true };
    for (const actorType of PRINCIPAL_TYPES)
      expect(request("instance:admin", admin, { actorType }).allow).toBe(actorType === "user");
  });

  it("judges principal type by the actor, not by the user an agent acts for", () => {
    // An agent acting for an instance administrator holds the user's rights,
    // but the instance permission is for users only, and the actor is an agent.
    const admin = { ...NO_RIGHTS, isInstanceAdmin: true };
    expect(request("instance:admin", admin, { actorType: "agent" })).toEqual({
      allow: false,
      reason: "principal_type",
    });
  });

  it("never lets an agent exceed its owner", () => {
    expect(
      request("contents:write", role("admin"), { actorType: "agent", ceilings: [role("read")] }),
    ).toEqual({ allow: false, reason: "ceiling" });
    expect(
      request("contents:read", role("admin"), { actorType: "agent", ceilings: [role("read")] })
        .allow,
    ).toBe(true);
  });

  it("caps by every principal in a delegation chain", () => {
    const ceilings = [role("admin"), role("write"), role("read")];
    expect(request("contents:write", role("admin"), { actorType: "agent", ceilings }).allow).toBe(
      false,
    );
  });
});

describe("evaluate: properties", () => {
  const permission = fc.constantFrom(...PERMISSION_NAMES);
  const maybeRole = fc.option(fc.constantFrom(...REPO_ROLES), { nil: null });
  const rights = fc.record({
    isInstanceAdmin: fc.boolean(),
    accountRole: fc.constantFrom("owner", "member", null),
    repoRole: maybeRole,
  });
  const scopes = fc.array(fc.oneof(permission, fc.constantFrom("repo", "admin", "")), {
    maxLength: 3,
  });
  const actorType = fc.constantFrom(...PRINCIPAL_TYPES);

  it("an agent never exceeds its owner's effective permission", () => {
    fc.assert(
      fc.property(permission, rights, rights, scopes, (p, agent, owner, s) => {
        const asAgent = evaluate({
          permission: p,
          actorType: "agent",
          rights: agent,
          ceilings: [owner],
          token: { scopes: s, repoIds: null },
          repoId: REPO,
        });
        const asOwner = evaluate({
          permission: p,
          actorType: "user",
          rights: owner,
          token: unrestricted,
          repoId: REPO,
        });
        if (asAgent.allow) expect(asOwner.allow).toBe(true);
      }),
    );
  });

  it("a stronger role never loses a permission", () => {
    fc.assert(
      fc.property(permission, actorType, scopes, (p, actor, s) => {
        let allowedBefore = false;
        for (const r of REPO_ROLES) {
          const allowed = evaluate({
            permission: p,
            actorType: actor,
            rights: role(r),
            token: { scopes: s, repoIds: null },
            repoId: REPO,
          }).allow;
          if (allowedBefore) expect(allowed).toBe(true);
          allowedBefore = allowed;
        }
      }),
    );
  });

  it("scopes, repository lists and ceilings only ever take permissions away", () => {
    fc.assert(
      fc.property(
        permission,
        actorType,
        rights,
        scopes,
        fc.array(rights, { maxLength: 2 }),
        fc.option(fc.array(fc.constantFrom(REPO, "rep_2"), { maxLength: 2 }), { nil: null }),
        (p, actor, r, s, ceilings, repoIds) => {
          const narrowed = evaluate({
            permission: p,
            actorType: actor,
            rights: r,
            ceilings,
            token: { scopes: s, repoIds },
            repoId: REPO,
          });
          const plain = evaluate({
            permission: p,
            actorType: actor,
            rights: r,
            token: unrestricted,
            repoId: REPO,
          });
          if (narrowed.allow) expect(plain.allow).toBe(true);
        },
      ),
    );
  });
});

describe("checkOperation", () => {
  const caller = { actorType: "user" as const, isInstanceAdmin: false, scopes: [] };

  it("lets any authenticated caller through for an operation that only needs authentication", () => {
    for (const actorType of PRINCIPAL_TYPES)
      expect(
        checkOperation(AUTHENTICATED, { actorType, isInstanceAdmin: false, scopes: ["x"] }).allow,
      ).toBe(true);
  });

  it("checks instance permissions completely", () => {
    expect(checkOperation("instance:admin", caller)).toEqual({ allow: false, reason: "rights" });
    expect(checkOperation("instance:admin", { ...caller, isInstanceAdmin: true }).allow).toBe(true);
    expect(
      checkOperation("instance:admin", {
        ...caller,
        isInstanceAdmin: true,
        scopes: ["contents:read"],
      }),
    ).toEqual({ allow: false, reason: "scope" });
  });

  it("checks scopes and principal type for repository and account permissions, leaving the role to the handler", () => {
    expect(checkOperation("contents:write", caller).allow).toBe(true);
    expect(checkOperation("repos:create", caller).allow).toBe(true);
    expect(checkOperation("contents:write", { ...caller, scopes: ["contents:read"] })).toEqual({
      allow: false,
      reason: "scope",
    });
  });

  it("fails closed on an unknown permission", () => {
    expect(checkOperation("repo:read" as Permission, caller)).toEqual({
      allow: false,
      reason: "unknown_permission",
    });
  });
});
