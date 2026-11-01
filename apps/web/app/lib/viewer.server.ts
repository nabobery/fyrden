import type { RouterContextProvider } from "react-router";
import { checkSession } from "./api.server.js";

/** What a form drawn for one person answers when the session is now someone else's. */
export const OTHER_VIEWER =
  "This page was shown to another account (or the session ended since): reload it, and choose again.";

/**
 * Whether a form's `viewer` (the person it was drawn for) is still the
 * session's: a form saved after signing in as someone else in another tab
 * must not change that other account's settings.
 */
export async function sameViewer(
  context: Readonly<RouterContextProvider>,
  request: Request,
  form: FormData,
): Promise<boolean> {
  const session = await checkSession(context, request);
  return session.state === "signed-in" && session.user.id === String(form.get("viewer") ?? "");
}
