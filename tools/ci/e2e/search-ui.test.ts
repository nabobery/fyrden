// The search page in a real browser (Chromium through Playwright) against
// both Workers under one wrangler dev: the header's search box opens it,
// a query with no scope asks for one before anything is searched, the
// scope chosen beside the query is searched from the first page (the form
// works without scripts too), and the API's refusals are shown beside the
// controls that made them. Search indexing stays off here, so every search
// answers no results that may be incomplete: results themselves are the
// route tests' (apps/web/test/routes.search.test.tsx), since nothing tells
// a test when the events projected into search have arrived. Six searches
// in all, within the API's ten a minute. Every page it visits is checked
// with axe for WCAG 2.x A and AA. Needs `pnpm --filter @fyrden/web build`
// first (turbo does it).
import { type Page, expect as see } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accessible as axe, startWebStack, visit, type WebStack } from "./web-stack.js";

let stack: WebStack;
let page: Page;
const handle = "ada";
const name = "forge";

const accessible = (what: string) => axe(page, what);

beforeAll(async () => {
  stack = await startWebStack(handle);
  page = stack.page;
  const res = await fetch(`${stack.origin}/api/user/repos`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${stack.token}`,
      "Content-Type": "application/json",
      "Idempotency-Key": crypto.randomUUID(),
    },
    body: JSON.stringify({ name }),
  });
  expect(res.status, await res.text()).toBe(201);
}, 180_000);

afterAll(async () => {
  await stack?.stop();
});

const headerBox = () =>
  page.getByRole("searchbox", { name: "Search issues, pull requests and repositories" });
const query = () => page.getByRole("searchbox", { name: "Query" });

describe("search in the web UI", () => {
  it("opens from the header's box and asks for a scope before searching", async () => {
    await visit(page, `${stack.origin}/`);
    await headerBox().fill("lantern");
    await headerBox().press("Enter");
    await see(page).toHaveURL(`${stack.origin}/search?q=lantern`);
    await see(page.getByRole("alert")).toContainText("Choose where to search");
    await see(query()).toHaveValue("lantern");
    await accessible("search page asking for a scope");
  });

  it("searches the scope chosen beside the query, from the first page", async () => {
    await page.getByLabel("Scope", { exact: true }).selectOption("repo");
    await page.getByLabel("Repository (owner/name) or handle").fill(`${handle}/${name}`);
    await page.getByLabel("Results a page").fill("10");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await see(page).toHaveURL(/scope=repo&scope_value=ada%2Fforge/);
    expect(new URL(page.url()).searchParams.get("per_page")).toBe("10");
    expect(new URL(page.url()).searchParams.has("page")).toBe(false);
    await see(page.getByRole("status")).toHaveText("No results.");
    // Indexing is off: the API says results may be missing, and the page says so.
    await see(page.getByText("Results may be missing")).toBeVisible();
    await see(query()).toHaveValue("lantern");
    await accessible("search results that may be incomplete");
  });

  it("starts again from the first page when the form is sent, without scripts", async () => {
    const context = await page
      .context()
      .browser()
      ?.newContext({ javaScriptEnabled: false, storageState: await page.context().storageState() });
    if (!context) throw new Error("no browser");
    try {
      const plain = await context.newPage();
      await plain.goto(
        `${stack.origin}/search?q=lantern&type=issues&scope=repo&scope_value=ada%2Fforge&page=3&per_page=10`,
      );
      await see(plain.getByRole("link", { name: "Previous page" })).toHaveAttribute(
        "href",
        /page=2&per_page=10/,
      );
      await plain.getByRole("searchbox", { name: "Query" }).fill("lantern dims");
      await plain.getByRole("button", { name: "Search", exact: true }).click();
      await see(plain).toHaveURL(/q=lantern\+dims/);
      const url = new URL(plain.url());
      expect(url.searchParams.has("page")).toBe(false);
      expect(url.searchParams.get("scope_value")).toBe("ada/forge");
      await see(plain.getByRole("status")).toHaveText("No results.");
    } finally {
      await context.close();
    }
  });

  it("shows each refusal beside the controls that made it", async () => {
    await visit(page, `${stack.origin}/`);
    await headerBox().fill(`lantern repo:${handle}/missing`);
    await headerBox().press("Enter");
    await see(page.getByRole("alert")).toHaveText("No such repository, or you cannot read it.");
    await see(query()).toHaveValue(`lantern repo:${handle}/missing`);
    await accessible("refused search");
    await visit(
      page,
      `${stack.origin}/search?q=&type=repositories&scope=user&scope_value=${handle}`,
    );
    await see(page.getByRole("alert")).toContainText("needs words to match");
    await see(page.getByLabel("Search for")).toHaveValue("repositories");
    await visit(page, `${stack.origin}/search?q=${encodeURIComponent("日本 repo:ada/forge")}`);
    await see(page.getByRole("alert")).toContainText("text search cannot match");
    // A scope value not of its kind's shape is refused before any search.
    await page.getByLabel("Scope", { exact: true }).selectOption("repo");
    await page.getByLabel("Repository (owner/name) or handle").fill(`${handle} org:other`);
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await see(page.getByRole("alert")).toHaveText("The scope must be a repository as owner/name.");
    expect(stack.refused).toEqual([]);
  });
});
