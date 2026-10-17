import { describe, expect, it } from "vitest";
import { merge3 } from "../../src/merge/diff3.js";

const ids = (s: string) => [...s].map((c) => c.charCodeAt(0));

describe("merge3", () => {
  it("takes the side that changed a chunk, and either when both changed it alike", () => {
    const { chunks, conflicts } = merge3(ids("abcde"), ids("aXcde"), ids("abcdY"));
    expect(conflicts).toBe(0);
    expect(chunks.flatMap((c) => (c.kind === "clean" ? c.lines : []))).toEqual(ids("aXcdY"));
    expect(merge3(ids("abc"), ids("aXc"), ids("aXc")).conflicts).toBe(0);
  });

  it("gives a chunk both changed differently as a conflict with all three versions", () => {
    const { chunks, conflicts } = merge3(ids("abc"), ids("aXc"), ids("aYc"));
    expect(conflicts).toBe(1);
    expect(chunks).toEqual([
      { kind: "clean", lines: ids("a") },
      { kind: "conflict", base: ids("b"), ours: ids("X"), theirs: ids("Y") },
      { kind: "clean", lines: ids("c") },
    ]);
  });

  it("merges into empty sides and an empty base", () => {
    expect(merge3([], ids("ab"), []).chunks).toEqual([{ kind: "clean", lines: ids("ab") }]);
    expect(merge3([], ids("ab"), ids("cd")).conflicts).toBe(1);
    expect(merge3(ids("ab"), [], ids("ab")).chunks).toEqual([]);
  });

  it("gives clean lines in a row as one chunk, whichever side they came from", () => {
    expect(merge3(ids("abcde"), ids("aXcde"), ids("abcdY")).chunks).toEqual([
      { kind: "clean", lines: ids("aXcdY") },
    ]);
  });
});
