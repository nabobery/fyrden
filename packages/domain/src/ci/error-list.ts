/*
 * The named errors of one check, bounded as the parser bounds its own: the
 * first MAX_WORKFLOW_ERRORS by file position, whatever order they are found
 * in, then one saying there were more, every field cut short because paths
 * and messages quote user text.
 */
import {
  MAX_WORKFLOW_ERRORS,
  type Position,
  type WorkflowError,
  type WorkflowErrorCode,
} from "./workflow-schema.js";

/** Code points of a user's key or id kept where a message quotes it. */
export const MAX_QUOTED = 60;
/** Code points kept of an error's path and feature; a message keeps twice this (the parser's). */
const MAX_ERROR_FIELD = 200;

/** `text` cut to at most `max` code points, without reading past them (as the parser cuts). */
export function cut(text: string, max = MAX_QUOTED): string {
  if (text.length <= max) return text;
  let count = 0;
  let end = 0;
  for (const char of text) {
    if (count === max) return `${text.slice(0, end)}…`;
    count++;
    end += char.length;
  }
  return text;
}

/**
 * The first MAX_WORKFLOW_ERRORS errors in file order, whatever order they are
 * found in, then one saying there were more. Fields are cut as the parser
 * cuts them, since paths and messages quote user ids.
 */
export class ErrorList {
  /** Sorted by position; equal positions in the order found. */
  readonly #errors: WorkflowError[] = [];
  #more = false;

  add(code: WorkflowErrorCode, feature: string, path: string, at: Position, message: string): void {
    const errors = this.#errors;
    const after = (e: WorkflowError) =>
      e.line < at.line || (e.line === at.line && e.column <= at.column);
    let i = errors.length;
    while (i > 0 && !after(errors[i - 1] as WorkflowError)) i--;
    if (i >= MAX_WORKFLOW_ERRORS) {
      this.#more = true;
      return;
    }
    errors.splice(i, 0, {
      code,
      feature: cut(feature, MAX_ERROR_FIELD),
      path: cut(path, MAX_ERROR_FIELD),
      line: at.line,
      column: at.column,
      message: cut(message, 2 * MAX_ERROR_FIELD),
    });
    if (errors.length > MAX_WORKFLOW_ERRORS) {
      errors.pop();
      this.#more = true;
    }
  }

  any(): boolean {
    return this.#errors.length > 0;
  }

  list(): WorkflowError[] {
    const sorted = [...this.#errors];
    if (this.#more) {
      sorted.push({
        code: "too_many_errors",
        feature: "",
        path: "",
        line: 0,
        column: 0,
        message: `The file has more than ${MAX_WORKFLOW_ERRORS} errors; the first ${MAX_WORKFLOW_ERRORS} are shown.`,
      });
    }
    return sorted;
  }
}
