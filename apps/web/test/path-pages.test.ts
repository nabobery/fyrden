// The finder's page loop over `repos.paths.list`: every answer, what it waits for, what it keeps,
// and the words it has for each way a list can end.

import { listPaths } from "@fyrden/api-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  countParts,
  isComposingKey,
  listNotice,
  PATH_REQUEST_BUDGET,
  PATHS_PER_PAGE,
  PathLoader,
  type PathPage,
  type PathQuery,
  type PathReply,
  waitFor,
} from "../app/lib/path-pages.js";

const page = (fields: Partial<PathPage>): PathReply => ({
  status: 200,
  page: {
    state: "complete",
    reason: null,
    paths: [],
    unlisted_names: 0,
    next_cursor: null,
    retry_after_ms: null,
    ...fields,
  },
});
const more = (next: string, paths: string[], fields: Partial<PathPage> = {}) =>
  page({ state: "incomplete", reason: "more_pages", next_cursor: next, paths, ...fields });
const busy = (retry = 500, next: string | null = null) =>
  page({ state: "unavailable", reason: "busy", retry_after_ms: retry, next_cursor: next });
const unreadable = () => page({ state: "unavailable", reason: "unreadable" });

/** A loader answering `replies` in turn; what it asked and how long it waited are recorded. */
function loaderOf(...replies: (PathReply | Error)[]) {
  const queries: PathQuery[] = [];
  const waits: number[] = [];
  const seen: string[] = [];
  const controller = new AbortController();
  const loader = new PathLoader({
    ref: "main",
    signal: controller.signal,
    fetchPage: async (query) => {
      queries.push(query);
      const reply = replies.shift();
      if (!reply) throw new Error("asked for more pages than the test has");
      if (reply instanceof Error) throw reply;
      return reply;
    },
    wait: async (ms) => {
      waits.push(ms);
    },
    onChange: () => seen.push(`${loader.status}:${loader.index.size}`),
  });
  return { loader, queries, waits, seen, controller };
}

describe("loading a path list", () => {
  it("names the ref first, then follows each cursor, at the most paths a page holds", async () => {
    const { loader, queries } = loaderOf(
      more("c1", ["a"]),
      more("c2", ["b"]),
      page({ paths: ["c"] }),
    );
    await loader.run();
    expect(queries).toEqual([
      { ref: "main", per_page: PATHS_PER_PAGE },
      { cursor: "c1", per_page: PATHS_PER_PAGE },
      { cursor: "c2", per_page: PATHS_PER_PAGE },
    ]);
    expect(loader.status).toBe("complete");
    expect(loader.index.search("", 10).shown).toEqual(["a", "b", "c"]);
  });

  it("tells after each page, so the list shows as it grows", async () => {
    const { loader, seen } = loaderOf(more("c1", ["a"]), page({ paths: ["b"] }));
    await loader.run();
    expect(seen).toEqual(["loading:1", "complete:2"]);
  });

  it("carries on through an empty page: only a null cursor ends a list", async () => {
    const { loader } = loaderOf(more("c1", []), more("c2", []), page({ paths: ["a"] }));
    await loader.run();
    expect(loader.index.size).toBe(1);
    expect(loader.status).toBe("complete");
  });

  it("adds up the names it cannot show, once a page", async () => {
    const { loader } = loaderOf(more("c1", [], { unlisted_names: 2 }), page({ unlisted_names: 3 }));
    await loader.run();
    expect(loader.unlisted).toBe(5);
  });

  it("keeps what a truncated list has, and stops there", async () => {
    const { loader, queries } = loaderOf(
      more("c1", ["a"]),
      page({ state: "incomplete", reason: "malformed_tree", paths: ["b"] }),
    );
    await loader.run();
    expect(queries).toHaveLength(2);
    expect(loader.status).toBe("truncated");
    expect(loader.reason).toBe("malformed_tree");
    expect(loader.index.size).toBe(2);
  });
});

