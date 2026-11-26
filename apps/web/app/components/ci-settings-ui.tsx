import { Form, useSearchParams } from "react-router";
import {
  type AccessRepository,
  type FormErrors,
  VISIBILITIES,
  type Visibility,
} from "../lib/ci-settings.js";
import type { PageLinks } from "../lib/pages.js";
import { Pager } from "./pager.js";

export function ErrorSummary({ errors }: { errors: FormErrors }) {
  const messages = Object.values(errors).filter((m): m is string => typeof m === "string");
  if (messages.length === 0) return null;
  return (
    <div className="error" role="alert">
      {messages.map((m) => (
        <p key={m}>{m}</p>
      ))}
    </div>
  );
}

/** A field's error, which the field names in `aria-describedby`. */
export function FieldError({ id, message }: { id: string; message: string | undefined }) {
  return message ? (
    <p id={id} className="error">
      {message}
    </p>
  ) : null;
}

export function describedBy(
  field: string,
  message: string | undefined,
  hint = true,
): { "aria-invalid"?: true; "aria-describedby"?: string } {
  const ids = [hint && `${field}-hint`, message && `${field}-error`].filter(Boolean).join(" ");
  return { ...(message && { "aria-invalid": true }), ...(ids && { "aria-describedby": ids }) };
}

/** What the last write did (`?created=`, `?saved=`, `?deleted=` after a redirect). */
export function SavedNotice({ noun }: { noun: string }) {
  const [search] = useSearchParams();
  const created = search.get("created");
  const saved = search.get("saved");
  const deleted = search.get("deleted");
  const text = created
    ? `Created the ${noun} ${created}.`
    : saved
      ? `Updated the ${noun} ${saved}.`
      : deleted
        ? `Deleted the ${noun} ${deleted}.`
        : null;
  return text ? <p role="status">{text}</p> : null;
}

/** A time from the API (ISO 8601) as its date. */
export function When({ at }: { at: string }) {
  return <time dateTime={at}>{at.slice(0, 10)}</time>;
}

/** An organization entry's visibility: required radios, `private` unless it has one already. */
export function VisibilityField({
  chosen,
  stored,
  error,
  secret,
}: {
  /** The access to show chosen: the one a refused save sent, else the stored one. */
  chosen: Visibility | undefined;
  /** The entry's stored access; none for a new entry. */
  stored: Visibility | undefined;
  error: string | undefined;
  secret: boolean;
}) {
  return (
    <fieldset {...describedBy("visibility", error)}>
      <legend>Repository access</legend>
      {VISIBILITIES.map((v) => (
        <p key={v.value}>
          <input
            type="radio"
            id={`visibility-${v.value}`}
            name="visibility"
            value={v.value}
            required
            defaultChecked={v.value === (chosen ?? "private")}
            aria-describedby={`visibility-${v.value}-hint`}
          />{" "}
          <label htmlFor={`visibility-${v.value}`} style={{ display: "inline" }}>
            {v.label}
          </label>
          <br />
          <span id={`visibility-${v.value}-hint`} className="muted">
            {v.hint}
          </span>
        </p>
      ))}
      <p id="visibility-hint" className="muted">
        Choosing another access than selected repositories clears the list of repositories.
        {secret && stored !== undefined && " To change a secret's access, enter its value again."}
      </p>
      <FieldError id="visibility-error" message={error} />
    </fieldset>
  );
}

export function RepositoryAccess({
  noun,
  repositories,
  total,
  pages,
  error,
}: {
  noun: string;
  repositories: readonly AccessRepository[];
  total: number;
  pages: PageLinks;
  error: string | undefined;
}) {
  const [search] = useSearchParams();
  const added = search.get("added");
  const removed = search.get("removed");
  const createdHere = search.get("created");
  return (
    <section className="panel" aria-labelledby="access">
      <h2 id="access">Selected repositories</h2>
      {added && <p role="status">Added {added}.</p>}
      {removed && <p role="status">Removed {removed}.</p>}
      {createdHere && total === 0 && (
        <p role="status">
          Created the {noun} {createdHere}. No repository can use it until you add one.
        </p>
      )}
      <p className="muted">
        {total === 1 ? "1 repository" : `${total} repositories`} can use this {noun}.
      </p>
      {repositories.length > 0 && (
        <ul>
          {repositories.map((r) => (
            <li key={r.id}>
              <Form method="post" encType="multipart/form-data" className="row">
                <span>{r.full_name}</span>
                <input type="hidden" name="repository_id" value={r.id} />
                <input type="hidden" name="repository" value={r.name} />
                <button type="submit" name="intent" value="remove-repository">
                  Remove<span className="visually-hidden"> {r.full_name}</span>
                </button>
              </Form>
            </li>
          ))}
        </ul>
      )}
      <Pager links={pages} label="Selected repositories" />
      <Form method="post" encType="multipart/form-data">
        <label htmlFor="repository">Add repository</label>
        <input
          id="repository"
          name="repository"
          required
          autoComplete="off"
          spellCheck={false}
          {...describedBy("repository", error)}
        />
        <p id="repository-hint" className="muted">
          A repository of this organization, by name.
        </p>
        <FieldError id="repository-error" message={error} />
        <p>
          <button type="submit" name="intent" value="add-repository">
            Add repository
          </button>
        </p>
      </Form>
    </section>
  );
}
