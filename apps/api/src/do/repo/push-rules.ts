import type { RepoGitStorage } from "@fyrden/adapters-cloudflare/git";
import {
  applicableRules,
  PRECHECK_RULES,
  principalTypeOf,
  type RepoRole,
  type RuleActor,
  type Ruleset,
  type RuleViolation,
  ruleViolations,
} from "@fyrden/domain";
import {
  type CheckedCommand,
  MissingCommitError,
  type Oid,
  oidToHex,
  type PackId,
  reachableCommits,
  WalkLimitError,
} from "@fyrden/git-core";
import type { SignedFact } from "../../signing/verification.js";
import type { RepoRulesets } from "./rulesets.js";

/** New commits one ref update's signatures are checked for at most. Proposed. */
export const MAX_SIGNED_COMMITS = 1_000;
/** Commits the walk for them may load (new ones and the old history it stops at). Proposed. */
export const MAX_SIGNED_WALK = 20_000;
/** Longest refusal reason, in UTF-8 bytes: one status line of git's report holds 65,516. Proposed. */
export const MAX_REFUSAL_BYTES = 2_000;

/**
 * What a check reads, taken at one moment: the rulesets, HEAD and the
 * pusher's role. The commit compares its stamp (see `RepoPush.rules`).
 */
export interface RuleSnapshot {
  readonly rulesets: readonly Ruleset[];
  /** The ref HEAD names, or null. */
  readonly head: string | null;
  readonly role: RepoRole | null;
}

export interface PushRulesDeps {
  readonly git: RepoGitStorage;
  /** The signature facts of commits, read from the live packs and `packs`, by hex id. */
  signatures(oids: readonly Oid[], packs: readonly PackId[]): Promise<Map<string, SignedFact>>;
  /** Whether each fact is a verified signature (see `verdicts`). */
  verdicts(facts: readonly SignedFact[]): Promise<{ verified: boolean; reason: string }[]>;
}

/** Whether any active ruleset has a rule checked before an upload. */
export function hasPrecheckRules(rulesets: RepoRulesets): boolean {
  return rulesets
    .current()
    .rulesets.some(
      (r) =>
        r.ruleset.enforcement === "active" &&
        r.ruleset.rules.some((rule) => PRECHECK_RULES.has(rule.type)),
    );
}

/** The branches `~DEFAULT_BRANCH` names for a push: the current one and one it sets. */
function defaultBranches(current: string | null, head: string | undefined): (string | null)[] {
  const branch = (ref: string | null | undefined) =>
    ref?.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : null;
  const now = branch(current);
  const next = branch(head);
  return next !== null && next !== now ? [now, next] : [now];
}

/** The blocking violations of `change` under any of `branches` as the default branch. */
function blocking(
  rulesets: readonly Ruleset[],
  change: Parameters<typeof ruleViolations>[1],
  actor: RuleActor,
  branches: readonly (string | null)[],
  stage: "precheck" | "commit",
): string[] {
  return violations(rulesets, change, actor, branches, stage).blocking;
}

/**
 * The violations of `change` under any of `branches` as the default
 * branch: the blocking ones' messages, and those of `evaluate` rulesets
 * (each rule once).
 */
function violations(
  rulesets: readonly Ruleset[],
  change: Parameters<typeof ruleViolations>[1],
  actor: RuleActor,
  branches: readonly (string | null)[],
  stage: "precheck" | "commit",
): { blocking: string[]; evaluated: RuleViolation[] } {
  const messages = new Set<string>();
  const evaluated = new Map<string, RuleViolation>();
  for (const branch of branches)
    for (const v of ruleViolations(rulesets, change, actor, branch, stage))
      if (v.blocking) messages.add(v.message);
      else evaluated.set(`${v.rulesetId}:${v.rule}`, v);
  return { blocking: [...messages], evaluated: [...evaluated.values()] };
}

/** One refusal reason from rule messages, kept within one line of git's report. */
export function refusalOf(messages: readonly string[]): string {
  const text = messages.join("; ");
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= MAX_REFUSAL_BYTES) return text;
  return `${new TextDecoder().decode(bytes.subarray(0, MAX_REFUSAL_BYTES - 3)).replace(/�+$/, "")}...`;
}

/**
 * Who the rules see: the principal, or for a write under a delegation
 * grant (`delegated`), the agent acting for it (rules such as "agents must
 * use pull requests" apply to the agent, never to the user).
 */
