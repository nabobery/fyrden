import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { generate } from "../src/gen-compatibility.ts";

const page = fileURLToPath(new URL("../../../docs/ci/compatibility.md", import.meta.url));

it("docs/ci/compatibility.md is what the support matrix and the corpus generate", () => {
  const expected = generate();
  if (process.env.UPDATE_COMPATIBILITY) writeFileSync(page, expected);
  expect(readFileSync(page, "utf8")).toBe(expected);
});
