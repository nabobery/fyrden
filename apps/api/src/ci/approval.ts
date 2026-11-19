import { approvalBindingText } from "@fyrden/domain/ci";
import type { RunSpec } from "../do/run/spec.js";

/** How long a run waits for approval before it fails: GitHub's 30 days (see the run note). */
export const APPROVAL_EXPIRY_MS = 30 * 24 * 60 * 60_000;

const utf8 = new TextEncoder();

/**
 * The binding of a held run's approval: the SHA-256 (hex) of the domain's
 * binding text, from the spec alone, so the repository and the run object
 * compute the same value; null for a run that waits for none.
 */
export async function approvalBinding(spec: RunSpec): Promise<string | null> {
  if (!spec.approval) return null;
  const text = approvalBindingText({
    runId: spec.runId,
    workflowPath: spec.workflow.path,
    workflowBlob: spec.approval.workflowBlob,
    checkoutSha: spec.sha,
    event: spec.event,
    action: spec.approval.action,
    kind: spec.event as Parameters<typeof approvalBindingText>[0]["kind"],
    trust: spec.trust,
    fork: spec.fork,
  });
  const hash = await crypto.subtle.digest("SHA-256", utf8.encode(text));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
