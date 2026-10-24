import { describe, expect, it } from "vitest";
import { FeedBlockSchema, MAX_FEED_PAGE_BYTES, MAX_FEED_PAGES } from "../../src/events/feed.js";

const block = (threadKey: string, kind: "issue" | "pull", number: number) => ({
  threadKey,
  subject: { kind, number, title: "T", version: 1 },
  action: "comment",
  actorRoot: null,
  actorTrust: "write",
  member: null,
  excerpt: null,
  audience: [],
});

describe("FeedBlockSchema", () => {
  it("takes a thread of an issue or a pull request named by its subject", () => {
    expect(FeedBlockSchema.safeParse(block("issue/7", "issue", 7)).success).toBe(true);
    expect(FeedBlockSchema.safeParse(block("pull/12", "pull", 12)).success).toBe(true);
  });

  it("refuses another kind of thread, or one naming another subject", () => {
    expect(FeedBlockSchema.safeParse(block("discussion/7", "issue", 7)).success).toBe(false);
    expect(FeedBlockSchema.safeParse(block("pull/7", "issue", 7)).success).toBe(false);
    expect(FeedBlockSchema.safeParse(block("issue/8", "issue", 7)).success).toBe(false);
  });

  it("takes a manifest of the audience's further pages, numbered from 1, with a deadline", () => {
    const paged = (pages: unknown, deadline: unknown = 1_000) => ({
      ...block("issue/7", "issue", 7),
      pages,
      deadline,
    });
    const page = (n: number) => ({ n, count: 100, bytes: 20_000 });
    expect(FeedBlockSchema.safeParse(paged([page(1), page(2)])).success).toBe(true);
    // Without a manifest: a block as before it had pages.
    expect(FeedBlockSchema.safeParse(block("issue/7", "issue", 7)).success).toBe(true);
    // Out of order, missing a number, too many, too large, empty, or without a deadline.
    expect(FeedBlockSchema.safeParse(paged([page(2)])).success).toBe(false);
    expect(FeedBlockSchema.safeParse(paged([page(1), page(3)])).success).toBe(false);
    expect(
      FeedBlockSchema.safeParse(
        paged(Array.from({ length: MAX_FEED_PAGES + 1 }, (_, i) => page(i + 1))),
      ).success,
    ).toBe(false);
    expect(
      FeedBlockSchema.safeParse(paged([{ n: 1, count: 1, bytes: MAX_FEED_PAGE_BYTES + 1 }]))
        .success,
    ).toBe(false);
    expect(FeedBlockSchema.safeParse(paged([{ n: 1, count: 0, bytes: 10 }])).success).toBe(false);
    const { deadline: _, ...undated } = paged([page(1)]);
    expect(FeedBlockSchema.safeParse(undated).success).toBe(false);
    expect(
      FeedBlockSchema.safeParse({ ...block("issue/7", "issue", 7), deadline: 1_000 }).success,
    ).toBe(false);
  });
});
