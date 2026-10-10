import { describe, expect, it } from "vitest";
import { envDeployOptions } from "../src/index.ts";

describe("envDeployOptions", () => {
  it.each([
    ["missing", undefined],
    ["empty (an unset GitHub secret)", ""],
  ])("never generates a bootstrap secret in CI when the preset is %s", (_, preset) => {
    const options = envDeployOptions({ CI: "true", FYRDEN_BOOTSTRAP_SECRET: preset });
    expect(options.presetBootstrapSecret).toBeUndefined();
    expect(options.randomSecret).toBeUndefined();
  });

  it("uses a preset secret in CI", () => {
    expect(envDeployOptions({ CI: "1", FYRDEN_BOOTSTRAP_SECRET: "s" }).presetBootstrapSecret).toBe(
      "s",
    );
  });

  it("generates one locally, where the operator sees it", () => {
    const options = envDeployOptions({}, () => "generated");
    expect(options.randomSecret?.()).toBe("generated");
  });

  it("treats an empty CLOUDFLARE_ACCOUNT_ID as unset", () => {
    expect(envDeployOptions({ CLOUDFLARE_ACCOUNT_ID: "" }).envAccountId).toBeUndefined();
    expect(envDeployOptions({ CLOUDFLARE_ACCOUNT_ID: "a1" }).envAccountId).toBe("a1");
  });
});
