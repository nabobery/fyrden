import type { RouterContextProvider } from "react-router";
import { apiCall, checkSession } from "./api.server.js";
import type { Draft, EditResult, Scope, Written } from "./edits.js";
import { field, problemCode, problemDetail } from "./pulls.js";

/**
 * Said for an edit whose form carries no version it was opened at (an edit
 * is never sent without one: it would overwrite whatever changed since).
 */
export const NO_VERSION =
  "This form does not say which version it was opened at: reload the page (your text is kept below).";

/** Sends one change to the API and answers it in its scope (see `editSender`). */
export type Send<S extends Scope> = (
  method: string,
  path: string,
  body: unknown,
  intent: string,
  fallback: string,
  draft?: Written,
  /** The item a change without text is of (a deletion). */
  target?: number,
) => Promise<EditResult<S>>;

/**
 * Checks who sends `form` before anything is: a form made for one viewer
 * sends nothing once another has signed in (another tab), and nothing
 * while the session cannot be checked (what was written comes back to
 * the viewer the form was made for). Then answers a sender for the
 * scope `scopeFor` names, carrying the version the form was written
 * from (its `version` field) as `expected` and in every refused draft.
 */
export async function editSender<S extends Scope>(
  context: Readonly<RouterContextProvider>,
  request: Request,
  form: FormData,
  scopeFor: (viewer: string) => S,
  draftOf: (form: FormData) => Written | undefined,
): Promise<
  | { refused: EditResult<S> }
  | {
      refused?: undefined;
      scope: S;
      version: number | undefined;
      /** The form's version as the API's precondition; undefined when the form carries none. */
      expected: { expected_version: number } | undefined;
      send: Send<S>;
      /** Refused here, before anything is sent: its draft keeps the version it was written from. */
      refuse: (error: string, draft?: Written) => EditResult<S>;
    }
> {
  const sent = Number(field(form, "version"));
  const version = Number.isSafeInteger(sent) && sent > 0 ? sent : undefined;
  const drafted = (draft: Written | undefined): { draft?: Draft } =>
    draft ? { draft: { ...draft, version } } : {};
  const session = await checkSession(context, request);
  if (session.state === "unknown")
    // Not known who is signed in: nothing is sent, and what was written comes back to the
    // viewer the form was made for (shown only once that viewer is confirmed).
    return {
      refused: {
        error: "Your session could not be checked just now: nothing was sent; send it again.",
        scope: scopeFor(field(form, "viewer")),
        ...drafted(draftOf(form)),
      },
    };
  if (session.state !== "signed-in" || session.user.id !== field(form, "viewer"))
    return { refused: { error: "You are signed in as someone else now: reload the page." } };
  const scope = scopeFor(session.user.id);
  const send: Send<S> = async (method, path, body, intent, fallback, draft, target) => {
    let result: Awaited<ReturnType<typeof apiCall<unknown>>>;
    try {
      result = await apiCall<unknown>(context, request, method, path, body);
    } catch {
      // Not reached, or an answer that could not be read: it may or may not have been done.
      return {
        error:
          "Fyrden could not be reached, or its answer read: it may or may not have been done. Reload to check before sending again (your text is kept below).",
        scope,
        ...drafted(draft),
      };
    }
    if (result.status >= 200 && result.status < 300) {
      const made = (result.body as { version?: unknown } | null)?.version;
      return {
        ok: intent,
        target: draft?.target ?? target,
        version: typeof made === "number" ? made : undefined,
        scope,
      };
    }
    const error =
      problemCode(result.body) === "stale"
        ? "Someone changed it since you opened this form: reload to see what changed (your text is kept below)."
        : problemDetail(result.body, fallback);
    // The draft keeps the version it was written from: sent again, it is still checked against it.
    return { error, scope, ...drafted(draft) };
  };
  return {
    scope,
    version,
    expected: version === undefined ? undefined : { expected_version: version },
    send,
    refuse: (error, draft) => ({ error, scope, ...drafted(draft) }),
  };
}