describe("a busy repository", () => {
  it("is asked again after exactly what it said, at the same position", async () => {
    const { loader, queries, waits } = loaderOf(
      more("c1", ["a"]),
      busy(700, "c1"),
      busy(1300, "c1"),
      page({ paths: ["b"] }),
    );
    await loader.run();
    expect(waits).toEqual([700, 1300]);
    expect(queries.slice(1).map((q) => q.cursor)).toEqual(["c1", "c1", "c1"]);
    expect(loader.status).toBe("complete");
    expect(loader.index.search("", 10).shown).toEqual(["a", "b"]);
  });

  it("is asked again with the ref when it had no position yet", async () => {
    const { loader, queries } = loaderOf(busy(), page({ paths: ["a"] }));
    await loader.run();
    expect(queries[1]).toEqual({ ref: "main", per_page: PATHS_PER_PAGE });
  });

  it("says it is waiting while it waits", async () => {
    const statuses: string[] = [];
    const replies = [busy(10), page({})];
    const loader: PathLoader = new PathLoader({
      ref: "main",
      signal: new AbortController().signal,
      fetchPage: async () => replies.shift() as PathReply,
      wait: async () => {
        statuses.push(loader.status);
      },
      onChange: () => {},
    });
    await loader.run();
    expect(statuses).toEqual(["waiting"]);
    expect(loader.status).toBe("complete");
  });

  it("gets three more tries, then the list is unavailable and a retry goes on from there", async () => {
    const { loader, queries, waits } = loaderOf(
      more("c1", ["a"]),
      busy(1, "c1"),
      busy(2, "c1"),
      busy(3, "c1"),
      busy(4, "c1"),
      page({ paths: ["b"] }),
    );
    await loader.run();
    expect(waits).toEqual([1, 2, 3]);
    expect(queries).toHaveLength(5);
    expect(loader.status).toBe("unavailable");
    expect(loader.reason).toBe("busy");
    expect(loader.index.size).toBe(1);
    await loader.retry();
    expect(queries.at(-1)?.cursor).toBe("c1");
    expect(loader.status).toBe("complete");
    expect(loader.index.size).toBe(2);
  });

  it("gets its three tries again once a page gets through", async () => {
    const { loader, waits } = loaderOf(
      busy(1),
      busy(2),
      busy(3),
      more("c1", ["a"]),
      busy(4, "c1"),
      busy(5, "c1"),
      busy(6, "c1"),
      page({}),
    );
    await loader.run();
    expect(waits).toEqual([1, 2, 3, 4, 5, 6]);
    expect(loader.status).toBe("complete");
  });

  it("answering 409 `busy` before any page waits too, with no time of its own to go by", async () => {
    const { loader, waits } = loaderOf({ status: 409, code: "busy" }, page({ paths: ["a"] }));
    await loader.run();
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThan(0);
    expect(loader.status).toBe("complete");
  });
});

