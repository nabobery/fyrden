import { REACTION_CONTENTS, type ReactionContent } from "@fyrden/domain";

/** What a reaction form asks the API: where, how, and with what. */
export type ReactionCall = {
  readonly method: "POST" | "DELETE";
  readonly path: string;
  readonly body: { content: ReactionContent } | undefined;
  /** The comment it is on, if any. */
  readonly target: number | undefined;
};

const ID = /^[1-9][0-9]{0,14}$/;

/**
 * The API call a `react` or `unreact` form makes, on `issueApi` (the
 * issue's or pull request's own path) or one of `repoApi`'s comments;
 * null for a form that names no content, target or reaction it may.
 */
export function reactionCall(
  form: FormData,
  issueApi: string,
  repoApi: string,
): ReactionCall | null {
  const intent = form.get("intent");
  const target = String(form.get("target") ?? "");
  const content = String(form.get("content") ?? "");
  if (target !== "issue" && !ID.test(target)) return null;
  const on = target === "issue" ? issueApi : `${repoApi}/issues/comments/${target}`;
  const comment = target === "issue" ? undefined : Number(target);
  if (intent === "react") {
    const known = REACTION_CONTENTS.find((c) => c === content);
    return known
      ? { method: "POST", path: `${on}/reactions`, body: { content: known }, target: comment }
      : null;
  }
  if (intent === "unreact") {
    const id = String(form.get("reaction_id") ?? "");
    return ID.test(id)
      ? { method: "DELETE", path: `${on}/reactions/${id}`, body: undefined, target: comment }
      : null;
  }
  return null;
}
