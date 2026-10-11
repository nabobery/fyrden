import { describe, expect, it } from "vitest";
import { concatBytes } from "../../src/object/bytes.js";
import { oidFromHex } from "../../src/object/oid.js";
import {
  PUSH_ACCEPTED_WARNINGS,
  PUSH_FSCK_SEVERITY,
  PUSH_REFUSED_WARNINGS,
  PushFsck,
  PushFsckError,
  type PushFsckId,
} from "../../src/receive-pack/fsck.js";
import { checkGitmodules } from "../../src/receive-pack/gitmodules.js";

/*
 * The push policy: git's severities with `receive.fsckObjects`, except that
 * warnings found in real, long-lived histories are accepted (reported to the
 * client, not refused), while the warnings that protect people who clone
 * the repository still refuse.
 */

const latin1 = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0));
const BLOB = "1".repeat(40);
const OID = oidFromHex("a".repeat(40));

function tree(entries: readonly [string, string, string?][]): Uint8Array {
  return concatBytes(
    entries.map(([mode, name, oid]) =>
      concatBytes([latin1(`${mode} ${name}`), Uint8Array.of(0), oidFromHex(oid ?? BLOB)]),
    ),
  );
}

const commit = (extra = "", body = "message\n") =>
  latin1(
    `tree ${"2".repeat(40)}\nauthor A <a@x> 1 +0000\ncommitter A <a@x> 1 +0000\n${extra}\n${body}`,
  );

/** Whether the default policy refuses one object, and the ids it reported. */
function judge(type: "tree" | "commit" | "tag" | "blob", data: Uint8Array) {
  const fsck = new PushFsck();
  try {
    fsck.check(OID, type, data);
    return { refused: false, ids: fsck.warnings.map((f) => f.id) };
  } catch (error) {
    if (!(error instanceof PushFsckError)) throw error;
    return { refused: true, ids: error.findings.map((f) => f.id) };
  }
}

