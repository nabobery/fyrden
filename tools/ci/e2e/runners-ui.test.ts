// An organization's runner settings, in a real browser against both
// Workers: an owner makes a registration token (shown once), sees the
// runner it registers, changes which jobs the runner takes with and
// without JavaScript, and deletes it; a member and a repository's admin
// get no page; and no registration token reaches the Workers' logs. Every
// page is checked with axe for WCAG 2.x A and AA. Needs
// `pnpm --filter @fyrden/web build` first (turbo does it).
import { type Page, expect as see } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  decodeRunnerResponse,
  encodeDeclareRequest,
  encodeRegisterRequest,
} from "../../../apps/api/test/helpers/runner-proto.js";
import { accessible as axe, startWebStack, visit, type WebStack } from "./web-stack.js";

let stack: WebStack;
let page: Page;
const org = "acme";
const base = () => `${stack.origin}/settings/orgs/${org}/runners`;
const accessible = (what: string) => axe(page, what);
const tokens: string[] = [];
/** A status `on` reads out with `text` in it (a change to a list has two). */
const says = (on: Page, text: string) =>
  see(on.getByRole("status").filter({ hasText: text })).toBeVisible();

async function ok<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${stack.origin}/api${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${stack.token}`,
      ...(body !== undefined && {
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  expect(res.status, `${method} ${path}: ${text}`).toBeLessThan(300);
  return (text ? JSON.parse(text) : undefined) as T;
}

/** Registers and starts a runner as the pinned runner does; its credentials stay here. */
async function register(token: string, name: string, ephemeral: boolean): Promise<void> {
  const call = (method: string, body: Uint8Array, credentials: Record<string, string> = {}) =>
    fetch(`${stack.origin}/api/actions/runner.v1.RunnerService/${method}`, {
      method: "POST",
      headers: {
        "content-type": "application/proto",
        "connect-protocol-version": "1",
        ...credentials,
      },
      body: Buffer.from(body),
    });
  const registered = await call(
    "Register",
    encodeRegisterRequest({
      name,
      token,
      agentLabels: [],
      customLabels: [],
      version: "v6.0.0",
      labels: ["ubuntu-latest"],
      ephemeral,
      capabilities: [],
    }),
  );
  expect(registered.status).toBe(200);
  const { runner } = decodeRunnerResponse(new Uint8Array(await registered.arrayBuffer()));
  if (!runner) throw new Error("no runner");
  tokens.push(runner.token);
  const declared = await call(
    "Declare",
    encodeDeclareRequest({ version: "v6.0.0", labels: ["ubuntu-latest"], capabilities: [] }),
    { "x-runner-uuid": runner.uuid, "x-runner-token": runner.token },
  );
  expect(declared.status).toBe(200);
}

/** The registration token the page shows. */
async function shownToken(on: Page): Promise<string> {
  const text = (await on.locator("pre.secret").first().textContent()) ?? "";
  const token = /--token (fyrden_run_\S+)/.exec(text)?.[1];
  if (!token) throw new Error("no token on the page");
  tokens.push(token);
  return token;
}

async function userToken(login: string): Promise<string> {
  const user = await ok<{ id: string }>("POST", "/admin/users", { handle: login });
  const made = await ok<{ token: string }>("POST", `/admin/users/${user.id}/tokens`, {
    type: "pat",
    scopes: [],
    expires_in_days: 1,
  });
  return made.token;
}

beforeAll(async () => {
  stack = await startWebStack("ada", {
    vars: { FYRDEN_CI_RUNNERS: "on", FYRDEN_CI_FLEET: "100" },
  });
  page = stack.page;
  await ok("POST", "/admin/organizations", { login: org, admin: "ada" });
  await ok("POST", `/orgs/${org}/repos`, { name: "web" });
  await ok("POST", `/orgs/${org}/repos`, { name: "app" });
}, 180_000);

afterAll(async () => {
  await stack?.stop();
  const leaked = tokens.filter((t) => stack.workerLines().some((line) => line.includes(t)));
  expect(leaked).toHaveLength(0);
});

describe("runner settings", () => {
  it("are reached from the organization's settings, empty at first", async () => {
    await visit(page, `${stack.origin}/settings/orgs/${org}/secrets/actions`);
    await page
      .getByRole("navigation", { name: "Organization settings" })
      .getByRole("link", { name: "Runners" })
      .click();
    await see(page.getByRole("heading", { name: "Self-hosted runners" })).toBeVisible();
    await see(page.getByText("No runners.")).toBeVisible();
    await accessible("runners, empty");
  });

  it("make a registration token with access, shown once", async () => {
    await page.getByRole("link", { name: "New runner" }).click();
    await see(page.getByLabel("All repositories")).toBeChecked();
    await see(page.getByLabel("Allow public repositories")).not.toBeChecked();
    await see(page.getByLabel("Allow pull requests from forks")).not.toBeChecked();
    await accessible("new runner");
    await page.getByLabel("Selected repositories").check();
    await page.getByLabel("Repository names, if selected").fill("web\nnope");
    await page.getByLabel("Allow pull requests from forks").check();
    await page.getByRole("button", { name: "Create registration token" }).click();
    await see(page.getByRole("alert")).toContainText("nope: not a repository");
    await see(page.getByLabel("Repository names, if selected")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    await accessible("new runner, refused");
    await page.getByLabel("Repository names, if selected").fill("web");
    await page.getByRole("button", { name: "Create registration token" }).click();
    await see(page.getByRole("heading", { name: "Register the runner" })).toBeVisible();
    await see(page.locator("pre.secret")).toHaveCount(1);
    await see(page.locator("pre.secret")).toContainText("--ephemeral");
    await accessible("new runner, token");
    await register(await shownToken(page), "fork-runner", true);
    await visit(page, `${base()}/new`);
    await see(page.locator("pre.secret")).toHaveCount(0);
  });

  it("show what the runner takes, and list it", async () => {
    await visit(page, base());
    const row = page.getByRole("row", { name: /fork-runner/ });
    await see(row).toContainText("Ephemeral");
    await see(row).toContainText("1 repository, fork pull requests");
    await accessible("runners");
    await page.getByRole("link", { name: "fork-runner" }).click();
    await see(page.getByRole("heading", { name: "Runner fork-runner" })).toBeVisible();
    await see(page.getByRole("button", { name: `Remove ${org}/web` })).toBeVisible();
    await accessible("ephemeral runner, selected");
  });

  it("change a runner's access, saying when it counts", async () => {
    await page.getByLabel("Allow public repositories").check();
    await page.getByRole("button", { name: "Save access" }).click();
    await says(page, "within five minutes");
    await see(page.getByLabel("Allow public repositories")).toBeChecked();
    await accessible("runner, access changed");
    await page.getByLabel("Add repository").fill("app");
    await page.getByRole("button", { name: "Add repository" }).click();
    await says(page, "Added app.");
    await says(page, "within five minutes");
    await page.getByRole("button", { name: `Remove ${org}/web` }).click();
    await says(page, "Removed web.");
    await page.getByLabel("All repositories").check();
    await page.getByLabel("Allow public repositories").uncheck();
    await page.getByRole("button", { name: "Save access" }).click();
    await says(page, "within five minutes");
    await see(page.getByRole("heading", { name: "Selected repositories" })).toHaveCount(0);
    const { runners } = await ok<{ runners: Record<string, unknown>[] }>(
      "GET",
      `/orgs/${org}/actions/runners?status=serving`,
    );
    expect(runners).toMatchObject([
      {
        name: "fork-runner",
        repository_access: "all",
        allows_public: false,
        allows_forks: true,
        selected_count: 0,
      },
    ]);
  });

  it("work without JavaScript, and offer no fork access to a long-lived runner", async () => {
    const browser = page.context().browser();
    if (!browser) throw new Error("no browser");
    const context = await browser.newContext({
      javaScriptEnabled: false,
      storageState: await page.context().storageState(),
    });
    const plain = await context.newPage();
    try {
      await plain.goto(`${base()}/new`);
      await plain.getByRole("button", { name: "Create registration token" }).click();
      await see(plain.locator("pre.secret")).toHaveCount(2);
      await register(await shownToken(plain), "long-runner", false);
      await plain.goto(base());
      await plain.getByRole("link", { name: "long-runner" }).click();
      await see(plain.getByLabel("Allow pull requests from forks")).toHaveCount(0);
      await see(plain.getByText("need an ephemeral runner")).toBeVisible();
      await plain.getByLabel("Selected repositories").check();
      await plain.getByRole("button", { name: "Save access" }).click();
      await says(plain, "from the next job");
      await plain.getByLabel("Add repository").fill("web");
      await plain.getByRole("button", { name: "Add repository" }).click();
      await says(plain, "Added web.");
      await visit(page, plain.url());
      await accessible("long-lived runner");
    } finally {
      await context.close();
    }
  });

  it("cancel unused tokens, which then register nothing", async () => {
    const { token } = await ok<{ token: string }>(
      "POST",
      `/orgs/${org}/actions/runners/registration-token`,
      {},
    );
    tokens.push(token);
    const back = page.url();
    await visit(page, base());
    await page.getByRole("button", { name: "Cancel unused tokens" }).click();
    await says(page, "Cancelled 1 unused token.");
    await accessible("runners, tokens cancelled");
    await expect(register(token, "never", false)).rejects.toThrow();
    await visit(page, back);
  });

  it("delete a runner once its name is typed, and keep it among past ones", async () => {
    await page.getByLabel("Type long-runner to confirm").fill("long");
    await page.getByRole("button", { name: "Delete runner" }).click();
    await see(page.getByRole("alert")).toContainText("Type long-runner");
    await accessible("runner, delete refused");
    await page.getByLabel("Type long-runner to confirm").fill("long-runner");
    await page.getByRole("button", { name: "Delete runner" }).click();
    await says(page, "Deleted the runner long-runner.");
    await see(page.getByRole("link", { name: "long-runner" })).toHaveCount(0);
    await page.getByRole("link", { name: "Past runners" }).click();
    await page.getByRole("link", { name: "long-runner" }).click();
    await see(page.getByText("Deleted", { exact: true })).toBeVisible();
    await see(page.getByRole("button", { name: "Save access" })).toHaveCount(0);
    await accessible("past runner");
    await visit(page, `${base()}?show=revoked`);
    await accessible("past runners");
  });

  it("give a member, and a repository's admin, no page", async () => {
    const token = await userToken("cy");
    await ok("PUT", `/orgs/${org}/memberships/cy`, { role: "member" });
    await ok("PUT", `/repos/${org}/web/collaborators/cy`, { permission: "admin" });
    const browser = page.context().browser();
    if (!browser) throw new Error("no browser");
    const context = await browser.newContext();
    const theirs = await context.newPage();
    try {
      await theirs.goto(`${stack.origin}/auth/sign-in?return_to=%2F`);
      await theirs.getByLabel(/personal access token/i).fill(token);
      await theirs.getByRole("button", { name: "Sign in with the token" }).click();
      await theirs.getByRole("button", { name: "Not now" }).click();
      await see(theirs).toHaveURL(`${stack.origin}/`);
      const { runners } = await ok<{ runners: { id: number }[] }>(
        "GET",
        `/orgs/${org}/actions/runners?status=serving`,
      );
      for (const path of ["", "/new", `/${runners[0]?.id}`]) {
        const response = await theirs.goto(`${base()}${path}`);
        expect(response?.status(), path).toBe(403);
        await see(theirs.getByRole("button", { name: /token|access|Delete/ })).toHaveCount(0);
      }
      const notAnOrg = await theirs.goto(`${stack.origin}/settings/orgs/ada/runners`);
      expect(notAnOrg?.status()).toBe(404);
    } finally {
      await context.close();
    }
  });
});
