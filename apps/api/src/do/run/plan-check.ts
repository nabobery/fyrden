import { checkNameKey, MAX_CHECK_NAME_LENGTH } from "@fyrden/domain";

/*
 * The check a run publishes when its workflow fails to plan. Check
 * summaries share one key space per commit (the folded name, one CI
 * source), so the name carries the workflow file's exact path and the
 * SHA-256 of that path: two files whose paths fold alike (`ci.yml`,
 * `CI.yml`) or share a hash prefix keep separate checks, and no job's name
 * can take one over, as job checks may not use the prefix.
 */

/** Check names starting with this (compared folded) are the plan-failure checks'. */
export const WORKFLOW_FILE_PREFIX = "workflow file:";

const utf8 = new TextEncoder();

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it replaces.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * `workflow file: <path> (<sha256 of path>)`: control characters in the
 * path replaced by U+FFFD and the path cut, by code points, so the name
 * stays within the 255 characters a check name may have.
 */
export async function workflowFileCheckName(path: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", utf8.encode(path));
  const hex = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const head = `${WORKFLOW_FILE_PREFIX} `;
  const tail = ` (${hex})`;
  const room = MAX_CHECK_NAME_LENGTH - head.length - tail.length;
  const shown = [...path.replace(CONTROL, "�")].slice(0, room).join("");
  return `${head}${shown}${tail}`;
}

/** Whether a job's check name is one only plan-failure checks may use. */
export function isReservedCheckName(name: string): boolean {
  return checkNameKey(name).startsWith(WORKFLOW_FILE_PREFIX);
}
