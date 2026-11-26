import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  MAX_RUN_ORG_SECRETS,
  MAX_RUN_VARIABLES_BYTES,
  type OrgVisibility,
  reachesRepo,
  runSecrets,
  runVariables,
} from "../../src/ci/secret-precedence.js";

const org = (name: string, visibility: OrgVisibility = "all", selected = false) => ({
  name,
  visibility,
  selected,
  from: "org" as const,
});
const own = (name: string) => ({ name, from: "repo" as const });

describe("reachesRepo", () => {
  it("all: every repository", () => {
    for (const v of ["public", "internal", "private"] as const)
      expect(reachesRepo({ visibility: "all", selected: false }, v)).toBe(true);
  });

  it("private: private and internal repositories only", () => {
    expect(reachesRepo({ visibility: "private", selected: false }, "private")).toBe(true);
    expect(reachesRepo({ visibility: "private", selected: false }, "internal")).toBe(true);
    expect(reachesRepo({ visibility: "private", selected: false }, "public")).toBe(false);
  });

  it("selected: the listed repositories only, whatever their visibility", () => {
    expect(reachesRepo({ visibility: "selected", selected: true }, "public")).toBe(true);
    expect(reachesRepo({ visibility: "selected", selected: false }, "private")).toBe(false);
  });
});

describe("runSecrets", () => {
  it("lets the repository's own override the organization's of the same name", () => {
    const got = runSecrets([org("A"), org("B")], [own("B"), own("C")], "private");
    expect([...got.keys()]).toEqual(["A", "B", "C"]);
    expect(got.get("A")?.from).toBe("org");
    expect(got.get("B")?.from).toBe("repo");
  });

  it("compares names ignoring case", () => {
    const got = runSecrets([org("Token")], [own("TOKEN")], "private");
    expect([...got.values()].map((s) => s.from)).toEqual(["repo"]);
  });

  it("leaves out organization secrets that do not reach the repository", () => {
    const got = runSecrets(
      [
        org("ALL"),
        org("PRIV", "private"),
        org("SEL", "selected", false),
        org("MINE", "selected", true),
      ],
      [],
      "public",
    );
    expect([...got.keys()]).toEqual(["ALL", "MINE"]);
  });

  it("takes the first 100 eligible organization secrets by name, before the repository's override", () => {
    // Names around the cut in code-unit order: digits, then letters, then `_`.
    const names = Array.from({ length: 99 }, (_, i) => `S${String(i).padStart(3, "0")}`);
    const eligible = [...names, "Z9", "Z_", "_LAST"].map((n) => org(n));
    const ineligible = [org("A_FIRST", "selected", false)];
    const got = runSecrets([...eligible, ...ineligible].reverse(), [own("Z9")], "private");
    expect(MAX_RUN_ORG_SECRETS).toBe(100);
    const fromOrg = [...got.values()].filter((s) => s.from === "org").map((s) => s.name);
    // Z9 was one of the 100 (overridden by the repository's), so Z_ and _LAST are cut.
    expect(fromOrg).toHaveLength(99);
    expect(got.has("Z_")).toBe(false);
    expect(got.has("_LAST")).toBe(false);
    expect(got.get("Z9")?.from).toBe("repo");
    expect(got.has("A_FIRST")).toBe(false);
  });

  it("never answers more than the repository's own and 100 of the organization's", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.stringMatching(/^[A-Z_][A-Z0-9_]{0,3}$/), { maxLength: 150 }),
        fc.uniqueArray(fc.stringMatching(/^[A-Z_][A-Z0-9_]{0,3}$/), { maxLength: 20 }),
        (orgNames, repoNames) => {
          const got = runSecrets(
            orgNames.map((n) => org(n)),
            repoNames.map(own),
            "private",
          );
          for (const n of repoNames) expect(got.get(n)?.from).toBe("repo");
          const fromOrg = [...got.values()].filter((s) => s.from === "org").map((s) => s.name);
          expect(fromOrg.length).toBeLessThanOrEqual(MAX_RUN_ORG_SECRETS);
          const first = [...orgNames].sort(codeUnits).slice(0, MAX_RUN_ORG_SECRETS);
          // Exactly the first 100 the repository does not override.
          expect([...fromOrg].sort(codeUnits)).toEqual(first.filter((n) => !repoNames.includes(n)));
        },
      ),
    );
  });
});

const codeUnits = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const v = (name: string, value: string) => ({ name, value });
const ov = (name: string, value: string, visibility: OrgVisibility = "all", selected = false) => ({
  name,
  value,
  visibility,
  selected,
});

describe("runVariables", () => {
  it("lets the repository's own override the organization's, and leaves out those that do not reach it", () => {
    expect(
      runVariables(
        [ov("A", "org"), ov("B", "org"), ov("P", "x", "private"), ov("S", "x", "selected")],
        [v("B", "repo")],
        "public",
      ),
    ).toEqual({ A: "org", B: "repo" });
  });

  it("is 256 KB at most: the repository's alphabetically while they fit, then the organization's in the space left", () => {
    expect(MAX_RUN_VARIABLES_BYTES).toBe(262_144);
    const big = (n: number) => "x".repeat(n);
    // Each counts its name and value in UTF-8 bytes.
    const repo = [v("R2", big(100_000 - 2)), v("R1", big(100_000 - 2)), v("R3", big(100_000 - 2))];
    const orgVars = [ov("O1", big(62_144 - 2)), ov("O2", "y")];
    const got = runVariables(orgVars, repo, "private");
    // R1 and R2 fit (200,000 bytes); R3 would pass the limit, and the repository's stop there.
    expect(Object.keys(got)).toEqual(["R1", "R2", "O1"]);
  });

  it("stops at the first one that does not fit, in each part", () => {
    const got = runVariables(
      [ov("A", "x".repeat(MAX_RUN_VARIABLES_BYTES)), ov("B", "small")],
      [v("Z", "z")],
      "private",
    );
    expect(got).toEqual({ Z: "z" });
  });

  it("counts UTF-8 bytes", () => {
    // 262,142 bytes, in 131,071 characters.
    const value = "é".repeat(131_071);
    expect(Object.keys(runVariables([], [v("AB", value)], "private"))).toEqual(["AB"]);
    expect(runVariables([], [v("ABC", value)], "private")).toEqual({});
  });
});
