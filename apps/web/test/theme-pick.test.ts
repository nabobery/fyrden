// A pick in the header shows at once, and goes back to what is really kept if it
// cannot be kept. Each test takes a fresh module: a tab's picks are module state.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ThemeMode } from "../app/lib/theme.js";

type Store = typeof import("../app/lib/use-theme-mode.js");
let store: Store;

/** A post the test settles, in the order it wants. */
function deferredPosts() {
  const posts: { mode: ThemeMode; ok(): void; fail(): void }[] = [];
  const post = (mode: ThemeMode) =>
    new Promise<void>((ok, fail) => {
      posts.push({ mode, ok, fail: () => fail(new Error("refused")) });
    });
  return { posts, post };
}

const untilStarted = async (posts: unknown[], count: number) => {
  // The chain starts each post on a later microtask.
  for (let turn = 0; turn < 20 && posts.length < count; turn++) await Promise.resolve();
  expect(posts).toHaveLength(count);
};

beforeEach(async () => {
  vi.resetModules();
  store = await import("../app/lib/use-theme-mode.js");
});

describe("a colour scheme picked in the header", () => {
  it("shows at once, and stays once kept", async () => {
    const { posts, post } = deferredPosts();
    const done = store.pickThemeMode("dark", "system", post);
    expect(store.themeModeShown("system")).toBe("dark");
    await untilStarted(posts, 1);
    posts[0]?.ok();
    await done;
    expect(store.themeModeShown("system")).toBe("dark");
  });

  it("goes back to what the server holds when it cannot be kept", async () => {
    const { posts, post } = deferredPosts();
    const done = store.pickThemeMode("dark", "light", post);
    await untilStarted(posts, 1);
    posts[0]?.fail();
    await done;
    expect(store.themeModeShown("light")).toBe("light");
  });

  it("goes back past a pick that was never kept when both fail", async () => {
    const { posts, post } = deferredPosts();
    const first = store.pickThemeMode("dark", "system", post);
    const second = store.pickThemeMode("light", "system", post);
    await untilStarted(posts, 1);
    posts[0]?.fail();
    await untilStarted(posts, 2);
    posts[1]?.fail();
    await Promise.all([first, second]);
    expect(store.themeModeShown("system")).toBe("system");
  });

  it("goes back to the last pick that was kept", async () => {
    const { posts, post } = deferredPosts();
    const first = store.pickThemeMode("dark", "system", post);
    await untilStarted(posts, 1);
    posts[0]?.ok();
    await first;
    const second = store.pickThemeMode("light", "system", post);
    await untilStarted(posts, 2);
    posts[1]?.fail();
    await second;
    expect(store.themeModeShown("system")).toBe("dark");
  });

  it("keeps the last pick when an earlier one fails", async () => {
    const { posts, post } = deferredPosts();
    const first = store.pickThemeMode("dark", "system", post);
    const second = store.pickThemeMode("light", "system", post);
    await untilStarted(posts, 1);
    posts[0]?.fail();
    await untilStarted(posts, 2);
    expect(store.themeModeShown("system")).toBe("light");
    posts[1]?.ok();
    await Promise.all([first, second]);
    expect(store.themeModeShown("system")).toBe("light");
  });

  it("posts picks one at a time, in the order they were made", async () => {
    const { posts, post } = deferredPosts();
    const first = store.pickThemeMode("dark", "system", post);
    const second = store.pickThemeMode("light", "system", post);
    await untilStarted(posts, 1);
    expect(posts.map((p) => p.mode)).toEqual(["dark"]);
    posts[0]?.ok();
    await untilStarted(posts, 2);
    posts[1]?.ok();
    await Promise.all([first, second]);
    expect(posts.map((p) => p.mode)).toEqual(["dark", "light"]);
  });

  it("does not bring an old pick back once the server has moved on", async () => {
    const { posts, post } = deferredPosts();
    const done = store.pickThemeMode("dark", "system", post);
    await untilStarted(posts, 1);
    posts[0]?.ok();
    await done;
    // Another tab saved Light, then System, each seen by a navigation in this tab.
    store.noteServerThemeMode("light");
    store.noteServerThemeMode("system");
    expect(store.themeModeShown("system")).toBe("system");
    // And a pick that then fails goes back to what the server says, not the old one.
    const failing = store.pickThemeMode("light", "system", post);
    await untilStarted(posts, 2);
    posts[1]?.fail();
    await failing;
    expect(store.themeModeShown("system")).toBe("system");
  });

  it("holds a pick still being kept, then catches up with what the server said meanwhile", async () => {
    const { posts, post } = deferredPosts();
    const saved = store.pickThemeMode("dark", "system", post);
    await untilStarted(posts, 1);
    posts[0]?.ok();
    await saved;
    const failing = store.pickThemeMode("light", "system", post);
    // A navigation while it is being kept: the server now says Dark.
    store.noteServerThemeMode("dark");
    expect(store.themeModeShown("system")).toBe("light");
    await untilStarted(posts, 2);
    posts[1]?.fail();
    await failing;
    // Another tab saves System, and this tab navigates again: the old pick stays gone.
    store.noteServerThemeMode("system");
    expect(store.themeModeShown("system")).toBe("system");
  });

  it("gives way when the server later says something newer, as after another tab's pick", async () => {
    const { posts, post } = deferredPosts();
    const done = store.pickThemeMode("dark", "system", post);
    await untilStarted(posts, 1);
    posts[0]?.ok();
    await done;
    // This page's root data is still the old word, so the pick shows.
    expect(store.themeModeShown("system")).toBe("dark");
    // A navigation reads the cookie again: another tab has saved Light since.
    expect(store.themeModeShown("light")).toBe("light");
  });
});
