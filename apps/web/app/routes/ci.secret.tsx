import { ciName } from "@fyrden/domain";
import { Form, Link, redirect, useActionData, useLocation } from "react-router";
import {
  describedBy,
  ErrorSummary,
  FieldError,
  RepositoryAccess,
  VisibilityField,
  When,
} from "../components/ci-settings-ui.js";
import { SettingsShell } from "../components/settings-shell.js";
import { apiGet, assertSameOrigin } from "../lib/api.server.js";
import {
  type CiScope,
  editPath,
  errorsFor,
  type FormErrors,
  listPath,
  scopeOf,
  VALUE_TOO_LARGE,
  type Visibility,
} from "../lib/ci-settings.js";
import {
  apiBase,
  changeAccess,
  fitsValue,
  loadAccess,
  loadShell,
  normalizeLineBreaks,
  problemOf,
  putSealedSecret,
  readValueForm,
  visibilityOf,
  write,
} from "../lib/ci-settings.server.js";
import type { Route } from "./+types/ci.secret";

interface Secret {
  readonly name: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly unreadable?: boolean;
  readonly visibility?: Visibility;
}

export function meta({ params }: Route.MetaArgs): Route.MetaDescriptors {
  return [{ title: `${params.name ? `Secret ${params.name}` : "New secret"} · Fyrden` }];
}

const secretPath = (scope: CiScope, name: string) =>
  `${apiBase(scope)}/actions/secrets/${encodeURIComponent(name)}`;

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const scope = scopeOf(params);
  const shell = await loadShell(context, request, scope);
  // The page reads before it offers a form, so the API's refusal is the page's.
  let secret: Secret | null = null;
  if (params.name) secret = await apiGet<Secret>(context, request, secretPath(scope, params.name));
  else await apiGet(context, request, `${apiBase(scope)}/actions/secrets?per_page=1`);
  const access = await loadAccess(context, request, scope, "secret", secret);
  return { shell, scope, secret, access };
}

/** A refused write: its errors and, on a save, the access chosen (never the value). */
type Result = { readonly errors: FormErrors; readonly visibility?: Visibility };

const refused = (errors: FormErrors, visibility?: Visibility): Result => ({
  errors,
  ...(visibility && { visibility }),
});

export async function action({ request, context, params }: Route.ActionArgs) {
  assertSameOrigin(request);
  const scope = scopeOf(params);
  const form = await readValueForm(request);
  if (form === "too-large") return refused({ value: VALUE_TOO_LARGE });
  const nameError = () => errorsFor("secret", scope, { status: 422, code: "invalid_secret_name" });

  if (form.get("intent") === "delete") {
    const name = params.name ? ciName("secret", params.name) : undefined;
    if (name === undefined) return refused(nameError());
    if (ciName("secret", String(form.get("confirm") ?? "")) !== name)
      return refused({ confirm: `Type ${name} to delete it.` });
    const problem = problemOf(
      await write(context, request, "DELETE", secretPath(scope, name)),
      request,
    );
    if (problem) return refused(errorsFor("secret", scope, problem));
    return redirect(`${listPath(scope, "secret")}?deleted=${encodeURIComponent(name)}`);
  }

  if (params.name) {
    const name = ciName("secret", params.name);
    const changed = name && (await changeAccess(context, request, scope, "secret", name, form));
    if (changed) return changed;
  }

  const visibility = scope.kind === "organization" ? visibilityOf(form) : undefined;
  const name = ciName("secret", params.name ?? String(form.get("name") ?? ""));
  if (name === undefined) return refused(nameError(), visibility);
  if (scope.kind === "organization" && visibility === undefined)
    return refused({ visibility: "Choose which repositories can use it." });
  const field = form.get("value");
  const value = normalizeLineBreaks(typeof field === "string" ? field : "");
  if (value === "") return refused({ value: "Enter the secret's value." }, visibility);
  if (!fitsValue(value)) return refused({ value: VALUE_TOO_LARGE }, visibility);
  const result = await putSealedSecret(
    context,
    request,
    scope,
    name,
    value,
    scope.kind === "organization" ? { visibility } : {},
  );
  const problem = problemOf(result, request);
  if (problem) return refused(errorsFor("secret", scope, problem), visibility);
  const done = `${result.status === 201 ? "created" : "saved"}=${encodeURIComponent(name)}`;
  // A new secret for selected repositories reaches none yet: its page adds them.
  if (result.status === 201 && visibility === "selected")
    return redirect(`${editPath(scope, "secret", name)}?${done}`);
  return redirect(`${listPath(scope, "secret")}?${done}`);
}

