/**
 * Releases as the pages read and show them: the API's own shapes (types
 * only), where a release lives, and how the state of its tag reads.
 */

import type { getRelease, listReleases, Output } from "@fyrden/api-contract";
import { encodePath } from "./types.js";

export type Release = Output<typeof getRelease>;
export type ReleasesPage = Output<typeof listReleases>;

/**
 * Bytes of a release form read at most: notes of 65,536 characters
 * URL-encoded at up to 9 bytes a character, a title, a tag, and the rest.
 */
export const RELEASE_FORM_MAX_BYTES = 9 * 65_536 + 32 * 1024;

/** A release's page, whatever its tag's slashes. */
export const releasePage = (owner: string, repo: string, tag: string) =>
  `/${owner}/${repo}/releases/tag/${encodePath(tag)}`;

/** A release's editor. */
export const releaseEditor = (owner: string, repo: string, tag: string) =>
  `/${owner}/${repo}/releases/edit/${encodePath(tag)}`;

/** The API's release of a tag. */
export const releaseByTagApi = (base: string, tag: string) =>
  `${base}/releases/tags/${encodePath(tag)}`;

/** The source archive of what a release recorded, whatever became of its tag. */
export const sourceArchive = (owner: string, repo: string, format: "tar.gz" | "zip", sha: string) =>
  `/${owner}/${repo}/archive/${format}?ref=${sha}`;

/** What a release's kind reads as: a text badge, never colour alone. */
export function releaseKind(release: Pick<Release, "draft" | "prerelease">): string {
  if (release.draft) return "Draft";
  return release.prerelease ? "Prerelease" : "Published";
}

/** What became of the tag since publication, when that's worth saying. */
export function tagNotice(release: Pick<Release, "tag_state" | "commit_sha">): string | null {
  const commit = release.commit_sha?.slice(0, 7);
  switch (release.tag_state) {
    case "moved":
      return `The tag has moved since this was published. The source archives stay at ${commit}.`;
    case "deleted":
      return `The tag has been deleted since this was published. The source archives stay at ${commit}.`;
    default:
      return null;
  }
}