describe("a list that cannot be had", () => {
  it("keeps its paths when an object cannot be read, and a retry goes on from there", async () => {
    const { loader, queries } = loaderOf(more("c1", ["a"]), unreadable(), page({ paths: ["b"] }));
    await loader.run();
    expect(loader.status).toBe("unavailable");
    expect(loader.reason).toBe("unreadable");
    expect(loader.index.size).toBe(1);
    await loader.retry();
    expect(queries.at(-1)?.cursor).toBe("c1");
    expect(loader.index.search("", 10).shown).toEqual(["a", "b"]);
  });

  it("starts over once when a cursor's commit is gone, without repeating a path", async () => {
    const { loader, queries } = loaderOf(
      more("c1", ["a"], { unlisted_names: 1 }),
      { status: 404, code: "ref_not_found" },
      more("c2", ["a"]),
      page({ paths: ["b"] }),
    );
    await loader.run();
    expect(queries[2]).toEqual({ ref: "main", per_page: PATHS_PER_PAGE });
    expect(loader.index.search("", 10).shown).toEqual(["a", "b"]);
    expect(loader.unlisted).toBe(0);
    expect(loader.status).toBe("complete");
  });

  it("tells as soon as it starts over, so what it dropped stops showing", async () => {
    const { loader, seen } = loaderOf(
      more("c1", ["a"]),
      { status: 404, code: "ref_not_found" },
      page({ paths: ["b"] }),
    );
    await loader.run();
    expect(seen).toEqual(["loading:1", "loading:0", "complete:1"]);
  });

  it("does not start over twice", async () => {
    const gone = { status: 404, code: "ref_not_found" };
    const { loader, queries } = loaderOf(more("c1", ["a"]), gone, more("c2", ["a"]), gone);
    await loader.run();
    expect(queries).toHaveLength(4);
    expect(loader.status).toBe("unavailable");
    expect(loader.reason).toBe("failed");
  });

  it("says when the ref is not there or the repository is empty: nothing to retry", async () => {
    const missing = loaderOf({ status: 404, code: "ref_not_found" });
    await missing.loader.run();
    expect(missing.loader.reason).toBe("not_found");
    expect(listNotice(missing.loader)?.retry).toBe(false);
    const empty = loaderOf({ status: 409, code: "repo_empty" });
    await empty.loader.run();
    expect(empty.loader.reason).toBe("empty");
    expect(listNotice(empty.loader)?.retry).toBe(false);
  });

  it("offers a retry for any other refusal, a failed request or an answer it cannot read", async () => {
    for (const reply of [
      { status: 500 },
      { status: 429, code: "rate_limited" },
      { status: 401, code: "unauthorized" },
      { status: 200 },
      new Error("the network went away"),
    ]) {
      const { loader } = loaderOf(reply);
      await loader.run();
      expect(loader.status).toBe("unavailable");
      expect(loader.reason).toBe("failed");
      expect(listNotice(loader)?.retry).toBe(true);
    }
  });

  it("stops when the page goes away: no more requests, no more news", async () => {
    const { loader, queries, seen, controller } = loaderOf(
      more("c1", ["a"]),
      page({ paths: ["b"] }),
    );
    controller.abort();
    await loader.run();
    expect(queries).toEqual([]);
    expect(seen).toEqual([]);
  });

  it("does not run twice at once", async () => {
    const { loader, queries } = loaderOf(page({ paths: ["a"] }));
    await Promise.all([loader.run(), loader.run(), loader.retry()]);
    expect(queries).toHaveLength(1);
    expect(loader.index.size).toBe(1);
  });
});

