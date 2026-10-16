import { describe, expect, it } from "vitest";
import { mergeFiles, withConflictMarkers } from "../../src/merge/file-merge.js";
import { dec, enc } from "./support.js";

describe("withConflictMarkers", () => {
  const marked = (base: string, ours: string, theirs: string) => {
    const merged = mergeFiles(enc.encode(base), enc.encode(ours), enc.encode(theirs));
    if (merged.kind !== "conflict") return merged.kind;
    return dec.decode(
      withConflictMarkers(
        merged.regions,
        { ours: "ours", theirs: "theirs" },
        { base: enc.encode(base), ours: enc.encode(ours), theirs: enc.encode(theirs) },
      ),
    );
  };

  // Each expected file is what `git merge-file -p ours base theirs` writes.
  for (const [what, base, ours, theirs, expected] of [
    [
      "LF lines",
      "a\nb\nc\n",
      "a\nX\nc\n",
      "a\nY\nc\n",
      "a\n<<<<<<< ours\nX\n=======\nY\n>>>>>>> theirs\nc\n",
    ],
    [
      "CRLF lines",
      "a\r\nb\r\nc\r\n",
      "a\r\nX\r\nc\r\n",
      "a\r\nY\r\nc\r\n",
      "a\r\n<<<<<<< ours\r\nX\r\n=======\r\nY\r\n>>>>>>> theirs\r\nc\r\n",
    ],
    [
      "a side that deleted the lines",
      "a\nb\nc\n",
      "a\nc\n",
      "a\nY\nc\n",
      "a\n<<<<<<< ours\n=======\nY\n>>>>>>> theirs\nc\n",
    ],
    [
      "a base of LF lines and sides of CRLF lines (LF markers)",
      "b\n",
      "o\r\n",
      "t\r\n",
      "<<<<<<< ours\no\r\n=======\nt\r\n>>>>>>> theirs\n",
    ],
    [
      "a CRLF base and our first line ending with a bare LF (LF markers)",
      "b\r\n",
      "o\n",
      "t\r\n",
      "<<<<<<< ours\no\n=======\nt\r\n>>>>>>> theirs\n",
    ],
    [
      "a CRLF base and their first line ending with a bare LF (LF markers)",
      "b\r\n",
      "o\r\n",
      "t\n",
      "<<<<<<< ours\no\r\n=======\nt\n>>>>>>> theirs\n",
    ],
    [
      "a CRLF base and our only line without a line feed (CRLF markers, and one after it)",
      "b\r\n",
      "o",
      "t\r\n",
      "<<<<<<< ours\r\no\r\n=======\r\nt\r\n>>>>>>> theirs\r\n",
    ],
    [
      "a CRLF base and our side empty (CRLF markers)",
      "b\r\n",
      "",
      "t\r\n",
      "<<<<<<< ours\r\n=======\r\nt\r\n>>>>>>> theirs\r\n",
    ],
    [
      "a base whose first line is an empty CRLF line",
      "\r\nb\r\n",
      "\r\nX\r\n",
      "\r\nY\r\n",
      "\r\n<<<<<<< ours\r\nX\r\n=======\r\nY\r\n>>>>>>> theirs\r\n",
    ],
    [
      "a base whose first line is an empty LF line and the rest CRLF (LF markers)",
      "\nb\r\n",
      "\no\r\n",
      "\nt\r\n",
      "\n<<<<<<< ours\no\r\n=======\nt\r\n>>>>>>> theirs\n",
    ],
    [
      "a base whose first line is CRLF and last LF (only the first counts)",
      "p\r\nb\n",
      "p\r\no\r\n",
      "p\r\nt\r\n",
      "p\r\n<<<<<<< ours\r\no\r\n=======\r\nt\r\n>>>>>>> theirs\r\n",
    ],
    [
      "a CRLF base and a clean line before the conflict ending with a bare LF (LF markers)",
      "p\r\nq\nb\r\n",
      "p\r\nq\no\r\n",
      "p\r\nq\nt\r\n",
      "p\r\nq\n<<<<<<< ours\no\r\n=======\nt\r\n>>>>>>> theirs\n",
    ],
    [
      "a CRLF base and the last clean line before the conflict ending with CRLF",
      "p\r\nq\nr\r\nb\r\n",
      "p\r\nq\nr\r\no\r\n",
      "p\r\nq\nr\r\nt\r\n",
      "p\r\nq\nr\r\n<<<<<<< ours\r\no\r\n=======\r\nt\r\n>>>>>>> theirs\r\n",
    ],
  ] as const)
    it(`writes git's file for ${what}`, () => {
      expect(marked(base, ours, theirs)).toBe(expected);
    });
});
