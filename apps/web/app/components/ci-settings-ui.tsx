import { useSearchParams } from "react-router";
import type { FormErrors } from "../lib/ci-settings.js";

/** Every error of a submitted form, read out when it appears. */
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

/** `aria-invalid` and `aria-describedby` for a field with a hint and maybe an error. */
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
