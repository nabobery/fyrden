import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  digestThreadKey,
  FeedBlockSchema,
  MAX_FEED_PAGE_BYTES,
  MAX_FEED_PAGES,
  parseThreadKey,
} from "../../src/events/feed.js";

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

describe("parseThreadKey", () => {
  it("names a conversation, or a kind's digest of a window in a generation", () => {
    expect(parseThreadKey("issue/7")).toEqual({ subject: "issue", number: 7 });
    expect(parseThreadKey("pull/12")).toEqual({ subject: "pull", number: 12 });
    expect(parseThreadKey(digestThreadKey("pull", 1_992_439, 3))).toEqual({
      subject: "pull",
      digest: { window: 1_992_439, epoch: 3 },
    });
    expect(digestThreadKey("issue", 5, 1)).toBe("issue-digest/5.1");
  });

  it("reads back every key it makes, and a conversation's of any safe number", () => {
    const subject = fc.constantFrom("issue" as const, "pull" as const);
    const positive = fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER });
    fc.assert(
      fc.property(subject, positive, positive, (kind, window, epoch) => {
        expect(parseThreadKey(digestThreadKey(kind, window, epoch))).toEqual({
          subject: kind,
          digest: { window, epoch },
        });
      }),
    );
    fc.assert(
      fc.property(subject, positive, (kind, number) => {
        expect(parseThreadKey(`${kind}/${number}`)).toEqual({ subject: kind, number });
      }),
    );
  });

  it("names nothing for a key that is not one of its own, whatever its text", () => {
    fc.assert(
      fc.property(fc.string(), (key) => {
        const named = parseThreadKey(key);
        if (named === undefined) return;
        // Whatever it names is spelled as its own key would be (no leading zeros, no extras).
        expect(
          "digest" in named
            ? digestThreadKey(named.subject, named.digest.window, named.digest.epoch)
            : `${named.subject}/${named.number}`,
        ).toBe(key);
      }),
    );
  });

  it("names nothing for any other key", () => {
    for (const key of [
      "issue/0",
      "issue/07",
      "discussion/7",
      "issue-digest/5",
      "issue-digest/0.1",
      "issue-digest/5.0",
      "pull-digest/5.1.2",
      "issue/9007199254740993",
      "",
    ])
      expect(parseThreadKey(key), key).toBeUndefined();
  });
});

describe("an event's recipients", () => {
  it("are never told a digest (digest events tell digests)", () => {
    const recipient = (kind: string) => ({
      principal: "usr_1",
      kind,
      reasons: ["watching"],
      priority: "P1",
      state: "open",
      silent: false,
    });
    const told = (kind: string) => ({
      ...block("issue/7", "issue", 7),
      audience: [recipient(kind)],
    });
    expect(FeedBlockSchema.safeParse(told("activity")).success).toBe(true);
    expect(FeedBlockSchema.safeParse(told("digest")).success).toBe(false);
  });
});
