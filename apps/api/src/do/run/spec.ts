import { isUlid } from "@fyrden/adapters-cloudflare/git";
import { isFullSha, principalTypeOf } from "@fyrden/domain";
import { MAX_WORKFLOW_BYTES } from "@fyrden/domain/ci";

/*
 * What a trigger gives a run: the commit and ref it ran for, the event, who
 * triggered it, the workflow file it read at the workflow commit, and the
 * contexts its expressions read. The trigger chooses the run id and keeps
 * it with its event, so its own retries reach the same run.
 */

export interface RunSpec {
  /** A ULID the trigger persisted with its event. */
  readonly runId: string;
  readonly repoId: string;
  readonly sha: string;
  readonly ref: string;
  readonly event: string;
  /** The principal that triggered the run: the job token's principal, on every attempt. */
  readonly actor: string;
  readonly workflow: { readonly path: string; readonly source: string };
  /** Whether the run's code is trusted: untrusted for a pull request's head in another repository. */
  readonly trust: "trusted" | "untrusted";
  /**
   * Whether the run is a fork job: a pull request event whose head is in
   * another repository, whatever the trust (a `pull_request_target` from a
   * fork is trusted code, and still a fork job).
   */
  readonly fork: boolean;
  /**
   * Present when the run waits for a maintainer's approval before any of
   * its attempts is admitted: what the approval binds beyond the spec's
   * own fields (the workflow file's blob and the event's action).
   */
  readonly approval?: { readonly workflowBlob: string; readonly action: string };
  /** The `github` context, as plain JSON data. */
  readonly github?: unknown;
  readonly inputs?: unknown;
  readonly vars?: unknown;
}

/** The contexts' stored size, as JSON text. Proposed. */
export const MAX_RUN_CONTEXTS_BYTES = 1024 * 1024;
const MAX_PATH_LENGTH = 1024;
const MAX_REF_LENGTH = 1024;
const MAX_EVENT_LENGTH = 64;

const utf8 = new TextEncoder();

/** A principal id: one of the known type prefixes and a body (`usr_…`, `agt_…`). */
export function isPrincipalId(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 64) return false;
  return principalTypeOf(value) !== undefined && value.indexOf("_") < value.length - 1;
}

/** The contexts as stored, or a thrown error: a malformed spec is a bug in its caller. */
export function validateRunSpec(spec: RunSpec): string {
  const fail = (what: string): never => {
    throw new TypeError(`invalid run spec: ${what}`);
  };
  if (typeof spec.runId !== "string" || !isUlid(spec.runId)) fail("runId must be a ULID");
  if (typeof spec.repoId !== "string" || spec.repoId.length === 0 || spec.repoId.length > 64)
    fail("repoId");
  if (!isFullSha(spec.sha)) fail("sha must be 40 hex characters");
  if (typeof spec.ref !== "string" || spec.ref.length === 0 || spec.ref.length > MAX_REF_LENGTH)
    fail("ref");
  if (
    typeof spec.event !== "string" ||
    spec.event.length === 0 ||
    spec.event.length > MAX_EVENT_LENGTH
  )
    fail("event");
  // Told when its attempt fails, so it must be a principal (the check outbox passes it on).
  if (!isPrincipalId(spec.actor)) fail("actor must be a principal id");
  if (spec.trust !== "trusted" && spec.trust !== "untrusted") fail("trust");
  if (typeof spec.fork !== "boolean") fail("fork");
  if (spec.approval !== undefined) {
    const { workflowBlob, action } = spec.approval ?? {};
    if (typeof workflowBlob !== "string" || !/^[0-9a-f]{40}$/.test(workflowBlob))
      fail("approval.workflowBlob");
    if (typeof action !== "string" || action.length === 0 || action.length > MAX_EVENT_LENGTH)
      fail("approval.action");
  }
  const { path, source } = spec.workflow ?? {};
  if (typeof path !== "string" || path.length === 0 || path.length > MAX_PATH_LENGTH) fail("path");
  if (typeof source !== "string" || utf8.encode(source).length > MAX_WORKFLOW_BYTES)
    fail(`workflow source must be a string of at most ${MAX_WORKFLOW_BYTES} bytes`);
  const contexts = JSON.stringify({
    github: spec.github ?? null,
    inputs: spec.inputs ?? null,
    vars: spec.vars ?? null,
  });
  if (utf8.encode(contexts).length > MAX_RUN_CONTEXTS_BYTES)
    fail(`contexts exceed ${MAX_RUN_CONTEXTS_BYTES} bytes`);
  return contexts;
}

/** A digest of everything in the spec, so a repeated create is told from a different one. */
export async function specDigest(spec: RunSpec, contexts: string): Promise<string> {
  const canonical = JSON.stringify([
    spec.runId,
    spec.repoId,
    spec.sha,
    spec.ref,
    spec.event,
    spec.actor,
    spec.workflow.path,
    spec.workflow.source,
    contexts,
    spec.trust,
    spec.fork,
    spec.approval ?? null,
  ]);
  const hash = await crypto.subtle.digest("SHA-256", utf8.encode(canonical));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
