import { HANDLE_SHAPE, MAX_HANDLE_LENGTH, MAX_REQUESTED_REVIEWERS } from "@fyrden/domain";

/** A team's slug, as the API takes one (lowercase words joined by hyphens). */
const TEAM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_TEAM_SLUG_LENGTH = 100;

/** A form field's comma- or space-separated names, each once, empty ones left out. */
function names(value: FormDataEntryValue | null): string[] {
  return [
    ...new Set(
      String(value ?? "")
        .split(/[\s,]+/)
        .map((name) => name.trim())
        .filter(Boolean),
    ),
  ];
}

/**
 * The review request a form asks for: its `reviewers` (handles, an `@`
 * dropped) and `team_reviewers` (bare slugs of `owner`'s teams; `owner/slug`
 * is taken as the bare slug, a team of another account refused), or why
 * none is sent.
 */
export function reviewRequest(
  form: FormData,
  owner: string,
): { reviewers: string[]; team_reviewers: string[] } | { refused: string } {
  // One each, as the API matches handles (ignoring case), so each counts once toward the limit.
  const seen = new Set<string>();
  const reviewers = names(form.get("reviewers"))
    .map((name) => name.replace(/^@/, ""))
    .filter((handle) => {
      const key = handle.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  for (const handle of reviewers)
    if (handle.length > MAX_HANDLE_LENGTH || !HANDLE_SHAPE.test(handle))
      return { refused: `"${handle}" is no handle.` };
  const teams: string[] = [];
  for (const entry of names(form.get("teams"))) {
    const at = entry.replace(/^@/, "").lastIndexOf("/");
    const named = entry.replace(/^@/, "");
    const org = at === -1 ? null : named.slice(0, at);
    const slug = (at === -1 ? named : named.slice(at + 1)).toLowerCase();
    // A team of another account cannot be asked here: never sent as if it were the owner's.
    if (org !== null && org.toLowerCase() !== owner.toLowerCase())
      return { refused: `"${entry}" is not a team of ${owner}.` };
    if (slug.length > MAX_TEAM_SLUG_LENGTH || !TEAM_SLUG.test(slug))
      return { refused: `"${entry}" is no team's slug.` };
    if (!teams.includes(slug)) teams.push(slug);
  }
  if (reviewers.length + teams.length === 0) return { refused: "Name a reviewer or a team." };
  if (reviewers.length + teams.length > MAX_REQUESTED_REVIEWERS)
    return { refused: `At most ${MAX_REQUESTED_REVIEWERS} reviewers and teams at once.` };
  return { reviewers, team_reviewers: teams };
}
