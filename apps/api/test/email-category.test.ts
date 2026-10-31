// Which notification email an event's entries for one recipient make: by
// what the event did and why the recipient hears of it, entries shaped as
// the repository makes them.

import type { FeedEntry, FeedKind } from "@fyrden/domain";
import { describe, expect, it } from "vitest";
import { emailCategory } from "../src/email/category.js";
import { entry } from "./helpers/feed.js";

const of = (
  kind: FeedKind,
  reasons: string[],
  action: string,
  extra: { state?: "open" | "resolved"; silent?: boolean } = {},
): FeedEntry => entry({ version: 1, kind, reasons, action, ...extra });

describe("an email's category", () => {
  it("is direct for what asks something of the recipient", () => {
    expect(
      emailCategory([of("review_requested", ["requested_reviewer"], "review_requested")]),
    ).toBe("direct");
    expect(emailCategory([of("review_requested", ["requested_team"], "review_requested")])).toBe(
      "direct",
    );
    expect(emailCategory([of("assigned", ["assignee"], "assigned")])).toBe("direct");
    expect(emailCategory([of("mention", ["mentioned"], "comment")])).toBe("direct");
    // Its own item's state changed by another, or now in conflict (or reopened in conflict).
    for (const action of ["closed", "reopened", "merged"])
      expect(emailCategory([of("activity", ["author"], action)]), action).toBe("direct");
    expect(emailCategory([of("merge_conflict", ["author"], "merge_conflict")])).toBe("direct");
    expect(emailCategory([of("merge_conflict", ["author"], "reopened")])).toBe("direct");
  });

  it("is participating for activity on a thread taken part in or subscribed to", () => {
    expect(emailCategory([of("activity", ["author"], "comment")])).toBe("participating");
    expect(emailCategory([of("activity", ["commenter"], "comment")])).toBe("participating");
    expect(emailCategory([of("activity", ["subscribed"], "comment")])).toBe("participating");
    expect(emailCategory([of("approved", ["author"], "approved")])).toBe("participating");
  });

  it("is watching only for watched activity and nothing more", () => {
    expect(emailCategory([of("activity", ["watching"], "comment")])).toBe("watching");
    // A watcher who also took part: its participation wins.
    expect(
      emailCategory([
        of("activity", ["watching"], "comment"),
        of("activity", ["commenter"], "comment"),
      ]),
    ).toBe("participating");
  });

  it("is the event's own, never a thread's earlier mention", () => {
    // A mention earlier, then a comment: the comment's entry alone decides its email.
    expect(emailCategory([of("activity", ["mentioned"], "comment")])).toBe("participating");
  });

  it("is none for what only settles, the recipient's own action, or a digest", () => {
    expect(
      emailCategory([
        of("review_requested", ["requested_reviewer"], "reviewed", { state: "resolved" }),
      ]),
    ).toBeNull();
    expect(
      emailCategory([of("merge_conflict", ["author"], "merge_clean", { state: "resolved" })]),
    ).toBeNull();
    expect(emailCategory([of("activity", ["author"], "closed", { silent: true })])).toBeNull();
    expect(emailCategory([of("digest", ["watching"], "digest")])).toBeNull();
    expect(emailCategory([])).toBeNull();
  });
});
