import { HANDLE_SHAPE, LOCK_REASONS, type LockReason, MAX_HANDLE_LENGTH } from "@fyrden/domain";
import { labelApiPath } from "./labels.js";
import type { MetaIntent } from "./subject-meta.js";

/** What a sidebar or picker form asks the API: where, how, and with what. */
export type MetaCall = {
  readonly method: "POST" | "PATCH" | "PUT" | "DELETE";
  readonly path: string;
  readonly body: unknown;
};

const ID = /^[1-9][0-9]{0,14}$/;
/** A principal id as an issue's answer names one (the API checks it is one). */
const PRINCIPAL = /^[A-Za-z0-9_-]{1,64}$/;

const text = (form: FormData, name: string) => String(form.get(name) ?? "").trim();

/**
 * The API call `intent`'s form makes on the issue or pull request at
 * `subjectApi` (`/repos/{owner}/{repo}/issues/{number}`), or why none is
 * made (a field it may not send).
 */
export function metaCall(
  intent: MetaIntent,
  form: FormData,
  subjectApi: string,
): MetaCall | { refused: string } {
  switch (intent) {
    case "label-add":
    case "label-remove": {
      const name = text(form, "label");
      const id = text(form, "label_id");
      if (!name || !ID.test(id)) return { refused: "No such label." };
      // By name, held to the label the form showed (renamed and its name taken since: refused).
      return intent === "label-add"
        ? {
            method: "POST",
            path: `${subjectApi}/labels`,
            body: { labels: [name], expected_ids: [Number(id)] },
          }
        : {
            method: "DELETE",
            path: labelApiPath(subjectApi, name),
            body: { expected_id: Number(id) },
          };
    }
    case "assign": {
      const handle = text(form, "handle").replace(/^@/, "");
      if (handle.length > MAX_HANDLE_LENGTH || !HANDLE_SHAPE.test(handle))
        return { refused: "Name someone by their handle." };
      return { method: "POST", path: `${subjectApi}/assignees`, body: { assignees: [handle] } };
    }
    case "unassign": {
      const id = text(form, "assignee_id");
      if (!PRINCIPAL.test(id)) return { refused: "No such assignee." };
      // By id: a deleted user's handle names no one.
      return { method: "DELETE", path: `${subjectApi}/assignees`, body: { assignee_ids: [id] } };
    }
    case "milestone-set": {
      const number = text(form, "milestone");
      if (!ID.test(number)) return { refused: "No such milestone." };
      return { method: "PATCH", path: subjectApi, body: { milestone: Number(number) } };
    }
    case "milestone-clear":
      return { method: "PATCH", path: subjectApi, body: { milestone: null } };
    case "lock": {
      const reason = text(form, "lock_reason");
      if (reason && !LOCK_REASONS.includes(reason as LockReason))
        return { refused: "Choose a reason from the list." };
      return {
        method: "PUT",
        path: `${subjectApi}/lock`,
        body: reason ? { lock_reason: reason } : {},
      };
    }
    case "unlock":
      return { method: "DELETE", path: `${subjectApi}/lock`, body: undefined };
    case "delete-issue":
      return { method: "DELETE", path: subjectApi, body: undefined };
  }
}