export default function SecretForm({ loaderData }: Route.ComponentProps) {
  const result: Result | undefined = useActionData<typeof action>();
  const errors: FormErrors = result?.errors ?? {};
  const { shell, scope, secret, access } = loaderData;
  const location = useLocation();
  return (
    <SettingsShell scope={shell} active="secrets">
      <section className="panel" aria-labelledby="secret-form">
        <h2 id="secret-form">{secret ? `Secret ${secret.name}` : "New secret"}</h2>
        <p>
          <Link to={listPath(scope, "secret")}>All secrets</Link>
        </p>
        {secret?.unreadable && (
          <p className="muted">
            This secret can no longer be read: the key it was stored under is gone. Runs do not get
            it until it is set again.
          </p>
        )}
        {secret && (
          <p className="muted">
            Updated <When at={secret.updated_at} />. Saving replaces its value.
          </p>
        )}
        <ErrorSummary errors={errors} />
        {/* Keyed by page: the value typed on the new page is not carried into the edit page
            a save opens. */}
        <Form key={location.pathname} method="post" encType="multipart/form-data">
          {!secret && (
            <>
              <label htmlFor="name">Name</label>
              <input
                id="name"
                name="name"
                required
                maxLength={255}
                autoComplete="off"
                spellCheck={false}
                autoCapitalize="characters"
                {...describedBy("name", errors.name)}
              />
              <p id="name-hint" className="muted">
                Letters, digits and _, not starting with a digit or GITHUB_; at most 255 characters,
                stored uppercase. Saving a name that exists replaces its value.
              </p>
              <FieldError id="name-error" message={errors.name} />
            </>
          )}
          <label htmlFor="value">Value</label>
          <textarea
            id="value"
            name="value"
            rows={8}
            required
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            {...describedBy("value", errors.value)}
          />
          <p id="value-hint" className="muted">
            The value cannot be shown again after it is saved. At most 48 KiB. Line breaks are
            stored as LF; a value that needs a carriage return is set with{" "}
            <code>gh secret set</code> or the API.
          </p>
          <FieldError id="value-error" message={errors.value} />
          {scope.kind === "organization" && (
            <VisibilityField
              chosen={result?.visibility ?? secret?.visibility}
              stored={secret?.visibility}
              error={errors.visibility}
              secret
            />
          )}
          <p>
            <button className="primary" type="submit" name="intent" value="save">
              Save secret
            </button>
          </p>
        </Form>
      </section>
      {access && <RepositoryAccess noun="secret" {...access} error={errors.repository} />}
      {secret && (
        <section className="panel" aria-labelledby="delete-secret">
          <h2 id="delete-secret">Delete this secret</h2>
          <p className="muted">Its value is gone for good; workflows that read it get nothing.</p>
          <Form method="post" encType="multipart/form-data">
            <label htmlFor="confirm">Type {secret.name} to confirm</label>
            <input
              id="confirm"
              name="confirm"
              autoComplete="off"
              spellCheck={false}
              {...describedBy("confirm", errors.confirm, false)}
            />
            <FieldError id="confirm-error" message={errors.confirm} />
            <p>
              <button className="danger" type="submit" name="intent" value="delete">
                Delete secret
              </button>
            </p>
          </Form>
        </section>
      )}
    </SettingsShell>
  );
}