describe("push fsck policy (default)", () => {
  it.each<[string, "tree" | "commit" | "tag", Uint8Array, PushFsckId]>([
    ["a zero-padded file mode", "tree", tree([["0100644", "a"]]), "zeroPaddedFilemode"],
    ["a mode git does not know", "tree", tree([["100600", "a"]]), "badFilemode"],
    ["a name over 4,096 bytes", "tree", tree([["100644", "n".repeat(4097)]]), "largePathname"],
    ["a NUL in a commit message", "commit", commit("", "a\0b\n"), "nulInCommit"],
    [
      "a tag without a tagger",
      "tag",
      latin1(`object ${"3".repeat(40)}\ntype commit\ntag v1\n\nold tag\n`),
      "missingTaggerEntry",
    ],
    [
      "a tag with a bad name",
      "tag",
      latin1(`object ${"3".repeat(40)}\ntype commit\ntag a..b\ntagger T <t@x> 1 +0000\n\nm\n`),
      "badTagName",
    ],
  ])("accepts %s and reports it", (_what, type, data, id) => {
    expect(judge(type, data)).toEqual({ refused: false, ids: [id] });
  });

  it("accepts the legacy group-writable mode without a word, as git does unless --strict", () => {
    expect(judge("tree", tree([["100664", "a"]]))).toEqual({ refused: false, ids: [] });
  });

  it("accepts an unknown commit header (git ignores extraHeaderEntry)", () => {
    expect(judge("commit", commit("x-custom value\n"))).toEqual({ refused: false, ids: [] });
  });

  it.each<[string, "tree" | "blob", Uint8Array, PushFsckId]>([
    ["a .git entry in any case", "tree", tree([["40000", ".GIT", "4".repeat(40)]]), "hasDotgit"],
    ["a '.' entry", "tree", tree([["40000", ".", "4".repeat(40)]]), "hasDot"],
    ["a '..' entry", "tree", tree([["40000", "..", "4".repeat(40)]]), "hasDotdot"],
    ["a name with a slash", "tree", tree([["100644", "a/b"]]), "fullPathname"],
    ["an entry naming the null id", "tree", tree([["100644", "a", "0".repeat(40)]]), "nullSha1"],
    ["a .gitmodules symbolic link", "tree", tree([["120000", ".gitmodules"]]), "gitmodulesSymlink"],
    [
      "an unsorted tree",
      "tree",
      tree([
        ["100644", "b"],
        ["100644", "a"],
      ]),
      "treeNotSorted",
    ],
  ])("refuses %s", (_what, type, data, id) => {
    const verdict = judge(type, data);
    expect(verdict.refused).toBe(true);
    expect(verdict.ids).toContain(id);
  });

  it("refuses a .gitmodules that would make git write outside the repository", () => {
    const fsck = new PushFsck();
    const blob = oidFromHex(BLOB);
    fsck.check(OID, "tree", tree([["100644", ".gitmodules"]]));
    expect(() => fsck.check(blob, "blob", latin1('[submodule "../../x"]\n\tpath = a\n'))).toThrow(
      /gitmodulesName/,
    );
  });

  it("bounds and escapes .gitmodules values and caps its findings per blob", () => {
    const fsck = new PushFsck();
    const blob = oidFromHex(BLOB);
    fsck.check(OID, "tree", tree([["100644", ".gitmodules"]]));
    // 1,000 entries, each with a long name holding control characters and a bad url.
    const long = `../${"n".repeat(10_000)}\u0007\u001b[31m`;
    const entries = Array.from(
      { length: 1000 },
      (_, i) => `[submodule "${long}${i}"]\n\turl = -${"u".repeat(10_000)}\n`,
    );
    let error: unknown;
    try {
      fsck.check(blob, "blob", latin1(entries.join("")));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(PushFsckError);
    const findings = (error as PushFsckError).findings;
    // Ten findings, then one per id that counts the other 1,990.
    expect(findings).toHaveLength(12);
    expect(findings.slice(-2).map((f) => f.message)).toEqual([
      "gitmodulesName: and 995 more disallowed submodule settings",
      "gitmodulesUrl: and 995 more disallowed submodule settings",
    ]);
    for (const finding of findings) {
      expect(finding.message.length).toBeLessThan(160);
      expect(finding.message).toMatch(/^[\x20-\x7e]*$/);
    }
    expect(findings[0]?.message).toBe(
      `gitmodulesName: disallowed submodule name: ../${"n".repeat(61)}...`,
    );
    // A short value keeps its text, with control characters escaped.
    const short = checkGitmodules(latin1('[submodule "../\u001b[2Jx"]\n\tpath = a\n'));
    expect(short.map((f) => f.message)).toEqual(["disallowed submodule name: ../\\33[2Jx"]);
  });

  it("still refuses a finding past the cap when a per-id level ignores the ones before it", () => {
    const fsck = new PushFsck({ levels: { gitmodulesName: "ignore" } });
    const blob = oidFromHex(BLOB);
    fsck.check(OID, "tree", tree([["100644", ".gitmodules"]]));
    // Eleven ignored name findings fill the cap; the url error comes after them.
    const names = Array.from({ length: 11 }, (_, i) => `[submodule "../${i}"]\n\tpath = a\n`);
    const data = latin1(`${names.join("")}[submodule "ok"]\n\turl = -evil\n`);
    expect(() => fsck.check(blob, "blob", data)).toThrow(/gitmodulesUrl/);
    // Each id past the cap keeps its own count.
    expect(
      checkGitmodules(data, 10)
        .slice(10)
        .map((f) => f.message),
    ).toEqual([
      "and 1 more disallowed submodule settings",
      "and 1 more disallowed submodule settings",
    ]);
    expect(
      checkGitmodules(data, 10)
        .slice(10)
        .map((f) => f.id),
    ).toEqual(["gitmodulesName", "gitmodulesUrl"]);
  });

  it("classifies every warning git defines, so a new one cannot slip through unjudged", () => {
    const warnings = Object.entries(PUSH_FSCK_SEVERITY)
      .filter(([, severity]) => severity === "warn")
      .map(([id]) => id)
      .sort();
    const classified = [...PUSH_REFUSED_WARNINGS, ...PUSH_ACCEPTED_WARNINGS].sort();
    expect(classified).toEqual(warnings);
    expect(PUSH_REFUSED_WARNINGS).toEqual(
      expect.arrayContaining(["hasDotgit", "hasDotdot", "hasDot", "fullPathname", "nullSha1"]),
    );
  });

  it("keeps git's --strict behaviour on request: every warning refuses", () => {
    const fsck = new PushFsck({ strict: true });
    expect(() => fsck.check(OID, "tree", tree([["0100644", "a"]]))).toThrow(/zeroPaddedFilemode/);
  });

  it("lets a level set per id win, as receive.fsck.<id> does", () => {
    const fsck = new PushFsck({ levels: { zeroPaddedFilemode: "error", hasDotgit: "warn" } });
    expect(() => fsck.check(OID, "tree", tree([["0100644", "a"]]))).toThrow(/zeroPaddedFilemode/);
    fsck.check(OID, "tree", tree([["40000", ".git", "4".repeat(40)]]));
    expect(fsck.warnings.map((f) => f.id)).toEqual(["hasDotgit"]);
  });
});
