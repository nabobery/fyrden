import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { generate } from "../scripts/generate.js";

const target = fileURLToPath(new URL("../src/generated.ts", import.meta.url));

it("src/generated.ts is what the API contract generates (pnpm generate)", () => {
  const expected = generate();
  if (process.env.UPDATE_SDK) writeFileSync(target, expected);
  expect(readFileSync(target, "utf8")).toBe(expected);
});
