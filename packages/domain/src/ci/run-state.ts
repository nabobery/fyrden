/*
 * The states of a CI run's attempts, job nodes and job instances, and the
 * rules they follow. A node is a workflow job; its instances are its matrix
 * combinations (one for a job without a matrix). The run's object stores
 * the states and applies these functions; nothing here reads a clock or
 * storage.
 */
import type { CheckConclusion, CheckStatus } from "../checks/checks.js";
import type { NeedResult } from "./expressions.js";

export const INSTANCE_STATUSES = [
  "blocked",
  "queued",
  "in_progress",
  "cancelling",
  "completed",
] as const;
/**
 * `blocked`: expanded, waiting for a max-parallel slot or its concurrency
 * group. `queued`: waiting for a runner. `cancelling`: its runner was told
 * to stop and has not answered yet.
 */
export type InstanceStatus = (typeof INSTANCE_STATUSES)[number];

export const INSTANCE_CONCLUSIONS = [
  "success",
  "failure",
  "cancelled",
  "skipped",
  "timed_out",
] as const;
export type InstanceConclusion = (typeof INSTANCE_CONCLUSIONS)[number];

export const CANCEL_REASONS = ["cancel", "fail_fast", "timeout", "displaced", "evicted"] as const;
export type CancelReason = (typeof CANCEL_REASONS)[number];

/** What the runner reports at the end of a task. */
export type RunnerResult = "success" | "failure" | "cancelled" | "skipped";

export interface InstanceState {
  readonly status: InstanceStatus;
  /** Set exactly when completed. */
  readonly conclusion: InstanceConclusion | null;
  /** Why it was asked to stop, once it was. */
  readonly cancelReason: CancelReason | null;
  /** `continue-on-error`: a failure neither fails dependents nor the run. */
  readonly continueOnError: boolean;
}

export type InstanceEvent =
  /** A max-parallel slot and its concurrency group are free. */
  | { readonly kind: "queue" }
  /** A runner took it. */
  | { readonly kind: "assign" }
  /** Graceful: an instance that has not started ends; a running one is told to stop. */
  | { readonly kind: "cancel"; readonly reason: CancelReason }
  | { readonly kind: "complete"; readonly result: RunnerResult }
  /** A cancelling instance's runner did not answer in time. */
  | { readonly kind: "grace_expired" }
  /** Its runner stopped reporting. */
  | { readonly kind: "heartbeat_lost" }
  /** No runner took it in time. */
  | { readonly kind: "queue_expired" }
  | { readonly kind: "force_cancel" }
  /** A configuration error found before it started (a self-blocking concurrency group). */
  | { readonly kind: "fail" };

export type InstanceStep =
  | { readonly ok: true; readonly state: InstanceState }
  | { readonly ok: false; readonly code: "invalid_transition" };

const refused = { ok: false, code: "invalid_transition" } as const;

function completed(
  state: InstanceState,
  conclusion: InstanceConclusion,
  cancelReason = state.cancelReason,
): InstanceStep {
  return { ok: true, state: { ...state, status: "completed", conclusion, cancelReason } };
}

/** The instance after `event`, or a refusal: a completed instance never changes. */
export function advanceInstance(state: InstanceState, event: InstanceEvent): InstanceStep {
  const { status } = state;
  if (status === "completed") return refused;
  const unstarted = status === "blocked" || status === "queued";
  const running = status === "in_progress" || status === "cancelling";
  switch (event.kind) {
    case "queue":
      return status === "blocked" ? { ok: true, state: { ...state, status: "queued" } } : refused;
    case "assign":
      return status === "queued"
        ? { ok: true, state: { ...state, status: "in_progress" } }
        : refused;
    case "cancel":
      if (unstarted) return completed(state, "cancelled", event.reason);
      // The first reason stays: a timeout that is then cancelled still timed out.
      return {
        ok: true,
        state: { ...state, status: "cancelling", cancelReason: state.cancelReason ?? event.reason },
      };
    case "complete":
      if (!running) return refused;
      if (state.cancelReason === "timeout" && event.result !== "success")
        return completed(state, "timed_out");
      return completed(state, event.result);
    case "grace_expired":
      if (status !== "cancelling") return refused;
      return completed(state, state.cancelReason === "timeout" ? "timed_out" : "cancelled");
    case "heartbeat_lost":
      return running ? completed(state, "failure") : refused;
    case "queue_expired":
      return status === "queued" ? completed(state, "cancelled") : refused;
    case "force_cancel":
      return completed(state, "cancelled");
    case "fail":
      return unstarted ? completed(state, "failure") : refused;
  }
}

