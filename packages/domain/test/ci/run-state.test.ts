// The rules a run's attempts, job nodes and instances follow: every legal
// transition and the refusal of the rest, how instance outcomes become a
// node's result and a check, readiness, fail-fast, max-parallel, and how an
// attempt concludes.
import { describe, expect, it } from "vitest";
import {
  advanceAttempt,
  advanceInstance,
  attemptConclusion,
  type CancelMode,
  failFastVictims,
  type InstanceEvent,
  type InstanceState,
  type InstanceStatus,
  instanceCheck,
  isLive,
  needResultOf,
  nodeOutcome,
  nodeResultOf,
  promotable,
  readyNodes,
  unreadyNodeStatus,
} from "../../src/ci/run-state.js";

const instance = (status: InstanceStatus, extra: Partial<InstanceState> = {}): InstanceState => ({
  status,
  conclusion: null,
  cancelReason: null,
  continueOnError: false,
  ...extra,
});
const done = (conclusion: InstanceState["conclusion"], continueOnError = false): InstanceState => ({
  status: "completed",
  conclusion,
  cancelReason: null,
  continueOnError,
});

function step(state: InstanceState, event: InstanceEvent): InstanceState {
  const result = advanceInstance(state, event);
  if (!result.ok) throw new Error(`refused ${event.kind} from ${state.status}`);
  return result.state;
}

describe("instance transitions", () => {
  it("runs blocked -> queued -> in_progress -> completed", () => {
    let s = instance("blocked");
    s = step(s, { kind: "queue" });
    expect(s.status).toBe("queued");
    s = step(s, { kind: "assign" });
    expect(s.status).toBe("in_progress");
    s = step(s, { kind: "complete", result: "success" });
    expect(s).toEqual(done("success"));
  });

  it("maps each runner result to a conclusion", () => {
    for (const result of ["success", "failure", "cancelled", "skipped"] as const)
      expect(step(instance("in_progress"), { kind: "complete", result }).conclusion).toBe(result);
  });

  it("ends an instance that never started as cancelled when cancelled", () => {
    for (const status of ["blocked", "queued"] as const)
      for (const reason of ["cancel", "fail_fast", "displaced", "evicted"] as const)
        expect(step(instance(status), { kind: "cancel", reason })).toEqual({
          ...done("cancelled"),
          cancelReason: reason,
        });
  });

  it("asks a running instance to stop and keeps the first reason", () => {
    let s = step(instance("in_progress"), { kind: "cancel", reason: "timeout" });
    expect(s).toEqual(instance("cancelling", { cancelReason: "timeout" }));
    s = step(s, { kind: "cancel", reason: "cancel" });
    expect(s.cancelReason).toBe("timeout");
  });

  it("concludes a timed-out instance timed_out unless the runner reports success", () => {
    const timing = instance("cancelling", { cancelReason: "timeout" });
    expect(step(timing, { kind: "complete", result: "cancelled" }).conclusion).toBe("timed_out");
    expect(step(timing, { kind: "complete", result: "failure" }).conclusion).toBe("timed_out");
    expect(step(timing, { kind: "complete", result: "success" }).conclusion).toBe("success");
    expect(step(timing, { kind: "grace_expired" }).conclusion).toBe("timed_out");
  });

  it("concludes a cancelled instance cancelled when its grace ends", () => {
    for (const reason of ["cancel", "fail_fast", "evicted"] as const)
      expect(
        step(instance("cancelling", { cancelReason: reason }), { kind: "grace_expired" })
          .conclusion,
      ).toBe("cancelled");
  });

  it("fails an instance whose runner stopped reporting", () => {
    expect(step(instance("in_progress"), { kind: "heartbeat_lost" }).conclusion).toBe("failure");
    expect(
      step(instance("cancelling", { cancelReason: "cancel" }), { kind: "heartbeat_lost" })
        .conclusion,
    ).toBe("failure");
  });

  it("cancels an instance queued too long", () => {
    expect(step(instance("queued"), { kind: "queue_expired" }).conclusion).toBe("cancelled");
  });

  it("force-cancels anything unfinished", () => {
    for (const status of ["blocked", "queued", "in_progress", "cancelling"] as const)
      expect(step(instance(status), { kind: "force_cancel" }).conclusion).toBe("cancelled");
  });

  it("fails an instance before it starts on a configuration error", () => {
    for (const status of ["blocked", "queued"] as const)
      expect(step(instance(status), { kind: "fail" })).toEqual(done("failure"));
  });

  it("refuses every other transition", () => {
    const legal: Record<InstanceStatus, readonly InstanceEvent["kind"][]> = {
      blocked: ["queue", "cancel", "force_cancel", "fail"],
      queued: ["assign", "cancel", "queue_expired", "force_cancel", "fail"],
      in_progress: ["cancel", "complete", "heartbeat_lost", "force_cancel"],
      cancelling: ["cancel", "complete", "grace_expired", "heartbeat_lost", "force_cancel"],
      completed: [],
    };
    const events: InstanceEvent[] = [
      { kind: "queue" },
      { kind: "assign" },
      { kind: "cancel", reason: "cancel" },
      { kind: "complete", result: "success" },
      { kind: "grace_expired" },
      { kind: "heartbeat_lost" },
      { kind: "queue_expired" },
      { kind: "force_cancel" },
      { kind: "fail" },
    ];
    for (const [status, allowed] of Object.entries(legal) as [
      InstanceStatus,
      readonly InstanceEvent["kind"][],
    ][])
      for (const event of events) {
        const from =
          status === "completed"
            ? done("success")
            : instance(status, status === "cancelling" ? { cancelReason: "cancel" } : {});
        expect(advanceInstance(from, event).ok, `${event.kind} from ${status}`).toBe(
          allowed.includes(event.kind),
        );
      }
  });

  it("never changes a completed instance", () => {
    const result = advanceInstance(done("failure"), { kind: "complete", result: "success" });
    expect(result).toEqual({ ok: false, code: "invalid_transition" });
  });
});

