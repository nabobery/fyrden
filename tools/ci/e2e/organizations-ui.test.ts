// Needs `pnpm --filter @fyrden/web build` first (turbo does it).
import { type Locator, type Page, expect as see } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accessibleInEveryTheme, startWebStack, visit, type WebStack } from "./web-stack.js";

let stack: WebStack;
let page: Page;
const PAGES = ["Secrets", "Variables", "Runners"];

async function ok<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${stack.origin}/api${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${stack.token}`,
      ...(method !== "GET" && {
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

async function signedInAs(login: string) {
  const user = await ok<{ id: string }>("POST", "/admin/users", { handle: login });
  const { token } = await ok<{ token: string }>("POST", `/admin/users/${user.id}/tokens`, {
    type: "pat",
    scopes: [],
    expires_in_days: 1,
  });
  const context = await page.context().browser()?.newContext();
  if (!context) throw new Error("no browser");
  const theirs = await context.newPage();
  await theirs.goto(`${stack.origin}/auth/sign-in?return_to=%2F`);
  await theirs.getByLabel(/personal access token/i).fill(token);
  await theirs.getByRole("button", { name: "Sign in with the token" }).click();
  await theirs.getByRole("button", { name: "Not now" }).click();
  await see(theirs).toHaveURL(`${stack.origin}/`);
  return { page: theirs, close: () => context.close() };
}

const siteLink = (on: Page) =>
  on.getByRole("navigation", { name: "Site" }).getByRole("link", { name: "Organizations" });
const row = (on: Page, org: string) =>
  on.getByRole("row").filter({ has: on.getByRole("rowheader", { name: org, exact: true }) });

async function tabTo(on: Page, target: Locator): Promise<void> {
  for (let presses = 0; presses < 40; presses++) {
    await on.keyboard.press("Tab");
    if ((await target.and(on.locator(":focus")).count()) > 0) return;
  }
  throw new Error("no Tab reaches it");
}

beforeAll(async () => {
  stack = await startWebStack("ada", {
    vars: { FYRDEN_CI_RUNNERS: "on", FYRDEN_CI_FLEET: "100" },
  });
  page = stack.page;
}, 180_000);

afterAll(async () => {
  await stack?.stop();
});

describe("the viewer's organizations", () => {
  it("are none at first", async () => {
    await visit(page, `${stack.origin}/`);
    await siteLink(page).click();
    await see(page).toHaveURL(`${stack.origin}/settings/organizations`);
    await see(page.getByRole("heading", { name: "Your organizations" })).toBeVisible();
    await see(page.getByText("You are not a member of any organization.")).toBeVisible();
    await accessibleInEveryTheme(page, "organizations, none");
  });

  it("lead an owner of no repository to each settings page, by keyboard", async () => {
    await ok("POST", "/admin/organizations", { login: "acme", admin: "ada" });
    for (const name of PAGES) {
      await visit(page, `${stack.origin}/`);
      const nav = siteLink(page);
      await tabTo(page, nav);
      await page.keyboard.press("Enter");
      await see(row(page, "acme").getByRole("cell", { name: "Owner" })).toBeVisible();
      const link = page.getByRole("link", { name: `acme: ${name}` });
      await tabTo(page, link);
      await page.keyboard.press("Enter");
      await see(
        page
          .getByRole("navigation", { name: "Organization settings" })
          .getByRole("link", { name, exact: true }),
      ).toHaveAttribute("aria-current", "page");
      await see(page.getByRole("heading", { name: "acme", level: 1 })).toBeVisible();
    }
    await visit(page, `${stack.origin}/settings/organizations`);
    await accessibleInEveryTheme(page, "organizations, an owner's");
  });

  it("fit a phone's width, however long a name is", async () => {
    const longest = "w".repeat(39);
    await ok("POST", "/admin/organizations", { login: longest, admin: "ada" });
    const before = page.viewportSize();
    await page.setViewportSize({ width: 375, height: 800 });
    try {
      await visit(page, `${stack.origin}/settings/organizations`);
      await see(row(page, longest)).toBeVisible();
      expect(await page.locator("html").evaluate((html) => html.scrollWidth)).toBe(375);
      await accessibleInEveryTheme(page, "organizations, a phone's");
    } finally {
      if (before) await page.setViewportSize(before);
    }
  });

  it("lead there without JavaScript", async () => {
    const context = await page
      .context()
      .browser()
      ?.newContext({ javaScriptEnabled: false, storageState: await page.context().storageState() });
    if (!context) throw new Error("no browser");
    try {
      const plain = await context.newPage();
      for (const name of PAGES) {
        await plain.goto(`${stack.origin}/`);
        await siteLink(plain).click();
        await plain.getByRole("link", { name: `acme: ${name}` }).click();
        await see(
          plain
            .getByRole("navigation", { name: "Organization settings" })
            .getByRole("link", { name, exact: true }),
        ).toHaveAttribute("aria-current", "page");
      }
    } finally {
      await context.close();
    }
  });

  it("show a member their role and no settings page, and go when they are removed", async () => {
    const cy = await signedInAs("cy");
    try {
      await ok("PUT", "/orgs/acme/memberships/cy", { role: "member" });
      await siteLink(cy.page).click();
      await see(row(cy.page, "acme").getByRole("cell", { name: "Member" })).toBeVisible();
      await see(cy.page.getByRole("main").getByRole("link")).toHaveCount(0);
      await accessibleInEveryTheme(cy.page, "organizations, a member's");
      await ok("DELETE", "/orgs/acme/memberships/cy");
      await visit(cy.page, `${stack.origin}/settings/organizations`);
      await see(cy.page.getByText("You are not a member of any organization.")).toBeVisible();
    } finally {
      await cy.close();
    }
  });

  it("ask someone signed out to sign in", async () => {
    const context = await page.context().browser()?.newContext();
    if (!context) throw new Error("no browser");
    try {
      const anyone = await context.newPage();
      await anyone.goto(`${stack.origin}/settings/organizations`);
      await see(anyone).toHaveURL(/\/auth\/sign-in\?return_to=%2Fsettings%2Forganizations/);
      await anyone.goto(`${stack.origin}/`);
      await see(siteLink(anyone)).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});
