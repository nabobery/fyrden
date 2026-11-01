import { Form } from "react-router";

/**
 * A choice of one level among a few (a repository's watching, a thread's
 * subscription), posted with the intent `set`; the level now checked. Keyed
 * by its caller to the viewer and subject, so another one starts afresh.
 */
export function PreferenceForm({
  legend,
  name,
  levels,
  current,
  busy,
  viewer,
}: {
  legend: string;
  name: string;
  levels: readonly { value: string; label: string; hint: string }[];
  current: string;
  busy: boolean;
  /** The person it is drawn for, sent back so the action refuses another session. */
  viewer: string;
}) {
  return (
    <Form method="post">
      <input type="hidden" name="viewer" value={viewer} />
      {/* Disabled while one choice is sent: the one shown is the one saved. */}
      <fieldset disabled={busy}>
        <legend>{legend}</legend>
        {levels.map((l) => (
          <div key={l.value}>
            <input
              id={`${name}-${l.value}`}
              type="radio"
              name={name}
              value={l.value}
              defaultChecked={current === l.value}
              aria-describedby={`${name}-${l.value}-hint`}
            />{" "}
            <label
              htmlFor={`${name}-${l.value}`}
              style={{ display: "inline", fontWeight: "normal" }}
            >
              {l.label}
            </label>
            <p id={`${name}-${l.value}-hint`} className="muted">
              {l.hint}
            </p>
          </div>
        ))}
      </fieldset>
      <p>
        <button className="primary" type="submit" name="intent" value="set" disabled={busy}>
          Save
        </button>
      </p>
    </Form>
  );
}
