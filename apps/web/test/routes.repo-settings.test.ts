// A repository's settings form: saving other settings leaves its expiry as
// it was, to the millisecond; a date chosen means the end of that day, UTC.

import { describe, expect, it } from "vitest";
import { action } from "../app/routes/repo.settings.js";
import { fakeApi, formPost, json } from "./helpers/context.js";

async function save(fields: Record<string, string>): Promise<Record<string, unknown>> {
  const { context, calls } = fakeApi(() => json({}));
  const args = {
    request: formPost("/ada/demo/settings", {
      intent: "save",
      description: "d",
      default_branch: "main",
      ...fields,
    }),
    context,
    params: { owner: "ada", repo: "demo" },
  };
  expect(await action(args as never)).toEqual({ saved: true });
  const call = calls[0] as Request;
  expect(`${call.method} ${new URL(call.url).pathname}`).toBe("PATCH /api/repos/ada/demo");
  return call.json();
}

describe("saving a repository's settings", () => {
  it("leaves its expiry alone when its date is not changed", async () => {
    const body = await save({ expires_at: "2030-01-02", expires_shown: "2030-01-02" });
    expect(body).not.toHaveProperty("expires_at");
    expect(body).toMatchObject({ description: "d", default_branch: "main" });
  });

  it("sets a new date's end of day (UTC), or clears it", async () => {
    expect(await save({ expires_at: "2030-01-03", expires_shown: "2030-01-02" })).toMatchObject({
      expires_at: Date.parse("2030-01-03T23:59:59.999Z"),
    });
    expect(await save({ expires_at: "", expires_shown: "2030-01-02" })).toMatchObject({
      expires_at: null,
    });
    expect(await save({ expires_at: "2030-01-03", expires_shown: "" })).toMatchObject({
      expires_at: Date.parse("2030-01-03T23:59:59.999Z"),
    });
  });
});
