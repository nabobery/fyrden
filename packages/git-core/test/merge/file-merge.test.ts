import { describe, expect, it } from "vitest";
import { mergeFiles, withConflictMarkers } from "../../src/merge/file-merge.js";
import { dec, enc } from "./support.js";

describe("mergeFiles", () => {
  const m = (b: string, o: string, t: string) =>
    mergeFiles(enc.encode(b), enc.encode(o), enc.encode(t));

  it("returns merged bytes, or conflict regions as data", () => {
    const clean = m("a\nb\nc\n", "A\nb\nc\n", "a\nb\nC\n");
    expect(clean.kind === "clean" ? dec.decode(clean.bytes) : clean.kind).toBe("A\nb\nC\n");
    const conflict = m("a\nb\nc\n", "a\nX\nc\n", "a\nY\nc\n");
    if (conflict.kind !== "conflict") return expect.fail(conflict.kind);
    expect(conflict.conflicts).toBe(1);
    expect(conflict.regions[1]).toEqual({
      base: [enc.encode("b\n")],
      ours: [enc.encode("X\n")],
      theirs: [enc.encode("Y\n")],
    });
  });

  it("writes a conflicted file with git's markers, ending each side with a line feed", () => {
    const conflict = m("a\nb\nc", "a\nX\nc", "a\nY");
    if (conflict.kind !== "conflict") return expect.fail(conflict.kind);
    const text = dec.decode(
      withConflictMarkers(
        conflict.regions,
        { ours: "feature", theirs: "main" },
        { base: enc.encode("a\nb\nc"), ours: enc.encode("a\nX\nc"), theirs: enc.encode("a\nY") },
      ),
    );
    expect(text).toBe("a\n<<<<<<< feature\nX\nc\n=======\nY\n>>>>>>> main\n");
  });

  it("refuses binary sides and sides over the line budget", () => {
    expect(mergeFiles(new Uint8Array([0]), enc.encode("a"), enc.encode("b")).kind).toBe("binary");
    expect(
      mergeFiles(enc.encode("\n\n\n"), enc.encode(""), enc.encode(""), { maxLines: 2 }).kind,
    ).toBe("too_large");
  });

  it("flags a merge approximate when a side's line diff ran past its cost bound, and only then", () => {
    const [base, ours] = [enc.encode("a\nb\nc\nd\n"), enc.encode("a\nX\nY\nd\n")];
    expect(mergeFiles(base, ours, base)).toEqual({
      kind: "clean",
      bytes: ours,
      approximate: false,
    });
    // Our side's two changed lines cost more than one step to align; theirs is the base.
    expect(mergeFiles(base, ours, base, { maxCost: 1 })).toEqual({
      kind: "clean",
      bytes: ours,
      approximate: true,
    });
  });

  it("merges a line over 128 KiB without running out of stack", () => {
    const long = `${"x".repeat(200_000)}\n`;
    const merged = mergeFiles(
      enc.encode(`a\n${long}`),
      enc.encode(`A\n${long}`),
      enc.encode(`a\n${long}b\n`),
    );
    expect(merged.kind === "clean" ? dec.decode(merged.bytes) : merged.kind).toBe(`A\n${long}b\n`);
  });
});
