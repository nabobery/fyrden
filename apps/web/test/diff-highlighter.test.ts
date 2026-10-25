import { afterEach, describe, expect, it, vi } from "vitest";
import { type Highlighter, highlighterChoice, within } from "../app/components/diff/highlighter.js";

const done = async () => {};

afterEach(() => {
  vi.useRealTimers();
});

describe("the diff highlighter's steps", () => {
  it("starts on Highlights where it runs, else on Shiki, once", () => {
    const where = highlighterChoice({ teardown: done, prepare: done });
    expect(where.current()).toBeNull();
    where.choose(true);
    expect(where.current()).toEqual({ name: "highlights", pool: true, step: 0 });
    where.choose(false);
    expect(where.current()?.name).toBe("highlights");
    const without = highlighterChoice({ teardown: done, prepare: done });
    without.choose(false);
    expect(without.current()).toEqual({ name: "shiki-js", pool: true, step: 1 });
  });

  it("suspends drawing while the failed step is torn down, then prepares and draws the next", async () => {
    const seen: unknown[] = [];
    let release = () => {};
    const tornDown = new Promise<void>((resolve) => {
      release = resolve;
    });
    const choice = highlighterChoice({
      teardown: () => {
        seen.push("teardown");
        return tornDown;
      },
      prepare: async (next) => {
        seen.push(`prepare ${next.step}`);
      },
    });
    choice.choose(true);
    choice.subscribe(() => seen.push(choice.current()));
    const stepped = choice.fail(0);
    expect(choice.current()).toBeNull();
    // The same failure reported again, and an earlier pool's, change nothing.
    await choice.fail(0);
    release();
    await stepped;
    expect(seen).toEqual([
      null,
      "teardown",
      "prepare 1",
      { name: "shiki-js", pool: true, step: 1 },
    ]);
    await choice.fail(0);
    expect(choice.current()?.step).toBe(1);
  });

  it("steps through Shiki without workers to plain, and stays there", async () => {
    const choice = highlighterChoice({ teardown: done, prepare: done });
    choice.choose(false);
    await choice.fail(1);
    expect(choice.current()).toEqual({ name: "shiki-js", pool: false, step: 2 });
    await choice.fail(2);
    expect(choice.current()).toEqual({ name: "plain", pool: false, step: 3 });
    await choice.fail(3);
    expect(choice.current()?.step).toBe(3);
  });

  it("goes plain when the next step cannot be prepared", async () => {
    const prepared: Highlighter[] = [];
    const choice = highlighterChoice({
      teardown: done,
      prepare: async (next) => {
        prepared.push(next);
        throw new Error("the page's highlighter did not load");
      },
    });
    choice.choose(false);
    await choice.fail(1);
    expect(prepared.map((h) => h.step)).toEqual([2]);
    expect(choice.current()?.name).toBe("plain");
  });

  it("goes plain, preparing nothing, when the teardown fails or never ends", async () => {
    const prepare = vi.fn(done);
    const failing = highlighterChoice({
      teardown: async () => {
        throw new Error("not disposed");
      },
      prepare,
    });
    failing.choose(true);
    await failing.fail(0);
    expect(failing.current()?.name).toBe("plain");
    vi.useFakeTimers();
    const stuck = highlighterChoice({
      teardown: () => new Promise(() => {}),
      prepare,
      timeoutMs: 10_000,
    });
    stuck.choose(true);
    const stepped = stuck.fail(0);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(stuck.current()).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    await stepped;
    expect(stuck.current()?.name).toBe("plain");
    expect(prepare).not.toHaveBeenCalled();
  });

  it("tells each listener until it leaves", async () => {
    const choice = highlighterChoice({ teardown: done, prepare: done });
    let told = 0;
    const leave = choice.subscribe(() => {
      told += 1;
    });
    choice.choose(true);
    leave();
    await choice.fail(0);
    expect(told).toBe(1);
  });
});

describe("work within a time", () => {
  it("is true only for work that succeeds in time", async () => {
    vi.useFakeTimers();
    expect(await within(Promise.resolve(1), 10)).toBe(true);
    expect(await within(Promise.reject(new Error("no")), 10)).toBe(false);
    const late = within(new Promise(() => {}), 10);
    await vi.advanceTimersByTimeAsync(10);
    expect(await late).toBe(false);
  });
});
