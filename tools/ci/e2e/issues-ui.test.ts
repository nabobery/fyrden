// Issues in a real browser (Chromium through Playwright) against both
// Workers under one wrangler dev: a person opens an issue with a hostile
// title and body (inert), comments, edits the description, filters the
// list, closes it as not planned and reopens it; an edit made from a page
// someone else changed since is refused with the text kept. Every page it
// visits is checked with axe for WCAG 2.x A and AA. Needs `pnpm --filter
// @fyrden/web build` first (turbo does it).
import { type Page, type Route, expect as see } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accessible as axe, reload, startWebStack, visit, type WebStack } from "./web-stack.js";

let stack: WebStack;
let page: Page;
const handle = "ada";
const name = "issues";
/** A title that is markup wherever it lands unescaped. */
const HOSTILE = "<img src=x onerror=window.pwned=1> crash";

const accessible = (what: string) => axe(page, what);

async function rest<T>(method: string, path: string, body?: unknown): Promise<T> {
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
  expect(res.ok, `${method} ${path}: ${text}`).toBe(true);
  return (text ? JSON.parse(text) : undefined) as T;
}

beforeAll(async () => {
  stack = await startWebStack(handle);
  page = stack.page;
  await rest("POST", "/user/repos", { name });
}, 180_000);

afterAll(async () => {
  await stack?.stop();
});

