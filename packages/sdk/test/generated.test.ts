import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AUTHENTICATED, defineOperation, defineRegistry, NoContent } from "@fyrden/api-contract";
import { expect, it } from "vitest";
import { z } from "zod";
import { generate } from "../scripts/generate.js";

const target = fileURLToPath(new URL("../src/generated.ts", import.meta.url));

it("src/generated.ts is what the API contract generates (pnpm generate)", () => {
  const expected = generate();
  if (process.env.UPDATE_SDK) writeFileSync(target, expected);
  expect(readFileSync(target, "utf8")).toBe(expected);
});

it("lists the statuses an operation answers with no body", () => {
  const common = {
    input: z.object({ name: z.string() }),
    output: NoContent,
    permission: AUTHENTICATED,
    principals: ["user"],
    rateLimit: "write",
    idempotency: "key",
    mcp: false,
  } as const;
  const generated = generate(
    defineRegistry([
      defineOperation({
        ...common,
        id: "test.things.put",
        method: "PUT",
        path: "/things/{name}",
        summary: "Put a thing",
        successStatuses: [201, 204],
      }),
      defineOperation({
        ...common,
        id: "test.things.create",
        method: "POST",
        path: "/things/{name}",
        summary: "Create a thing",
        successStatus: 201,
      }),
      defineOperation({
        ...common,
        id: "test.things.delete",
        method: "DELETE",
        path: "/things/{name}",
        summary: "Delete a thing",
        successStatus: 204,
      }),
    ]),
  );
  expect(generated).toContain(
    `"test.things.put": { method: "PUT", path: "/things/{name}", pathParams: ["name"], idempotent: true, noContent: [201,204] },`,
  );
  expect(generated).toContain(
    `"test.things.create": { method: "POST", path: "/things/{name}", pathParams: ["name"], idempotent: true, noContent: [201] },`,
  );
  expect(generated).toContain(
    `"test.things.delete": { method: "DELETE", path: "/things/{name}", pathParams: ["name"], idempotent: true, noContent: [204] },`,
  );
});