/** Queued, in progress or cancelling: it holds (or is about to hold) a runner. */
export function isLive(status: InstanceStatus): boolean {
  return status === "queued" || status === "in_progress" || status === "cancelling";
}

/** A failure that counts: not allowed by `continue-on-error`. */
function failedHard(state: InstanceState): boolean {
  return (
    (state.conclusion === "failure" || state.conclusion === "timed_out") && !state.continueOnError
  );
}

/**
 * The check an instance publishes, or undefined while it is blocked (its
 * check starts when it is first queued). A failure allowed by
 * `continue-on-error` is `neutral`: it must not open a failing-checks item.
 */
export function instanceCheck(
  state: InstanceState,
): { readonly status: CheckStatus; readonly conclusion: CheckConclusion | null } | undefined {
  switch (state.status) {
    case "blocked":
      return undefined;
    case "queued":
      return { status: "queued", conclusion: null };
    case "in_progress":
    case "cancelling":
      return { status: "in_progress", conclusion: null };
    case "completed": {
      const conclusion = state.conclusion as InstanceConclusion;
      const allowed =
        state.continueOnError && (conclusion === "failure" || conclusion === "timed_out");
      return { status: "completed", conclusion: allowed ? "neutral" : conclusion };
    }
  }
}

/** A completed instance's result as its dependents see it. */
export function needResultOf(state: InstanceState): NeedResult {
  switch (state.conclusion) {
    case "failure":
    case "timed_out":
      return state.continueOnError ? "success" : "failure";
    case "cancelled":
      return "cancelled";
    case "skipped":
      return "skipped";
    default:
      return "success";
  }
}

/** A node's result from its completed instances: failure, then cancelled, then all skipped, else success. */
export function nodeResultOf(instances: readonly InstanceState[]): NeedResult {
  const results = instances.map(needResultOf);
  if (results.includes("failure")) return "failure";
  if (results.includes("cancelled")) return "cancelled";
  if (results.length > 0 && results.every((r) => r === "skipped")) return "skipped";
  return "success";
}

/**
 * Indices of blocked instances that may be queued now, in order, keeping at
 * most `maxParallel` live. A cancelling instance still holds its runner, so
 * it keeps its slot until it completes.
 */
export function promotable(
  instances: readonly InstanceState[],
  maxParallel: number | undefined,
): number[] {
  let room =
    maxParallel === undefined
      ? Number.POSITIVE_INFINITY
      : maxParallel - instances.filter((i) => isLive(i.status)).length;
  const out: number[] = [];
  instances.forEach((instance, index) => {
    if (room > 0 && instance.status === "blocked") {
      out.push(index);
      room--;
    }
  });
  return out;
}

/**
 * The instances fail-fast cancels after instance `failed` completed: every
 * other unfinished one of its node, when it failed without
 * `continue-on-error` and the node fails fast.
 */
export function failFastVictims(
  instances: readonly InstanceState[],
  failed: number,
  failFast: boolean,
): number[] {
  const source = instances[failed];
  if (!failFast || !source || !failedHard(source)) return [];
  const out: number[] = [];
  instances.forEach((instance, index) => {
    if (index !== failed && instance.status !== "completed") out.push(index);
  });
  return out;
}

export const NODE_STATUSES = [
  "waiting",
  "running",
  "done",
  "skipped",
  "failed",
  "cancelled",
] as const;
/**
 * `waiting`: its needs are not all terminal. `running`: expanded into
 * instances. `done`: every instance completed (its result aggregated).
 * `skipped`, `failed`, `cancelled`: decided without instances running (an
 * `if:` that was false, an expansion error, a cancel).
 */
