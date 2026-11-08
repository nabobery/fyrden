import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { alignFiles, scanAlignment } from "../../src/blame/align.js";
import { exhaustivePairs, NAMED_CASES, seededPairs } from "./align-cases.js";

/*
 * The alignment against what the pinned oracle answered, committed under
 * `vectors/`. `scanAlignment` is the pick before any refusal, so a witness
 * that's a close call still tests scoring. `alignFiles` adds the refusals:
 * where it settles a line, it must agree with the oracle too.
 */

const VECTORS = join(import.meta.dirname, "vectors");
const bytesOf = (text: string) => new Uint8Array(Buffer.from(text, "latin1"));

interface Expected {
  readonly id: string;
  readonly old: readonly number[];
  readonly new: readonly number[];
}

function read(name: string): Expected[] {
  return readFileSync(join(VECTORS, name), "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Expected);
}

/** Lines of each side the pairing leaves changed, from 1. */
function changedBy(oldOfNew: Int32Array, oldCount: number): { old: number[]; new: number[] } {
  const paired = new Uint8Array(oldCount);
  const newChanged: number[] = [];
  oldOfNew.forEach((old, line) => {
    if (old < 0) newChanged.push(line + 1);
    else paired[old] = 1;
  });
  const oldChanged: number[] = [];
  paired.forEach((seen, line) => {
    if (!seen) oldChanged.push(line + 1);
  });
  return { old: oldChanged, new: newChanged };
}

const countLines = (text: string) => {
  let count = 0;
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") count++;
  return count + (text.length > 0 && text[text.length - 1] !== "\n" ? 1 : 0);
};

function rawChanged(old: string, new_: string) {
  const scanned = scanAlignment(bytesOf(old), bytesOf(new_));
  return changedBy(scanned.oldOfNew, countLines(old));
}

describe("alignment against the oracle's vectors", () => {
  const named = new Map(read("named.jsonl").map((v) => [v.id, v]));

  it.each(NAMED_CASES.map((c) => [c.id, c] as const))("%s", (id, c) => {
    const expected = named.get(id) as Expected;
    const got = rawChanged(c.old, c.new);
    expect(got.new).toEqual(expected.new);
    expect(got.old).toEqual(expected.old);
  });

  it("the exhaustive tables", () => {
    const { pairs, sha256 } = JSON.parse(
      readFileSync(join(VECTORS, "exhaustive.json"), "utf8"),
    ) as { pairs: number; sha256: string };
    const hash = createHash("sha256");
    let count = 0;
    for (const [old, new_] of exhaustivePairs()) {
      const got = rawChanged(old, new_);
      hash.update(`${got.old.join(",")}|${got.new.join(",")}\n`);
      count++;
    }
    expect(count).toBe(pairs);
    expect(hash.digest("hex")).toBe(sha256);
  });

  it("seeded pairs: what's settled agrees, and refusals are rare and only of what's refused", () => {
    const expected = read("seeded.jsonl");
    let refusedLines = 0;
    let lines = 0;
    seededPairs(20261107, expected.length).forEach((c, k) => {
      const want = expected[k] as Expected;
      const result = alignFiles(bytesOf(c.old), bytesOf(c.new));
      if (result.kind !== "aligned") return;
      const newChanged = new Set(want.new);
      const unsettled = new Uint8Array(result.oldOfNew.length);
      for (const { start, end } of result.unsettled) unsettled.fill(1, start, end);
      // The oracle's kept lines in order, to compare each settled line with its old line.
      const keptOld: number[] = [];
      const oldChanged = new Set(want.old);
      for (let line = 0; line < countLines(c.old); line++)
        if (!oldChanged.has(line + 1)) keptOld.push(line);
      let kept = 0;
      for (let line = 0; line < result.oldOfNew.length; line++) {
        lines++;
        const oracleOld = newChanged.has(line + 1) ? -1 : (keptOld[kept++] as number);
        if (unsettled[line]) {
          refusedLines++;
          continue;
        }
        expect(result.oldOfNew[line], `${c.id} line ${line + 1}`).toBe(oracleOld);
      }
    });
    expect(lines).toBeGreaterThan(50_000);
    // A close call is the only refusal here, and costs little.
    expect(refusedLines / lines).toBeLessThan(0.05);
  });
});
