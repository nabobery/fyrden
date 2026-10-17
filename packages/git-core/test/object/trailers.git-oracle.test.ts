import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appendTrailers } from "../../src/object/trailers.js";
import { createGitSandbox, type GitSandbox } from "../../testing/git-cli.js";

// Differential against `git interpret-trailers`: after appendTrailers,
// git reads every trailer it read before and then the new one, and the
// message's own text is kept as written (git also reformats trailers, and
// can even detach one it read before: its own placement is no better).

const TRAILER = "Co-authored-by: ada <a@x>";
const SCISSORS = "# ------------------------ >8 ------------------------";

/** Lines git's trailer rules treat in their own ways. */
const LINES = [
  "Fix it",
  "Fix: the thing",
  "",
  " ",
  "\t",
  "\u000b",
  "\u000c",
  " ",
  "\r",
  "Signed-off-by: B <b@x>",
  "Signed-off-by:Bob <b@x>",
  "Key: v",
  "Reviewed-by: Bob <b@x>",
  "Key : v",
  "Empty:",
  "two words: no",
  "  folded",
  "\rfolded",
  "some prose",
  "more prose",
  "# note",
  SCISSORS,
  "---",
  "--- a/x",
  "---no space",
  "--- x",
  "Conflicts:",
  "\tpath",
  "(cherry picked from commit abc)",
];

let sandbox: GitSandbox;
beforeAll(async () => {
  sandbox = await createGitSandbox();
});
afterAll(async () => {
  await sandbox.dispose();
});

const trailers = async (input: string) =>
  (await sandbox.git(["interpret-trailers", "--parse"], { input })).stdout;

describe("appendTrailers against git interpret-trailers", () => {
  it.each([
    ["no block yet", "Fix it\n", `Fix it\n\n${TRAILER}\n`],
    [
      "joining a block",
      "Fix\n\nSigned-off-by:Bob <b@x>\n",
      `Fix\n\nSigned-off-by:Bob <b@x>\n${TRAILER}\n`,
    ],
    ["before a patch", "Fix\n\n---\n\nDetails", `Fix\n\n${TRAILER}\n\n---\n\nDetails\n`],
    [
      "before a scissors line",
      `Fix\n\n${SCISSORS}\nrest\n`,
      `Fix\n\n${TRAILER}\n\n${SCISSORS}\nrest\n`,
    ],
    [
      "past a trailing comment",
      "Fix\n\nReviewed-by: Bob <b@x>\n# note\n",
      `Fix\n\nReviewed-by: Bob <b@x>\n${TRAILER}\n# note\n`,
    ],
    [
      "after a value folded on a CR",
      "Fix\n\nKey: v\n\rfolded\n",
      `Fix\n\nKey: v\n\rfolded\n${TRAILER}\n`,
    ],
    [
      "after a sign-off folded on a CR",
      "Fix\n\nSigned-off-by: B <b@x>\n\rfolded\n",
      `Fix\n\nSigned-off-by: B <b@x>\n\rfolded\n${TRAILER}\n`,
    ],
    [
      "before trailing comments and blank lines",
      "Fix\n\nKey: v\n\n# note\n \n",
      `Fix\n\nKey: v\n${TRAILER}\n\n# note\n \n`,
    ],
  ])("%s", async (_, message, expected) => {
    expect(appendTrailers(message, [TRAILER])).toBe(expected);
    expect(await trailers(expected)).toContain(`${TRAILER}\n`);
  });

  it("refuses a message with a NUL, which git stops reading at", () => {
    expect(() => appendTrailers("Fix\n\nKey: v\n\u0000", [TRAILER])).toThrow(RangeError);
  });

  it("leaves git reading what it read before, then the new trailer, for any message", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom(...LINES), { minLength: 1, maxLength: 8 }),
        fc.boolean(),
        async (lines, finalNewline) => {
          const message = lines.join("\n") + (finalNewline ? "\n" : "");
          const ours = appendTrailers(message, [TRAILER]);
          const theirs = (
            await sandbox.git(["interpret-trailers", "--trailer", TRAILER], { input: message })
          ).stdout;
          const read = await trailers(ours);
          expect(read).toBe(`${await trailers(message)}${TRAILER}\n`);
          // Never fewer than git's own placement leaves it reading (git may fold
          // a value differently once it has reformatted the block).
          const count = (parsed: string) => parsed.split("\n").filter(Boolean).length;
          expect(count(read)).toBeGreaterThanOrEqual(count(await trailers(theirs)));
          // The message's own text, completed with a final newline, is all still there:
          // taking out the trailer, and the blank line put before it if any, gives it back.
          const completed = message.endsWith("\n") || message === "" ? message : `${message}\n`;
          const at = ours.indexOf(`${TRAILER}\n`);
          const without = ours.slice(0, at) + ours.slice(at + TRAILER.length + 1);
          expect([without, without.slice(0, at - 1) + without.slice(at)]).toContain(completed);
        },
      ),
      { numRuns: 300 },
    );
  }, 120_000);
});
