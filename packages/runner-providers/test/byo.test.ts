import { describe, expect, it } from "vitest";
import { byoProvider, schedule } from "../src/index.js";
import { job } from "./helpers/jobs.js";

describe("the bring-your-own provider", () => {
  it("knows nothing of its machines but that it makes none", () => {
    expect(byoProvider.describe()).toEqual({
      provisions: false,
      os: [],
      arch: [],
      docker: "unknown",
      containerNetworking: "unknown",
      maxLifetimeMs: null,
    });
  });

  it("is never chosen to buy capacity, though it costs nothing", () => {
    for (const req of [job(), job({ docker: true, jobNetwork: true })])
      expect(schedule(req, [byoProvider])).toEqual({
        choice: null,
        dropped: [{ providerId: "byo", reason: "does_not_provision" }],
      });
  });
});