describe("what an instance publishes and passes on", () => {
  it("maps live states onto a check's status", () => {
    expect(instanceCheck(instance("blocked"))).toBeUndefined();
    expect(instanceCheck(instance("queued"))).toEqual({ status: "queued", conclusion: null });
    expect(instanceCheck(instance("in_progress"))).toEqual({
      status: "in_progress",
      conclusion: null,
    });
    expect(instanceCheck(instance("cancelling", { cancelReason: "cancel" }))).toEqual({
      status: "in_progress",
      conclusion: null,
    });
  });

  it("publishes a failure allowed by continue-on-error as neutral", () => {
    expect(instanceCheck(done("failure", true))).toEqual({
      status: "completed",
      conclusion: "neutral",
    });
    expect(instanceCheck(done("timed_out", true))?.conclusion).toBe("neutral");
    expect(instanceCheck(done("failure"))?.conclusion).toBe("failure");
    expect(instanceCheck(done("cancelled", true))?.conclusion).toBe("cancelled");
  });

  it("passes a failure allowed by continue-on-error on as success", () => {
    expect(needResultOf(done("failure", true))).toBe("success");
    expect(needResultOf(done("timed_out", true))).toBe("success");
    expect(needResultOf(done("timed_out"))).toBe("failure");
    expect(needResultOf(done("cancelled"))).toBe("cancelled");
    expect(needResultOf(done("skipped"))).toBe("skipped");
  });

  it("aggregates a node's instances: failure, then cancelled, then all skipped, else success", () => {
    expect(nodeResultOf([done("success"), done("failure"), done("cancelled")])).toBe("failure");
    expect(nodeResultOf([done("success"), done("cancelled")])).toBe("cancelled");
    expect(nodeResultOf([done("skipped"), done("skipped")])).toBe("skipped");
    expect(nodeResultOf([done("skipped"), done("success")])).toBe("success");
    expect(nodeResultOf([done("failure", true), done("success")])).toBe("success");
  });

  it("counts queued, in-progress and cancelling instances as live", () => {
    expect(
      (["blocked", "queued", "in_progress", "cancelling", "completed"] as const).map((s) =>
        isLive(s),
      ),
    ).toEqual([false, true, true, true, false]);
  });
});

describe("max-parallel and fail-fast", () => {
  const statuses = (...list: InstanceStatus[]) => list.map((s) => instance(s));

  it("queues blocked instances in order while slots are free", () => {
    expect(promotable(statuses("blocked", "blocked", "blocked"), undefined)).toEqual([0, 1, 2]);
    expect(promotable(statuses("blocked", "blocked", "blocked"), 2)).toEqual([0, 1]);
    expect(promotable(statuses("in_progress", "blocked", "blocked"), 2)).toEqual([1]);
    expect(promotable(statuses("in_progress", "in_progress", "blocked"), 2)).toEqual([]);
  });

  it("keeps a cancelling instance's slot until it completes", () => {
    const list = [instance("cancelling", { cancelReason: "timeout" }), instance("blocked")];
    expect(promotable(list, 1)).toEqual([]);
    expect(promotable([done("timed_out"), instance("blocked")], 1)).toEqual([1]);
  });

  it("cancels the node's other unfinished instances when one fails", () => {
    const list = [
      done("failure"),
      instance("queued"),
      instance("in_progress"),
      instance("blocked"),
      done("success"),
    ];
    expect(failFastVictims(list, 0, true)).toEqual([1, 2, 3]);
    expect(failFastVictims(list, 0, false)).toEqual([]);
  });

  it("does not fail fast on a failure allowed by continue-on-error or on a cancel", () => {
    expect(failFastVictims([done("failure", true), instance("queued")], 0, true)).toEqual([]);
    expect(failFastVictims([done("cancelled"), instance("queued")], 0, true)).toEqual([]);
    expect(failFastVictims([done("timed_out"), instance("queued")], 0, true)).toEqual([1]);
  });
});

