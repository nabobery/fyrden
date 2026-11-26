import { matchRoutes } from "react-router";
import { describe, expect, it } from "vitest";
import { errorsFor } from "../app/lib/ci-settings.js";
import { CI_VALUE_FORM_MAX_BYTES } from "../app/lib/ci-settings.server.js";
import SecretForm, {
  action as secretAction,
  loader as secretLoader,
} from "../app/routes/ci.secret.js";
import SecretsList, { loader as secretsLoader } from "../app/routes/ci.secrets.js";
import VariableForm, {
  action as variableAction,
  loader as variableLoader,
} from "../app/routes/ci.variable.js";
import VariablesList, { loader as variablesLoader } from "../app/routes/ci.variables.js";
import routes from "../app/routes.js";
import { isApiPath } from "../workers/app.js";
import { fakeApi, json, ORIGIN } from "./helpers/context.js";
import { repo as baseRepo } from "./helpers/pulls.js";
import { escaped, renderPage } from "./helpers/render.js";
import { fixture, fromBase64, open } from "./helpers/sealed-box.js";

const ADMIN = { admin: true, maintain: true, push: true, triage: true, pull: true };
const WRITER = { admin: false, maintain: false, push: true, triage: true, pull: true };
const repo = { ...baseRepo, id: "rep_1", owner_type: "User", permissions: ADMIN };
const orgRepo = { ...repo, owner: "acme", full_name: "acme/demo", owner_type: "Organization" };
const params = { owner: "ada", repo: "demo" };
const KEY = { key_id: "key-1", key: fixture.publicKey };
const CANARY = "canary-3f9b1c-do-not-leak";
const T = "2030-01-01T00:00:00Z";

