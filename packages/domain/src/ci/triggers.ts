/*
 * Which of a workflow's triggers an event matches, following GitHub's rules
 * (verified 2026-11-15, https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax,
 * `on.push.<branches|tags>`, `on.<pull_request|pull_request_target>.branches`
 * and `on.<push|pull_request>.paths`), with two conservative differences: a
 * new branch and an incomplete diff count a paths filter as matched.
 */
import { filterAllows, type PatternFilter, pathsAllow } from "./filter-pattern.js";
import type { Filter, Trigger } from "./workflow-schema.js";

/** An event that may start workflows. Refs are full (`refs/heads/main`). */
export type TriggerEvent =
  | {
      readonly kind: "push";
      /** `refs/heads/<branch>` or `refs/tags/<tag>`; any other ref matches nothing. */
      readonly ref: string;
      /** The push created the ref. */
      readonly created: boolean;
    }
  | {
      readonly kind: "pull_request" | "pull_request_target";
      /** The activity type, such as `opened` or `synchronize`. */
      readonly action: string;
      /** The base branch as a full ref; branches filters match it. */
      readonly baseRef: string;
    }
  | { readonly kind: "schedule"; readonly cron: string }
  | { readonly kind: "workflow_dispatch" };

/**
 * Changed paths for a paths filter: `complete` false when the list was cut
 * at a cap (or could not be computed), which counts the filter as matched.
 */
export interface ChangedPaths {
  readonly paths: readonly string[];
  readonly complete: boolean;
}

/** GitHub's default activity types for pull request events. */
const DEFAULT_PULL_TYPES: ReadonlySet<string> = new Set(["opened", "synchronize", "reopened"]);

const BRANCH = "refs/heads/";
const TAG = "refs/tags/";

/**
 * The trigger `event` matches, or null. A trigger with a paths filter that
 * the event reaches needs `changedPaths` (see {@link needsPaths}); passing
 * none then is a caller's error and throws.
 */
export function matchEvent(
  triggers: readonly Trigger[],
  event: TriggerEvent,
  changedPaths: ChangedPaths | "not_needed" = "not_needed",
): Trigger | null {
  const trigger = matchBeforePaths(triggers, event);
  const paths = trigger && pathsFilter(trigger, event);
  if (!trigger || !paths) return trigger;
  if (changedPaths === "not_needed") {
    throw new Error(`The ${event.kind} trigger has a paths filter and needs the changed paths.`);
  }
  if (!changedPaths.complete) return trigger;
  return pathsAllow(patternsOf(paths), changedPaths.paths) ? trigger : null;
}

/** Whether matching `event` needs the changed paths: the trigger it reaches has a paths filter. */
export function needsPaths(triggers: readonly Trigger[], event: TriggerEvent): boolean {
  const trigger = matchBeforePaths(triggers, event);
  return trigger !== null && pathsFilter(trigger, event) !== undefined;
}

/**
 * The trigger's paths filter when it applies: to branch pushes that did not
 * create the branch, and to pull requests ("Path filters are not evaluated
 * for pushes of tags", verified 2026-11-15, same page).
 */
function pathsFilter(trigger: Trigger, event: TriggerEvent): Filter | undefined {
  if (trigger.event === "schedule" || trigger.event === "workflow_dispatch") return undefined;
  if (event.kind === "push" && (!event.ref.startsWith(BRANCH) || event.created)) return undefined;
  return trigger.paths;
}

/** The trigger of `event`'s kind when every filter but paths lets the event through. */
function matchBeforePaths(triggers: readonly Trigger[], event: TriggerEvent): Trigger | null {
  // The parser refuses a repeated event key, so at most one trigger has this kind.
  const trigger = triggers.find((t) => t.event === event.kind);
  if (!trigger) return null;
  switch (event.kind) {
    case "push": {
      if (trigger.event !== "push") return null;
      const { branches, tags } = trigger;
      if (event.ref.startsWith(BRANCH)) {
        // Only tags filters: the workflow does not run for branches (and the reverse below).
        if (tags && !branches) return null;
        return !branches || allows(branches, event.ref.slice(BRANCH.length)) ? trigger : null;
      }
      if (event.ref.startsWith(TAG)) {
        if (branches && !tags) return null;
        return !tags || allows(tags, event.ref.slice(TAG.length)) ? trigger : null;
      }
      return null;
    }
    case "pull_request":
    case "pull_request_target": {
      if (trigger.event !== "pull_request" && trigger.event !== "pull_request_target") return null;
      const types = trigger.types
        ? trigger.types.some((t) => t.value === event.action)
        : DEFAULT_PULL_TYPES.has(event.action);
      if (!types) return null;
      if (!trigger.branches) return trigger;
      if (!event.baseRef.startsWith(BRANCH)) return null;
      return allows(trigger.branches, event.baseRef.slice(BRANCH.length)) ? trigger : null;
    }
    case "schedule":
      return trigger.event === "schedule" && trigger.crons.some((c) => c.value === event.cron)
        ? trigger
        : null;
    case "workflow_dispatch":
      return trigger;
  }
}

function patternsOf(filter: Filter): PatternFilter {
  return { mode: filter.mode, patterns: filter.patterns.map((p) => p.value) };
}

const allows = (filter: Filter, name: string) => filterAllows(patternsOf(filter), name);

const SKIP_STRINGS = ["[skip ci]", "[ci skip]", "[no ci]", "[skip actions]", "[actions skip]"];
const SKIP_TRAILER = /^skip-checks: ?true$/;
const TRAILER = /^[A-Za-z0-9-]+:[ \t]*\S/;

/**
 * Whether a commit message asks for no `push` or `pull_request` runs: one of
 * GitHub's skip strings anywhere, or `skip-checks: true` (or
 * `skip-checks:true`) as the last trailer of the message's trailer section
 * (verified 2026-11-15,
 * https://docs.github.com/en/actions/how-tos/manage-workflow-runs/skip-workflow-runs:
 * "The trailers section should be included at the end of your commit message
 * and be preceded by two empty lines"; "If you already have other trailers
 * in your commit message, `skip-checks` should be last"). The trailer section
 * is the final paragraph after the subject, every line of it a trailer; one
 * blank line before it is enough here, as git's own trailers take (whether
 * GitHub insists on two is unverified).
 */
export function hasSkipDirective(message: string): boolean {
  if (SKIP_STRINGS.some((s) => message.includes(s))) return true;
  const lines = message.split(/\r?\n/).map((l) => l.trim());
  let last = lines.length - 1;
  while (last >= 0 && lines[last] === "") last--;
  let first = last;
  while (first > 0 && lines[first - 1] !== "") first--;
  // The final paragraph must follow a blank line, and so is not the subject's.
  if (first === 0 || last < 0) return false;
  const section = lines.slice(first, last + 1);
  return section.every((l) => TRAILER.test(l)) && SKIP_TRAILER.test(section.at(-1) as string);
}

/** Skip directives apply to `push` and `pull_request` only (same page). */
export function skipDirectiveApplies(kind: TriggerEvent["kind"]): boolean {
  return kind === "push" || kind === "pull_request";
}