describe("readiness and nodes", () => {
  const chain = { A: [], B: ["A"], C: ["B"], D: [] } as Record<string, string[]>;
  const order = ["A", "B", "C", "D"];

  it("readies nodes whose direct needs are all terminal", () => {
    const status = { A: "waiting", B: "waiting", C: "waiting", D: "waiting" } as const;
    expect(
      readyNodes(
        order,
        (id) => chain[id] ?? [],
        (id) => status[id as "A"],
      ),
    ).toEqual(["A", "D"]);
    const later = { A: "done", B: "running", C: "waiting", D: "skipped" } as const;
    expect(
      readyNodes(
        order,
        (id) => chain[id] ?? [],
        (id) => later[id as "A"],
      ),
    ).toEqual([]);
    const end = { A: "failed", B: "skipped", C: "waiting", D: "done" } as const;
    expect(
      readyNodes(
        order,
        (id) => chain[id] ?? [],
        (id) => end[id as "A"],
      ),
    ).toEqual(["C"]);
  });

  it("gives a terminal node's outcome as a need result", () => {
    expect(nodeOutcome({ status: "done", result: "success" })).toBe("success");
    expect(nodeOutcome({ status: "skipped", result: null })).toBe("skipped");
    expect(nodeOutcome({ status: "failed", result: null })).toBe("failure");
    expect(nodeOutcome({ status: "cancelled", result: null })).toBe("cancelled");
    expect(nodeOutcome({ status: "waiting", result: null })).toBeUndefined();
  });

  it("skips a false node, or cancels it when the attempt is being cancelled", () => {
    expect(unreadyNodeStatus("none")).toBe("skipped");
    expect(unreadyNodeStatus("graceful")).toBe("cancelled");
    expect(unreadyNodeStatus("force")).toBe("cancelled");
  });
});

describe("attempts", () => {
  const attempt = (
    status: "queued" | "pending" | "in_progress" | "completed",
    cancel: CancelMode = "none",
  ) => ({
    status,
    conclusion: status === "completed" ? ("success" as const) : null,
    cancel,
  });

  it("concludes failure over cancelled over success, and cancelled when a cancel was asked", () => {
    expect(attemptConclusion("none", ["success", "skipped"])).toBe("success");
    expect(attemptConclusion("none", ["success", "failure", "cancelled"])).toBe("failure");
    expect(attemptConclusion("none", ["success", "cancelled"])).toBe("cancelled");
    expect(attemptConclusion("graceful", ["failure"])).toBe("cancelled");
    expect(attemptConclusion("none", [])).toBe("success");
  });

  it("is admitted, waits on its group, starts and finishes", () => {
    expect(advanceAttempt(attempt("queued"), { kind: "admitted" })).toMatchObject({
      ok: true,
      state: { status: "in_progress" },
    });
    expect(advanceAttempt(attempt("queued"), { kind: "pending" })).toMatchObject({
      ok: true,
      state: { status: "pending" },
    });
    expect(advanceAttempt(attempt("pending"), { kind: "admitted" })).toMatchObject({
      ok: true,
      state: { status: "in_progress" },
    });
    expect(
      advanceAttempt(attempt("in_progress"), { kind: "finished", conclusion: "failure" }),
    ).toMatchObject({ ok: true, state: { status: "completed", conclusion: "failure" } });
  });

  it("ends at once when cancelled before anything started", () => {
    for (const status of ["queued", "pending"] as const)
      for (const mode of ["graceful", "force"] as const)
        expect(advanceAttempt(attempt(status), { kind: "cancel", mode })).toEqual({
          ok: true,
          state: { status: "completed", conclusion: "cancelled", cancel: mode },
        });
    expect(advanceAttempt(attempt("queued"), { kind: "displaced" })).toMatchObject({
      ok: true,
      state: { status: "completed", conclusion: "cancelled" },
    });
  });

  it("marks a running attempt cancelled, force overriding graceful but not the reverse", () => {
    const graceful = advanceAttempt(attempt("in_progress"), { kind: "cancel", mode: "graceful" });
    expect(graceful).toMatchObject({
      ok: true,
      state: { status: "in_progress", cancel: "graceful" },
    });
    expect(
      advanceAttempt(attempt("in_progress", "graceful"), { kind: "cancel", mode: "force" }),
    ).toMatchObject({ ok: true, state: { cancel: "force" } });
    expect(
      advanceAttempt(attempt("in_progress", "force"), { kind: "cancel", mode: "graceful" }),
    ).toMatchObject({ ok: true, state: { cancel: "force" } });
  });

  it("fails a plan before anything starts", () => {
    expect(advanceAttempt(attempt("queued"), { kind: "plan_failed" })).toEqual({
      ok: true,
      state: { status: "completed", conclusion: "failure", cancel: "none" },
    });
  });

  it("refuses to change a completed attempt", () => {
    for (const event of [
      { kind: "admitted" },
      { kind: "cancel", mode: "force" },
      { kind: "finished", conclusion: "success" },
    ] as const)
      expect(advanceAttempt(attempt("completed"), event)).toEqual({
        ok: false,
        code: "attempt_completed",
      });
    expect(advanceAttempt(attempt("queued"), { kind: "finished", conclusion: "success" })).toEqual({
      ok: false,
      code: "invalid_transition",
    });
    expect(advanceAttempt(attempt("in_progress"), { kind: "pending" })).toEqual({
      ok: false,
      code: "invalid_transition",
    });
  });
});
