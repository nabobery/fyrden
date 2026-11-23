// Actions secrets and variables settings, in a real browser against both
// Workers: an administrator sets, updates and deletes a repository's
// secrets and variables, a 48 KiB value fits and one byte more does not,
// line breaks typed in a form are stored as "\n" (with and without
// JavaScript), worst-case variable values still list, a writer gets no
// page and no form, and a secret's value never comes back to the browser
// or into the Workers' logs. Every page is checked with axe for WCAG 2.x A
// and AA. Needs `pnpm --filter @fyrden/web build` first (turbo does it).
import { uniqueId } from "@fyrden/testing";
import { type APIResponse, type Browser, type Page, expect as see } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accessible as axe, startWebStack, visit, type WebStack } from "./web-stack.js";

let stack: WebStack;
let page: Page;
let browser: Browser;
const handle = "ada";
const name = "secrets";
const CANARY = `canary-${uniqueId()}`;
/** What the browser received, as text: every response's status, headers and body. */
const received: string[] = [];

const accessible = (what: string) => axe(page, what);
const settings = () => `${stack.origin}/${handle}/${name}/settings`;

async function rest<T>(
  method: string,
  path: string,
  body?: unknown,
  token = stack.token,
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${stack.origin}/api${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined && {
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T };
}

async function ok<T>(method: string, path: string, body?: unknown, token?: string): Promise<T> {
  const res = await rest<T>(method, path, body, token);
  expect(res.status, `${method} ${path}: ${JSON.stringify(res.body)}`).toBeLessThan(300);
  return res.body;
}

const asText = async (response: APIResponse): Promise<string> => {
  const headers = response
    .headersArray()
    .map(({ name, value }) => `${name}: ${value}`)
    .join("\n");
  return `${response.status()} ${response.url()}\n${headers}\n${await response.text()}`;
};

/**
 * Passes every request of `target`'s context through here, so each response
 * is read in full before the browser gets it. The browser follows a redirect
 * without asking the route again, so the page a redirect names is read here
 * too, with the same cookies (a GET, as the browser's own).
 */
async function record(target: Page): Promise<void> {
  const context = target.context();
  await context.route("**/*", async (route) => {
    const response = await route.fetch({ maxRedirects: 0 });
    received.push(await asText(response));
    const location = response.headers().location;
    if (response.status() >= 300 && response.status() < 400 && location) {
      const next = new URL(location, response.url()).href;
      received.push(await asText(await context.request.get(next, { maxRedirects: 0 })));
    }
    await route.fulfill({ response });
  });
}

/** Puts `value` into a large field at once (typing 48 KiB through `fill` stalls the page). */
async function setValue(target: Page, label: string, value: string): Promise<void> {
  await target.getByLabel(label).evaluate((field, text) => {
    (field as unknown as { value: string }).value = text;
  }, value);
}

async function close(target: Page): Promise<void> {
  await target.context().close();
}

/** A page of this session with no JavaScript. */
async function withoutScript(): Promise<Page> {
  const context = await browser.newContext({
    javaScriptEnabled: false,
    storageState: await page.context().storageState(),
  });
  const plain = await context.newPage();
  await record(plain);
  return plain;
}

/** A signed-in page for the user with `token`, in its own browser context. */
async function signedIn(token: string): Promise<Page> {
  const theirs = await (await browser.newContext()).newPage();
  await theirs.goto(`${stack.origin}/auth/sign-in?return_to=%2F`);
  await theirs.getByLabel(/personal access token/i).fill(token);
  await theirs.getByRole("button", { name: "Sign in with the token" }).click();
  await theirs.getByRole("button", { name: "Not now" }).click();
  await see(theirs).toHaveURL(`${stack.origin}/`);
  await record(theirs);
  return theirs;
}

async function userToken(login: string): Promise<string> {
  const user = await ok<{ id: string }>("POST", "/admin/users", { handle: login });
  const { token } = await ok<{ token: string }>("POST", `/admin/users/${user.id}/tokens`, {
    type: "pat",
    scopes: [],
    expires_in_days: 1,
  });
  return token;
}

beforeAll(async () => {
  stack = await startWebStack(handle);
  page = stack.page;
  const own = page.context().browser();
  if (!own) throw new Error("no browser");
  browser = own;
  await record(page);
  await ok("POST", "/user/repos", { name });
}, 180_000);

afterAll(async () => {
  const lines = stack?.workerLines() ?? [];
  await stack?.stop();
  // Read after the Workers stopped, so late output counts too.
  const leaked = [...lines, ...(stack?.workerLines() ?? [])].filter((l) => l.includes(CANARY));
  expect(leaked).toEqual([]);
});

describe("repository secrets", () => {
  it("creates a secret from the settings nav, and lists it without its value", async () => {
    await visit(page, `${settings()}`);
    const nav = page.getByRole("navigation", { name: "Repository settings" });
    await see(nav.getByRole("link", { name: "General" })).toHaveAttribute("aria-current", "page");
    await nav.getByRole("link", { name: "Secrets" }).click();
    await see(page.getByRole("heading", { name: "Actions secrets" })).toBeVisible();
    await see(page.getByText("No secrets.")).toBeVisible();
    await accessible("repository secrets, empty");
    await page.getByRole("link", { name: "New secret" }).click();
    await see(page.getByRole("heading", { name: "New secret" })).toBeVisible();
    await accessible("new repository secret");
    await page.getByLabel("Name").fill("deploy_key");
    await page.getByLabel("Value").fill(`-----BEGIN KEY-----\n${CANARY}\n-----END KEY-----\n`);
    await page.getByRole("button", { name: "Save secret" }).click();
    await see(page.getByRole("status")).toHaveText("Created the secret DEPLOY_KEY.");
    await see(page.getByRole("link", { name: "DEPLOY_KEY" })).toBeVisible();
    await accessible("repository secrets");
    const listed = await ok<{ secrets: { name: string }[] }>(
      "GET",
      `/repos/${handle}/${name}/actions/secrets`,
    );
    expect(listed.secrets.map((s) => s.name)).toEqual(["DEPLOY_KEY"]);
  });

  it("shows a refused name on its field, keeping the value out of the page", async () => {
    await visit(page, `${settings()}/secrets/actions/new`);
    await page.getByLabel("Name").fill("GITHUB_TOKEN");
    await page.getByLabel("Value").fill(CANARY);
    await page.getByRole("button", { name: "Save secret" }).click();
    await see(page.getByRole("alert")).toContainText("not starting with a digit or GITHUB_");
    await see(page.getByLabel("Name")).toHaveAttribute("aria-invalid", "true");
    await accessible("new repository secret, refused name");
  });

  it("takes a 48 KiB value with line breaks, and refuses one byte more on the page", async () => {
    const value = "ab\n".repeat(16_384); // 49,152 bytes as "\n", 65,536 as the browser's CRLF
    await visit(page, `${settings()}/secrets/actions/new`);
    await page.getByLabel("Name").fill("BIG");
    await setValue(page, "Value", value);
    await page.getByRole("button", { name: "Save secret" }).click();
    await see(page.getByRole("status")).toHaveText("Created the secret BIG.");

    await visit(page, `${settings()}/secrets/actions/new`);
    await page.getByLabel("Name").fill("BIGGER");
    await setValue(page, "Value", `${value}x`);
    await page.getByRole("button", { name: "Save secret" }).click();
    await see(page.getByRole("alert")).toContainText("At most 48 KiB");
    const listed = await ok<{ secrets: { name: string }[] }>(
      "GET",
      `/repos/${handle}/${name}/actions/secrets`,
    );
    expect(listed.secrets.map((s) => s.name).sort()).toEqual(["BIG", "DEPLOY_KEY"]);
  });

  it("updates a secret, then deletes it once its name is typed", async () => {
    await visit(page, `${settings()}/secrets/actions`);
    await page.getByRole("link", { name: "DEPLOY_KEY" }).click();
    await see(page.getByRole("heading", { name: "Secret DEPLOY_KEY" })).toBeVisible();
    await accessible("repository secret");
    await page.getByLabel("Value").fill(`${CANARY}-2`);
    await page.getByRole("button", { name: "Save secret" }).click();
    await see(page.getByRole("status")).toHaveText("Updated the secret DEPLOY_KEY.");

    await visit(page, `${settings()}/secrets/actions/DEPLOY_KEY/edit`);
    await page.getByRole("button", { name: "Delete secret" }).click();
    await see(page.getByRole("alert")).toContainText("Type DEPLOY_KEY to delete it.");
    await accessible("repository secret, delete refused");
    await page.getByLabel("Type DEPLOY_KEY to confirm").fill("DEPLOY_KEY");
    await page.getByRole("button", { name: "Delete secret" }).click();
    await see(page.getByRole("status")).toHaveText("Deleted the secret DEPLOY_KEY.");
    const listed = await ok<{ secrets: { name: string }[] }>(
      "GET",
      `/repos/${handle}/${name}/actions/secrets`,
    );
    expect(listed.secrets.map((s) => s.name)).toEqual(["BIG"]);
  });
});

describe("repository variables", () => {
  it("stores typed line breaks as \\n, updates and deletes a variable", async () => {
    await visit(page, `${settings()}/variables/actions`);
    await accessible("repository variables, empty");
    await page.getByRole("link", { name: "New variable" }).click();
    await page.getByLabel("Name").fill("region");
    await page.getByLabel("Value").fill("eu\nwest\n");
    await page.getByRole("button", { name: "Save variable" }).click();
    await see(page.getByRole("status")).toHaveText("Created the variable REGION.");
    const made = await ok<{ value: string }>(
      "GET",
      `/repos/${handle}/${name}/actions/variables/REGION`,
    );
    expect(made.value).toBe("eu\nwest\n");
    await accessible("repository variables");

    await page.getByRole("link", { name: "REGION" }).click();
    await see(page.getByLabel("Value")).toHaveValue("eu\nwest\n");
    await accessible("repository variable");
    await page.getByLabel("Value").fill("us");
    await page.getByRole("button", { name: "Save variable" }).click();
    await see(page.getByRole("status")).toHaveText("Updated the variable REGION.");

    await visit(page, `${settings()}/variables/actions/REGION/edit`);
    await page.getByLabel("Type REGION to confirm").fill("region");
    await page.getByRole("button", { name: "Delete variable" }).click();
    await see(page.getByRole("status")).toHaveText("Deleted the variable REGION.");
  });

  it("lists a full page of worst-case values, escaped", async () => {
    // 49,152 control characters: 294,912 bytes of JSON each, the most a page has to read.
    const worst = "\u0001".repeat(49_152);
    for (let i = 0; i < 7; i++)
      await ok("POST", `/repos/${handle}/${name}/actions/variables`, {
        name: `WORST_${i}`,
        value: worst,
      });
    await visit(page, `${settings()}/variables/actions`);
    await see(page.getByRole("link", { name: "WORST_0" })).toBeVisible();
    await see(page.getByText("7 variables")).toBeVisible();
    await page.getByRole("link", { name: "Next page" }).click();
    await see(page.getByRole("link", { name: "WORST_6" })).toBeVisible();
    for (let i = 0; i < 7; i++)
      await ok("DELETE", `/repos/${handle}/${name}/actions/variables/WORST_${i}`);
  });
});

describe("without JavaScript", () => {
  it("creates a secret and a variable, line breaks stored as \\n", async () => {
    const plain = await withoutScript();
    try {
      await plain.goto(`${settings()}/secrets/actions/new`);
      await plain.getByLabel("Name").fill("PLAIN");
      await plain.getByLabel("Value").fill(`${CANARY}\nplain`);
      await plain.getByRole("button", { name: "Save secret" }).click();
      await see(plain.getByRole("status")).toHaveText("Created the secret PLAIN.");

      await plain.goto(`${settings()}/variables/actions/new`);
      await plain.getByLabel("Name").fill("PLAIN");
      await plain.getByLabel("Value").fill("a\nb");
      await plain.getByRole("button", { name: "Save variable" }).click();
      await see(plain.getByRole("status")).toHaveText("Created the variable PLAIN.");
      const made = await ok<{ value: string }>(
        "GET",
        `/repos/${handle}/${name}/actions/variables/PLAIN`,
      );
      expect(made.value).toBe("a\nb");
    } finally {
      await close(plain);
    }
  });
});

describe("who may manage them", () => {
  it("gives a writer no settings entry, no list and no form", async () => {
    const token = await userToken("bo");
    await ok("PUT", `/repos/${handle}/${name}/collaborators/bo`, { permission: "push" });
    const theirs = await signedIn(token);
    try {
      await visit(theirs, `${settings()}`);
      const nav = theirs.getByRole("navigation", { name: "Repository settings" });
      await see(nav.getByRole("link", { name: "General" })).toBeVisible();
      await see(nav.getByRole("link", { name: "Secrets" })).toHaveCount(0);
      for (const path of ["secrets/actions", "secrets/actions/new", "variables/actions/new"]) {
        const response = await theirs.goto(`${settings()}/${path}`);
        expect(response?.status(), path).toBe(404);
        await see(theirs.getByLabel("Value")).toHaveCount(0);
      }
    } finally {
      await close(theirs);
    }
  });
});

describe("the secret's value", () => {
  it("never came back to the browser", async () => {
    const texts = received;
    // The secret pages' own answers were read: the actions' (a data request's redirect is a
    // 202, a plain form's a 302) and the lists after them, the page without JavaScript's too.
    const read = (pattern: RegExp) => texts.some((t) => pattern.test(t.split("\n")[0] ?? ""));
    expect(read(/^202 .*\/settings\/secrets\/actions\/new\.data$/)).toBe(true);
    expect(read(/^302 .*\/settings\/secrets\/actions\/new$/)).toBe(true);
    expect(read(/^200 .*\/settings\/secrets\/actions\.data\?created=DEPLOY_KEY$/)).toBe(true);
    expect(read(/^200 .*\/settings\/secrets\/actions\?created=PLAIN$/)).toBe(true);
    expect(texts.filter((t) => t.includes(CANARY))).toEqual([]);
  });
});
