import { describe, expect, it } from "vitest";
import { expiryProblem, MAX_REPO_TTL_MS } from "../../src/repos/expiry.js";

describe("expiryProblem", () => {
  const now = 1_000_000;

  it("accepts any future time up to one year ahead", () => {
    expect(expiryProblem(now + 1, now)).toBeUndefined();
    expect(expiryProblem(now + MAX_REPO_TTL_MS, now)).toBeUndefined();
  });

  it("refuses now, the past and beyond a year", () => {
    expect(expiryProblem(now, now)).toMatch(/future/);
    expect(expiryProblem(now - 1, now)).toMatch(/future/);
    expect(expiryProblem(now + MAX_REPO_TTL_MS + 1, now)).toMatch(/one year/);
  });
});
