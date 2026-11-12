// The browser's side of blame: paging every range from the start at one commit, walking at
// most 8 times a visit on its own, honouring the API's waits, starting again when the run
// is gone, and stopping while the tab is hidden. Driven by explicit signals: each request,
// wait and change of state is one the test answers or waits for, never a clock.

import { describe, expect, it } from "vitest";
import type { Range } from "../app/lib/blame.js";
import {
  type Answer,
  AUTOMATIC_REQUESTS,
  BlameDelivery,
  Budget,
  type DeliveryState,
  MAX_TEXT_BYTES,
  PAGE_RANGES,
  readBlameText,
} from "../app/lib/blame-delivery.js";

const COMMIT = "c".repeat(40);
const A = "a".repeat(40);

/** A deferred value, settled by the test. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A queue the delivery pushes to and the test pulls from, each pull waiting for the next push. */
function channel<T>() {
  const items: T[] = [];
  const waiting: ((item: T) => void)[] = [];
  return {
    push(item: T) {
      const next = waiting.shift();
      if (next) next(item);
      else items.push(item);
    },
    next(): Promise<T> {
      const item = items.shift();
      if (item !== undefined) return Promise.resolve(item);
      return new Promise((r) => waiting.push(r));
    },
    get pending() {
      return items.length;
    },
  };
}

interface Call {
  query: URLSearchParams;
  answer(answer: Answer): void;
}

