import { latin1 } from "../object/bytes.js";
import { isZeroOid, type Oid, oidEquals } from "../object/oid.js";
import type { RefSnapshot } from "../ports/ref-store.js";
import { findCapability } from "../protocol/capabilities.js";
import type { ReceivePackRequest } from "../protocol/receive-pack-request.js";
import { refnameConflicts, sortedRefNamespace } from "../refs/namespace.js";
import { isValidRefname } from "../refs/refname.js";

/*
 * Per-command checks of `git receive-pack` (builtin/receive-pack.c
 * `update`, `reject_updates_to_hidden`, git v2.53.0, verified) and the
 * rules Fyrden adds. Messages and `ng` reasons are git's where git has the
 * check, so the client prints what it prints for git.
 */

export interface PushPolicy {
  /** Allow ref deletions (`delete-refs`; git's receive.denyDeletes inverted). Default true. */
  readonly allowDeletes?: boolean;
  /** Refuse deleting the ref HEAD points to, as git does by default. Default true. */
  readonly denyDeleteCurrent?: boolean;
  /**
   * Ref prefixes clients may not update (git's receive.hideRefs).
   * Default `refs/pull/`: pull request refs are moved by the server only.
   */
  readonly hiddenRefPrefixes?: readonly string[];
  /**
   * Longest ref name accepted, in bytes. Proposed 1,024 bytes; tuned
   * later. It keeps every ref (and its peeled line) inside one pkt-line of
   * an advertisement or ls-refs response, whose payload limit is 65,516 bytes.
   */
  readonly maxRefNameBytes?: number;
  /** Refuse pointing a branch (refs/heads/) at anything but a commit. Default true. */
  readonly branchesMustBeCommits?: boolean;
}

export const DEFAULT_PUSH_POLICY: Required<PushPolicy> = Object.freeze({
  allowDeletes: true,
  denyDeleteCurrent: true,
  hiddenRefPrefixes: Object.freeze(["refs/pull/"]),
  maxRefNameBytes: 1024,
  branchesMustBeCommits: true,
});

export type CommandKind = "create" | "update" | "delete";

/** One ref update and where it stands. `error` is the `ng` reason once it has failed. */
export interface PushCommandState {
  /** Position in the request; reports keep this order. */
  readonly index: number;
  readonly refName: Uint8Array;
  /** The name as text; set for every command whose name passed the checks. */
  readonly name: string | undefined;
  readonly oldOid: Oid | null;
  readonly newOid: Oid | null;
  readonly kind: CommandKind;
  error: string | undefined;
}

/** What the client asked for on its first command. */
export interface PushCapabilities {
  readonly reportStatus: boolean;
  readonly reportStatusV2: boolean;
  readonly sideband: boolean;
  readonly quiet: boolean;
  readonly atomic: boolean;
  readonly agent: string | undefined;
}

export interface PushPlan {
  readonly commands: readonly PushCommandState[];
  readonly capabilities: PushCapabilities;
  /** Push options as sent; attached to the push event, no server-side meaning. */
  readonly pushOptions: readonly Uint8Array[];
  readonly shallow: readonly Oid[];
  /** Whether a pack follows: false only when every command is a deletion (git `delete_only`). */
  readonly expectsPack: boolean;
  /** `error: ...` lines for the client's progress channel. */
  readonly messages: string[];
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const REFS = "refs/";

function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return utf8.decode(bytes);
  } catch {
    return undefined;
  }
}

function startsWithBytes(bytes: Uint8Array, prefix: string): boolean {
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (bytes[i] !== prefix.charCodeAt(i)) return false;
  return true;
}

/**
 * Checks every command against the request, the current refs and the
 * policy. Commands that pass have no `error` yet; the pack, connectivity
 * and the commit decide the rest. Under `atomic`, one failure fails all.
 */
