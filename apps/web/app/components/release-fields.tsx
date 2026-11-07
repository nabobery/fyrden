import type { FormEvent } from "react";
import { fieldsOf } from "./kept-drafts.js";

/** What a release form records as it is written. */
export const writtenRelease = (event: FormEvent<HTMLFormElement>) =>
  fieldsOf(event, ["tag_name", "name", "body", "prerelease"]);

/** A release's tag, title, notes and prerelease flag, filled from `shown`. */
export function ReleaseFields({
  shown,
  tagFixed,
}: {
  shown: { tag_name: string; name: string; body: string; prerelease: boolean };
  /** A published release's tag doesn't change. */
  tagFixed: boolean;
}) {
  return (
    <>
      <label htmlFor="release-tag">Tag</label>
      <input
        id="release-tag"
        name="tag_name"
        required
        readOnly={tagFixed}
        maxLength={1024}
        size={40}
        defaultValue={shown.tag_name}
        aria-describedby="release-tag-help"
      />
      <p id="release-tag-help" className="muted">
        {tagFixed
          ? "A published release keeps its tag."
          : "Publishing needs this tag to exist already: push it first."}
      </p>
      <label htmlFor="release-name">Title (optional)</label>
      <input id="release-name" name="name" maxLength={256} size={60} defaultValue={shown.name} />
      <label htmlFor="release-body">Notes (Markdown, optional)</label>
      <textarea id="release-body" name="body" defaultValue={shown.body} />
      <p>
        <label>
          <input type="checkbox" name="prerelease" defaultChecked={shown.prerelease} /> This is a
          prerelease
        </label>
      </p>
    </>
  );
}