/** A same-origin multipart post with `fields` written byte for byte (values keep their own line breaks). */
function multipartPost(path: string, fields: Record<string, string>, extra = ""): Request {
  const boundary = "----fyrden-test-boundary";
  let body = "";
  for (const [name, value] of Object.entries(fields))
    body += `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  body += `${extra}--${boundary}--\r\n`;
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      Origin: ORIGIN,
      Cookie: "__Host-fyrden_session=s",
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });
}

type Reply = Response | ((request: Request) => Response | Promise<Response>);

function api(routes: Record<string, Reply | Reply[]>) {
  const used: Record<string, number> = {};
  return fakeApi(async (request) => {
    const url = new URL(request.url);
    const key = `${request.method} ${url.pathname}`;
    const route = routes[key];
    if (route === undefined) return json({ code: "not_found", detail: "Not found" }, 404);
    const at = used[key] ?? 0;
    used[key] = at + 1;
    const reply = Array.isArray(route) ? route[Math.min(at, route.length - 1)] : route;
    if (reply === undefined) throw new Error(`no reply for ${key}`);
    return typeof reply === "function" ? reply(request) : reply.clone();
  });
}

const lineOf = (call: Request) => `${call.method} ${new URL(call.url).pathname}`;

async function exposed(result: unknown): Promise<string> {
  if (result instanceof Response)
    return [
      String(result.status),
      ...[...result.headers].map(([k, v]) => `${k}: ${v}`),
      await result.clone().text(),
    ].join("\n");
  return JSON.stringify(result);
}

async function openPut(call: Request): Promise<{ value: string; body: Record<string, unknown> }> {
  const body = (await call.clone().json()) as Record<string, unknown>;
  const opened = await open(
    fromBase64(fixture.privateKey),
    fromBase64(fixture.publicKey),
    fromBase64(String(body.encrypted_value)),
  );
  return { value: new TextDecoder().decode(opened), body };
}

const run = (fn: typeof secretAction, request: Request, p: Record<string, string> = params) =>
  fn({ request, context: undefined, params: p } as never);

describe("setting a repository secret", () => {
  const path = "/ada/demo/settings/secrets/actions/new";

  it("reads the key, then puts the value sealed for it, CRLF stored as \\n", async () => {
    const { context, calls } = api({
      "GET /api/repos/ada/demo/actions/secrets/public-key": json(KEY),
      "PUT /api/repos/ada/demo/actions/secrets/DEPLOY_KEY": new Response(null, { status: 201 }),
    });
    const result = await secretAction({
      request: multipartPost(path, { intent: "save", name: "deploy_key", value: "a\r\nb\r\n" }),
      context,
      params,
    } as never);
    expect(calls.map(lineOf)).toEqual([
      "GET /api/repos/ada/demo/actions/secrets/public-key",
      "PUT /api/repos/ada/demo/actions/secrets/DEPLOY_KEY",
    ]);
    const put = await openPut(calls[1] as Request);
    expect(put.value).toBe("a\nb\n");
    expect(put.body).toEqual({ encrypted_value: expect.any(String), key_id: "key-1" });
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).headers.get("Location")).toBe(
      "/ada/demo/settings/secrets/actions?created=DEPLOY_KEY",
    );
  });

  it("says updated when the secret existed (204)", async () => {
    const { context } = api({
      "GET /api/repos/ada/demo/actions/secrets/public-key": json(KEY),
      "PUT /api/repos/ada/demo/actions/secrets/TOKEN": new Response(null, { status: 204 }),
    });
    const result = (await secretAction({
      request: multipartPost("/ada/demo/settings/secrets/actions/TOKEN/edit", {
        intent: "save",
        value: "v",
      }),
      context,
      params: { ...params, name: "TOKEN" },
    } as never)) as Response;
    expect(result.headers.get("Location")).toBe("/ada/demo/settings/secrets/actions?saved=TOKEN");
  });

  it("reads the key again once when it changed meanwhile, and no more", async () => {
    const badKey = () => json({ status: 422, code: "bad_key_id", detail: "x" }, 422);
    const once = api({
      "GET /api/repos/ada/demo/actions/secrets/public-key": json(KEY),
      "PUT /api/repos/ada/demo/actions/secrets/A": [badKey, new Response(null, { status: 201 })],
    });
    const ok = await secretAction({
      request: multipartPost(path, { intent: "save", name: "A", value: "v" }),
      context: once.context,
      params,
    } as never);
    expect(once.calls).toHaveLength(4);
    expect(ok).toBeInstanceOf(Response);

    const twice = api({
      "GET /api/repos/ada/demo/actions/secrets/public-key": json(KEY),
      "PUT /api/repos/ada/demo/actions/secrets/A": badKey,
    });
    const failed = await secretAction({
      request: multipartPost(path, { intent: "save", name: "A", value: "v" }),
      context: twice.context,
      params,
    } as never);
    expect(twice.calls).toHaveLength(4);
    expect(failed).toMatchObject({ errors: { form: expect.stringContaining("key") } });
  });

  it("takes a 48 KiB value of line breaks sent as CRLF, and refuses one byte more unsent", async () => {
    const answers = {
      "GET /api/repos/ada/demo/actions/secrets/public-key": json(KEY),
      "PUT /api/repos/ada/demo/actions/secrets/BIG": new Response(null, { status: 201 }),
    };
    const fits = api(answers);
    const big = "\r\n".repeat(49_152);
    const request = multipartPost(path, { intent: "save", name: "BIG", value: big });
    const ok = await secretAction({ request, context: fits.context, params } as never);
    expect(ok).toBeInstanceOf(Response);
    expect((await openPut(fits.calls[1] as Request)).value).toBe("\n".repeat(49_152));

    const over = api(answers);
    const refused = await secretAction({
      request: multipartPost(path, { intent: "save", name: "BIG", value: `${big}x` }),
      context: over.context,
      params,
    } as never);
    expect(refused).toMatchObject({ errors: { value: expect.stringContaining("48 KiB") } });
    expect(over.calls).toHaveLength(0);

    const huge = api(answers);
    const tooLarge = await secretAction({
      request: multipartPost(
        path,
        { intent: "save", name: "BIG" },
        "x".repeat(CI_VALUE_FORM_MAX_BYTES),
      ),
      context: huge.context,
      params,
    } as never);
    expect(tooLarge).toMatchObject({ errors: { value: expect.stringContaining("48 KiB") } });
    expect(huge.calls).toHaveLength(0);
  });

  it("refuses an empty value and a bad name without calling the API", async () => {
    const { context, calls } = api({});
    expect(
      await secretAction({
        request: multipartPost(path, { intent: "save", name: "A", value: "" }),
        context,
        params,
      } as never),
    ).toMatchObject({ errors: { value: expect.any(String) } });
    expect(
      await secretAction({
        request: multipartPost(path, { intent: "save", name: "1A", value: "v" }),
        context,
        params,
      } as never),
    ).toMatchObject({ errors: { name: expect.any(String) } });
    expect(calls).toHaveLength(0);
  });

  it("never shows the value: not in a redirect, a header, an error or its data", async () => {
    const outcomes: Record<string, Reply> = {
      created: new Response(null, { status: 201 }),
      name: json({ status: 422, code: "invalid_secret_name", detail: "bad" }, 422),
      big: json({ status: 422, code: "secret_too_large", detail: "big" }, 422),
      key: json({ status: 503, code: "ci_key_unavailable", detail: "no key" }, 503),
      gone: json({ status: 404, code: "repo_not_found", detail: "gone" }, 404),
    };
    for (const reply of Object.values(outcomes)) {
      const { context } = api({
        "GET /api/repos/ada/demo/actions/secrets/public-key": json(KEY),
        "PUT /api/repos/ada/demo/actions/secrets/A": reply,
      });
      const result = await secretAction({
        request: multipartPost(path, { intent: "save", name: "A", value: CANARY }),
        context,
        params,
      } as never);
      expect(await exposed(result)).not.toContain(CANARY);
    }
  });

  it("refuses a post from another origin", async () => {
    const request = multipartPost(path, { intent: "save", name: "A", value: "v" });
    const foreign = new Request(request, {
      headers: { ...Object.fromEntries(request.headers), Origin: "https://evil.test" },
    });
    await expect(run(secretAction, foreign)).rejects.toMatchObject({ init: { status: 403 } });
  });
});

describe("deleting a repository secret", () => {
  const editPath = "/ada/demo/settings/secrets/actions/TOKEN/edit";
  const p = { ...params, name: "TOKEN" };

  it("needs the name typed to confirm, and then deletes it", async () => {
    const { context, calls } = api({
      "DELETE /api/repos/ada/demo/actions/secrets/TOKEN": new Response(null, { status: 204 }),
    });
    const unconfirmed = await secretAction({
      request: multipartPost(editPath, { intent: "delete", confirm: "TOKE" }),
      context,
      params: p,
    } as never);
    expect(unconfirmed).toMatchObject({ errors: { confirm: expect.any(String) } });
    expect(calls).toHaveLength(0);

    const deleted = (await secretAction({
      request: multipartPost(editPath, { intent: "delete", confirm: "token" }),
      context,
      params: p,
    } as never)) as Response;
    expect(calls.map(lineOf)).toEqual(["DELETE /api/repos/ada/demo/actions/secrets/TOKEN"]);
    expect(deleted.headers.get("Location")).toBe(
      "/ada/demo/settings/secrets/actions?deleted=TOKEN",
    );
  });
});

describe("what the API answers, on the form", () => {
  const repoScope = { kind: "repository", owner: "ada", repo: "demo" } as const;
  const orgScope = { kind: "organization", org: "acme" } as const;
  const cases: [string, number, keyof ReturnType<typeof errorsFor>][] = [
    ["invalid_secret_name", 422, "name"],
    ["invalid_variable_name", 422, "name"],
    ["secret_too_large", 422, "value"],
    ["variable_too_large", 422, "value"],
    ["variable_exists", 409, "name"],
    ["undecryptable_value", 422, "form"],
    ["bad_key_id", 422, "form"],
    ["too_many_secrets", 422, "form"],
    ["too_many_variables", 422, "form"],
    ["ci_key_unavailable", 503, "form"],
    ["repo_transferring", 409, "form"],
    ["repository_changed", 409, "form"],
    ["unknown_repository", 422, "repository"],
    ["too_many_repositories", 422, "repository"],
    ["visibility_not_selected", 409, "form"],
    ["rate_limited", 429, "form"],
    ["busy", 503, "form"],
    ["repo_not_found", 404, "form"],
    ["not_an_org", 404, "form"],
    ["secret_not_found", 404, "form"],
    ["not_recorded", 404, "form"],
  ];
  it.each(cases)("%s (%i) is about the %s", (code, status, field) => {
    expect(errorsFor("secret", repoScope, { status, code, detail: "d" })[field]).toEqual(
      expect.any(String),
    );
  });
  it("gives each count limit its own number", () => {
    const limit = (code: string, scope: typeof repoScope | typeof orgScope) =>
      errorsFor("secret", scope, { status: 422, code }).form;
    expect(limit("too_many_secrets", repoScope)).toContain("100");
    expect(limit("too_many_variables", repoScope)).toContain("500");
    expect(limit("too_many_secrets", orgScope)).toContain("1,000");
  });
  it("shows an unknown problem's own detail", () => {
    expect(
      errorsFor("secret", repoScope, { status: 422, code: "invalid_input", detail: "why" }),
    ).toEqual({
      form: "why",
    });
  });
});

describe("repository variables", () => {
  const path = "/ada/demo/settings/variables/actions/new";

  it("creates one with CRLF stored as \\n, and keeps the value when it fails", async () => {
    const { context, calls } = api({
      "POST /api/repos/ada/demo/actions/variables": [
        new Response(null, { status: 201 }),
        json({ status: 409, code: "variable_exists", detail: "x" }, 409),
      ],
    });
    const made = (await variableAction({
      request: multipartPost(path, { intent: "save", name: "region", value: "\r\neu\r\n" }),
      context,
      params,
    } as never)) as Response;
    expect(await (calls[0] as Request).json()).toEqual({ name: "REGION", value: "\neu\n" });
    expect(made.headers.get("Location")).toBe(
      "/ada/demo/settings/variables/actions?created=REGION",
    );

    const exists = await variableAction({
      request: multipartPost(path, { intent: "save", name: "region", value: "eu" }),
      context,
      params,
    } as never);
    expect(exists).toMatchObject({ errors: { name: expect.any(String) }, value: "eu" });
  });

  it("updates one by PATCH, and an empty value is a value", async () => {
    const { context, calls } = api({
      "PATCH /api/repos/ada/demo/actions/variables/REGION": new Response(null, { status: 204 }),
    });
    const saved = (await variableAction({
      request: multipartPost("/ada/demo/settings/variables/actions/REGION/edit", {
        intent: "save",
        value: "",
      }),
      context,
      params: { ...params, name: "REGION" },
    } as never)) as Response;
    expect(await (calls[0] as Request).json()).toEqual({ name: "REGION", value: "" });
    expect(saved.headers.get("Location")).toBe("/ada/demo/settings/variables/actions?saved=REGION");
  });
});

describe("who sees the pages", () => {
  const loaderArgs = (url: string, p: Record<string, string>, context: unknown) =>
    ({ request: new Request(`${ORIGIN}${url}`), context, params: p }) as never;

  it("a new page reads the list first: a writer gets its 404, not a form", async () => {
    const { context } = api({
      "GET /api/repos/ada/demo": json({ ...repo, permissions: WRITER }),
      "GET /api/repos/ada/demo/actions/secrets": json(
        { status: 404, code: "repo_not_found", detail: "Not found" },
        404,
      ),
    });
    await expect(
      secretLoader(loaderArgs("/ada/demo/settings/secrets/actions/new", params, context)),
    ).rejects.toMatchObject({ init: { status: 404 } });
  });

  it("an edit page reads the entry: a missing one is 404", async () => {
    const { context } = api({ "GET /api/repos/ada/demo": json(repo) });
    await expect(
      variableLoader(
        loaderArgs(
          "/ada/demo/settings/variables/actions/NOPE/edit",
          { ...params, name: "NOPE" },
          context,
        ),
      ),
    ).rejects.toMatchObject({ init: { status: 404 } });
  });

  it("the list answers the API's refusal", async () => {
    const { context } = api({
      "GET /api/repos/ada/demo": json({ ...repo, permissions: WRITER }),
      "GET /api/repos/ada/demo/actions/variables": json(
        { status: 404, code: "repo_not_found" },
        404,
      ),
    });
    await expect(
      variablesLoader(loaderArgs("/ada/demo/settings/variables/actions", params, context)),
    ).rejects.toMatchObject({ init: { status: 404 } });
  });
});

describe("lists", () => {
  const loaderArgs = (url: string, context: unknown) =>
    ({ request: new Request(`${ORIGIN}${url}`), context, params }) as never;
  const variable = (name: string, value: string) => ({ name, value, created_at: T, updated_at: T });

  it("a user's repository reads 6 variables a page, cut to 200 characters", async () => {
    const { context, calls } = api({
      "GET /api/repos/ada/demo": json(repo),
      "GET /api/repos/ada/demo/actions/variables": json({
        total_count: 1,
        variables: [variable("LONG", "x".repeat(5000))],
      }),
    });
    const data = await variablesLoader(loaderArgs("/ada/demo/settings/variables/actions", context));
    expect(calls.map((c) => new URL(c.url).search)).toContain("?per_page=6&page=1");
    expect(JSON.stringify(data)).not.toContain("x".repeat(201));
  });

  it("an organization's repository reads 3 of its own and 3 inherited, paged apart", async () => {
    const { context, calls } = fakeApi((request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/repos/acme/demo") return json(orgRepo);
      if (url.pathname.endsWith("/organization-variables"))
        return json({ total_count: 0, variables: [] });
      return json({ total_count: 0, variables: [] });
    });
    await variablesLoader({
      request: new Request(`${ORIGIN}/acme/demo/settings/variables/actions?page=2&org_page=3`),
      context,
      params: { owner: "acme", repo: "demo" },
    } as never);
    const asked = calls.map((c) => `${new URL(c.url).pathname}${new URL(c.url).search}`);
    expect(asked).toContain("/api/repos/acme/demo/actions/variables?per_page=3&page=2");
    expect(asked).toContain(
      "/api/repos/acme/demo/actions/organization-variables?per_page=3&page=3",
    );
  });

  it("secrets: 100 a page, inherited ones, and the organization link only for its owners", async () => {
    const secret = (name: string, extra = {}) => ({ name, created_at: T, updated_at: T, ...extra });
    const owner = api({
      "GET /api/repos/acme/demo": json(orgRepo),
      "GET /api/repos/acme/demo/actions/secrets": json({ total_count: 1, secrets: [secret("A")] }),
      "GET /api/repos/acme/demo/actions/organization-secrets": json({
        total_count: 1,
        secrets: [secret("LOST", { unreadable: true })],
      }),
      "GET /api/orgs/acme/actions/secrets": json({ total_count: 0, secrets: [] }),
    });
    const args = {
      request: new Request(`${ORIGIN}/acme/demo/settings/secrets/actions`),
      context: owner.context,
      params: { owner: "acme", repo: "demo" },
    } as never;
    const data = await secretsLoader(args);
    expect(owner.calls.map((c) => new URL(c.url).search)).toContain("?per_page=100&page=1");
    expect(data).toMatchObject({ manageOrg: true });
    const html = renderPage(SecretsList, "/acme/demo/settings/secrets/actions", data);
    expect(html).toContain("Unreadable");
    expect(html).not.toContain('href="/acme/demo/settings/secrets/actions/LOST/edit"');
    expect(html).toContain('href="/settings/orgs/acme/secrets/actions/LOST/edit"');

    const member = api({
      "GET /api/repos/acme/demo": json(orgRepo),
      "GET /api/repos/acme/demo/actions/secrets": json({ total_count: 0, secrets: [] }),
      "GET /api/repos/acme/demo/actions/organization-secrets": json({
        total_count: 1,
        secrets: [secret("LOST", { unreadable: true })],
      }),
      "GET /api/orgs/acme/actions/secrets": json({ status: 403, code: "forbidden" }, 403),
    });
    const memberData = await secretsLoader({
      request: new Request(`${ORIGIN}/acme/demo/settings/secrets/actions`),
      context: member.context,
      params: { owner: "acme", repo: "demo" },
    } as never);
    expect(memberData).toMatchObject({ manageOrg: false });
    const memberHtml = renderPage(SecretsList, "/acme/demo/settings/secrets/actions", memberData);
    expect(memberHtml).not.toContain("/settings/orgs/acme");
    expect(memberHtml).toContain("organization owner");
  });
});

describe("pages", () => {
  it("the secret form never prefills the value, and turns off browser help on it", () => {
    const html = renderPage(SecretForm, "/ada/demo/settings/secrets/actions/new", {
      shell: { kind: "repository", repo, origin: ORIGIN },
      scope: { kind: "repository", owner: "ada", repo: "demo" },
      secret: null,
    });
    // HTML attribute names ignore case (React writes spellCheck, autoComplete, …).
    const textarea = (html.match(/<textarea[^>]*>/)?.[0] ?? "").toLowerCase();
    expect(textarea).toContain('spellcheck="false"');
    expect(textarea).toContain('autocomplete="off"');
    expect(textarea).toContain('autocorrect="off"');
    expect(textarea).toContain('autocapitalize="none"');
    expect(textarea).toContain("required");
    expect(html.toLowerCase()).toContain('enctype="multipart/form-data"');
    expect(html).toContain("cannot be shown again");
  });

  it("a variable's leading line break survives into its textarea", () => {
    const html = renderPage(VariableForm, "/ada/demo/settings/variables/actions/A/edit", {
      shell: { kind: "repository", repo, origin: ORIGIN },
      scope: { kind: "repository", owner: "ada", repo: "demo" },
      variable: { name: "A", value: "\nkept", created_at: T, updated_at: T },
    });
    expect(html).toMatch(/<textarea[^>]*>\n\nkept<\/textarea>/);
  });

  it("the settings nav shows secrets and variables to an administrator only", () => {
    const data = (permissions: typeof ADMIN) => ({
      shell: { kind: "repository", repo: { ...repo, permissions }, origin: ORIGIN },
      scope: { kind: "repository", owner: "ada", repo: "demo" },
      variables: [],
      total: 0,
      pages: { next: null, first: null },
      inherited: null,
    });
    const admin = renderPage(VariablesList, "/ada/demo/settings/variables/actions", data(ADMIN));
    expect(admin).toContain('href="/ada/demo/settings/secrets/actions"');
    const writer = renderPage(VariablesList, "/ada/demo/settings/variables/actions", data(WRITER));
    expect(writer).not.toContain('href="/ada/demo/settings/secrets/actions"');
  });

  it("a hostile variable value is text", () => {
    const value = `<script>alert(1)</script>`;
    const html = renderPage(VariablesList, "/ada/demo/settings/variables/actions", {
      shell: { kind: "repository", repo, origin: ORIGIN },
      scope: { kind: "repository", owner: "ada", repo: "demo" },
      variables: [{ name: "X", value, created_at: T, updated_at: T }],
      total: 1,
      pages: { next: null, first: null },
      inherited: null,
    });
    expect(html).toContain(escaped(value));
    expect(html).not.toContain(value);
  });
});

describe("page paths", () => {
  const routeOf = (path: string) =>
    matchRoutes(
      routes.map((r) => ({ path: r.path ?? "", id: r.id ?? r.file })),
      path,
    )?.at(-1)?.route.id;

  it("sends a secret or variable named NEW to its edit page, not the new page", () => {
    expect(routeOf("/ada/demo/settings/secrets/actions/new")).toBe("repo.secret.new");
    expect(routeOf("/ada/demo/settings/secrets/actions/NEW/edit")).toBe("repo.secret.edit");
    expect(routeOf("/ada/demo/settings/variables/actions/new")).toBe("repo.variable.new");
    expect(routeOf("/ada/demo/settings/variables/actions/NEW/edit")).toBe("repo.variable.edit");
    expect(routeOf("/ada/demo/settings/secrets/actions")).toBe("repo.secrets");
  });

  it("keeps the pages the web Worker's own", () => {
    for (const path of [
      "/ada/demo/settings/secrets/actions",
      "/ada/demo/settings/variables/actions/new",
      "/ada/demo/settings/secrets/actions/TOKEN/edit",
    ])
      expect(isApiPath(path), path).toBe(false);
  });
});

describe("organization secrets and variables", () => {
  const org = { org: "acme" };
  const secretsPath = "/settings/orgs/acme/secrets/actions";
  const created = () => new Response(null, { status: 201 });
  const updated = () => new Response(null, { status: 204 });

  it("sets a secret with the visibility chosen, and needs one chosen", async () => {
    const { context, calls } = api({
      "GET /api/orgs/acme/actions/secrets/public-key": json(KEY),
      "PUT /api/orgs/acme/actions/secrets/TOKEN": created,
    });
    const none = await secretAction({
      request: multipartPost(`${secretsPath}/new`, { intent: "save", name: "TOKEN", value: "v" }),
      context,
      params: org,
    } as never);
    expect(none).toMatchObject({ errors: { visibility: expect.any(String) } });
    expect(calls).toHaveLength(0);

    const made = (await secretAction({
      request: multipartPost(`${secretsPath}/new`, {
        intent: "save",
        name: "token",
        value: "v",
        visibility: "private",
      }),
      context,
      params: org,
    } as never)) as Response;
    const put = await openPut(calls[1] as Request);
    expect(put.value).toBe("v");
    expect(put.body).toMatchObject({ visibility: "private", key_id: "key-1" });
    expect(put.body).not.toHaveProperty("selected_repository_ids");
    expect(made.headers.get("Location")).toBe(`${secretsPath}?created=TOKEN`);
  });

  it("sends a new secret for selected repositories to its edit page to add them", async () => {
    const { context } = api({
      "GET /api/orgs/acme/actions/secrets/public-key": json(KEY),
      "PUT /api/orgs/acme/actions/secrets/TOKEN": created,
    });
    const made = (await secretAction({
      request: multipartPost(`${secretsPath}/new`, {
        intent: "save",
        name: "TOKEN",
        value: "v",
        visibility: "selected",
      }),
      context,
      params: org,
    } as never)) as Response;
    expect(made.headers.get("Location")).toBe(`${secretsPath}/TOKEN/edit?created=TOKEN`);
  });

  it("adds a repository by name, and says so on the field when there is none", async () => {
    const { context, calls } = api({
      "GET /api/repos/acme/web": json({ ...orgRepo, id: "rep_9", name: "web" }),
      "PUT /api/orgs/acme/actions/secrets/TOKEN/repositories/rep_9": updated,
    });
    const p = { ...org, name: "TOKEN" };
    const added = (await secretAction({
      request: multipartPost(`${secretsPath}/TOKEN/edit`, {
        intent: "add-repository",
        repository: "web",
      }),
      context,
      params: p,
    } as never)) as Response;
    expect(calls.map(lineOf)).toEqual([
      "GET /api/repos/acme/web",
      "PUT /api/orgs/acme/actions/secrets/TOKEN/repositories/rep_9",
    ]);
    expect(added.headers.get("Location")).toBe(`${secretsPath}/TOKEN/edit?added=web`);

    const missing = await secretAction({
      request: multipartPost(`${secretsPath}/TOKEN/edit`, {
        intent: "add-repository",
        repository: "nope",
      }),
      context,
      params: p,
    } as never);
    expect(missing).toMatchObject({
      errors: { repository: "Not a repository of this organization." },
    });
    expect(calls).toHaveLength(3);
  });

  it("removes a repository by id", async () => {
    const { context, calls } = api({
      "DELETE /api/orgs/acme/actions/variables/REGION/repositories/rep_9": updated,
    });
    const removed = (await variableAction({
      request: multipartPost("/settings/orgs/acme/variables/actions/REGION/edit", {
        intent: "remove-repository",
        repository_id: "rep_9",
        repository: "web",
      }),
      context,
      params: { ...org, name: "REGION" },
    } as never)) as Response;
    expect(calls.map(lineOf)).toEqual([
      "DELETE /api/orgs/acme/actions/variables/REGION/repositories/rep_9",
    ]);
    expect(removed.headers.get("Location")).toBe(
      "/settings/orgs/acme/variables/actions/REGION/edit?removed=web",
    );
  });

  it("changes a variable's visibility with its value by PATCH", async () => {
    const { context, calls } = api({
      "PATCH /api/orgs/acme/actions/variables/REGION": updated,
    });
    await variableAction({
      request: multipartPost("/settings/orgs/acme/variables/actions/REGION/edit", {
        intent: "save",
        value: "eu",
        visibility: "all",
      }),
      context,
      params: { ...org, name: "REGION" },
    } as never);
    expect(await (calls[0] as Request).json()).toEqual({
      name: "REGION",
      value: "eu",
      visibility: "all",
    });
  });

  it("answers a member's 403 and a user's 404 as the page's own", async () => {
    for (const [status, code] of [
      [403, "forbidden"],
      [404, "not_an_org"],
    ] as const) {
      const { context } = api({
        "GET /api/orgs/acme/actions/secrets": json({ status, code }, status),
        "GET /api/orgs/acme/actions/variables": json({ status, code }, status),
      });
      const args = (url: string) =>
        ({ request: new Request(`${ORIGIN}${url}`), context, params: org }) as never;
      await expect(secretsLoader(args(secretsPath))).rejects.toMatchObject({ init: { status } });
      await expect(secretLoader(args(`${secretsPath}/new`))).rejects.toMatchObject({
        init: { status },
      });
      await expect(
        variablesLoader(args("/settings/orgs/acme/variables/actions")),
      ).rejects.toMatchObject({ init: { status } });
    }
  });

  it("reads 6 variables a page, and the selected repositories 100 a page", async () => {
    const { context, calls } = fakeApi((request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/repositories"))
        return json({ total_count: 101, repositories: [] });
      if (url.pathname === "/api/orgs/acme/actions/variables/REGION")
        return json({
          name: "REGION",
          value: "eu",
          visibility: "selected",
          created_at: T,
          updated_at: T,
        });
      return json({ total_count: 0, variables: [] });
    });
    await variablesLoader({
      request: new Request(`${ORIGIN}/settings/orgs/acme/variables/actions`),
      context,
      params: org,
    } as never);
    const data = await variableLoader({
      request: new Request(
        `${ORIGIN}/settings/orgs/acme/variables/actions/REGION/edit?repo_page=2`,
      ),
      context,
      params: { ...org, name: "REGION" },
    } as never);
    const asked = calls.map((c) => `${new URL(c.url).pathname}${new URL(c.url).search}`);
    expect(asked).toContain("/api/orgs/acme/actions/variables?per_page=6&page=1");
    expect(asked).toContain(
      "/api/orgs/acme/actions/variables/REGION/repositories?per_page=100&page=2",
    );
    expect(data).toMatchObject({ access: { total: 101, pages: { first: expect.any(String) } } });
  });

  it("renders visibility as required radios, private by default, and the selected repositories", () => {
    const shell = { kind: "organization", org: "acme" };
    const scope = { kind: "organization", org: "acme" };
    const fresh = renderPage(SecretForm, `${secretsPath}/new`, {
      shell,
      scope,
      secret: null,
      access: null,
    });
    const radio = (html: string, value: string) =>
      (html.match(new RegExp(`<input[^>]*value="${value}"[^>]*>`))?.[0] ?? "").toLowerCase();
    expect(radio(fresh, "private")).toContain("checked");
    expect(radio(fresh, "all")).not.toContain("checked");
    expect(radio(fresh, "all")).toContain("required");

    const edit = renderPage(SecretForm, `${secretsPath}/TOKEN/edit`, {
      shell,
      scope,
      secret: { name: "TOKEN", created_at: T, updated_at: T, visibility: "selected" },
      access: {
        repositories: [{ id: "rep_9", name: "web", full_name: "acme/web", visibility: "private" }],
        total: 1,
        pages: { next: null, first: null },
      },
    });
    expect(radio(edit, "selected")).toContain("checked");
    expect(edit).toContain("acme/web");
    expect(edit).toContain('value="rep_9"');
    expect(edit).toContain("Add repository");
    expect(edit).toContain("enter its value again");
  });

  it("keeps the access chosen when a save is refused, for a secret and a variable", async () => {
    const shell = { kind: "organization", org: "acme" };
    const scope = { kind: "organization", org: "acme" };
    const checked = (html: string) =>
      html
        .match(/<input[^>]*checked[^>]*value="(\w+)"|<input[^>]*value="(\w+)"[^>]*checked/i)
        ?.slice(1)
        .find(Boolean);

    const secret = api({
      "GET /api/orgs/acme/actions/secrets/public-key": json(KEY),
      "PUT /api/orgs/acme/actions/secrets/TOKEN": json(
        { status: 503, code: "ci_key_unavailable", detail: "no key" },
        503,
      ),
    });
    const secretResult = await secretAction({
      request: multipartPost(`${secretsPath}/TOKEN/edit`, {
        intent: "save",
        value: CANARY,
        visibility: "selected",
      }),
      context: secret.context,
      params: { ...org, name: "TOKEN" },
    } as never);
    expect(secretResult).toMatchObject({
      visibility: "selected",
      errors: { form: expect.any(String) },
    });
    expect(await exposed(secretResult)).not.toContain(CANARY);
    const secretHtml = renderPage(
      SecretForm,
      `${secretsPath}/TOKEN/edit`,
      {
        shell,
        scope,
        secret: { name: "TOKEN", created_at: T, updated_at: T, visibility: "all" },
        access: null,
      },
      secretResult,
    );
    expect(checked(secretHtml)).toBe("selected");

    const variable = api({
      "PATCH /api/orgs/acme/actions/variables/REGION": json(
        { status: 429, code: "rate_limited", detail: "slow" },
        429,
      ),
    });
    const variableResult = await variableAction({
      request: multipartPost("/settings/orgs/acme/variables/actions/REGION/edit", {
        intent: "save",
        value: "eu",
        visibility: "private",
      }),
      context: variable.context,
      params: { ...org, name: "REGION" },
    } as never);
    expect(variableResult).toMatchObject({ visibility: "private", value: "eu" });
    const variableHtml = renderPage(
      VariableForm,
      "/settings/orgs/acme/variables/actions/REGION/edit",
      {
        shell,
        scope,
        variable: { name: "REGION", value: "us", created_at: T, updated_at: T, visibility: "all" },
        access: null,
      },
      variableResult,
    );
    expect(checked(variableHtml)).toBe("private");
  });

  it("routes the organization pages under /settings/orgs", () => {
    const routeOf = (path: string) =>
      matchRoutes(
        routes.map((r) => ({ path: r.path ?? "", id: r.id ?? r.file })),
        path,
      )?.at(-1)?.route.id;
    expect(routeOf("/settings/orgs/acme/secrets/actions")).toBe("org.secrets");
    expect(routeOf("/settings/orgs/acme/secrets/actions/new")).toBe("org.secret.new");
    expect(routeOf("/settings/orgs/acme/secrets/actions/NEW/edit")).toBe("org.secret.edit");
    expect(routeOf("/settings/orgs/acme/variables/actions")).toBe("org.variables");
    expect(routeOf("/settings/orgs/acme/variables/actions/new")).toBe("org.variable.new");
    expect(routeOf("/settings/orgs/acme/variables/actions/X/edit")).toBe("org.variable.edit");
    expect(isApiPath("/settings/orgs/acme/secrets/actions")).toBe(false);
  });
});