describe("a list that goes on and on", () => {
  /** A loader whose every answer goes on: a tree of endless empty directories. */
  function endless() {
    const queries: PathQuery[] = [];
    const loader = new PathLoader({
      ref: "main",
      signal: new AbortController().signal,
      fetchPage: async (query) => {
        queries.push(query);
        return more(`c${queries.length}`, []);
      },
      wait: async () => {},
      onChange: () => {},
    });
    return { loader, queries };
  }

  it("stops at the budget, says so, and asks before spending another", async () => {
    const { loader, queries } = endless();
    await loader.run();
    expect(queries).toHaveLength(PATH_REQUEST_BUDGET);
    expect(loader.status).toBe("partial");
    const notice = listNotice(loader);
    expect(notice?.retry).toBe(true);
    expect(notice?.continues).toBe(true);
    expect(notice?.browse).toBe(true);
    expect(notice?.text).toBe("This list isn't whole yet: this tree takes many requests to read.");
    await loader.retry();
    expect(queries).toHaveLength(2 * PATH_REQUEST_BUDGET);
    expect(queries.at(-1)?.cursor).toBe(`c${2 * PATH_REQUEST_BUDGET - 1}`);
    expect(loader.status).toBe("partial");
  });

  /** A list of `length` pages holding one path each. */
  function pagesOf(length: number) {
    const queries: PathQuery[] = [];
    const loader = new PathLoader({
      ref: "main",
      signal: new AbortController().signal,
      fetchPage: async (query) => {
        queries.push(query);
        const n = queries.length;
        return n < length ? more(`c${n}`, [`p${n}`]) : page({ paths: [`p${n}`] });
      },
      wait: async () => {},
      onChange: () => {},
    });
    return { loader, queries };
  }

  it("is 64 requests", () => {
    expect(PATH_REQUEST_BUDGET).toBe(64);
  });

  it("finishes a list that takes exactly the budget", async () => {
    const { loader, queries } = pagesOf(PATH_REQUEST_BUDGET);
    await loader.run();
    expect(queries).toHaveLength(PATH_REQUEST_BUDGET);
    expect(loader.status).toBe("complete");
    expect(listNotice(loader)).toBeNull();
  });

  it("stops a list one page longer with all it has, and one more request finishes it", async () => {
    const { loader, queries } = pagesOf(PATH_REQUEST_BUDGET + 1);
    await loader.run();
    expect(queries).toHaveLength(PATH_REQUEST_BUDGET);
    expect(loader.status).toBe("partial");
    expect(loader.index.size).toBe(PATH_REQUEST_BUDGET);
    await loader.retry();
    expect(queries).toHaveLength(PATH_REQUEST_BUDGET + 1);
    expect(loader.status).toBe("complete");
    expect(loader.index.size).toBe(PATH_REQUEST_BUDGET + 1);
  });

  it("takes one Continue for a list of 97 pages, as names of control characters can at the caps", async () => {
    const { loader, queries } = pagesOf(97);
    await loader.run();
    expect(loader.status).toBe("partial");
    await loader.retry();
    expect(queries).toHaveLength(97);
    expect(loader.status).toBe("complete");
    expect(loader.index.size).toBe(97);
  });

  it("is spent by a busy answer on its last request, and Continue asks at the same place", async () => {
    const queries: PathQuery[] = [];
    const loader = new PathLoader({
      ref: "main",
      signal: new AbortController().signal,
      fetchPage: async (query) => {
        queries.push(query);
        const n = queries.length;
        if (n === PATH_REQUEST_BUDGET) return busy(1, `c${n - 1}`);
        return n > PATH_REQUEST_BUDGET ? page({}) : more(`c${n}`, []);
      },
      wait: async () => {},
      onChange: () => {},
    });
    await loader.run();
    expect(queries).toHaveLength(PATH_REQUEST_BUDGET);
    expect(loader.status).toBe("partial");
    await loader.retry();
    expect(queries.at(-1)?.cursor).toBe(`c${PATH_REQUEST_BUDGET - 1}`);
    expect(loader.status).toBe("complete");
  });

  it("counts every request, a busy one's too", async () => {
    let asked = 0;
    const loader: PathLoader = new PathLoader({
      ref: "main",
      signal: new AbortController().signal,
      fetchPage: async () => {
        asked++;
        return asked % 2 === 1 ? busy(1) : more(`c${asked}`, []);
      },
      wait: async () => {},
      onChange: () => {},
    });
    await loader.run();
    expect(asked).toBe(PATH_REQUEST_BUDGET);
    expect(loader.status).toBe("partial");
  });

  it("says how much it has so far", () => {
    const line = (query: string, shown: number, total: number) =>
      countParts({ status: "partial", query, shown, total }).live;
    expect(line("", 2, 2)).toBe("2 files so far");
    expect(line("", 100, 300)).toBe("Showing the first 100 of 300 files so far");
    expect(line("", 0, 0)).toBe("No files so far");
    expect(line("x", 2, 2)).toBe("2 files match so far");
  });
});