function actorOf(snapshot: RuleSnapshot, principal: string, delegated: boolean): RuleActor {
  return {
    // An id of no known type matches no ruleset's actor types but its own.
    principalType: delegated ? "agent" : (principalTypeOf(principal) ?? "installation"),
    role: snapshot.role,
  };
}

/**
 * The rulesets' refusals of ref updates before anything is stored: only
 * the rules on names and kinds of change (and who makes them), by index.
 * `head`: a default branch the change sets as it commits (an import's),
 * which `~DEFAULT_BRANCH` names too, as at the commit.
 */
export function precheckPushRules(
  snapshot: RuleSnapshot,
  principal: string,
  commands: readonly {
    readonly index: number;
    readonly name: string;
    readonly kind: CheckedCommand["kind"];
  }[],
  delegated = false,
  head?: string,
): Map<number, string> {
  const refusals = new Map<number, string>();
  const rulesets = snapshot.rulesets.filter((r) => r.enforcement === "active");
  if (rulesets.length === 0 || commands.length === 0) return refusals;
  const actor = actorOf(snapshot, principal, delegated);
  const branches = defaultBranches(snapshot.head, head);
  for (const cmd of commands) {
    const found = blocking(
      rulesets,
      { ref: cmd.name, kind: cmd.kind },
      actor,
      branches,
      "precheck",
    );
    if (found.length > 0) refusals.set(cmd.index, refusalOf(found));
  }
  return refusals;
}

/** What an `evaluate` ruleset would have refused of one ref update. */
export interface EvaluatedUpdate {
  readonly ref: string;
  readonly before: string | null;
  readonly after: string | null;
  /** Whether active rulesets refused it. */
  readonly refused: boolean;
  readonly violations: readonly RuleViolation[];
}

/**
 * The rulesets' refusals of a push's commands at its commit point: every
 * rule of every active ruleset that applies to the ref and the pusher,
 * with the fast-forward proof and, for `required_signatures`, the first
 * new commit (reachable from the new tip, not from the ref's old one)
 * whose signature is not verified. `evaluated`: what `evaluate` rulesets
 * would have refused, judged the same way, refusing nothing.
 */
export async function checkPushRules(
  deps: PushRulesDeps,
  snapshot: RuleSnapshot,
  input: {
    readonly principal: string;
    /** Written under a delegation grant: an agent acts for `principal`. */
    readonly delegated?: boolean;
    readonly uploadId: string;
    readonly packs: readonly PackId[];
    readonly head: string | undefined;
    readonly commands: readonly CheckedCommand[];
    /** An atomic push: one refused update fails them all. */
    readonly atomic?: boolean;
  },
): Promise<{ refusals: Map<number, string>; evaluated: EvaluatedUpdate[] }> {
  const refusals = new Map<number, string>();
  const evaluated: EvaluatedUpdate[] = [];
  const rulesets = snapshot.rulesets.filter((r) => r.enforcement !== "disabled");
  if (rulesets.length === 0 || input.commands.length === 0) return { refusals, evaluated };
  const actor = actorOf(snapshot, input.principal, input.delegated ?? false);
  const branches = defaultBranches(snapshot.head, input.head);
  // Refs often share new commits: each is read and judged once per push.
  const signed = sharedSignatures(deps);
  for (const cmd of input.commands) {
    const signing =
      cmd.kind === "delete"
        ? []
        : branches.flatMap((branch) =>
            applicableRules(rulesets, cmd.name, actor, branch).filter(
              (a) => a.rule.type === "required_signatures",
            ),
          );
    const enforced = signing.some((a) => a.ruleset.enforcement === "active");
    let unverifiedCommit: { sha: string; reason: string } | undefined;
    /** Why the signatures could not be checked: refused under an active rule. */
    let unchecked: string | undefined;
    if (signing.length > 0) {
      const found = await firstUnverified(signed, input, cmd);
      if (typeof found === "string") unchecked = found;
      else unverifiedCommit = found;
    }
    const found = violations(
      rulesets,
      {
        ref: cmd.name,
        kind: cmd.kind,
        fastForward: cmd.fastForward,
        ...(unverifiedCommit && { unverifiedCommit }),
      },
      actor,
      branches,
      "commit",
    );
    const blockingMessages = [
      ...(enforced && unchecked !== undefined ? [unchecked] : []),
      ...found.blocking,
    ];
    if (blockingMessages.length > 0) refusals.set(cmd.index, refusalOf(blockingMessages));
    // Signatures that could not be checked count against an evaluated rule, as they would refuse.
    const evaluating = signing.filter((a) => a.ruleset.enforcement === "evaluate");
    const notChecked: RuleViolation[] =
      unchecked === undefined
        ? []
        : [...new Map(evaluating.map((a) => [a.ruleset.id, a.ruleset])).values()].map((r) => ({
            rulesetId: r.id,
            ruleset: r.name,
            rule: "required_signatures",
            message: `${unchecked} (ruleset "${r.name}")`,
            blocking: false,
          }));
    const all = [...found.evaluated, ...notChecked];
    if (all.length > 0)
      evaluated.push({
        ref: cmd.name,
        before: cmd.oldOid ? oidToHex(cmd.oldOid) : null,
        after: cmd.newOid ? oidToHex(cmd.newOid) : null,
        refused: refusals.has(cmd.index),
        violations: all,
      });
  }
  // An atomic push one update of which is refused updates nothing.
  if (input.atomic && refusals.size > 0)
    return { refusals, evaluated: evaluated.map((u) => ({ ...u, refused: true })) };
  return { refusals, evaluated };
}

