import { ciName } from "@fyrden/domain";
import { Form, Link, redirect, useActionData } from "react-router";
import { describedBy, ErrorSummary, FieldError, When } from "../components/ci-settings-ui.js";
import { SettingsShell } from "../components/settings-shell.js";
import { apiGet, assertSameOrigin } from "../lib/api.server.js";
import {
  type CiScope,
  errorsFor,
  type FormErrors,
  listPath,
  scopeOf,
  VALUE_TOO_LARGE,
} from "../lib/ci-settings.js";
import {
  apiBase,
  fitsValue,
  loadShell,
  normalizeLineBreaks,
  problemOf,
  readValueForm,
  write,
} from "../lib/ci-settings.server.js";
import type { Route } from "./+types/ci.variable";

interface Variable {
  readonly name: string;
  readonly value: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export function meta({ params }: Route.MetaArgs): Route.MetaDescriptors {
  return [{ title: `${params.name ? `Variable ${params.name}` : "New variable"} · Fyrden` }];
}

const variablesPath = (scope: CiScope) => `${apiBase(scope)}/actions/variables`;
const variablePath = (scope: CiScope, name: string) =>
  `${variablesPath(scope)}/${encodeURIComponent(name)}`;

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const scope = scopeOf(params);
  const shell = await loadShell(context, request, scope);
  // The page reads before it offers a form, so the API's refusal is the page's.
  let variable: Variable | null = null;
  if (params.name)
    variable = await apiGet<Variable>(context, request, variablePath(scope, params.name));
  else await apiGet(context, request, `${variablesPath(scope)}?per_page=1`);
  return { shell, scope, variable };
}

/** A refused write: its errors and, a variable being readable, the value sent (to send again). */
type Result = { readonly errors: FormErrors; readonly value?: string };

export async function action({ request, context, params }: Route.ActionArgs) {
  assertSameOrigin(request);
  const scope = scopeOf(params);
  const form = await readValueForm(request);
  if (form === "too-large") return { errors: { value: VALUE_TOO_LARGE } } satisfies Result;
  const nameError = () =>
    errorsFor("variable", scope, { status: 422, code: "invalid_variable_name" });

  if (form.get("intent") === "delete") {
    const name = params.name ? ciName("variable", params.name) : undefined;
    if (name === undefined) return { errors: nameError() } satisfies Result;
    if (ciName("variable", String(form.get("confirm") ?? "")) !== name)
      return { errors: { confirm: `Type ${name} to delete it.` } } satisfies Result;
    const problem = problemOf(
      await write(context, request, "DELETE", variablePath(scope, name)),
      request,
    );
    if (problem) return { errors: errorsFor("variable", scope, problem) } satisfies Result;
    return redirect(`${listPath(scope, "variable")}?deleted=${encodeURIComponent(name)}`);
  }

  const field = form.get("value");
  const value = normalizeLineBreaks(typeof field === "string" ? field : "");
  const name = ciName("variable", params.name ?? String(form.get("name") ?? ""));
  if (name === undefined) return { errors: nameError(), value } satisfies Result;
  if (!fitsValue(value)) return { errors: { value: VALUE_TOO_LARGE }, value } satisfies Result;
  const result = params.name
    ? await write(context, request, "PATCH", variablePath(scope, name), { name, value })
    : await write(context, request, "POST", variablesPath(scope), { name, value });
  const problem = problemOf(result, request);
  if (problem) return { errors: errorsFor("variable", scope, problem), value } satisfies Result;
  const done = params.name ? "saved" : "created";
  return redirect(`${listPath(scope, "variable")}?${done}=${encodeURIComponent(name)}`);
}

export default function VariableForm({ loaderData }: Route.ComponentProps) {
  const result: Result | undefined = useActionData<typeof action>();
  const errors: FormErrors = result?.errors ?? {};
  const { shell, scope, variable } = loaderData;
  const value = result?.value ?? variable?.value ?? "";
  return (
    <SettingsShell scope={shell} active="variables">
      <section className="panel" aria-labelledby="variable-form">
        <h2 id="variable-form">{variable ? `Variable ${variable.name}` : "New variable"}</h2>
        <p>
          <Link to={listPath(scope, "variable")}>All variables</Link>
        </p>
        {variable && (
          <p className="muted">
            Updated <When at={variable.updated_at} />.
          </p>
        )}
        <ErrorSummary errors={errors} />
        <Form method="post" encType="multipart/form-data">
          {!variable && (
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
                stored uppercase.
              </p>
              <FieldError id="name-error" message={errors.name} />
            </>
          )}
          <label htmlFor="value">Value</label>
          <textarea
            id="value"
            name="value"
            rows={8}
            defaultValue={value}
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            {...describedBy("value", errors.value)}
          />
          <p id="value-hint" className="muted">
            Readable by anyone who manages this page and not masked in logs: keep credentials in
            secrets. At most 48 KiB. Line breaks are stored as LF.
          </p>
          <FieldError id="value-error" message={errors.value} />
          <p>
            <button className="primary" type="submit" name="intent" value="save">
              Save variable
            </button>
          </p>
        </Form>
      </section>
      {variable && (
        <section className="panel" aria-labelledby="delete-variable">
          <h2 id="delete-variable">Delete this variable</h2>
          <Form method="post" encType="multipart/form-data">
            <label htmlFor="confirm">Type {variable.name} to confirm</label>
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
                Delete variable
              </button>
            </p>
          </Form>
        </section>
      )}
    </SettingsShell>
  );
}
