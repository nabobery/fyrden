import { describe, expect, it } from "vitest";
import { FeedBlockSchema } from "../../src/events/feed.js";

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
});