/**
 * `deps` remembering, across a push's ref updates, each commit's signature
 * fact and each fact's verdict (a commit that could not be read is asked
 * for again).
 */
export function sharedSignatures(deps: PushRulesDeps): PushRulesDeps {
  const facts = new Map<string, SignedFact>();
  const judged = new Map<string, { verified: boolean; reason: string }>();
  const keyOf = (f: SignedFact) => JSON.stringify([f.reason, f.key, f.committerEmail]);
  return {
    git: deps.git,
    async signatures(oids, packs) {
      const unread = oids.filter((oid) => !facts.has(oidToHex(oid)));
      if (unread.length > 0)
        for (const [hex, fact] of await deps.signatures(unread, packs)) facts.set(hex, fact);
      return new Map(
        oids.flatMap((oid) => {
          const fact = facts.get(oidToHex(oid));
          return fact ? [[oidToHex(oid), fact] as const] : [];
        }),
      );
    },
    async verdicts(asked) {
      const unjudged = [...new Map(asked.map((f) => [keyOf(f), f])).entries()].filter(
        ([key]) => !judged.has(key),
      );
      if (unjudged.length > 0) {
        const results = await deps.verdicts(unjudged.map(([, f]) => f));
        for (const [i, [key]] of unjudged.entries()) {
          const result = results[i];
          if (result) judged.set(key, result);
        }
      }
      return asked.map((f) => judged.get(keyOf(f)) ?? { verified: false, reason: "unverified" });
    },
  };
}

/**
 * The first new commit of an update whose signature is not verified,
 * undefined when all are, or why they cannot be checked.
 */
async function firstUnverified(
  deps: PushRulesDeps,
  input: { readonly uploadId: string; readonly packs: readonly PackId[] },
  cmd: CheckedCommand,
): Promise<{ sha: string; reason: string } | undefined | string> {
  const graph = deps.git.commitGraph;
  const view = { uploadId: input.uploadId };
  const tip = cmd.newOid as Oid;
  const [tipRow] = await graph.read([tip], view);
  if (!tipRow) return { sha: oidToHex(tip), reason: "not a commit" };
  // An old tip that is no commit excludes nothing: every commit of the new tip is new.
  const [oldRow] = cmd.oldOid ? await graph.read([cmd.oldOid], view) : [undefined];
  let commits: Oid[];
  try {
    const found = await reachableCommits(graph, view, [tip], oldRow ? [oldRow.oid] : [], {
      maxCommits: MAX_SIGNED_WALK,
    });
    if (found.size > MAX_SIGNED_COMMITS)
      return `more than ${MAX_SIGNED_COMMITS} new commits to check signatures of; push fewer at a time`;
    commits = [...found];
  } catch (error) {
    if (error instanceof WalkLimitError)
      return "the history is too long to find this update's new commits; push fewer at a time";
    if (error instanceof MissingCommitError) return { sha: oidToHex(tip), reason: "incomplete" };
    throw error;
  }
  const facts = await deps.signatures(commits, input.packs);
  const known = commits.flatMap((oid) => {
    const fact = facts.get(oidToHex(oid));
    return fact ? [{ oid, fact }] : [];
  });
  if (known.length < commits.length) {
    const unread = commits.find((oid) => !facts.has(oidToHex(oid))) as Oid;
    return { sha: oidToHex(unread), reason: "unreadable" };
  }
  const verdicts = await deps.verdicts(known.map((k) => k.fact));
  for (const [i, { oid }] of known.entries()) {
    const verdict = verdicts[i];
    if (!verdict?.verified) return { sha: oidToHex(oid), reason: verdict?.reason ?? "unverified" };
  }
  return undefined;
}
