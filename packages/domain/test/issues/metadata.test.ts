import { describe, expect, it } from "vitest";
import { REPO_ROLES } from "../../src/authz/roles.js";
import {
  decideMetadataAction,
  GITHUB_DEFAULT_LABELS,
  LABEL_COLOR,
  LABEL_NAME,
  labelNameKey,
  MAX_LABEL_NAME_LENGTH,
  METADATA_ACTIONS,
} from "../../src/issues/metadata.js";

describe("decideMetadataAction", () => {
  it("lets triage label, assign and set milestones, and write manage labels and milestones", () => {
    const least = Object.fromEntries(
      METADATA_ACTIONS.map((action) => [
        action,
        REPO_ROLES.find((role) => decideMetadataAction(action, role).ok),
      ]),
    );
    expect(least).toEqual({
      label: "triage",
      assign: "triage",
      set_milestone: "triage",
      manage_labels: "write",
      manage_milestones: "write",
    });
    for (const action of METADATA_ACTIONS)
      expect(decideMetadataAction(action, null)).toEqual({ ok: false, refusal: "forbidden" });
  });
});

describe("label names and colors", () => {
  it("take any characters but controls, without spaces around them", () => {
    for (const name of ["bug", "good first issue", "area/api", "ünïcode", "🐛", "a", "...", ".x"])
      expect(LABEL_NAME.test(name), name).toBe(true);
    for (const name of [" bug", "bug ", "", "a\nb", "\u0000", "\t", ".", ".."])
      expect(LABEL_NAME.test(name), JSON.stringify(name)).toBe(false);
  });

  it("are GitHub's for the defaults: valid, unique, lower-case colors", () => {
    expect(GITHUB_DEFAULT_LABELS).toHaveLength(9);
    for (const label of GITHUB_DEFAULT_LABELS) {
      expect(LABEL_NAME.test(label.name)).toBe(true);
      expect(label.name.length).toBeLessThanOrEqual(MAX_LABEL_NAME_LENGTH);
      expect(label.color).toMatch(/^[0-9a-f]{6}$/);
      expect(LABEL_COLOR.test(label.color)).toBe(true);
    }
    expect(new Set(GITHUB_DEFAULT_LABELS.map((l) => l.name)).size).toBe(9);
  });
});

describe("labelNameKey", () => {
  it("folds ASCII letters only, as storage compares names", () => {
    expect(labelNameKey("Bug Report")).toBe("bug report");
    expect(labelNameKey("Émoji")).toBe("Émoji");
  });
});