export function planPush(
  request: ReceivePackRequest,
  refs: RefSnapshot,
  policy: PushPolicy = {},
): PushPlan {
  const rules = { ...DEFAULT_PUSH_POLICY, ...policy };
  const caps = request.capabilities;
  const capabilities: PushCapabilities = {
    reportStatus: findCapability(caps, "report-status") !== undefined,
    reportStatusV2: findCapability(caps, "report-status-v2") !== undefined,
    sideband:
      findCapability(caps, "side-band-64k") !== undefined ||
      findCapability(caps, "side-band") !== undefined,
    quiet: findCapability(caps, "quiet") !== undefined,
    atomic: findCapability(caps, "atomic") !== undefined,
    agent: findCapability(caps, "agent")?.value,
  };
  const messages: string[] = [];
  const error = (text: string) => messages.push(`error: ${text}`);
  const seen = new Map<string, number>();
  const commands = request.commands.map((cmd, index): PushCommandState => {
    const oldOid = isZeroOid(cmd.oldOid) ? null : cmd.oldOid;
    const newOid = isZeroOid(cmd.newOid) ? null : cmd.newOid;
    const kind: CommandKind = newOid === null ? "delete" : oldOid === null ? "create" : "update";
    const state: PushCommandState = {
      index,
      refName: cmd.refName,
      name: undefined,
      oldOid,
      newOid,
      kind,
      error: undefined,
    };
    const shown = latin1(cmd.refName);
    const fail = (reason: string, message?: string) => {
      if (message) error(message);
      state.error = reason;
      return state;
    };
    if (
      !startsWithBytes(cmd.refName, REFS) ||
      !isValidRefname(cmd.refName.subarray(REFS.length), { allowOneLevel: kind === "delete" })
    ) {
      return fail("funny refname", `refusing to update funny ref '${shown}' remotely`);
    }
    if (cmd.refName.length > rules.maxRefNameBytes) {
      return fail(
        `ref name is longer than ${rules.maxRefNameBytes} bytes`,
        `refusing to update ref '${shown.slice(0, 80)}...': name longer than ${rules.maxRefNameBytes} bytes`,
      );
    }
    const name = decodeUtf8(cmd.refName);
    if (name === undefined) {
      // Deleting such a ref is never needed: none can exist.
      return fail(
        "ref name must be valid UTF-8",
        `refusing to update ref '${shown}': ref name must be valid UTF-8`,
      );
    }
    (state as { name: string }).name = name;
    const duplicate = seen.get(name);
    seen.set(name, index);
    if (duplicate !== undefined) {
      return fail("failed to update refs", `multiple updates for ref '${name}' not allowed`);
    }
    if (rules.hiddenRefPrefixes.some((prefix) => name.startsWith(prefix))) {
      return fail(kind === "delete" ? "deny deleting a hidden ref" : "deny updating a hidden ref");
    }
    if (kind === "delete") {
      if (!rules.allowDeletes) {
        return fail("deletion prohibited", `denying ref deletion for ${name}`);
      }
      if (rules.denyDeleteCurrent && refs.head === name) {
        return fail(
          "deletion of the current branch prohibited",
          `refusing to delete the current branch: ${name}`,
        );
      }
    }
    const current = refs.refs.get(name) ?? null;
    const conflict = casConflict(current, oldOid);
    if (conflict) return fail(conflict);
    return state;
  });
  // git fails every update of a ref named twice (the transaction refuses them all).
  for (const state of commands) {
    if (state.name !== undefined && seen.get(state.name) !== state.index && !state.error) {
      state.error = "failed to update refs";
    }
  }
  refuseNamespaceConflicts(commands, refs, capabilities.atomic, error);
  const plan: PushPlan = {
    commands,
    capabilities,
    pushOptions: request.pushOptions ?? [],
    shallow: request.shallow,
    expectsPack: commands.some((c) => c.kind !== "delete"),
    messages,
  };
  if (capabilities.atomic) failAtomically(plan);
  return plan;
}

/** The `ng` reason git 2.53 gives a creation that collides with another ref (refs.c `ref_transaction_error_msg`). */
export const REFNAME_CONFLICT = "refname conflict";
/** The `ng` reason git gives every command of an atomic push whose transaction failed. */
export const ATOMIC_TRANSACTION_FAILED = "atomic transaction failed";

/**
 * git's message for a ref creation that collides with `conflictsWith`
 * (refs.c `refs_verify_refname_available`, git v2.53.0, verified).
 */
export function refnameConflictMessage(
  ref: string,
  conflictsWith: string,
  inRequest: boolean,
): string {
  if (!inRequest)
    return `cannot lock ref '${ref}': '${conflictsWith}' exists; cannot create '${ref}'`;
  const [upper, lower] = ref < conflictsWith ? [ref, conflictsWith] : [conflictsWith, ref];
  return `cannot process '${upper}' and '${lower}' at the same time`;
}

/**
 * Refuses creations that collide with a ref above or below them, as git's
 * ref transaction does: per ref ("refname conflict") in a batched push,
 * every ref ("atomic transaction failed") in an atomic one. Deletions in
 * the push free their names. The ref store checks again at the commit point,
 * where another push may have changed the refs since.
 */
function refuseNamespaceConflicts(
  commands: readonly PushCommandState[],
  refs: RefSnapshot,
  atomic: boolean,
  error: (text: string) => void,
): void {
  if (atomic && commands.some((c) => c.error !== undefined)) return;
  const live = commands.filter((c) => c.error === undefined && c.name !== undefined);
  if (!live.some((c) => c.kind === "create")) return;
  const conflicts = refnameConflicts(
    live.map((c) => ({ name: c.name as string, oldOid: c.oldOid, newOid: c.newOid })),
    sortedRefNamespace(refs.refs.keys()),
  );
  if (conflicts.length === 0) return;
  if (atomic) {
    const [conflict] = conflicts as [(typeof conflicts)[number]];
    error(refnameConflictMessage(conflict.ref, conflict.conflictsWith, conflict.inRequest));
    for (const cmd of commands) cmd.error = ATOMIC_TRANSACTION_FAILED;
    return;
  }
  const byName = new Map(live.map((c) => [c.name as string, c]));
  for (const conflict of conflicts) {
    error(refnameConflictMessage(conflict.ref, conflict.conflictsWith, conflict.inRequest));
    const cmd = byName.get(conflict.ref);
    if (cmd) cmd.error = REFNAME_CONFLICT;
  }
}

/**
 * The compare-and-set check against `current`, with the reasons git 2.53
 * gives for a rejected update in a batched transaction (refs.c
 * `ref_transaction_error_msg`). Deleting a ref that no longer exists is
 * refused as "reference does not exist", as git refuses it when the old id
 * names an object; git lets it pass when the old id is no object at all,
 * which only a hand-made request sends.
 */
export function casConflict(current: Oid | null, oldOid: Oid | null): string | undefined {
  if (oldOid === null) return current === null ? undefined : "reference already exists";
  if (current === null) return "reference does not exist";
  return oidEquals(current, oldOid) ? undefined : "incorrect old value provided";
}

/** Under `atomic`, every command without an error of its own gets "atomic push failure". */
export function failAtomically(plan: PushPlan): void {
  if (!plan.capabilities.atomic) return;
  if (!plan.commands.some((c) => c.error !== undefined)) return;
  for (const cmd of plan.commands) cmd.error ??= "atomic push failure";
}

/** Commands still going ahead. */
export function liveCommands(plan: PushPlan): PushCommandState[] {
  return plan.commands.filter((c) => c.error === undefined);
}