/** The delivery's effects, each one the test sees and settles. */
function harness(
  mode: { kind: "whole" } | { kind: "window"; start: number; end: number } = { kind: "whole" },
  initial: ConstructorParameters<typeof BlameDelivery>[0]["initial"] = {
    lines: 10,
    resolved: 0,
    unresolved: 0,
    state: "partial",
  },
  budget = new Budget(),
) {
  const calls = channel<Call>();
  const sleeps = channel<{ seconds: number; wake(): void }>();
  let visible = true;
  const clock = { now: 0 };
  const listeners = new Set<() => void>();
  const states = channel<DeliveryState>();
  const delivery = new BlameDelivery({
    mode,
    initial,
    budget,
    deps: {
      ask: (query) => {
        const done = deferred<Answer>();
        calls.push({ query, answer: done.resolve });
        return done.promise;
      },
      sleep: (seconds) => {
        const done = deferred<void>();
        sleeps.push({ seconds, wake: () => done.resolve() });
        return done.promise;
      },
      visible: () => visible,
      now: () => clock.now,
      onVisibilityChange: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  });
  delivery.subscribe(() => states.push(delivery.snapshot()));
  /** Resolves once the delivery reaches a state `test` accepts. */
  async function until(test: (state: DeliveryState) => boolean): Promise<DeliveryState> {
    if (test(delivery.snapshot())) return delivery.snapshot();
    for (;;) {
      const state = await states.next();
      if (test(state)) return state;
    }
  }
  return {
    delivery,
    budget,
    calls,
    sleeps,
    until,
    clock,
    setVisible(value: boolean) {
      visible = value;
      for (const listener of listeners) listener();
    },
  };
}

const range = (start: number, count = 1, sha = A): Range => ({
  start_line: start,
  line_count: count,
  commit: sha,
  source_start_line: start,
});

const ok = (body: Record<string, unknown>): Answer => ({
  status: 200,
  retryAfter: null,
  body: {
    commit: COMMIT,
    lines: 10,
    state: "partial",
    resolved_lines: 0,
    unresolved_lines: 0,
    pending_lines: 10,
    ranges: [],
    commits: {},
    next_continuation: null,
    ...body,
  },
});

const problem = (status: number, code: string, retryAfter: number | null = null, extra = {}) => ({
  status,
  retryAfter,
  body: { status, code, detail: "words", ...extra },
});

describe("whole-file delivery", () => {
  it("pages every range from the start, at one page size, until the token runs out", async () => {
    const h = harness();
    h.delivery.start();
    const first = await h.calls.next();
    expect(Object.fromEntries(first.query)).toEqual({ per_page: String(PAGE_RANGES) });
    first.answer(ok({ ranges: [range(1, 4)], resolved_lines: 4, next_continuation: "t1" }));
    const second = await h.calls.next();
    expect(second.query.get("continuation")).toBe("t1");
    second.answer(
      ok({
        ranges: [range(5, 6)],
        resolved_lines: 10,
        pending_lines: 0,
        state: "complete",
        commits: { [A]: { summary: "s", author: { name: "n", email: "e", date: "1 +0000" } } },
        next_continuation: null,
      }),
    );
    const done = await h.until((s) => s.status === "done");
    expect(done.ranges).toEqual([range(1, 4), range(5, 6)]);
    expect(done.state).toBe("complete");
    expect(done.commits[A]?.summary).toBe("s");
    expect(h.calls.pending).toBe(0);
  });

  it("holds no ranges of its own until the first answer, so the server's window stays", async () => {
    const h = harness();
    expect(h.delivery.snapshot().ranges).toBeNull();
    h.delivery.start();
    (await h.calls.next()).answer(ok({ ranges: [], next_continuation: "t" }));
    expect((await h.until((s) => s.ranges !== null)).ranges).toEqual([]);
  });

  it("counts the first request, and paging while settled ranges wait, not at all", async () => {
    const h = harness();
    h.delivery.start();
    // The first request has no token: it may start a run, so it counts.
    (await h.calls.next()).answer(
      ok({ ranges: [range(1, 2)], resolved_lines: 6, next_continuation: "t1" }),
    );
    // 2 lines delivered of 6 settled: the next request only pages.
    (await h.calls.next()).answer(
      ok({ ranges: [range(3, 4)], resolved_lines: 6, next_continuation: "t2" }),
    );
    // All 6 delivered: the next one walks.
    await h.calls.next();
    expect(h.budget.used).toBe(2);
  });

  it("counts a request after an exactly full page that reached every settled line", async () => {
    const h = harness(undefined, { lines: 6_000, resolved: 0, unresolved: 0, state: "partial" });
    h.delivery.start();
    const full = Array.from({ length: PAGE_RANGES }, (_, k) => range(k + 1));
    (await h.calls.next()).answer(
      ok({ lines: 6_000, ranges: full, resolved_lines: PAGE_RANGES, next_continuation: "t1" }),
    );
    await h.calls.next();
    expect(h.budget.used).toBe(2);
  });

  it("doesn't count paging a blame the API has said is complete", async () => {
    const h = harness();
    h.delivery.start();
    (await h.calls.next()).answer(
      ok({ ranges: [range(1)], resolved_lines: 10, state: "complete", next_continuation: "t1" }),
    );
    (await h.calls.next()).answer(
      ok({ ranges: [range(2)], resolved_lines: 10, state: "complete", next_continuation: "t2" }),
    );
    await h.calls.next();
    expect(h.budget.used).toBe(1);
  });

  it(`stops after ${AUTOMATIC_REQUESTS} walking requests, and Continue allows as many more`, async () => {
    const h = harness();
    h.delivery.start();
    for (let k = 0; k < AUTOMATIC_REQUESTS; k++)
      (await h.calls.next()).answer(ok({ next_continuation: `t${k}` }));
    const paused = await h.until((s) => s.status === "budget");
    expect(paused.requests).toBe(AUTOMATIC_REQUESTS);
    expect(h.calls.pending).toBe(0);
    h.delivery.resume();
    for (let k = 0; k < AUTOMATIC_REQUESTS; k++)
      (await h.calls.next()).answer(ok({ next_continuation: `u${k}` }));
    expect((await h.until((s) => s.status === "budget")).requests).toBe(2 * AUTOMATIC_REQUESTS);
  });

  it("starts again from the first range when the run is gone, keeping the visit's count", async () => {
    const h = harness();
    h.delivery.start();
    (await h.calls.next()).answer(
      ok({ ranges: [range(1, 3)], resolved_lines: 3, next_continuation: "t1" }),
    );
    (await h.calls.next()).answer(problem(409, "blame_restarted"));
    const cleared = await h.until((s) => s.ranges !== null && s.ranges.length === 0);
    expect(cleared.ranges).toEqual([]);
    const again = await h.calls.next();
    expect(again.query.has("continuation")).toBe(false);
    expect(h.budget.used).toBe(3);
  });

  it("waits what a busy answer asks, counting it, from its body or its header", async () => {
    const h = harness();
    h.delivery.start();
    (await h.calls.next()).answer(problem(503, "blame_busy", null, { retry_after: 3 }));
    const wait = await h.sleeps.next();
    expect(wait.seconds).toBe(3);
    expect(h.delivery.snapshot().status).toBe("waiting");
    wait.wake();
    (await h.calls.next()).answer(problem(503, "blame_busy", 2));
    expect((await h.sleeps.next()).seconds).toBe(2);
    expect(h.budget.used).toBe(2);
  });

  it("counts a busy answer to a request that only paged", async () => {
    const h = harness();
    h.delivery.start();
    (await h.calls.next()).answer(
      ok({ ranges: [range(1)], resolved_lines: 5, next_continuation: "t1" }),
    );
    (await h.calls.next()).answer(problem(503, "blame_busy", 1));
    await h.sleeps.next();
    expect(h.budget.used).toBe(2);
  });

  it("stops at the budget when busy answers spend it while paging, owing the wait it asked for", async () => {
    const h = harness();
    h.delivery.start();
    // Settled lines wait undelivered, so the requests after this one only page.
    (await h.calls.next()).answer(
      ok({ ranges: [range(1)], resolved_lines: 9, next_continuation: "t1" }),
    );
    for (let k = 1; k < AUTOMATIC_REQUESTS; k++) {
      (await h.calls.next()).answer(problem(503, "blame_busy", 2));
      if (k < AUTOMATIC_REQUESTS - 1) (await h.sleeps.next()).wake();
    }
    const paused = await h.until((s) => s.status === "budget");
    expect(paused.requests).toBe(AUTOMATIC_REQUESTS);
    expect(h.calls.pending).toBe(0);
    expect(h.sleeps.pending).toBe(0);
    h.delivery.resume();
    // The wait the last busy answer asked for comes first.
    const owed = await h.sleeps.next();
    expect(owed.seconds).toBe(2);
    expect(h.calls.pending).toBe(0);
    owed.wake();
    expect((await h.calls.next()).query.get("continuation")).toBe("t1");
  });

  it("fails on a 200 that isn't a blame, keeping what it has", async () => {
    const h = harness();
    h.delivery.start();
    (await h.calls.next()).answer(
      ok({ ranges: [range(1)], resolved_lines: 1, next_continuation: "t1" }),
    );
    (await h.calls.next()).answer({ status: 200, retryAfter: null, body: null });
    const failed = await h.until((s) => s.status === "failed");
    expect(failed.ranges).toEqual([range(1)]);
    h.delivery.resume();
    (await h.calls.next()).answer({ status: 200, retryAfter: null, body: { ranges: "no" } });
    expect((await h.until((s) => s.status === "failed")).ranges).toEqual([range(1)]);
  });

  it("starts from what an earlier delivery of the visit had, until its own first answer", async () => {
    const budget = new Budget();
    budget.used = AUTOMATIC_REQUESTS;
    const seeded = [range(1, 4), range(9, 2)];
    const h = harness(
      { kind: "window", start: 1, end: 10 },
      {
        lines: 10,
        resolved: 6,
        unresolved: 0,
        state: "partial",
        ranges: seeded,
        commits: { [A]: { summary: "s", author: { name: "n", email: "e", date: "1 +0000" } } },
      },
      budget,
    );
    expect(h.delivery.snapshot().ranges).toEqual(seeded);
    h.delivery.start();
    const paused = await h.until((s) => s.status === "budget");
    expect(paused.ranges).toEqual(seeded);
    expect(paused.resolved).toBe(6);
    expect(paused.commits[A]?.summary).toBe("s");
    expect(h.calls.pending).toBe(0);
    h.delivery.resume();
    (await h.calls.next()).answer(
      ok({ ranges: [range(1, 10)], resolved_lines: 10, state: "complete" }),
    );
    expect((await h.until((s) => s.status === "done")).ranges).toEqual([range(1, 10)]);
  });

  it("asks nothing when an earlier delivery of the visit was refused, and keeps why", async () => {
    const h = harness(
      { kind: "window", start: 1, end: 10 },
      {
        lines: 10,
        resolved: 2,
        unresolved: 0,
        state: "partial",
        ranges: [range(1, 2)],
        status: "refused",
        refusal: "work_limit",
      },
    );
    h.delivery.start();
    h.delivery.resume();
    const state = h.delivery.snapshot();
    expect(state.status).toBe("refused");
    expect(state.refusal).toBe("work_limit");
    expect(state.ranges).toEqual([range(1, 2)]);
    expect(h.calls.pending).toBe(0);
    expect(h.budget.used).toBe(0);
  });

  it("asks nothing when an earlier delivery had every range", async () => {
    const h = harness(
      { kind: "window", start: 1, end: 10 },
      {
        lines: 10,
        resolved: 10,
        unresolved: 0,
        state: "complete",
        ranges: [range(1, 10)],
        status: "done",
      },
    );
    h.delivery.start();
    expect(h.delivery.snapshot().status).toBe("done");
    expect(h.calls.pending).toBe(0);
  });

  it("waits out what's left of a wait an earlier delivery owed before asking", async () => {
    const budget = new Budget();
    budget.used = AUTOMATIC_REQUESTS;
    const h = harness(
      { kind: "window", start: 1, end: 10 },
      { lines: 10, resolved: 0, unresolved: 0, state: "partial", owedUntil: 30_000 },
      budget,
    );
    h.clock.now = 10_000;
    h.delivery.start();
    await h.until((s) => s.status === "budget");
    expect(h.calls.pending).toBe(0);
    h.delivery.resume();
    const wait = await h.sleeps.next();
    expect(wait.seconds).toBe(20);
    expect(h.calls.pending).toBe(0);
    h.clock.now = 30_000;
    wait.wake();
    await h.calls.next();
  });

  it("still owes a wait being waited out, so a delivery replacing it mid-wait waits the rest", async () => {
    const budget = new Budget();
    budget.used = AUTOMATIC_REQUESTS;
    const first = harness(
      { kind: "whole" },
      { lines: 10, resolved: 0, unresolved: 0, state: "partial", owedUntil: 30_000 },
      budget,
    );
    first.clock.now = 10_000;
    first.delivery.start();
    await first.until((s) => s.status === "budget");
    first.delivery.resume();
    expect((await first.sleeps.next()).seconds).toBe(20);
    // Replaced partway through the wait: what it hands on still owes the deadline.
    const handed = first.delivery.snapshot();
    expect(handed.owedUntil).toBe(30_000);
    first.delivery.stop();
    const second = harness(
      { kind: "window", start: 1, end: 10 },
      { lines: 10, resolved: 0, unresolved: 0, state: "partial", owedUntil: handed.owedUntil },
      budget,
    );
    second.clock.now = 15_000;
    second.delivery.start();
    expect((await second.sleeps.next()).seconds).toBe(15);
    expect(second.calls.pending).toBe(0);
    expect(first.calls.pending).toBe(0);
  });

  it("waits retry_after_seconds before asking again", async () => {
    const h = harness();
    h.delivery.start();
    (await h.calls.next()).answer(ok({ next_continuation: "t1", retry_after_seconds: 4 }));
    const wait = await h.sleeps.next();
    expect(wait.seconds).toBe(4);
    expect(h.calls.pending).toBe(0);
    wait.wake();
    expect((await h.calls.next()).query.get("continuation")).toBe("t1");
  });

  it("asks nothing while the tab is hidden, and goes on when it's shown, at no cost", async () => {
    const h = harness();
    h.setVisible(false);
    h.delivery.start();
    await h.until((s) => s.status === "hidden");
    expect(h.calls.pending).toBe(0);
    h.setVisible(true);
    (await h.calls.next()).answer(ok({ next_continuation: "t1" }));
    h.setVisible(false);
    await h.until((s) => s.status === "hidden");
    expect(h.calls.pending).toBe(0);
    expect(h.budget.used).toBe(1);
  });

  it("stops at a refusal, with its code", async () => {
    const h = harness();
    h.delivery.start();
    (await h.calls.next()).answer(problem(422, "work_limit"));
    const refused = await h.until((s) => s.status === "refused");
    expect(refused.refusal).toBe("work_limit");
    expect(h.calls.pending).toBe(0);
  });

  it("stops at a failure keeping what it has, and Try again goes on from there", async () => {
    const h = harness();
    h.delivery.start();
    (await h.calls.next()).answer(
      ok({ ranges: [range(1)], resolved_lines: 1, next_continuation: "t1" }),
    );
    (await h.calls.next()).answer(problem(500, "internal"));
    const failed = await h.until((s) => s.status === "failed");
    expect(failed.ranges).toEqual([range(1)]);
    h.delivery.resume();
    expect((await h.calls.next()).query.get("continuation")).toBe("t1");
  });

  it("treats a request that couldn't be sent as a failure", async () => {
    const h = harness();
    h.delivery.start();
    (await h.calls.next()).answer({ status: 0, retryAfter: null, body: null });
    expect((await h.until((s) => s.status === "failed")).status).toBe("failed");
  });

  it("asks nothing more once stopped", async () => {
    const h = harness();
    h.delivery.start();
    const call = await h.calls.next();
    h.delivery.stop();
    call.answer(ok({ next_continuation: "t1" }));
    expect(h.delivery.snapshot().ranges).toBeNull();
    expect(h.calls.pending).toBe(0);
  });

  it("shares one count between deliveries of a visit", async () => {
    const budget = new Budget();
    budget.used = AUTOMATIC_REQUESTS - 1;
    const h = harness({ kind: "window", start: 1, end: 10 }, undefined, budget);
    h.delivery.start();
    (await h.calls.next()).answer(ok({}));
    expect((await h.until((s) => s.status === "budget")).status).toBe("budget");
  });
});

describe("window delivery", () => {
  it("asks for its window again until the blame is complete, replacing its ranges, each time counted", async () => {
    const h = harness({ kind: "window", start: 2_001, end: 4_000 });
    h.delivery.start();
    const first = await h.calls.next();
    expect(Object.fromEntries(first.query)).toEqual({ line_start: "2001", line_end: "4000" });
    first.answer(ok({ ranges: [range(2_001, 5)], resolved_lines: 5 }));
    (await h.calls.next()).answer(
      ok({ ranges: [range(2_001, 9)], resolved_lines: 10, state: "complete" }),
    );
    const done = await h.until((s) => s.status === "done");
    expect(done.ranges).toEqual([range(2_001, 9)]);
    expect(h.budget.used).toBe(2);
  });
});

describe("the whole text", () => {
  const stream = (chunks: Uint8Array[]) => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks.shift();
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    return { body, cancelled: () => cancelled };
  };

  it("reads text up to 1 MiB, keeping a byte order mark", async () => {
    const { body } = stream([new Uint8Array([0xef, 0xbb, 0xbf, 0x61]), new Uint8Array([0x0a])]);
    const read = await readBlameText(new Response(body), new AbortController().signal);
    expect(read).toEqual({ kind: "text", text: "﻿a\n" });
  });

  it("refuses an answer that says it's over 1 MiB, without reading it", async () => {
    const { body, cancelled } = stream([new Uint8Array(10)]);
    const response = new Response(body, {
      headers: { "Content-Length": String(MAX_TEXT_BYTES + 1) },
    });
    expect(await readBlameText(response, new AbortController().signal)).toEqual({
      kind: "too-large",
    });
    expect(cancelled()).toBe(true);
  });

  it("stops reading once the bytes pass 1 MiB", async () => {
    const half = new Uint8Array(MAX_TEXT_BYTES / 2 + 1).fill(0x61);
    const { body, cancelled } = stream([half, half, half]);
    expect(await readBlameText(new Response(body), new AbortController().signal)).toEqual({
      kind: "too-large",
    });
    expect(cancelled()).toBe(true);
  });

  it("says what isn't text", async () => {
    expect(
      await readBlameText(new Response(new Uint8Array([0x61, 0])), new AbortController().signal),
    ).toEqual({ kind: "binary" });
    expect(
      await readBlameText(new Response("x", { status: 404 }), new AbortController().signal),
    ).toEqual({ kind: "failed" });
  });
});
