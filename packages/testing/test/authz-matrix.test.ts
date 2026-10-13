import {
  evaluate,
  PERMISSION_NAMES,
  PRINCIPAL_TYPES,
  REPO_ROLES,
  type RepoRole,
} from "@fyrden/domain";
import { describe, expect, it } from "vitest";
import { authzMatrix, HOLDERS, rightsOf } from "../src/authz/matrix.js";

const matrix = authzMatrix();

describe("authorization matrix", () => {
  it("has one cell per principal type, holder and permission", () => {
    expect(matrix).toHaveLength(PRINCIPAL_TYPES.length * HOLDERS.length * PERMISSION_NAMES.length);
    const keys = new Set(matrix.map((c) => `${c.actorType}/${c.holder}/${c.permission}`));
    expect(keys.size).toBe(matrix.length);
  });

  it("allows some cells and denies others for every permission", () => {
    for (const permission of PERMISSION_NAMES) {
      const cells = matrix.filter((c) => c.permission === permission);
      expect(
        cells.some((c) => c.allow),
        permission,
      ).toBe(true);
      expect(
        cells.some((c) => !c.allow),
        permission,
      ).toBe(true);
    }
  });

  it.each(matrix)("$actorType as $holder: $permission → allow $allow", (cell) => {
    const decision = evaluate({
      permission: cell.permission,
      actorType: cell.actorType,
      rights: rightsOf(cell.holder),
      token: { scopes: [], repoIds: null },
      repoId: "rep_matrix",
    });
    expect(decision.allow).toBe(cell.allow);
  });

  it("matches hand-written expectations for a few cells", () => {
    const allow = (actorType: string, holder: string, permission: string) =>
      matrix.find(
        (c) => c.actorType === actorType && c.holder === holder && c.permission === permission,
      )?.allow;
    expect(allow("user", "read", "contents:read")).toBe(true);
    expect(allow("user", "triage", "contents:write")).toBe(false);
    expect(allow("agent", "write", "contents:write")).toBe(true);
    expect(allow("user", "maintain", "administration:write")).toBe(false);
    expect(allow("user", "admin", "administration:write")).toBe(true);
    expect(allow("user", "admin", "repos:create")).toBe(false);
    expect(allow("agent", "instance-admin", "instance:admin")).toBe(false);
    expect(allow("user", "instance-admin", "instance:admin")).toBe(true);
    expect(allow("user", "instance-admin", "contents:read")).toBe(false);
  });

  it("covers every repository role", () => {
    const holders: readonly string[] = HOLDERS;
    for (const role of REPO_ROLES as readonly RepoRole[]) expect(holders).toContain(role);
  });
});
