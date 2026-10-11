import { describe, expect, it } from "vitest";
import {
  type NamespaceUpdate,
  type RefNamespace,
  refnameConflicts,
  refParents,
  sortedRefNamespace,
} from "../../src/refs/namespace.js";

const create = (name: string): NamespaceUpdate => ({ name, oldOid: null, newOid: "c1" });
const remove = (name: string): NamespaceUpdate => ({ name, oldOid: "c1", newOid: null });
const update = (name: string): NamespaceUpdate => ({ name, oldOid: "c1", newOid: "c2" });

describe("refParents", () => {
  it.each([
    ["refs/heads/a/b", ["refs/heads", "refs/heads/a"]],
    ["refs/x/y", ["refs/x"]],
    ["refs/heads", []],
    ["refs/a", []],
  ])("%j needs %j as directories", (name, parents) => {
    expect(refParents(name)).toEqual(parents);
  });
});

describe("sortedRefNamespace", () => {
  const names = [
    "refs/heads/b",
    "refs/heads/a/y",
    "refs/heads/a",
    "refs/heads/a/x",
    "refs/heads/a-b",
  ];
  const ns = sortedRefNamespace(names);

  it("knows the names it holds", () => {
    for (const name of names) expect(ns.has(name)).toBe(true);
    expect(ns.has("refs/heads/c")).toBe(false);
    expect(ns.has("refs/heads")).toBe(false);
  });

  it("lists the names below a name, in order, and nothing that only shares a prefix", () => {
    expect(ns.below("refs/heads/a", 10)).toEqual(["refs/heads/a/x", "refs/heads/a/y"]);
    expect(ns.below("refs/heads/b", 10)).toEqual([]);
    expect(ns.below("refs/heads", 10)).toEqual([
      "refs/heads/a",
      "refs/heads/a-b",
      "refs/heads/a/x",
      "refs/heads/a/y",
      "refs/heads/b",
    ]);
  });

  it("stops at the limit", () => {
    expect(ns.below("refs/heads/a", 1)).toEqual(["refs/heads/a/x"]);
    expect(ns.below("refs/heads/a", 0)).toEqual([]);
  });

  it("finds names below with a binary search over many names", () => {
    const many = Array.from({ length: 200 }, (_, i) => `refs/tags/v${String(i).padStart(3, "0")}`);
    const big = sortedRefNamespace([...many, "refs/tags/v100/rc1", "refs/tags/v100/rc2"]);
    expect(big.below("refs/tags/v100", 5)).toEqual(["refs/tags/v100/rc1", "refs/tags/v100/rc2"]);
    expect(big.below("refs/tags/v000", 5)).toEqual([]);
    expect(big.below("refs/tags/v199", 5)).toEqual([]);
    expect(big.has("refs/tags/v150")).toBe(true);
  });
});

