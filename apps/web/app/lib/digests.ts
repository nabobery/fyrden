import { positiveId } from "./pages.js";

/**
 * A digest tells of a watched repository's activity of one kind in one
 * 15-minute window; the API names it by repository id, kind, window and
 * the repository's restore epoch.
 */

export interface DigestName {
  readonly repo: string;
  readonly subject: "issue" | "pull";
  readonly window: number;
  readonly epoch: number;
}

/** A digest's name from a page's parameters, or null when they name none. */
export function digestName(params: Record<string, string | undefined>): DigestName | null {
  const { repo, subject, window, epoch } = params;
  if (!repo || !/^[A-Za-z0-9_]{1,64}$/.test(repo)) return null;
  if (subject !== "issue" && subject !== "pull") return null;
  const [w, e] = [positiveId(window ?? null), positiveId(epoch ?? null)];
  if (w === null || e === null) return null;
  return { repo, subject, window: w, epoch: e };
}

/** The path naming a digest, below `/notifications/digests` on the web and `/feed/digests` in the API. */
export const digestPath = (d: DigestName) => `${d.repo}/${d.subject}/${d.window}/${d.epoch}`;

/** A digest's web page from the API's URL of it, or null when that URL is not one. */
export function digestPage(apiUrl: string): string | null {
  const m = /\/feed\/digests\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(apiUrl);
  const name = m && digestName({ repo: m[1], subject: m[2], window: m[3], epoch: m[4] });
  return name ? `/notifications/digests/${digestPath(name)}` : null;
}

/** What a digest is about: `Pull request activity in owner/name`. */
export const digestTitle = (subject: "issue" | "pull", repo: string) =>
  `${subject === "pull" ? "Pull request" : "Issue"} activity in ${repo}`;

const minute = (ms: number) => new Date(ms).toISOString().slice(11, 16);

/** A window as `2026-10-29 02:45–03:00 UTC`. */
export const windowLabel = (startsAt: number, endsAt: number) =>
  `${new Date(startsAt).toISOString().slice(0, 10)} ${minute(startsAt)}–${minute(endsAt)} UTC`;
