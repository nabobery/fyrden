// The inbox and how one hears of a repository or a thread, in a real
// browser against both Workers: the inbox opens from the header and its
// digests from its tabs, a repository is watched and the choice read
// back, a thread unsubscribed and read back, each page checked with axe
// for WCAG 2.x A and AA. Needs `pnpm --filter @fyrden/web build` first
// (turbo does it).
import { type Page, expect as see } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accessible as axe, startWebStack, visit, type WebStack } from "./web-stack.js";

let stack: WebStack;
let page: Page;
const handle = "ada";
const name = "inbox";
/** A title that is markup wherever it lands unescaped. */
const HOSTILE = "<img src=x onerror=window.pwned=1> crash";

const accessible = (what: string) => axe(page, what);

async function rest<T>(
  method: string,
  path: string,
  body?: unknown,
  token = stack.token,
): Promise<T> {
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
  expect(res.ok, `${method} ${path}: ${text}`).toBe(true);
  return (text ? JSON.parse(text) : undefined) as T;
}

beforeAll(async () => {
  stack = await startWebStack(handle);
  page = stack.page;
  await rest("POST", "/user/repos", { name });
  await rest("POST", `/repos/${handle}/${name}/issues`, { title: HOSTILE });
}, 180_000);

afterAll(async () => {
  await stack?.stop();
});

describe("the inbox and notification choices", () => {
  it("opens the inbox from the header", async () => {
    await visit(page, `${stack.origin}/`);
    await page.getByRole("link", { name: "Inbox", exact: true }).click();
    await see(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
    await see(page.getByText("Nothing here.")).toBeVisible();
    await page.getByRole("link", { name: "All" }).click();
    await see(page.getByRole("link", { name: "All" })).toHaveAttribute("aria-current", "page");
    await accessible("inbox");
  });

  it("opens the digests of watched repositories, and says when a digest no longer shows", async () => {
    await visit(page, `${stack.origin}/notifications`);
    await page.getByRole("link", { name: "Digests" }).click();
    await see(page.getByRole("link", { name: "Digests" })).toHaveAttribute("aria-current", "page");
    await see(page.getByText("Nothing here.")).toBeVisible();
    await accessible("digests");
    const { id } = await rest<{ id: string }>("GET", `/repos/${handle}/${name}`);
    await visit(page, `${stack.origin}/notifications/digests/${id}/issue/1992491/1`);
    await see(page.getByText("This digest no longer shows")).toBeVisible();
    await accessible("a digest no longer shown");
  });

  it("shows a thread another person notified it of, inert, opens it, and marks it read and done", async () => {
    const bo = await rest<{ id: string }>("POST", "/admin/users", { handle: "bo" });
    const { token } = await rest<{ token: string }>("POST", `/admin/users/${bo.id}/tokens`, {
      type: "pat",
      scopes: [],
      expires_in_days: 1,
    });
    await rest("PUT", `/repos/${handle}/${name}/collaborators/bo`, { permission: "push" });
    await rest(
      "POST",
      `/repos/${handle}/${name}/issues/1/comments`,
      { body: `@${handle} have a look` },
      token,
    );
    // Delivered through the events queue to ada's feed.
    await expect
      .poll(
        async () =>
          (await rest<{ notifications: unknown[] }>("GET", "/notifications")).notifications.length,
        { timeout: 60_000, interval: 500 },
      )
      .toBe(1);
    await visit(page, `${stack.origin}/notifications`);
    const row = page.getByRole("listitem").filter({ hasText: "crash" });
    await see(row.getByText("Mentioned")).toBeVisible();
    expect(await page.evaluate(() => (globalThis as { pwned?: unknown }).pwned)).toBeUndefined();
    await accessible("inbox with a thread");
    await row.getByRole("link", { name: /crash/ }).click();
    await see(page).toHaveURL(`${stack.origin}/${handle}/${name}/issues/1`);
    await visit(page, `${stack.origin}/notifications`);
    await page.getByRole("button", { name: /^Mark read:/ }).click();
    await see(page.getByRole("status")).toHaveText("Marked read.");
    await see(page.getByText("Nothing here.")).toBeVisible();
    await visit(page, `${stack.origin}/notifications?tab=all`);
    await page.getByRole("button", { name: /^Done:/ }).click();
    await see(page.getByRole("status")).toContainText("Marked done");
    await see(page.getByText("Nothing here.")).toBeVisible();
  });

  it("watches a repository, and reads the choice back", async () => {
    await visit(page, `${stack.origin}/${handle}/${name}`);
    await page.getByRole("link", { name: "Watch" }).click();
    await see(page.getByLabel("Participating")).toBeChecked();
    await page.getByLabel("Watching").check();
    await page.getByRole("button", { name: "Save" }).click();
    await see(page.getByRole("status")).toHaveText("Saved.");
    await visit(page, `${stack.origin}/${handle}/${name}/watching`);
    await see(page.getByLabel("Watching")).toBeChecked();
    await accessible("watching");
  });

  it("unsubscribes from a thread with a hostile title, inert, and reads it back", async () => {
    await visit(page, `${stack.origin}/${handle}/${name}/issues/1`);
    await page.getByRole("link", { name: "How you hear of it" }).click();
    await see(page.getByRole("heading", { name: /crash/ })).toBeVisible();
    await page.getByLabel("Unsubscribed").check();
    await page.getByRole("button", { name: "Save" }).click();
    await see(page.getByRole("status")).toHaveText("Saved.");
    await visit(page, `${stack.origin}/${handle}/${name}/issues/1/subscription`);
    await see(page.getByLabel("Unsubscribed")).toBeChecked();
    expect(await page.evaluate(() => (globalThis as { pwned?: unknown }).pwned)).toBeUndefined();
    await accessible("thread notifications");
  });
});
