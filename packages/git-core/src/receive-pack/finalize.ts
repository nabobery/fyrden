import { MissingCommitError, WalkLimitError } from "../graph/errors.js";
import { isAncestor } from "../graph/reachability.js";
import type { Oid } from "../object/oid.js";
import type { CommitGraph } from "../ports/commit-graph.js";
import type { PackId } from "../ports/pack-store.js";
import type { RefUpdate } from "../ports/ref-store.js";
import {
  ATOMIC_TRANSACTION_FAILED,
  failAtomically,
  liveCommands,
  type PushCommandState,
  type PushPlan,
  REFNAME_CONFLICT,
  refnameConflictMessage,
} from "./commands.js";
import type { IndexOutcome } from "./indexer.js";
import type { PushReport } from "./report.js";

/*
 * The commit point of a push: fast-forward proof per ref,
 * re-authorization, then the ref transaction(s). Atomic pushes commit every
 * ref in one transaction; other pushes commit ref by ref (deletions first,
 * as git does), each succeeding or failing on its own. The first
 * transaction that succeeds also makes the upload's pack unit live and its
 * pending commit rows verified.
 */

/** One ref transaction, for the repository's commit point (`commitSync` in the Durable Object). */
export interface PushCommitRequest {
  readonly uploadId: string;
  /**
   * True for the first transaction of the push that can succeed: it must also
   * make `packs` live, promote the upload's pending commit rows and mark the
   * upload committed. False once an earlier transaction of this push did.
   */
  readonly withUpload: boolean;
  /** The upload's pack unit (empty for a push without objects). */
  readonly packs: readonly PackId[];
  /** Existing packs the connectivity check relied on; refuse if one is no longer readable. */
  readonly deps: readonly PackId[];
  /** Compare-and-set updates; `name` is valid UTF-8 and passed `isValidRefname`. */
  readonly updates: readonly RefUpdate[];
  /** Updates proven fast-forward over verified rows plus this upload's pending rows. */
  readonly fastForward: ReadonlySet<string>;
}

export type PushCommitResult =
  | { readonly ok: true }
  /** A ref's current value is not the expected old value. */
  | { readonly ok: false; readonly reason: "ref-conflict"; readonly ref: string }
  /** Creating `ref` would collide with `conflictsWith`, a ref above or below it. */
  | {
      readonly ok: false;
      readonly reason: "refname-conflict";
      readonly ref: string;
      readonly conflictsWith: string;
    }
  /** The in-transaction authorization refused (ACL snapshot expired, ruleset). */
  | { readonly ok: false; readonly reason: "refused"; readonly message: string }
  /** Anything else that leaves the refs unchanged (a dependency gone, upload not ready). */
  | { readonly ok: false; readonly reason: "failed"; readonly message: string };

export interface FinalizeEnv {
  readonly commitGraph: CommitGraph;
  /**
   * Re-authorizes the pusher just before the commit (token and grant
   * revocation from the primary, a fresh ACL snapshot). Returns a message
   * to refuse the push; a token that merely expired during an accepted
   * upload is not a refusal. Runs once per push.
   */
  reauthorize(): Promise<string | undefined>;
  /** Runs one ref transaction. */
  commit(request: PushCommitRequest): Promise<PushCommitResult>;
  /**
   * The repository's own rules on each live command (rulesets), once the
   * fast-forward proof is known and the pusher re-authorized: a refusal
   * message by command index. Runs once per push.
   */
  checkCommands?(commands: readonly CheckedCommand[]): Promise<ReadonlyMap<number, string>>;
  /** Commits a fast-forward walk may visit per ref. Proposed: 100,000. Beyond it, the update counts as non-fast-forward. */
  readonly maxFastForwardWalk?: number;
  /** git's receive.denyNonFastForwards for refs/heads/. Default false. */
  readonly denyNonFastForwards?: boolean;
}

/** A live command as the rules see it. */
export interface CheckedCommand {
  readonly index: number;
  readonly name: string;
  readonly kind: "create" | "update" | "delete";
  readonly oldOid: Oid | null;
  readonly newOid: Oid | null;
  /** For an update: whether the new commit has the old one in its history. */
  readonly fastForward: boolean;
}

export interface PushResult {
  readonly report: PushReport;
  /** Lines for the client's progress channel (side-band 2). */
  readonly messages: readonly string[];
  /** Whether a transaction made the upload live; when false the caller discards it. */
  readonly uploadCommitted: boolean;
  /** The ref updates that took effect, in order (for the push event). */
  readonly applied: readonly RefUpdate[];
  /** Push options as sent, for the push event. */
  readonly pushOptions: readonly Uint8Array[];
}

const DEFAULT_MAX_WALK = 100_000;

/**
 * Finishes a push whose indexing is done (or that had no pack). Mutates the
 * plan's command states and returns the report.
 */