describe("a dialog that closes", () => {
  /** A loader whose requests wait to be answered, and can be told they were dropped. */
  function held() {
    const queries: PathQuery[] = [];
    let answer: (reply: PathReply) => void = () => {};
    let refuse: (error: Error) => void = () => {};
    const waits: { ms: number; signal: AbortSignal }[] = [];
    const seen: string[] = [];
    const loader: PathLoader = new PathLoader({
      ref: "main",
      signal: new AbortController().signal,
      fetchPage: (query, signal) => {
        queries.push(query);
        signal.addEventListener("abort", () => refuse(new Error("aborted")));
        return new Promise((resolve, reject) => {
          answer = resolve;
          refuse = reject;
        });
      },
      wait: (ms, signal) => {
        waits.push({ ms, signal });
        return new Promise((resolve) => signal.addEventListener("abort", () => resolve()));
      },
      onChange: () => seen.push(loader.status),
    });
    return { loader, queries, waits, seen, answer: (reply: PathReply) => answer(reply) };
  }
  const settled = () => new Promise((resolve) => setImmediate(resolve));

  it("drops the request under way and asks for no more, at the same place when it opens again", async () => {
    const { loader, queries, answer } = held();
    const run = loader.run();
    answer(more("c1", ["a"]));
    await settled();
    expect(queries).toHaveLength(2);
    loader.pause();
    await run;
    expect(loader.status).toBe("paused");
    await settled();
    expect(queries).toHaveLength(2);
    expect(listNotice(loader)).toBeNull();
    const resumed = loader.resume();
    await settled();
    expect(queries.at(-1)).toEqual({ cursor: "c1", per_page: PATHS_PER_PAGE });
    expect(loader.status).toBe("loading");
    answer(page({ paths: ["b"] }));
    await resumed;
    expect(loader.index.search("", 10).shown).toEqual(["a", "b"]);
    expect(loader.status).toBe("complete");
  });

  it("stops waiting on a busy repository too", async () => {
    const { loader, queries, waits, answer } = held();
    const run = loader.run();
    answer(busy(60_000));
    await settled();
    expect(waits.map((w) => w.ms)).toEqual([60_000]);
    loader.pause();
    await run;
    expect(waits[0]?.signal.aborted).toBe(true);
    expect(queries).toHaveLength(1);
    expect(loader.status).toBe("paused");
  });

  it("goes on when it opens again before the request it dropped has ended", async () => {
    const { loader, queries, answer } = held();
    const run = loader.run();
    answer(more("c1", ["a"]));
    await settled();
    expect(queries).toHaveLength(2);
    loader.pause();
    const resumed = loader.resume();
    await settled();
    expect(queries).toHaveLength(3);
    expect(queries.at(-1)).toEqual({ cursor: "c1", per_page: PATHS_PER_PAGE });
    expect(loader.status).toBe("loading");
    answer(page({ paths: ["b"] }));
    await Promise.all([run, resumed]);
    expect(loader.status).toBe("complete");
    expect(loader.index.search("", 10).shown).toEqual(["a", "b"]);
  });

  it("goes on when it opens again before a dropped wait has ended", async () => {
    const { loader, queries, answer } = held();
    const run = loader.run();
    answer(busy(60_000));
    await settled();
    loader.pause();
    void loader.resume();
    await settled();
    expect(queries).toHaveLength(2);
    expect(loader.status).toBe("loading");
    answer(page({}));
    await run;
    expect(loader.status).toBe("complete");
  });

  it("stays stopped when it closes again before the request it dropped has ended", async () => {
    const { loader, queries, answer } = held();
    const run = loader.run();
    answer(more("c1", ["a"]));
    await settled();
    loader.pause();
    void loader.resume();
    loader.pause();
    await run;
    await settled();
    expect(queries).toHaveLength(2);
    expect(loader.status).toBe("paused");
  });

  it("keeps what it spent through a close and an opening that overlap", async () => {
    let asked = 0;
    const loader: PathLoader = new PathLoader({
      ref: "main",
      signal: new AbortController().signal,
      fetchPage: async () => {
        asked++;
        if (asked === 10) {
          loader.pause();
          void loader.resume();
        }
        return more(`c${asked}`, []);
      },
      wait: async () => {},
      onChange: () => {},
    });
    await loader.run();
    expect(asked).toBe(PATH_REQUEST_BUDGET);
    expect(loader.status).toBe("partial");
  });

  it("does not fill up the budget again by opening: only asking does", async () => {
    let asked = 0;
    const loader: PathLoader = new PathLoader({
      ref: "main",
      signal: new AbortController().signal,
      fetchPage: async () => {
        asked++;
        if (asked === 10) loader.pause();
        return more(`c${asked}`, []);
      },
      wait: async () => {},
      onChange: () => {},
    });
    await loader.run();
    expect(asked).toBe(10);
    await loader.resume();
    expect(asked).toBe(PATH_REQUEST_BUDGET);
    expect(loader.status).toBe("partial");
    await loader.resume();
    expect(asked).toBe(PATH_REQUEST_BUDGET);
  });

  it("leaves a finished or failed list as it is", async () => {
    const { loader, answer } = held();
    const run = loader.run();
    answer(page({ paths: ["a"] }));
    await run;
    loader.pause();
    expect(loader.status).toBe("complete");
    await loader.resume();
    expect(loader.status).toBe("complete");
  });
});

