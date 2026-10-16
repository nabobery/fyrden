// Pull requests in a real browser (Chromium through Playwright) against both
// Workers under one wrangler dev: a person opens a pull request from a
// pushed branch, discusses it, reads its files drawn by the diff renderer
// (hostile file names and lines staying inert), comments on a line from the
// keyboard, replies, resolves and applies a suggestion, reviews, updates the
// branch and squash-merges it, and resolves another one's conflict in the
// web editor. Every page it visits is checked with axe for WCAG 2.x A and
// AA. Needs `pnpm --filter @fyrden/web build` first (turbo does it).
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { mentionsToken } from "@fyrden/domain";
import { type Page, expect as see } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accessible, startWebStack, type WebStack } from "./web-stack.js";

let stack: WebStack;
let page: Page;
const handle = "ada";
const name = "prs";
/** A file name that is markup wherever it lands unescaped. */
const HOSTILE_FILE = "<img src=x onerror=window.pwned=1>.md";

/** Stock git with no user or system config, never prompting; fails with its output, the token redacted. */
function git(args: string[], cwd: string): Promise<string> {
  return new Promise((done, fail) => {
    const child = spawn("git", args, {
      cwd,
      env: {
        ...process.env,
        HOME: join(stack.scratch, "home"),
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: join(stack.scratch, "home/.gitconfig"),
        GIT_TERMINAL_PROMPT: "0",
        GIT_AUTHOR_NAME: "Fyrden E2E",
        GIT_AUTHOR_EMAIL: "e2e@fyrden.invalid",
        GIT_COMMITTER_NAME: "Fyrden E2E",
        GIT_COMMITTER_EMAIL: "e2e@fyrden.invalid",
      },
    });
    let out = "";
    child.stdout.on("data", (d: Buffer) => {
      out += d;
    });
    child.stderr.on("data", (d: Buffer) => {
      out += d;
    });
    child.on("error", fail);
    child.on("close", (code) =>
      code === 0
        ? done(out)
        : fail(new Error(`git ${args[0]}: ${out.replace(/\/\/[^/@\s]*@/g, "//***@")}`)),
    );
    child.stdin.end();
  });
}

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
  return JSON.parse(text) as T;
}

/** Nothing a hostile string held has run. */
async function inert(): Promise<void> {
  expect(await page.evaluate(() => (globalThis as { pwned?: unknown }).pwned)).toBeUndefined();
}

const lines = (n: number) => Array.from({ length: n }, (_, i) => `const line${i + 1} = ${i + 1};`);

beforeAll(async () => {
  stack = await startWebStack(handle);
  page = stack.page;
  await rest("POST", "/user/repos", { name });
  const { token } = await rest<{ token: string }>("POST", "/user/git-tokens", {});
  const work = join(stack.scratch, "work");
  await mkdir(join(work, "src"), { recursive: true });
  await git(["init", "-q", "-b", "main", work], stack.scratch);
  await writeFile(join(work, "src/app.ts"), `${lines(12).join("\n")}\n`);
  await writeFile(join(work, "README.md"), "# PRs\n");
  await git(["add", "-A"], work);
  await git(["commit", "-q", "-m", "first"], work);
  await git(["checkout", "-q", "-b", "topic"], work);
  const changed = lines(12);
  changed[2] = `const html = "<script>window.pwned=2</script>";`;
  await writeFile(join(work, "src/app.ts"), `${changed.join("\n")}\n`);
  await writeFile(join(work, HOSTILE_FILE), "<svg onload=window.pwned=3>\n");
  await git(["add", "-A"], work);
  await git(["commit", "-q", "-m", "change"], work);
  // A branch whose README conflicts with the base's once the base changes it too.
  await git(["checkout", "-q", "-b", "clash", "main"], work);
  await writeFile(join(work, "README.md"), "# Clash\n");
  await git(["commit", "-q", "-am", "clash"], work);
  const remote = `http://x-access-token:${token}@127.0.0.1:${stack.port}/${handle}/${name}.git`;
  await git(["push", "-q", remote, "main", "topic", "clash"], work);
}, 240_000);

afterAll(async () => {
  const output = stack?.output() ?? "";
  await stack?.stop();
  // Neither Worker logs a token (wrangler's own access log lines aside).
  expect(
    output
      .split("\n")
      .filter((l) => !l.startsWith("[wrangler:info]"))
      .filter(mentionsToken),
  ).toEqual([]);
});