describe("issues in the web UI", () => {
  it("opens an issue with a hostile title, inert, and shows it", async () => {
    await visit(page, `${stack.origin}/${handle}/${name}/issues`);
    await see(page.getByText("No open issues.")).toBeVisible();
    await accessible("empty issue list");
    await page.getByText("New issue").click();
    await page.getByLabel("Title").fill(HOSTILE);
    await page.getByLabel("Description (Markdown, optional)").fill(`**bold** ${HOSTILE}`);
    await accessible("new issue form");
    await page.getByRole("button", { name: "Open issue" }).click();
    await see(page).toHaveURL(`${stack.origin}/${handle}/${name}/issues/1`);
    await see(page.getByRole("heading", { name: /crash/ })).toBeVisible();
    await see(page.locator(".markdown strong")).toHaveText("bold");
    expect(await page.evaluate(() => (globalThis as { pwned?: unknown }).pwned)).toBeUndefined();
    await accessible("issue page");
  });

  it("comments, edits the description, and keeps an edit refused as stale", async () => {
    await page.getByLabel("Comment (Markdown)", { exact: true }).fill("First comment");
    await page.getByRole("button", { name: "Comment", exact: true }).click();
    await see(page.getByRole("status")).toHaveText("Comment added.");
    await see(page.locator(".timeline .markdown").getByText("First comment")).toBeVisible();
    // Someone else edits it after the page was shown; this page's edit is then refused.
    await page.getByText("Edit title and description").click();
    await rest("PATCH", `/repos/${handle}/${name}/issues/1`, { body: "changed elsewhere" });
    await page.getByLabel("Description (Markdown)").fill("my edit");
    // Another form sent meanwhile reads the page again: the editor keeps the version it opened at.
    await page.locator("#comment-body").fill("Second comment");
    await page.getByRole("button", { name: "Comment", exact: true }).click();
    await see(page.getByRole("status")).toHaveText("Comment added.");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await see(page.getByRole("alert")).toContainText("Someone changed it");
    await see(page.getByLabel("Description (Markdown)")).toHaveValue("my edit");
    await accessible("stale edit");
    // Read again, then saved.
    await reload(page);
    await see(page.locator(".markdown").getByText("changed elsewhere")).toBeVisible();
    await page.getByText("Edit title and description").click();
    await page.getByLabel("Description (Markdown)").fill("my edit");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await see(page.getByRole("status")).toHaveText("Saved.");
    await see(page.locator(".markdown").first()).toHaveText("my edit");
  });

  it("keeps each comment's editor to the version it opened at when another comment is saved", async () => {
    const [first, second] = await rest<{ id: number }[]>(
      "GET",
      `/repos/${handle}/${name}/issues/1/comments`,
    ).then((page) => (page as unknown as { comments: { id: number }[] }).comments);
    if (!first || !second) throw new Error("two comments expected");
    // Second's editor opened and written in; then someone else edits the second comment.
    const secondItem = page.locator(`#comment-${second.id}`);
    await secondItem.getByText("Edit or delete").click();
    await secondItem.locator("textarea").fill("my edit of the second");
    await rest("PATCH", `/repos/${handle}/${name}/issues/comments/${second.id}`, {
      body: "second, changed elsewhere",
    });
    // The first comment saved from this page: the page is read again.
    const firstItem = page.locator(`#comment-${first.id}`);
    await firstItem.getByText("Edit or delete").click();
    await firstItem.locator("textarea").fill("first, edited here");
    await firstItem.getByRole("button", { name: "Save comment" }).click();
    await see(page.getByRole("status")).toHaveText("Comment saved.");
    // The second's draft is still checked against what it was written from: refused.
    await secondItem.getByRole("button", { name: "Save comment" }).click();
    await see(page.getByRole("alert")).toContainText("Someone changed it");
  });

  it("clears the filter fields with the filters", async () => {
    await visit(page, `${stack.origin}/${handle}/${name}/issues`);
    await page.getByText("Filters").click();
    await page.getByLabel(/^Labels/).fill("bug");
    await page.getByRole("button", { name: "Filter" }).click();
    await see(page).toHaveURL(/labels=bug/);
    await page.getByRole("link", { name: "Clear filters" }).click();
    await see(page).not.toHaveURL(/labels=/);
    await page.getByText("Filters").click();
    await see(page.getByLabel(/^Labels/)).toHaveValue("");
    await visit(page, `${stack.origin}/${handle}/${name}/issues/1`);
  });

  it("closes it as not planned and reopens it; the list filters by state", async () => {
    await page.getByLabel("Not planned").check();
    await page.getByRole("button", { name: "Close issue" }).click();
    await see(page.getByText("Closed as not planned")).toBeVisible();
    await visit(page, `${stack.origin}/${handle}/${name}/issues`);
    await see(page.getByText("No open issues.")).toBeVisible();
    await page.getByRole("link", { name: "Closed", exact: true }).click();
    await see(page.getByRole("link", { name: /crash/ })).toBeVisible();
    await accessible("closed issues");
    await page.getByRole("link", { name: /crash/ }).click();
    await page.getByRole("button", { name: "Reopen issue" }).click();
    await see(page.getByRole("status")).toHaveText("Reopened.");
    // Reopening moved the issue's version: an edit started once the reopened issue is shown is
    // made from the new one.
    await see(page.getByRole("button", { name: "Close issue" })).toBeVisible();
    await page.getByText("Edit title and description").click();
    await page.getByLabel("Description (Markdown)").fill("edited after reopening");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await see(page.getByRole("status")).toHaveText("Saved.");
    expect(stack.refused).toEqual([]);
  });

  it("refuses an untouched editor sent twice against a changed issue, both times", async () => {
    await visit(page, `${stack.origin}/${handle}/${name}/issues/1`);
    await page.getByText("Edit title and description").click();
    await rest("PATCH", `/repos/${handle}/${name}/issues/1`, { body: "changed elsewhere again" });
    for (let i = 0; i < 2; i++) {
      // Each send answered before the next (the alert of the first must not stand for the second).
      await Promise.all([
        page.waitForResponse(
          (r) => r.request().method() === "POST" && r.url().includes("/issues/1"),
        ),
        page.getByRole("button", { name: "Save", exact: true }).click(),
      ]);
      await see(page.getByRole("alert")).toContainText("Someone changed it");
    }
    await reload(page);
    await see(page.locator(".markdown").getByText("changed elsewhere again")).toBeVisible();
  });

  it("follows the page again after its own save: save, close, reopen, then edit", async () => {
    await page.getByText("Edit title and description").click();
    await page.getByLabel("Description (Markdown)").fill("saved here");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await see(page.getByRole("status")).toHaveText("Saved.");
    await page.getByRole("button", { name: "Close issue" }).click();
    await see(page.getByRole("status")).toHaveText("Closed.");
    await page.getByRole("button", { name: "Reopen issue" }).click();
    await see(page.getByRole("status")).toHaveText("Reopened.");
    // The answer can show while the page is still read again: written before the reopened issue
    // is shown, an edit is from the closed one's version (and refused). Written once it is.
    await see(page.getByRole("button", { name: "Close issue" })).toBeVisible();
    await page.getByLabel("Description (Markdown)").fill("edited after my own changes");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await see(page.getByRole("status")).toHaveText("Saved.");
  });

  /**
   * Holds this page's next form post to `at` until the returned `release` is
   * called (then unroutes); `release.arrived` settles once that post is held.
   */
  async function holdNextPost(
    at = "issues/1",
    on: Page = page,
  ): Promise<(() => Promise<void>) & { arrived: Promise<void> }> {
    const pattern = `**/${handle}/${name}/${at}*`;
    let release = () => {};
    const held = new Promise<void>((done) => {
      release = done;
    });
    let arrive = () => {};
    const arrived = new Promise<void>((done) => {
      arrive = done;
    });
    let taken = false;
    const handler = async (route: Route) => {
      if (taken || route.request().method() !== "POST") return route.fallback();
      taken = true;
      arrive();
      await held;
      // Left while it was held, the browser may have given up on it.
      return route.continue().catch(() => undefined);
    };
    await on.route(pattern, handler);
    const done = async () => {
      release();
      await on.unroute(pattern, handler);
    };
    return Object.assign(done, { arrived });
  }

  it("keeps what is written while a save or a comment is answered", async () => {
    await visit(page, `${stack.origin}/${handle}/${name}/issues/1`);
    // An edit answered while more is written: the more stays.
    await page.getByText("Edit title and description").click();
    await page.getByLabel("Description (Markdown)").fill("sent text");
    let release = await holdNextPost();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByLabel("Description (Markdown)").fill("sent text, and more written meanwhile");
    await release();
    await see(page.getByRole("status")).toHaveText("Saved.");
    await see(page.getByLabel("Description (Markdown)")).toHaveValue(
      "sent text, and more written meanwhile",
    );
    // A comment added while the next is written: the next stays.
    await page.locator("#comment-body").fill("a comment");
    release = await holdNextPost();
    await page.getByRole("button", { name: "Comment", exact: true }).click();
    await page.locator("#comment-body").fill("the next comment, unsent");
    await release();
    await see(page.getByRole("status")).toHaveText("Comment added.");
    await see(page.locator("#comment-body")).toHaveValue("the next comment, unsent");
  });

  it("reacts to the issue and a comment, and takes a reaction back", async () => {
    await visit(page, `${stack.origin}/${handle}/${name}/issues/1`);
    const description = page.locator("section", {
      has: page.getByRole("heading", { name: "Description" }),
    });
    const reactions = description.getByRole("list", { name: "Reactions" });
    await reactions.getByText("Add a reaction").click();
    await accessible("reaction picker");
    await reactions.getByRole("button", { name: "Heart" }).click();
    await see(page.getByRole("status")).toHaveText("Reaction added.");
    const heart = reactions.getByRole("button", { name: "Heart 1" });
    await see(heart).toHaveAttribute("aria-pressed", "true");
    // Pressed again, it is taken back by its id.
    await heart.click();
    await see(page.getByRole("status")).toHaveText("Reaction taken back.");
    await see(reactions.getByRole("button", { name: /^Heart \d/ })).toHaveCount(0);
    // A comment's own, apart from the issue's.
    const first = page.locator(".timeline li").first();
    await first.getByText("Add a reaction").click();
    await first.getByRole("button", { name: "Rocket" }).click();
    await see(first.getByRole("button", { name: "Rocket 1" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await see(reactions.getByRole("button", { name: /^Rocket \d/ })).toHaveCount(0);
    const issue = await rest<{ reactions: { total_count: number } }>(
      "GET",
      `/repos/${handle}/${name}/issues/1`,
    );
    expect(issue.reactions.total_count).toBe(0);
  });

  it("keeps focus on a reaction's toggle as it moves, from the keyboard", async () => {
    await visit(page, `${stack.origin}/${handle}/${name}/issues/1`);
    const reactions = page
      .locator("section", { has: page.getByRole("heading", { name: "Description" }) })
      .getByRole("list", { name: "Reactions" });
    await reactions.getByText("Add a reaction").focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Tab");
    await see(reactions.getByRole("button", { name: "Thumbs up" })).toBeFocused();
    // Added, it moves out of the picker into the counted ones; focus goes with it.
    await page.keyboard.press("Enter");
    const counted = reactions.getByRole("button", { name: "Thumbs up 1" });
    await see(counted).toBeFocused();
    // Taken back, it moves into the picker again (still open), focus with it.
    await page.keyboard.press("Enter");
    await see(page.getByRole("status")).toHaveText("Reaction taken back.");
    await see(reactions.getByRole("button", { name: "Thumbs up", exact: true })).toBeFocused();
  });

  it("keeps an edit whose comment leaves the page, and resumes it when it comes back", async () => {
    const big = "€".repeat(65_536);
    const { number } = await rest<{ number: number }>("POST", `/repos/${handle}/${name}/issues`, {
      title: "Long conversation",
    });
    const path = `/repos/${handle}/${name}/issues`;
    await rest("POST", `${path}/${number}/comments`, { body: big });
    const second = await rest<{ id: number }>("POST", `${path}/${number}/comments`, {
      body: "second",
    });
    await visit(page, `${stack.origin}/${handle}/${name}/issues/${number}`);
    const item = page.locator(`#comment-${second.id}`);
    await item.getByText("Edit or delete").click();
    await item.getByLabel("Comment (Markdown)").fill("my unsent edit");
    // It grows past the page's budget elsewhere; a comment sent here reads the page again.
    await rest("PATCH", `${path}/comments/${second.id}`, { body: big });
    const comment = async (text: string) => {
      await page.locator("#comment-body").fill(text);
      await page.getByRole("button", { name: "Comment", exact: true }).click();
      await see(page.locator("#comment-body")).toHaveValue("");
    };
    await comment("a new comment");
    await see(item).toHaveCount(0);
    await see(page.getByLabel("Your edit of a comment", { exact: true })).toHaveValue(
      "my unsent edit",
    );
    // Another answer comes; the edit stays.
    await comment("another comment");
    await see(page.getByLabel("Your edit of a comment", { exact: true })).toHaveValue(
      "my unsent edit",
    );
    // Back on the page, its editor resumes from it and from the version it was written at.
    await rest("PATCH", `${path}/comments/${second.id}`, { body: "short again" });
    await comment("a third comment");
    await see(page.getByLabel("Your edit of a comment", { exact: true })).toHaveCount(0);
    await see(item.getByLabel("Comment (Markdown)")).toHaveValue("my unsent edit");
    await item.getByRole("button", { name: "Save comment" }).click();
    await see(page.getByRole("alert")).toContainText("Someone changed it");
    await see(item.getByLabel("Comment (Markdown)")).toHaveValue("my unsent edit");
  });

  it("resumes text written during its own save from the version that save made", async () => {
    const big = "€".repeat(65_536);
    const path = `/repos/${handle}/${name}/issues`;
    const { number } = await rest<{ number: number }>("POST", path, { title: "Saved meanwhile" });
    await rest("POST", `${path}/${number}/comments`, { body: big });
    const filler = await rest<{ id: number }>("POST", `${path}/${number}/comments`, {
      body: "filler",
    });
    const mine = await rest<{ id: number }>("POST", `${path}/${number}/comments`, {
      body: "mine",
    });
    await visit(page, `${stack.origin}/${handle}/${name}/issues/${number}`);
    const item = page.locator(`#comment-${mine.id}`);
    const editor = item.getByLabel("Comment (Markdown)");
    await item.getByText("Edit or delete").click();
    await editor.fill("saved");
    const release = await holdNextPost(`issues/${number}`);
    await item.getByRole("button", { name: "Save comment" }).click();
    await editor.fill("saved, and more written meanwhile");
    await release();
    await see(page.getByRole("status")).toHaveText("Comment saved.");
    const comment = async (text: string) => {
      await page.locator("#comment-body").fill(text);
      await page.getByRole("button", { name: "Comment", exact: true }).click();
      await see(page.locator("#comment-body")).toHaveValue("");
    };
    // An earlier comment grows past the page's budget and shrinks again: this one goes and
    // comes back, from the version its own save made (not refused as stale).
    await rest("PATCH", `${path}/comments/${filler.id}`, { body: big });
    await comment("one");
    await see(page.getByLabel("Your edit of a comment", { exact: true })).toHaveValue(
      "saved, and more written meanwhile",
    );
    await rest("PATCH", `${path}/comments/${filler.id}`, { body: "filler" });
    await comment("two");
    await see(editor).toHaveValue("saved, and more written meanwhile");
    await item.getByRole("button", { name: "Save comment" }).click();
    await see(page.getByRole("status")).toHaveText("Comment saved.");
    // An unsent edit of a comment deleted goes with it.
    await editor.fill("never sent");
    await item.getByRole("button", { name: "Delete comment" }).click();
    await see(page.getByRole("status")).toHaveText("Comment deleted.");
    await see(item).toHaveCount(0);
    await see(page.getByRole("heading", { name: "Your unsent text" })).toHaveCount(0);
  });

  it("keeps what was sent when the page is left before its answer", async () => {
    const big = "€".repeat(65_536);
    const path = `/repos/${handle}/${name}/issues`;
    const { number } = await rest<{ number: number }>("POST", path, { title: "Left meanwhile" });
    await rest("POST", `${path}/${number}/comments`, { body: big });
    const mine = await rest<{ id: number }>("POST", `${path}/${number}/comments`, {
      body: "mine",
    });
    await rest("POST", `${path}/${number}/comments`, { body: big });
    await visit(page, `${stack.origin}/${handle}/${name}/issues/${number}`);
    const item = page.locator(`#comment-${mine.id}`);
    await item.getByText("Edit or delete").click();
    await item.getByLabel("Comment (Markdown)").fill("sent, then left");
    const release = await holdNextPost(`issues/${number}`);
    await item.getByRole("button", { name: "Save comment" }).click();
    // The next page, before the answer: the edit's answer is never taken.
    await page.getByRole("link", { name: "Next page" }).click();
    await see(page).toHaveURL(/after=/);
    await release();
    await see(page.getByLabel("Your edit of a comment", { exact: true })).toHaveValue(
      "sent, then left",
    );
    await page.getByRole("link", { name: "First page" }).click();
    await see(item.getByLabel("Comment (Markdown)")).toHaveValue("sent, then left");
  });

  it("keeps a reader's unsent text to copy once the conversation is locked", async () => {
    const reader = await rest<{ id: string }>("POST", "/admin/users", { handle: "bo" });
    const { token } = await rest<{ token: string }>("POST", `/admin/users/${reader.id}/tokens`, {
      type: "pat",
      scopes: [],
      expires_in_days: 1,
    });
    await rest("PUT", `/repos/${handle}/${name}/collaborators/bo`, { permission: "pull" });
    const browser = page.context().browser();
    if (!browser) throw new Error("no browser");
    const theirs = await (await browser.newContext()).newPage();
    try {
      await theirs.goto(`${stack.origin}/auth/sign-in?return_to=%2F`);
      await theirs.getByLabel(/personal access token/i).fill(token);
      await theirs.getByRole("button", { name: "Sign in with the token" }).click();
      await theirs.getByRole("button", { name: "Not now" }).click();
      const issuePage = `${stack.origin}/${handle}/${name}/issues/1`;
      await visit(theirs, issuePage);
      await theirs.locator("#comment-body").fill("bo's comment");
      await theirs.getByRole("button", { name: "Comment", exact: true }).click();
      await see(theirs.getByRole("status")).toHaveText("Comment added.");
      const mine = theirs.locator(".timeline li", { hasText: "bo's comment" });
      const unsent = (label: string) => theirs.getByLabel(label, { exact: true });
      // A new comment written, unsent; an edit sent and held, more written meanwhile, while ada
      // locks it: the edit is refused, and neither text is lost.
      await theirs.locator("#comment-body").fill("bo's reply, unsent");
      await mine.getByText("Edit or delete").click();
      await mine.getByLabel("Comment (Markdown)").fill("bo's edit");
      let release = await holdNextPost("issues/1", theirs);
      await mine.getByRole("button", { name: "Save comment" }).click();
      await mine.getByLabel("Comment (Markdown)").fill("bo's edit, and more written meanwhile");
      // Sent and held before the lock: it reaches the API locked.
      await release.arrived;
      await rest("PUT", `/repos/${handle}/${name}/issues/1/lock`, {});
      await release();
      await see(theirs.getByRole("alert")).toBeVisible();
      await see(theirs.getByRole("button", { name: "Comment", exact: true })).toHaveCount(0);
      await see(unsent("New comment")).toHaveValue("bo's reply, unsent");
      await see(unsent("Your edit of a comment")).toHaveValue(
        "bo's edit, and more written meanwhile",
      );
      // Unlocked, read afresh: an edit written, unsent; a new comment sent and held while ada
      // locks it again.
      await rest("DELETE", `/repos/${handle}/${name}/issues/1/lock`);
      await visit(theirs, issuePage);
      await mine.getByText("Edit or delete").click();
      await mine.getByLabel("Comment (Markdown)").fill("bo's edit, unsent");
      await theirs.locator("#comment-body").fill("bo's reply, refused");
      release = await holdNextPost("issues/1", theirs);
      await theirs.getByRole("button", { name: "Comment", exact: true }).click();
      await release.arrived;
      await rest("PUT", `/repos/${handle}/${name}/issues/1/lock`, {});
      await release();
      await see(theirs.getByRole("alert")).toBeVisible();
      // Nothing left to send them with; both texts still there to copy.
      await see(theirs.getByRole("button", { name: "Comment", exact: true })).toHaveCount(0);
      await see(theirs.getByRole("button", { name: "Save comment" })).toHaveCount(0);
      await see(theirs.getByLabel("New comment", { exact: true })).toHaveValue(
        "bo's reply, refused",
      );
      await see(theirs.getByLabel("Your edit of a comment", { exact: true })).toHaveValue(
        "bo's edit, unsent",
      );
      await axe(theirs, "unsent text after a lock");
      // Discarded, one goes; the other stays.
      await theirs.getByRole("button", { name: "Discard: New comment" }).click();
      await see(theirs.getByLabel("New comment", { exact: true })).toHaveCount(0);
      await see(theirs.getByLabel("Your edit of a comment", { exact: true })).toHaveValue(
        "bo's edit, unsent",
      );
    } finally {
      await theirs.context().close();
      await rest("DELETE", `/repos/${handle}/${name}/issues/1/lock`);
    }
  });

  it("sets an issue's labels, assignee and milestone, locks it, and deletes another", async () => {
    const issue = `${stack.origin}/${handle}/${name}/issues/1`;
    await visit(page, issue);
    const sidebar = page.getByRole("complementary");
    // A label, chosen on its own page by name.
    await sidebar.getByRole("link", { name: "Add labels" }).click();
    await page.getByLabel("Labels named").fill("doc");
    await page.getByRole("button", { name: "Search" }).click();
    await see(page).toHaveURL(/q=doc/);
    await page.getByRole("button", { name: "Add documentation" }).click();
    await see(page.getByRole("status")).toHaveText("Label added.");
    await see(page.getByRole("button", { name: "Remove documentation" })).toBeVisible();
    await accessible("labels of an issue");
    await page.getByRole("link", { name: /^Back to the issue/ }).click();
    await see(sidebar.locator(".label-chip", { hasText: "documentation" })).toBeVisible();
    await sidebar.getByRole("button", { name: "Remove the label documentation" }).click();
    await see(page.getByRole("status")).toHaveText("Label removed.");
    await see(sidebar.locator(".label-chip", { hasText: "documentation" })).toHaveCount(0);
    // Assigned by handle, shown as "you"; taken off by id.
    await sidebar.getByLabel("Assign (a handle)").fill(handle);
    await sidebar.getByRole("button", { name: "Assign", exact: true }).click();
    await see(page.getByRole("status")).toHaveText("Assigned.");
    await see(sidebar.getByRole("list", { name: "Its assignees" })).toContainText("you");
    await sidebar.getByRole("button", { name: "Remove you from its assignees" }).click();
    await see(page.getByRole("status")).toHaveText("Unassigned.");
    await see(sidebar.getByText("No one.")).toBeVisible();
    // A milestone, chosen among the open ones.
    const chosen = await rest<{ number: number }>("POST", `/repos/${handle}/${name}/milestones`, {
      title: "Sidebar milestone",
    });
    await sidebar.getByRole("link", { name: "Choose a milestone" }).click();
    await page.getByRole("button", { name: "Set Sidebar milestone" }).click();
    await see(page.getByRole("status")).toHaveText("Milestone set.");
    await see(page.getByText("(its milestone)")).toBeVisible();
    await accessible("milestone of an issue");
    await page.getByRole("link", { name: /^Back to the issue/ }).click();
    await see(sidebar.getByText("Sidebar milestone")).toBeVisible();
    await sidebar.getByRole("button", { name: "Clear the milestone" }).click();
    await see(page.getByRole("status")).toHaveText("Milestone cleared.");
    await see(sidebar.getByText("None.", { exact: true })).toBeVisible();
    await rest("DELETE", `/repos/${handle}/${name}/milestones/${chosen.number}`);
    // Locked with a reason, then unlocked.
    await sidebar.getByLabel("Reason (optional)").selectOption("resolved");
    await sidebar.getByRole("button", { name: "Lock conversation" }).click();
    await see(page.getByRole("status")).toHaveText("Conversation locked.");
    await see(sidebar.getByText(/Locked as Resolved/)).toBeVisible();
    await accessible("a locked issue's sidebar");
    await sidebar.getByRole("button", { name: "Unlock conversation" }).click();
    await see(page.getByRole("status")).toHaveText("Conversation unlocked.");
    // Another issue, deleted: the page goes back to the list.
    const doomed = await rest<{ number: number }>("POST", `/repos/${handle}/${name}/issues`, {
      title: "To be deleted",
    });
    await visit(page, `${stack.origin}/${handle}/${name}/issues/${doomed.number}`);
    await page.getByText("Delete issue", { exact: true }).click();
    await page.getByRole("button", { name: `Delete issue #${doomed.number}` }).click();
    await see(page).toHaveURL(`${stack.origin}/${handle}/${name}/issues`);
    await see(page.getByRole("link", { name: "To be deleted" })).toHaveCount(0);
  });

  it("lists what refers to an issue, and opens a comment past the first page by its permalink", async () => {
    const path = `/repos/${handle}/${name}/issues`;
    // A long description: its comments start well below the fold, so reaching one is scrolling.
    const { number } = await rest<{ number: number }>("POST", path, {
      title: "Long thread",
      body: Array.from({ length: 120 }, (_, i) => `Paragraph ${i + 1}.`).join("\n\n"),
    });
    for (let i = 1; i <= 29; i++)
      await rest("POST", `${path}/${number}/comments`, { body: `comment ${i}` });
    const naming = await rest<{ id: number }>("POST", `${path}/${number}/comments`, {
      body: "this is about #1",
    });
    // A reference within the repository is recorded with the comment naming it: listed at once.
    const listed = await rest<{ references: { source: { comment_id: number | null } }[] }>(
      "GET",
      `${path}/1/references`,
    );
    expect(listed.references.some((r) => r.source.comment_id === naming.id)).toBe(true);
    await visit(page, `${stack.origin}/${handle}/${name}/issues/1`);
    await page.getByRole("complementary").getByRole("link", { name: "What refers to it" }).click();
    await see(page.getByRole("heading", { level: 1 })).toContainText("What refers to");
    await accessible("references");
    await page.getByRole("link", { name: `${handle}/${name}#${number}` }).click();
    // Comment 30, past the first page of 25: the page that starts with it, marked, scrolled to
    // (from another page: its header in view, below the long description).
    await see(page).toHaveURL(new RegExp(`comment=${naming.id}#comment-${naming.id}$`));
    const linked = page.locator(`#comment-${naming.id} article.linked`);
    await see(linked).toContainText("this is about #1");
    await see(linked.locator("header")).toBeInViewport();
    await see(page.getByText("comment 1", { exact: true })).toHaveCount(0);
    await page.getByRole("link", { name: "First page" }).click();
    await see(page.getByText("comment 1", { exact: true }).first()).toBeVisible();
    // Without scripts too: the server's page of comments 30 onward, the browser at the fragment.
    const browser = page.context().browser();
    if (!browser) throw new Error("no browser");
    const plain = await (
      await browser.newContext({
        javaScriptEnabled: false,
        storageState: await page.context().storageState(),
      })
    ).newPage();
    try {
      await plain.goto(
        `${stack.origin}/${handle}/${name}/issues/${number}?comment=${naming.id}#comment-${naming.id}`,
      );
      const there = plain.locator(`#comment-${naming.id} article.linked`);
      await see(there.locator("header")).toBeInViewport();
      await see(plain.locator(".timeline > li")).toHaveCount(1);
      await plain.getByRole("link", { name: "First page" }).click();
      await see(plain.locator(".timeline > li")).toHaveCount(25);
    } finally {
      await plain.context().close();
    }
  });

  it("opens a comment by its permalink without scripts, past the page's bytes, scrolled to", async () => {
    const path = `/repos/${handle}/${name}/issues`;
    // A long description: its comments start well below the fold, so reaching one is scrolling.
    const { number } = await rest<{ number: number }>("POST", path, {
      title: "Long comments",
      body: Array.from({ length: 120 }, (_, i) => `Paragraph ${i + 1}.`).join("\n\n"),
    });
    // 192 KiB of Markdown each: one a page (the page shows up to 256 KiB).
    const ids: number[] = [];
    for (let i = 1; i <= 6; i++)
      ids.push(
        (
          await rest<{ id: number }>("POST", `${path}/${number}/comments`, {
            body: `long ${i} ${"€".repeat(65_520)}`,
          })
        ).id,
      );
    const target = ids[3] as number;
    const browser = page.context().browser();
    if (!browser) throw new Error("no browser");
    // The same session, no scripts: what a server-rendered page and plain links do.
    const plain = await (
      await browser.newContext({
        javaScriptEnabled: false,
        storageState: await page.context().storageState(),
      })
    ).newPage();
    try {
      const at = `${stack.origin}/${handle}/${name}/issues/${number}`;
      await plain.goto(`${at}?comment=${target}#comment-${target}`);
      const linked = plain.locator(`#comment-${target} article.linked`);
      await see(linked).toContainText("long 4");
      await see(linked.locator("header")).toBeInViewport();
      await see(plain.locator(`#comment-${ids[0]}`)).toHaveCount(0);
      await plain.getByRole("link", { name: "Next page" }).click();
      await see(plain.locator(`#comment-${ids[4]}`)).toBeVisible();
      await see(plain).not.toHaveURL(/comment=/);
      await plain.getByRole("link", { name: "First page" }).click();
      await see(plain.locator(`#comment-${ids[0]}`)).toBeVisible();
    } finally {
      await plain.context().close();
    }
    // With scripts: a comment's time is its permalink (reaching it from elsewhere scrolls: see the
    // references test).
    await visit(page, `${stack.origin}/${handle}/${name}/issues/${number}`);
    await page.locator(`#comment-${ids[0]}`).getByRole("link").first().click();
    await see(page).toHaveURL(new RegExp(`comment=${ids[0]}#comment-${ids[0]}$`));
    await see(page.locator(`#comment-${ids[0]} article.linked`)).toHaveCount(1);
  });

  it("manages labels: creates one with a hostile name, edits it, keeps a stale edit, deletes it", async () => {
    const labels = `${stack.origin}/${handle}/${name}/labels`;
    await visit(page, labels);
    // A new repository has the default labels.
    await see(page.locator(".label-chip", { hasText: /^bug$/ })).toBeVisible();
    await accessible("labels");
    await page.getByText("New label").click();
    const create = page.locator("form", {
      has: page.getByRole("button", { name: "Create label" }),
    });
    await create.getByLabel("Name").fill(HOSTILE);
    await create.getByLabel("Colour").fill("#fbca04");
    await create.getByLabel("Description (optional)").fill(`about ${HOSTILE}`);
    await page.getByRole("button", { name: "Create label" }).click();
    await see(page.getByRole("status")).toHaveText("Label created.");
    // The form is cleared for the next one.
    await see(create.getByLabel("Name")).toHaveValue("");
    await see(create.getByLabel("Description (optional)")).toHaveValue("");
    // What is written while the next one is created stays.
    await create.getByLabel("Name").fill("second");
    const release = await holdNextPost("labels");
    await page.getByRole("button", { name: "Create label" }).click();
    await create.getByLabel("Name").fill("third, written meanwhile");
    await release();
    await see(page.locator(".label-chip", { hasText: /^second$/ })).toBeVisible();
    await see(create.getByLabel("Name")).toHaveValue("third, written meanwhile");
    const item = page.locator(".label-list li", {
      has: page.locator(".label-chip", { hasText: HOSTILE }),
    });
    await see(item.locator(".label-chip")).toHaveCSS("color", "rgb(0, 0, 0)");
    expect(await page.evaluate(() => (globalThis as { pwned?: unknown }).pwned)).toBeUndefined();
    await accessible("labels with a new one");
    // Its issues: one carries it.
    await rest("POST", `/repos/${handle}/${name}/issues/1/labels`, { labels: [HOSTILE] });
    await item.getByRole("link", { name: /^Issues/ }).click();
    await see(page).toHaveURL(/\/issues\?labels=/);
    await see(
      page.getByRole("list", { name: "Issues" }).getByRole("link", { name: /crash/ }),
    ).toHaveCount(1);
    await page.goBack();
    await see(page).toHaveURL(labels);
    // An edit someone else's change overtook is refused, its text kept.
    await item.getByText("Edit", { exact: true }).click();
    await item.getByLabel("Name").fill("renamed here");
    await rest("PATCH", `/repos/${handle}/${name}/labels/${encodeURIComponent(HOSTILE)}`, {
      description: "changed elsewhere",
    });
    await item.getByRole("button", { name: "Save label" }).click();
    await see(page.getByRole("alert")).toContainText("Someone changed it");
    await see(item.getByLabel("Name")).toHaveValue("renamed here");
    await reload(page);
    const fresh = page.locator(".label-list li", {
      has: page.locator(".label-chip", { hasText: HOSTILE }),
    });
    await fresh.getByText("Edit", { exact: true }).click();
    await fresh.getByLabel("Name").fill("renamed here");
    await fresh.getByRole("button", { name: "Save label" }).click();
    await see(page.getByRole("status")).toHaveText("Label saved.");
    const renamed = page.locator(".label-list li", {
      has: page.locator(".label-chip", { hasText: /^renamed here$/ }),
    });
    await renamed.getByText("Delete", { exact: true }).click();
    await renamed.getByRole("button", { name: "Delete label renamed here" }).click();
    await see(page.getByRole("status")).toHaveText("Label deleted.");
    await see(page.locator(".label-chip", { hasText: /^renamed here$/ })).toHaveCount(0);
  });

  it("manages milestones: creates one, lists its items, keeps a stale edit, closes, reopens, deletes", async () => {
    const milestones = `${stack.origin}/${handle}/${name}/milestones`;
    await visit(page, milestones);
    await see(page.getByText("No open milestones.")).toBeVisible();
    await accessible("no milestones");
    await page.getByText("New milestone").click();
    const create = page.locator("form", {
      has: page.getByRole("button", { name: "Create milestone" }),
    });
    await create.getByLabel("Title").fill(HOSTILE);
    await create.getByLabel(/^Due date/).fill("2027-01-02");
    await create.getByLabel(/^Description/).fill(`about ${HOSTILE}`);
    await page.getByRole("button", { name: "Create milestone" }).click();
    await see(page.getByRole("status")).toHaveText("Milestone created.");
    await see(create.getByLabel("Title")).toHaveValue("");
    const item = page.locator(".label-list li", {
      has: page.getByRole("heading", { name: HOSTILE }),
    });
    await see(item.getByText(/Due 2027-01-02 · Nothing in it yet/)).toBeVisible();
    expect(await page.evaluate(() => (globalThis as { pwned?: unknown }).pwned)).toBeUndefined();
    await accessible("a milestone");
    // Its items: an issue in it.
    const { number } = (
      await rest<{ milestones: { number: number }[] }>("GET", `/repos/${handle}/${name}/milestones`)
    ).milestones[0] as { number: number };
    await rest("PATCH", `/repos/${handle}/${name}/issues/1`, { milestone: number });
    await reload(page);
    await see(item.getByText(/0% complete · 1 open · 0 closed/)).toBeVisible();
    await item.getByRole("link", { name: /^Issues and pull requests/ }).click();
    await see(page).toHaveURL(/kind=all/);
    await see(page.getByRole("list", { name: "Issues" }).getByRole("link")).toHaveCount(1);
    await visit(page, milestones);
    // An edit someone else's change overtook is refused, its text kept.
    await item.getByText("Edit", { exact: true }).click();
    await item.getByLabel("Title").fill("v1, mine");
    await rest("PATCH", `/repos/${handle}/${name}/milestones/${number}`, {
      description: "changed elsewhere",
    });
    await item.getByRole("button", { name: "Save milestone" }).click();
    await see(page.getByRole("alert")).toContainText("Someone changed it");
    await see(item.getByLabel("Title")).toHaveValue("v1, mine");
    // Closed, it leaves the open list (its unsent edit kept to copy); reopened, it is back.
    await item.getByRole("button", { name: "Close milestone" }).click();
    await see(page.getByRole("status")).toHaveText("Milestone closed.");
    await see(page.getByText("No open milestones.")).toBeVisible();
    await see(page.getByLabel("Your edit of a milestone", { exact: true })).toHaveValue("v1, mine");
    await page.getByRole("link", { name: "Closed", exact: true }).click();
    const closed = page.locator(".label-list li", {
      has: page.getByRole("heading", { name: HOSTILE }),
    });
    await closed.getByRole("button", { name: "Reopen milestone" }).click();
    await see(page.getByRole("status")).toHaveText("Milestone reopened.");
    // Back on the open list (within the page, its drafts kept), its editor resumes the edit.
    await page.getByRole("link", { name: "Open", exact: true }).click();
    await see(item.getByLabel("Title")).toHaveValue("v1, mine");
    // Deleted, its unsent edit goes with it.
    await item.getByText("Delete", { exact: true }).click();
    await item.getByRole("button", { name: `Delete milestone ${HOSTILE}` }).click();
    await see(page.getByRole("status")).toHaveText("Milestone deleted.");
    await see(page.getByText("No open milestones.")).toBeVisible();
    await see(page.getByRole("heading", { name: "Your unsent text" })).toHaveCount(0);
  });
});