describe("waiting", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("takes exactly as long as it is told", async () => {
    vi.useFakeTimers();
    let done = false;
    void waitFor(5000, new AbortController().signal).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(4999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
  });

  it("ends at once when it is told to stop, or was already", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let done = false;
    void waitFor(5000, controller.signal).then(() => {
      done = true;
    });
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(true);
    let again = false;
    void waitFor(5000, controller.signal).then(() => {
      again = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(again).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("a key pressed while composing", () => {
  it("is the input method's, however the browser says so", () => {
    expect(isComposingKey({ isComposing: true, keyCode: 13 })).toBe(true);
    // Safari ends a composition with an Enter that no longer says it is composing.
    expect(isComposingKey({ isComposing: false, keyCode: 229 })).toBe(true);
    expect(isComposingKey({ isComposing: false, keyCode: 13 })).toBe(false);
  });
});

describe("refusals as the fixed API gives them", () => {
  it("does not start over for a repository that is gone: only a commit can go", async () => {
    const { loader, queries } = loaderOf(more("c1", ["a"]), {
      status: 404,
      code: "repo_not_found",
    });
    await loader.run();
    expect(queries).toHaveLength(2);
    expect(loader.status).toBe("unavailable");
    expect(loader.reason).toBe("failed");
    expect(loader.index.size).toBe(1);
  });

  it("does not call a repository that is gone a missing branch", async () => {
    const { loader } = loaderOf({ status: 404, code: "repo_not_found" });
    await loader.run();
    expect(loader.reason).toBe("failed");
  });

  it("starts over when a cursor's commit is gone, even with a branch named like it", async () => {
    const { loader, queries } = loaderOf(
      more("c1", ["a"]),
      { status: 404, code: "ref_not_found" },
      page({ paths: ["a"] }),
    );
    await loader.run();
    expect(queries).toHaveLength(3);
    expect(loader.index.size).toBe(1);
  });
});

describe("what a person is told", () => {
  const ended = async (reason: string) => {
    const { loader } = loaderOf(
      page({ state: "incomplete", reason, paths: Array.from({ length: 1234 }, (_, i) => `f${i}`) }),
    );
    await loader.run();
    return loader;
  };

  it("has a sentence for every reason the API can give, and none says the same", async () => {
    const reasons = listPaths.output.shape.reason.unwrap().options as readonly string[];
    expect(reasons).toContain("malformed_tree");
    const said = new Set<string>();
    for (const reason of reasons) {
      if (reason === "more_pages") continue;
      const { loader } = loaderOf(
        page({
          state: reason === "busy" || reason === "unreadable" ? "unavailable" : "incomplete",
          reason,
          retry_after_ms: reason === "busy" ? 1 : null,
          next_cursor: null,
        }),
        ...(reason === "busy" ? [busy(1), busy(1), busy(1)] : []),
      );
      await loader.run();
      const notice = listNotice(loader);
      expect(notice?.text, reason).toBeTruthy();
      said.add(notice?.text as string);
    }
    expect(said.size).toBe(reasons.length - 1);
  });

  it("tells a cap and a malformed tree what is shown and where the rest is", async () => {
    expect(listNotice(await ended("too_many_paths"))).toEqual({
      text: "Showing the first 1,234 files; this repository has more.",
      retry: false,
      browse: true,
    });
    const malformed = listNotice(await ended("malformed_tree"));
    expect(malformed?.text).toMatch(/^Showing the first 1,234 files: .*damaged/);
    expect(malformed?.text).not.toContain("Browse folders");
    expect(malformed?.browse).toBe(true);
    expect(malformed?.retry).toBe(false);
  });

  it("offers a retry, not folders, when the list is only unavailable", async () => {
    const { loader } = loaderOf(unreadable());
    await loader.run();
    expect(listNotice(loader)).toEqual({
      text: "The file list isn't available right now: some files can't be read at the moment.",
      retry: true,
      browse: true,
    });
  });

  it("tells names it cannot show, and says nothing when there is nothing to tell", async () => {
    const whole = loaderOf(page({ paths: ["a"] }));
    await whole.loader.run();
    expect(listNotice(whole.loader)).toBeNull();
    const one = loaderOf(page({ unlisted_names: 1 }));
    await one.loader.run();
    expect(listNotice(one.loader)?.text).toBe("1 file has a name that can't be shown.");
    const some = loaderOf(page({ unlisted_names: 2500 }));
    await some.loader.run();
    expect(listNotice(some.loader)?.text).toBe("2,500 files have names that can't be shown.");
  });

  it("puts a cap and left-out names in one notice", async () => {
    const { loader } = loaderOf(
      page({ state: "incomplete", reason: "too_deep", unlisted_names: 1, paths: ["a"] }),
    );
    await loader.run();
    expect(listNotice(loader)?.text).toMatch(/\w\. 1 file has a name/);
    expect(listNotice(loader)?.text).not.toContain("Browse folders");
  });

  it("says it is waiting, with nothing to press", async () => {
    let told: ReturnType<typeof listNotice> = null;
    const replies = [busy(10), page({})];
    const loader: PathLoader = new PathLoader({
      ref: "main",
      signal: new AbortController().signal,
      fetchPage: async () => replies.shift() as PathReply,
      wait: async () => {
        told = listNotice(loader);
      },
      onChange: () => {},
    });
    await loader.run();
    expect(told).toEqual({
      text: "The repository is busy; trying again…",
      retry: false,
      browse: false,
    });
  });

  it("says Loading once while the list grows, and keeps the growing count out of it", () => {
    const parts = (status: string, query: string, shown: number, total: number) =>
      countParts({ status: status as never, query, shown, total });
    const live = "Loading…";
    expect(parts("loading", "", 0, 0)).toEqual({ live, quiet: "" });
    expect(parts("loading", "", 50, 20000)).toEqual({
      live,
      quiet: "showing the first 50 of 20,000 files so far",
    });
    expect(parts("loading", "", 2, 2)).toEqual({ live, quiet: "2 files so far" });
    expect(parts("loading", "", 1, 1)).toEqual({ live, quiet: "1 file so far" });
    expect(parts("waiting", "", 50, 20000)).toEqual({
      live,
      quiet: "showing the first 50 of 20,000 files so far",
    });
    expect(parts("loading", "x", 0, 0)).toEqual({ live, quiet: "no files match so far" });
    expect(parts("loading", "x", 1, 1)).toEqual({ live, quiet: "1 file matches so far" });
    expect(parts("loading", "x", 2, 2)).toEqual({ live, quiet: "2 files match so far" });
    expect(parts("loading", "x", 50, 90)).toEqual({
      live,
      quiet: "showing the first 50 of 90 matches so far",
    });
    expect(parts("complete", "", 3, 3)).toEqual({ live: "3 files", quiet: "" });
  });

  it("counts what is shown, in every state of the list and the search", () => {
    const line = (status: string, query: string, shown: number, total: number) =>
      countParts({ status: status as never, query, shown, total }).live;
    expect(line("complete", "", 3, 3)).toBe("3 files");
    expect(line("complete", "", 1, 1)).toBe("1 file");
    expect(line("complete", "", 0, 0)).toBe("No files");
    expect(line("complete", "", 50, 30000)).toBe(
      "Showing the first 50 of 30,000 files. Type to narrow them.",
    );
    expect(line("complete", "x", 3, 3)).toBe("3 files match");
    expect(line("complete", "x", 1, 1)).toBe("1 file matches");
    expect(line("complete", "x", 0, 0)).toBe("No files match");
    expect(line("complete", "x", 50, 1234)).toBe(
      "Showing the first 50 of 1,234 matches. Type more to narrow them.",
    );
    expect(line("truncated", "x", 50, 1234)).toBe(
      "Showing the first 50 of 1,234 matches. Type more to narrow them.",
    );
    expect(line("unavailable", "", 0, 0)).toBe("");
  });
});
