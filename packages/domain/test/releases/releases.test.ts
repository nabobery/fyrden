import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  isReleaseEvent,
  isWellFormedTagName,
  MAX_RELEASE_TAG_LENGTH,
  RELEASE_EVENTS,
  releaseEventsOfCreate,
  releaseEventsOfPublish,
} from "../../src/releases/releases.js";

describe("release events", () => {
  it("names the six actions, each once", () => {
    expect([...RELEASE_EVENTS].sort()).toEqual(
      [
        "release.created",
        "release.deleted",
        "release.edited",
        "release.prereleased",
        "release.published",
        "release.released",
      ].sort(),
    );
    expect(new Set(RELEASE_EVENTS).size).toBe(RELEASE_EVENTS.length);
  });

  it("knows its own names and no others", () => {
    expect(isReleaseEvent("release.published")).toBe(true);
    expect(isReleaseEvent("release.assets")).toBe(false);
    expect(isReleaseEvent("milestone.created")).toBe(false);
  });

  it("publishes, then says which kind", () => {
    expect(releaseEventsOfPublish(false)).toEqual(["release.published", "release.released"]);
    expect(releaseEventsOfPublish(true)).toEqual(["release.published", "release.prereleased"]);
  });

  it("creates a draft with one event, and a published release with all three", () => {
    expect(releaseEventsOfCreate({ draft: true, prerelease: false })).toEqual(["release.created"]);
    expect(releaseEventsOfCreate({ draft: true, prerelease: true })).toEqual(["release.created"]);
    expect(releaseEventsOfCreate({ draft: false, prerelease: true })).toEqual([
      "release.created",
      "release.published",
      "release.prereleased",
    ]);
  });
});

describe("tag names", () => {
  it("takes ordinary names, slashes and non-ASCII", () => {
    for (const tag of ["v1", "v1.0.0", "v1/rc", "släpp-1"])
      expect(isWellFormedTagName(tag)).toBe(true);
  });

  it("refuses empty, too long and ill-formed names", () => {
    expect(isWellFormedTagName("")).toBe(false);
    expect(isWellFormedTagName("a".repeat(MAX_RELEASE_TAG_LENGTH))).toBe(true);
    expect(isWellFormedTagName("a".repeat(MAX_RELEASE_TAG_LENGTH + 1))).toBe(false);
    expect(isWellFormedTagName("v1\uD800")).toBe(false);
  });

  it("takes any well-formed string within the length, and no lone surrogate", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme", minLength: 1, maxLength: 64 }), (tag) => {
        expect(isWellFormedTagName(tag)).toBe(tag.length <= MAX_RELEASE_TAG_LENGTH);
      }),
    );
    fc.assert(
      fc.property(
        fc.string({ maxLength: 16 }),
        fc.integer({ min: 0xd800, max: 0xdbff }),
        (a, s) => {
          expect(isWellFormedTagName(`${a}${String.fromCharCode(s)}`)).toBe(false);
        },
      ),
    );
  });
});
