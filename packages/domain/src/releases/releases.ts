import { MAX_ISSUE_BODY_LENGTH } from "../issues/issue.js";

/** A repository's releases at most. Proposed: each is a row, and each published one up to two GC roots. */
export const MAX_RELEASES = 1_000;
/** A release's title at most. Proposed. */
export const MAX_RELEASE_TITLE_LENGTH = 256;
/** A release's notes at most, as an issue's body. */
export const MAX_RELEASE_BODY_LENGTH = MAX_ISSUE_BODY_LENGTH;
/** A tag name's characters at most. Proposed. */
export const MAX_RELEASE_TAG_LENGTH = 1_024;

/** The repository events of a release; each is a webhook action of the same name. */
export const RELEASE_EVENTS = [
  "release.created",
  "release.edited",
  "release.deleted",
  "release.published",
  "release.released",
  "release.prereleased",
] as const;

export type ReleaseEvent = (typeof RELEASE_EVENTS)[number];

export function isReleaseEvent(type: string): type is ReleaseEvent {
  return (RELEASE_EVENTS as readonly string[]).includes(type);
}

/** What publishing says, in order: that it was published, then as which kind. */
export function releaseEventsOfPublish(prerelease: boolean): readonly ReleaseEvent[] {
  return ["release.published", prerelease ? "release.prereleased" : "release.released"];
}

/** What creating says: a draft only that it exists, a published release all of it, in one change. */
export function releaseEventsOfCreate(release: {
  readonly draft: boolean;
  readonly prerelease: boolean;
}): readonly ReleaseEvent[] {
  return release.draft
    ? ["release.created"]
    : ["release.created", ...releaseEventsOfPublish(release.prerelease)];
}

/**
 * Whether a tag name fits before git's own rules are asked (those take the
 * git engine, so the API checks them): not empty, within the length, and
 * well-formed Unicode, since a lone surrogate has no UTF-8 form.
 */
export function isWellFormedTagName(tag: string): boolean {
  return tag.length > 0 && tag.length <= MAX_RELEASE_TAG_LENGTH && tag.isWellFormed();
}