export type NodeStatus = (typeof NODE_STATUSES)[number];

export interface NodeState {
  readonly status: NodeStatus;
  /** The aggregated result once `done`. */
  readonly result: NeedResult | null;
}

/** A terminal node's result as its dependents see it; undefined while it is not terminal. */
export function nodeOutcome(node: NodeState): NeedResult | undefined {
  switch (node.status) {
    case "done":
      return node.result ?? "success";
    case "skipped":
      return "skipped";
    case "failed":
      return "failure";
    case "cancelled":
      return "cancelled";
    default:
      return undefined;
  }
}

/** Waiting nodes, in `order`, whose direct needs are all terminal. */
export function readyNodes(
  order: readonly string[],
  needsOf: (id: string) => readonly string[],
  statusOf: (id: string) => NodeStatus,
): string[] {
  return order.filter(
    (id) =>
      statusOf(id) === "waiting" &&
      needsOf(id).every((need) => nodeOutcome({ status: statusOf(need), result: null })),
  );
}

export type CancelMode = "none" | "graceful" | "force";

/** A node whose `if:` is false: skipped, or cancelled when the attempt is being cancelled. */
export function unreadyNodeStatus(cancel: CancelMode): "skipped" | "cancelled" {
  return cancel === "none" ? "skipped" : "cancelled";
}

export type AttemptStatus = "queued" | "pending" | "in_progress" | "completed";
export type AttemptConclusion = "success" | "failure" | "cancelled";

export interface AttemptState {
  readonly status: AttemptStatus;
  readonly conclusion: AttemptConclusion | null;
  readonly cancel: CancelMode;
}

/** Cancelled when a cancel was asked; else failure if any node failed; else cancelled if any was; else success. */
export function attemptConclusion(
  cancel: CancelMode,
  nodeResults: readonly NeedResult[],
): AttemptConclusion {
  if (cancel !== "none") return "cancelled";
  if (nodeResults.includes("failure")) return "failure";
  if (nodeResults.includes("cancelled")) return "cancelled";
  return "success";
}

export type AttemptEvent =
  /** It owns its workflow concurrency group, or has none. */
  | { readonly kind: "admitted" }
  /** Its group is held by another run. */
  | { readonly kind: "pending" }
  /** A newer run took its place in the group before it started. */
  | { readonly kind: "displaced" }
  | { readonly kind: "plan_failed" }
  | { readonly kind: "cancel"; readonly mode: "graceful" | "force" }
  /** Every node is terminal. */
  | { readonly kind: "finished"; readonly conclusion: AttemptConclusion };

export type AttemptStep =
  | { readonly ok: true; readonly state: AttemptState }
  | { readonly ok: false; readonly code: "invalid_transition" | "attempt_completed" };

/** The attempt after `event`, or a refusal. An attempt that started nothing ends at once when cancelled. */
export function advanceAttempt(state: AttemptState, event: AttemptEvent): AttemptStep {
  if (state.status === "completed") return { ok: false, code: "attempt_completed" };
  const unstarted = state.status === "queued" || state.status === "pending";
  const end = (conclusion: AttemptConclusion, cancel = state.cancel): AttemptStep => ({
    ok: true,
    state: { status: "completed", conclusion, cancel },
  });
  switch (event.kind) {
    case "admitted":
      return unstarted
        ? { ok: true, state: { ...state, status: "in_progress" } }
        : { ok: false, code: "invalid_transition" };
    case "pending":
      return state.status === "queued"
        ? { ok: true, state: { ...state, status: "pending" } }
        : { ok: false, code: "invalid_transition" };
    case "displaced":
      return unstarted ? end("cancelled") : { ok: false, code: "invalid_transition" };
    case "plan_failed":
      return state.status === "queued" ? end("failure") : { ok: false, code: "invalid_transition" };
    case "cancel": {
      const mode = state.cancel === "force" ? "force" : event.mode;
      if (unstarted) return end("cancelled", mode);
      return { ok: true, state: { ...state, cancel: mode } };
    }
    case "finished":
      return state.status === "in_progress"
        ? end(event.conclusion)
        : { ok: false, code: "invalid_transition" };
  }
}