describe("pull requests in the web UI", () => {
  it("opens a pull request from a branch, with a hostile title and description", async () => {
    await page.goto(`${stack.origin}/${handle}/${name}/pulls`);
    await see(page.getByText("No open pull requests.")).toBeVisible();
    await accessible(page, "empty pull request list");
    await page.getByText("New pull request").click();
    await page.getByLabel("Head branch (with the changes)").fill("topic");
    await page.getByLabel("Title").fill("<img src=x onerror=window.pwned=4> Change");
    await page
      .getByLabel("Description (Markdown, optional)")
      .fill("Hello <script>window.pwned=5</script> [x](javascript:window.pwned=6)");
    await accessible(page, "new pull request form");
    await page.getByRole("button", { name: "Open pull request" }).click();
    await see(page).toHaveURL(`${stack.origin}/${handle}/${name}/pull/1`);
    await see(page.getByRole("heading", { level: 1 })).toContainText(
      "<img src=x onerror=window.pwned=4> Change",
    );
    await inert();
    expect(await page.locator(".markdown a[href^='javascript']").count()).toBe(0);
    await accessible(page, "pull request");
  });

  it("comments on the conversation, drafts it and makes it ready again", async () => {
    await page
      .getByLabel("Comment (Markdown)")
      .fill("Looks **good** <img src=x onerror=window.pwned=7>");
    await page.getByRole("button", { name: "Comment", exact: true }).click();
    await see(page.getByRole("status")).toHaveText("Comment added.");
    await see(page.locator(".timeline strong", { hasText: "good" })).toBeVisible();
    await page.getByRole("button", { name: "Convert to draft" }).click();
    await see(page.locator(".badge.status-draft")).toBeVisible();
    await page.getByRole("button", { name: "Ready for review" }).click();
    await see(page.locator(".badge.status-open")).toBeVisible();
    await inert();
    await accessible(page, "pull request with a comment");
  });

  it("draws the files' changes, hostile names and lines as text", async () => {
    await page.getByRole("link", { name: "Files changed" }).click();
    await see(page).toHaveURL(`${stack.origin}/${handle}/${name}/pull/1/files`);
    await see(page.getByRole("link", { name: HOSTILE_FILE })).toBeVisible();
    // The renderer draws each file into its own element's shadow root.
    await see(page.locator("diffs-container")).toHaveCount(2, { timeout: 30_000 });
    const drawn = page.locator("diffs-container");
    await see(drawn.getByText('const html = "<script>window.pwned=2</script>";')).toBeVisible({
      timeout: 30_000,
    });
    await see(drawn.getByText("<svg onload=window.pwned=3>")).toBeVisible();
    await inert();
    await accessible(page, "files");
  });

  it("comments on a line from the keyboard, replies and resolves", async () => {
    const file = page.locator("section.file", { hasText: "src/app.ts" });
    await file.getByText("Comment on lines").focus();
    await page.keyboard.press("Enter");
    await file.getByLabel("Line", { exact: true }).fill("3");
    await file.getByLabel(/^Comment \(Markdown/).fill("Why *this* line?");
    await file.getByRole("button", { name: "Add comment" }).click();
    await see(file.getByRole("status")).toHaveText("Comment added.");
    const thread = file.locator(".thread").first();
    await see(thread.getByText("Why this line?")).toBeVisible();
    await thread.getByLabel("Reply").fill("Because.");
    await thread.getByRole("button", { name: "Reply" }).click();
    await see(thread.getByText("Because.")).toBeVisible();
    await thread.getByRole("button", { name: "Resolve conversation" }).click();
    await see(thread.getByRole("button", { name: "Unresolve conversation" })).toBeVisible();
    await accessible(page, "files with a thread");
  });

  it("applies a suggested change to the head branch", async () => {
    const file = page.locator("section.file", { hasText: "src/app.ts" });
    // The form is still open from the last comment.
    await file.getByLabel("Line", { exact: true }).fill("3");
    await file.getByLabel(/^Comment \(Markdown/).fill('```suggestion\nconst html = "";\n```');
    await file.getByRole("button", { name: "Add comment" }).click();
    await file.getByRole("button", { name: "Apply suggestion" }).click();
    await see(file.getByRole("status").filter({ hasText: "Suggestion applied." })).toBeVisible();
    const pull = await rest<{ head: { sha: string } }>("GET", `/repos/${handle}/${name}/pulls/1`);
    const commit = await rest<{ commit: { message: string } }>(
      "GET",
      `/repos/${handle}/${name}/commits/${pull.head.sha}`,
    );
    expect(commit.commit.message).toContain("Apply suggestions from code review");
  });

  it("reviews, brings the branch up to date and squashes it into the base", async () => {
    // The base moves on, touching nothing the pull request changes.
    await rest("PUT", `/repos/${handle}/${name}/contents/docs/later.md`, {
      message: "Add docs",
      content: Buffer.from("later\n").toString("base64"),
    });
    await page.goto(`${stack.origin}/${handle}/${name}/pull/1`);
    const review = page.locator("section", { has: page.getByRole("heading", { name: "Review" }) });
    // Its author may only comment.
    await see(review.getByLabel("Approve")).toBeDisabled();
    await review.getByLabel(/^Review comment/).fill("Reviewed the change.");
    await review.getByRole("button", { name: "Submit review" }).click();
    await see(review.getByRole("status")).toHaveText("Review submitted.");
    await see(page.locator(".timeline").getByText("Reviewed the change.")).toBeVisible();
    const merge = page.locator("section.merge-box");
    await merge.getByRole("button", { name: "Update branch" }).click();
    await see(merge.getByText("The branch is up to date with the base branch.")).toBeVisible();
    await see(merge.getByText("No conflicts with the base branch.")).toBeVisible({
      timeout: 60_000,
    });
    await accessible(page, "merge box");
    await merge.getByLabel("Squash and merge").check();
    await merge.getByLabel("Commit title (optional)").fill("Change things (#1)");
    await merge.getByRole("button", { name: "Merge pull request" }).click();
    await see(page.locator(".badge.status-merged")).toBeVisible({ timeout: 30_000 });
    await see(page.locator(".timeline-event")).toContainText("Merged");
    const main = await rest<{ commit: { message: string } }>(
      "GET",
      `/repos/${handle}/${name}/commits/main`,
    );
    expect(main.commit.message).toMatch(/^Change things \(#1\)/);
    await accessible(page, "merged pull request");
  });

  it("resolves a conflict in the web editor, from the keyboard", async () => {
    await rest("POST", `/repos/${handle}/${name}/pulls`, {
      title: "Clash",
      head: "clash",
      base: "main",
    });
    // The base changes the same line.
    const readme = await rest<{ sha: string }>(
      "GET",
      `/repos/${handle}/${name}/contents/README.md`,
    );
    await rest("PUT", `/repos/${handle}/${name}/contents/README.md`, {
      message: "Retitle",
      sha: readme.sha,
      content: Buffer.from("# Main\n").toString("base64"),
    });
    await page.goto(`${stack.origin}/${handle}/${name}/pull/2/conflicts`);
    await see(page.getByText("1 conflict left in this file.")).toBeVisible();
    await accessible(page, "conflicts");
    const editor = page.getByLabel(/^Resolved content of README\.md/);
    await see(editor).toHaveValue("<<<<<<< clash\n# Clash\n=======\n# Main\n>>>>>>> main\n");
    await page.getByRole("button", { name: "Next conflict" }).focus();
    await page.keyboard.press("Enter");
    await see(editor).toBeFocused();
    await page.getByRole("button", { name: "Keep both" }).focus();
    await page.keyboard.press("Enter");
    await see(page.getByText("No conflict markers left.")).toBeVisible();
    await page.getByRole("button", { name: "Commit merge" }).click();
    await see(page.getByRole("status").filter({ hasText: "Resolved" })).toBeVisible({
      timeout: 30_000,
    });
    await accessible(page, "conflicts resolved");
    // One merge commit on the head branch, the file's line breaks as they were.
    const head = await rest<{ parents: unknown[] }>(
      "GET",
      `/repos/${handle}/${name}/commits/clash`,
    );
    expect(head.parents).toHaveLength(2);
    const merged = await rest<{ content: string }>(
      "GET",
      `/repos/${handle}/${name}/contents/README.md?ref=clash`,
    );
    expect(Buffer.from(merged.content, "base64").toString()).toBe("# Clash\n# Main\n");
  });

  it("never had a script, style or image refused by the policy on any page", () => {
    expect(stack.refused).toEqual([]);
  });
});