describe("refnameConflicts", () => {
  const conflicts = (updates: NamespaceUpdate[], existing: string[] = []) =>
    refnameConflicts(updates, sortedRefNamespace(existing));

  it("has nothing to check without a creation", () => {
    const untouchable: RefNamespace = {
      has: () => {
        throw new Error("looked up");
      },
      below: () => {
        throw new Error("looked up");
      },
    };
    expect(refnameConflicts([], untouchable)).toEqual([]);
    expect(
      refnameConflicts([update("refs/heads/a/b"), remove("refs/heads/c")], untouchable),
    ).toEqual([]);
  });

  it("refuses a creation below an existing ref", () => {
    expect(conflicts([create("refs/heads/ns/sub")], ["refs/heads/ns"])).toEqual([
      { ref: "refs/heads/ns/sub", conflictsWith: "refs/heads/ns", inRequest: false },
    ]);
    expect(conflicts([create("refs/heads/ns/a/b")], ["refs/heads/ns"])).toEqual([
      { ref: "refs/heads/ns/a/b", conflictsWith: "refs/heads/ns", inRequest: false },
    ]);
  });

  it("refuses a creation above an existing ref", () => {
    expect(conflicts([create("refs/heads/ns")], ["refs/heads/ns/sub"])).toEqual([
      { ref: "refs/heads/ns", conflictsWith: "refs/heads/ns/sub", inRequest: false },
    ]);
  });

  it("lets a name that only shares a prefix through", () => {
    const existing = ["refs/heads/ns", "refs/heads/ns-b/x", "refs/heads/ns0/x"];
    const creations = ["refs/heads/ns-a", "refs/heads/ns.a", "refs/heads/ns1", "refs/heads/nsx/y"];
    expect(conflicts(creations.map(create), existing)).toEqual([]);
    expect(conflicts([create("refs/heads/ns")], ["refs/heads/ns-b/x", "refs/heads/ns0/x"])).toEqual(
      [],
    );
  });

  it("never refuses an update of an existing ref", () => {
    expect(conflicts([update("refs/heads/ns/sub")], ["refs/heads/ns"])).toEqual([]);
  });

  it("frees a name deleted in the same request", () => {
    expect(
      conflicts([remove("refs/heads/ns"), create("refs/heads/ns/sub")], ["refs/heads/ns"]),
    ).toEqual([]);
    expect(
      conflicts([remove("refs/heads/ns/sub"), create("refs/heads/ns")], ["refs/heads/ns/sub"]),
    ).toEqual([]);
  });

  it("still refuses when only some of the refs below are deleted", () => {
    const existing = ["refs/heads/a/x", "refs/heads/a/y"];
    expect(conflicts([remove("refs/heads/a/x"), create("refs/heads/a")], existing)).toEqual([
      { ref: "refs/heads/a", conflictsWith: "refs/heads/a/y", inRequest: false },
    ]);
    expect(
      conflicts(
        [remove("refs/heads/a/x"), remove("refs/heads/a/y"), create("refs/heads/a")],
        existing,
      ),
    ).toEqual([]);
  });

  it("between two creations, refuses the upper one and lets the lower one go ahead", () => {
    // Given in reverse order: the request's order does not matter.
    expect(conflicts([create("refs/heads/q/y"), create("refs/heads/q")])).toEqual([
      { ref: "refs/heads/q", conflictsWith: "refs/heads/q/y", inRequest: true },
    ]);
    expect(
      conflicts([create("refs/heads/a/b/c"), create("refs/heads/a"), create("refs/heads/a/b")]),
    ).toEqual([
      { ref: "refs/heads/a", conflictsWith: "refs/heads/a/b", inRequest: true },
      { ref: "refs/heads/a/b", conflictsWith: "refs/heads/a/b/c", inRequest: true },
    ]);
    expect(conflicts([create("refs/heads/q"), create("refs/heads/q0")])).toEqual([]);
    expect(conflicts([create("refs/heads/q-y"), create("refs/heads/q")])).toEqual([]);
  });

  it("checks existing refs before creations in the same request, and reports in name order", () => {
    const result = conflicts(
      [
        create("refs/heads/z/sub"),
        create("refs/heads/q"),
        create("refs/heads/q/y"),
        create("refs/heads/m"),
        create("refs/heads/ok"),
      ],
      ["refs/heads/z", "refs/heads/m/x"],
    );
    expect(result).toEqual([
      { ref: "refs/heads/m", conflictsWith: "refs/heads/m/x", inRequest: false },
      { ref: "refs/heads/q", conflictsWith: "refs/heads/q/y", inRequest: true },
      { ref: "refs/heads/z/sub", conflictsWith: "refs/heads/z", inRequest: false },
    ]);
  });

  it("does not count a creation refused by an existing ref against the one above it", () => {
    // refs/heads/w/x is refused by the existing ref below it; refs/heads/w is
    // refused by that existing ref too, not by the creation of refs/heads/w/x.
    expect(
      conflicts([create("refs/heads/w"), create("refs/heads/w/x")], ["refs/heads/w/x/y"]),
    ).toEqual([
      { ref: "refs/heads/w", conflictsWith: "refs/heads/w/x/y", inRequest: false },
      { ref: "refs/heads/w/x", conflictsWith: "refs/heads/w/x/y", inRequest: false },
    ]);
  });
});
