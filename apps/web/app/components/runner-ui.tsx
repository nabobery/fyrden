import {
  ACCESSES,
  FORKS_WARNING,
  PUBLIC_WARNING,
  type RunnerAccess,
  type RunnerErrors,
} from "../lib/runners.js";
import { describedBy, FieldError } from "./ci-settings-ui.js";

/** A time from the API (milliseconds) as its date. */
export function At({ ms }: { ms: number }) {
  const iso = new Date(ms).toISOString();
  return <time dateTime={iso}>{iso.slice(0, 10)}</time>;
}

function Check({
  name,
  label,
  warning,
  checked,
  error,
}: {
  name: string;
  label: string;
  warning: string;
  checked: boolean;
  error: string | undefined;
}) {
  return (
    <>
      <p>
        <input
          type="checkbox"
          id={name}
          name={name}
          defaultChecked={checked}
          {...describedBy(name, error)}
        />{" "}
        <label htmlFor={name} style={{ display: "inline" }}>
          {label}
        </label>
        <br />
        <span id={`${name}-hint`} className="muted">
          {warning}
        </span>
      </p>
      <FieldError id={`${name}-error`} message={error} />
    </>
  );
}

export function AccessFields({
  access,
  errors,
  forks,
}: {
  access: RunnerAccess;
  errors: RunnerErrors;
  /** Whether fork jobs may be chosen (an ephemeral runner, or a token's runner to come), else why not. */
  forks: true | string;
}) {
  return (
    <>
      <fieldset {...describedBy("repository_access", errors.access, false)}>
        <legend>Repository access</legend>
        {ACCESSES.map((a) => (
          <p key={a.value}>
            <input
              type="radio"
              id={`access-${a.value}`}
              name="repository_access"
              value={a.value}
              required
              defaultChecked={a.value === access.repository_access}
              aria-describedby={`access-${a.value}-hint`}
            />{" "}
            <label htmlFor={`access-${a.value}`} style={{ display: "inline" }}>
              {a.label}
            </label>
            <br />
            <span id={`access-${a.value}-hint`} className="muted">
              {a.hint}
            </span>
          </p>
        ))}
        <FieldError id="repository_access-error" message={errors.access} />
      </fieldset>
      <fieldset>
        <legend>Less trusted jobs</legend>
        <Check
          name="allows_public"
          label="Allow public repositories"
          warning={PUBLIC_WARNING}
          checked={access.allows_public}
          error={errors.public}
        />
        {forks === true ? (
          <Check
            name="allows_forks"
            label="Allow pull requests from forks"
            warning={FORKS_WARNING}
            checked={access.allows_forks}
            error={errors.forks}
          />
        ) : (
          <p className="muted">{forks}</p>
        )}
      </fieldset>
    </>
  );
}