export async function finalizePush(
  plan: PushPlan,
  indexed: IndexOutcome | undefined,
  uploadId: string,
  env: FinalizeEnv,
): Promise<PushResult> {
  const messages = [...plan.messages];
  const done = (unpackError: string | undefined, committed: boolean, applied: RefUpdate[]) => ({
    report: { unpackError, commands: plan.commands },
    messages,
    uploadCommitted: committed,
    applied,
    pushOptions: plan.pushOptions,
  });

  if (indexed && !indexed.ok) {
    for (const message of indexed.failure.messages) messages.push(message);
    for (const cmd of plan.commands) cmd.error ??= "unpacker error";
    return done(indexed.failure.status, false, []);
  }
  if (indexed) {
    // A warning per object can be many: no argument spreading.
    for (const message of indexed.messages) messages.push(message);
    for (const [index, reason] of indexed.commandErrors) {
      const cmd = plan.commands[index];
      if (cmd && cmd.error === undefined) cmd.error = reason;
    }
  }
  failAtomically(plan);

  const fastForward = new Set<string>();
  for (const cmd of liveCommands(plan)) {
    if (cmd.kind !== "update") continue;
    const ff = await isFastForward(env, uploadId, cmd.oldOid as Oid, cmd.newOid as Oid);
    if (ff) fastForward.add(cmd.name as string);
    else if (env.denyNonFastForwards && cmd.name?.startsWith("refs/heads/")) {
      messages.push(`error: denying non-fast-forward ${cmd.name} (you should pull first)`);
      cmd.error = "non-fast-forward";
    }
  }
  failAtomically(plan);

  const live = liveCommands(plan);
  if (live.length === 0) return done(undefined, false, []);

  const refusal = await env.reauthorize();
  if (refusal !== undefined) {
    messages.push(`error: ${refusal}`);
    for (const cmd of live) cmd.error = refusal;
    return done(undefined, false, []);
  }

  if (env.checkCommands) {
    const refusals = await env.checkCommands(
      live.map((cmd) => ({
        index: cmd.index,
        name: cmd.name as string,
        kind: cmd.kind,
        oldOid: cmd.oldOid,
        newOid: cmd.newOid,
        fastForward: fastForward.has(cmd.name as string),
      })),
    );
    for (const cmd of live) {
      const refusal = refusals.get(cmd.index);
      if (refusal === undefined) continue;
      messages.push(`error: ${refusal}`);
      cmd.error = refusal;
    }
    failAtomically(plan);
  }
  const checked = liveCommands(plan);
  if (checked.length === 0) return done(undefined, false, []);

  const packs = indexed?.ok ? indexed.packs : [];
  const deps = indexed?.ok ? indexed.deps : [];
  const toUpdate = (cmd: PushCommandState): RefUpdate => ({
    name: cmd.name as string,
    oldOid: cmd.oldOid,
    newOid: cmd.newOid,
  });
  let committed = false;
  const applied: RefUpdate[] = [];

  if (plan.capabilities.atomic) {
    const result = await env.commit({
      uploadId,
      withUpload: true,
      packs,
      deps,
      updates: checked.map(toUpdate),
      fastForward,
    });
    if (result.ok) {
      committed = true;
      for (const cmd of checked) applied.push(toUpdate(cmd));
    } else if (result.reason === "refname-conflict") {
      const inRequest = checked.some((cmd) => cmd.name === result.conflictsWith);
      messages.push(
        `error: ${refnameConflictMessage(result.ref, result.conflictsWith, inRequest)}`,
      );
      for (const cmd of checked) cmd.error = ATOMIC_TRANSACTION_FAILED;
    } else {
      const failed = result.reason === "ref-conflict" ? result.ref : undefined;
      for (const cmd of checked) {
        if (cmd.name === failed) cmd.error = conflictReason(cmd);
        else
          cmd.error = result.reason === "ref-conflict" ? ATOMIC_TRANSACTION_FAILED : result.message;
      }
      if (result.reason !== "ref-conflict") messages.push(`error: ${result.message}`);
    }
    return done(undefined, committed, applied);
  }

  // Deletions first, then the rest, as git's non-atomic path does.
  const ordered = [
    ...checked.filter((c) => c.kind === "delete"),
    ...checked.filter((c) => c.kind !== "delete"),
  ];
  for (const cmd of ordered) {
    const update = toUpdate(cmd);
    const result = await env.commit({
      uploadId,
      withUpload: !committed,
      packs,
      deps,
      updates: [update],
      fastForward: fastForward.has(update.name) ? new Set([update.name]) : new Set(),
    });
    if (result.ok) {
      committed = true;
      applied.push(update);
    } else if (result.reason === "ref-conflict") {
      cmd.error = conflictReason(cmd);
    } else if (result.reason === "refname-conflict") {
      cmd.error = REFNAME_CONFLICT;
      messages.push(`error: ${refnameConflictMessage(result.ref, result.conflictsWith, false)}`);
    } else {
      cmd.error = result.message;
      messages.push(`error: ${result.message}`);
    }
  }
  return done(undefined, committed, applied);
}

/** The reason for a lost compare-and-set, as git 2.53 reports it. */
function conflictReason(cmd: PushCommandState): string {
  if (cmd.oldOid === null) return "reference already exists";
  return cmd.kind === "delete" ? "reference does not exist" : "incorrect old value provided";
}

/** Whether `newOid` descends from `oldOid`; false when either is not a visible commit or the walk is too long. */
async function isFastForward(
  env: FinalizeEnv,
  uploadId: string,
  oldOid: Oid,
  newOid: Oid,
): Promise<boolean> {
  try {
    return await isAncestor(env.commitGraph, { uploadId }, oldOid, newOid, {
      maxCommits: env.maxFastForwardWalk ?? DEFAULT_MAX_WALK,
    });
  } catch (error) {
    // Not a commit (a tag ref), or beyond the walk budget: not proven, so not fast-forward.
    if (error instanceof MissingCommitError || error instanceof WalkLimitError) return false;
    throw error;
  }
}
