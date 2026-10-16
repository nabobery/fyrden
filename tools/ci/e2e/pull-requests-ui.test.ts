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
import { dirname, join } from "node:path";
import { mentionsToken } from "@fyrden/domain";
import { type Locator, type Page, expect as see } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accessible, startWebStack, type WebStack } from "./web-stack.js";

let stack: WebStack;
let page: Page;
const handle = "ada";
const name = "prs";
/** The working copy branches are pushed from: main is its first commit. */
let work = "";
/** The repository's git URL, with a git token. */
let remote = "";
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
  return JSON.parse(text) as T;
}

/** Nothing a hostile string held has run. */
async function inert(): Promise<void> {
  expect(await page.evaluate(() => (globalThis as { pwned?: unknown }).pwned)).toBeUndefined();
}

const lines = (n: number) => Array.from({ length: n }, (_, i) => `const line${i + 1} = ${i + 1};`);

/** Pushes `branch`, made from main's first commit with `files` written over it. */
async function pushBranch(branch: string, files: Record<string, string>): Promise<void> {
  await git(["checkout", "-q", "-B", branch, "main"], work);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(work, path)), { recursive: true });
    await writeFile(join(work, path), content);
  }
  await git(["add", "-A"], work);
  await git(["commit", "-q", "-m", branch], work);
  await git(["push", "-q", remote, branch], work);
}

let topics = 0;
/** A new branch changing a line of src/app.ts into markup and adding a hostile file name: its name. */
async function pushTopic(): Promise<string> {
  const branch = `topic-${++topics}`;
  const changed = lines(12);
  changed[2] = `const html = "<script>window.pwned=2</script>";`;
  await pushBranch(branch, {
    "src/app.ts": `${changed.join("\n")}\n`,
    [HOSTILE_FILE]: "<svg onload=window.pwned=3>\n",
  });
  return branch;
}

/** A pull request of `head` into main, opened through REST (by ada unless `token` is another's): its number. */
async function openPull(
  head: string,
  title: string,
  { body, token }: { body?: string; token?: string } = {},
): Promise<number> {
  const pull = await rest<{ number: number }>(
    "POST",
    `/repos/${handle}/${name}/pulls`,
    { title, head, base: "main", body },
    token,
  );
  return pull.number;
}

/** Commits a new file to `branch` through the API: its pull request's head moves. */
async function pushFile(branch: string, path: string): Promise<void> {
  await rest("PUT", `/repos/${handle}/${name}/contents/${path}`, {
    message: `Add ${path}`,
    branch,
    content: Buffer.from(`${path}\n`).toString("base64"),
  });
}

/** The pull request's head now. */
async function headOf(number: number): Promise<string> {
  const pull = await rest<{ head: { sha: string } }>(
    "GET",
    `/repos/${handle}/${name}/pulls/${number}`,
  );
  return pull.head.sha;
}

/** A pull request of a new topic branch, its conversation open in the page: its number. */
async function visitTopicPull(title: string): Promise<number> {
  const number = await openPull(await pushTopic(), title);
  await page.goto(`${stack.origin}/${handle}/${name}/pull/${number}`);
  return number;
}

/** A pull request of a new topic branch, its files open in the page: its number and src/app.ts. */
async function visitTopicFiles(title: string) {
  const number = await openPull(await pushTopic(), title);
  await page.goto(`${stack.origin}/${handle}/${name}/pull/${number}/files`);
  return { number, file: page.locator("section.file", { hasText: "src/app.ts" }) };
}

/** Opens the form for a comment on lines of `file`, from the keyboard. */
async function openLineComment(file: Locator): Promise<void> {
  await file.getByText("Comment on lines").focus();
  await page.keyboard.press("Enter");
}

beforeAll(async () => {
  stack = await startWebStack(handle);
  page = stack.page;
  await rest("POST", "/user/repos", { name });
  const { token } = await rest<{ token: string }>("POST", "/user/git-tokens", {});
  remote = `http://x-access-token:${token}@127.0.0.1:${stack.port}/${handle}/${name}.git`;
  work = join(stack.scratch, "work");
  await mkdir(join(work, "src"), { recursive: true });
  await git(["init", "-q", "-b", "main", work], stack.scratch);
  await writeFile(join(work, "src/app.ts"), `${lines(12).join("\n")}\n`);
  await writeFile(join(work, "README.md"), "# PRs\n");
  await git(["add", "-A"], work);
  await git(["commit", "-q", "-m", "first"], work);
  await git(["push", "-q", remote, "main"], work);
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
    // A repository of its own has none yet.
    await rest("POST", "/user/repos", { name: "no-pulls" });
    await page.goto(`${stack.origin}/${handle}/no-pulls/pulls`);
    await see(page.getByText("No open pull requests.")).toBeVisible();
    await accessible(page, "empty pull request list");
    const branch = await pushTopic();
    await page.goto(`${stack.origin}/${handle}/${name}/pulls`);
    await page.getByText("New pull request").click();
    await page.getByLabel("Head branch (with the changes)").fill(branch);
    await page.getByLabel("Title").fill("<img src=x onerror=window.pwned=4> Change");
    await page
      .getByLabel("Description (Markdown, optional)")
      .fill("Hello <script>window.pwned=5</script> [x](javascript:window.pwned=6)");
    await accessible(page, "new pull request form");
    await page.getByRole("button", { name: "Open pull request" }).click();
    await see(page).toHaveURL(new RegExp(`^${stack.origin}/${handle}/${name}/pull/\\d+$`));
    await see(page.getByRole("heading", { level: 1 })).toContainText(
      "<img src=x onerror=window.pwned=4> Change",
    );
    await inert();
    expect(await page.locator(".markdown a[href^='javascript']").count()).toBe(0);
    await accessible(page, "pull request");
  });

  it("comments on the conversation, drafts it and makes it ready again", async () => {
    await visitTopicPull("Discussed");
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
    const number = await visitTopicPull("Drawn");
    await page.getByRole("link", { name: "Files changed" }).click();
    await see(page).toHaveURL(`${stack.origin}/${handle}/${name}/pull/${number}/files`);
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
    const { file } = await visitTopicFiles("Commented on a line");
    await openLineComment(file);
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
    const { number, file } = await visitTopicFiles("Suggested");
    await openLineComment(file);
    await file.getByLabel("Line", { exact: true }).fill("3");
    await file.getByLabel(/^Comment \(Markdown/).fill('```suggestion\nconst html = "";\n```');
    await file.getByRole("button", { name: "Add comment" }).click();
    await file.getByRole("button", { name: "Apply suggestion" }).click();
    // The head moves: the thread goes outdated and leaves the diff, and the answer stays.
    await see(file.locator(".threads .badge", { hasText: "outdated" }).first()).toBeVisible();
    await see(file.getByRole("status").filter({ hasText: "Suggestion applied." })).toBeVisible();
    const pull = await rest<{ head: { sha: string } }>(
      "GET",
      `/repos/${handle}/${name}/pulls/${number}`,
    );
    const commit = await rest<{ commit: { message: string } }>(
      "GET",
      `/repos/${handle}/${name}/commits/${pull.head.sha}`,
    );
    expect(commit.commit.message).toContain("Apply suggestions from code review");
  });

  it("reviews, brings the branch up to date and squashes it into the base", async () => {
    const number = await openPull(await pushTopic(), "Change things");
    // The base moves on, touching nothing the pull request changes.
    await rest("PUT", `/repos/${handle}/${name}/contents/docs/later.md`, {
      message: "Add docs",
      content: Buffer.from("later\n").toString("base64"),
    });
    await page.goto(`${stack.origin}/${handle}/${name}/pull/${number}`);
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
    await merge.getByLabel("Commit title (optional)").fill(`Change things (#${number})`);
    await merge.getByRole("button", { name: "Merge pull request" }).click();
    await see(page.locator(".badge.status-merged")).toBeVisible({ timeout: 30_000 });
    await see(page.locator(".timeline-event")).toContainText("Merged");
    const main = await rest<{ commit: { message: string } }>(
      "GET",
      `/repos/${handle}/${name}/commits/main`,
    );
    expect(main.commit.message.startsWith(`Change things (#${number})`)).toBe(true);
    await accessible(page, "merged pull request");
  });

  it("resolves a conflict in the web editor, from the keyboard", async () => {
    // A branch whose README conflicts with the base's once the base changes it too.
    await pushBranch("clash", { "README.md": "# Clash\n" });
    const number = await openPull("clash", "Clash");
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
    await page.goto(`${stack.origin}/${handle}/${name}/pull/${number}/conflicts`);
    await see(page.getByText("1 conflict left in this file.")).toBeVisible();
    await accessible(page, "conflicts");
    const editor = page.getByLabel(/^Resolved content of README\.md/);
    await see(editor).toHaveValue("<<<<<<< clash\n# Clash\n=======\n# Main\n>>>>>>> main\n");
    await page.getByRole("button", { name: "Next conflict" }).focus();
    await page.keyboard.press("Enter");
    await see(editor).toBeFocused();
    await page.getByRole("button", { name: "Keep both" }).focus();
    await page.keyboard.press("Enter");
    await see(page.getByText("No conflict markers left.", { exact: true })).toBeVisible();
    // The base moves again before the resolution is sent: it is refused, and the edit is
    // kept with the conflicts it was made against, never sent with a newer snapshot.
    const again = await rest<{ sha: string }>("GET", `/repos/${handle}/${name}/contents/README.md`);
    await rest("PUT", `/repos/${handle}/${name}/contents/README.md`, {
      message: "Retitle again",
      sha: again.sha,
      content: Buffer.from("# Main 2\n").toString("base64"),
    });
    await page.getByRole("button", { name: "Commit merge" }).click();
    await see(page.getByRole("alert")).toBeVisible();
    await see(
      page.getByText("The branches have moved since these conflicts were read"),
    ).toBeVisible();
    await see(editor).toHaveValue("# Clash\n# Main\n");
    await see(page.getByRole("button", { name: "Commit merge" })).toBeDisabled();
    await accessible(page, "conflicts moved");
    await page.getByRole("button", { name: "Read the conflicts again" }).click();
    await see(editor).toHaveValue("<<<<<<< clash\n# Clash\n=======\n# Main 2\n>>>>>>> main\n");
    await see(page.getByLabel("README.md (earlier edit, to copy from)")).toHaveValue(
      "# Clash\n# Main\n",
    );
    await editor.focus();
    await page.getByRole("button", { name: "Keep both" }).click();
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
    expect(Buffer.from(merged.content, "base64").toString()).toBe("# Clash\n# Main 2\n");
  });

  it("draws only a window of a long file's lines, following the scroll", async () => {
    // One long file, for the renderer to draw a window of.
    await pushBranch("big", {
      "big.txt": `${Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`).join("\n")}\n`,
    });
    const number = await openPull("big", "Big");
    await page.goto(`${stack.origin}/${handle}/${name}/pull/${number}/files`);
    const drawn = page.locator("section.file", { hasText: "big.txt" }).locator("diffs-container");
    await see(drawn.getByText("line 1", { exact: true })).toBeVisible({ timeout: 30_000 });
    const mounted = () =>
      drawn.evaluate(
        (el) =>
          (
            el as unknown as { shadowRoot: { querySelectorAll(s: string): { length: number } } }
          ).shadowRoot.querySelectorAll("[data-line]").length,
      );
    expect(await mounted()).toBeGreaterThan(0);
    expect(await mounted()).toBeLessThan(1000);
    // Scrolled to its end, the last lines are drawn, and still only a window of them.
    await page.keyboard.press("End");
    await see(drawn.getByText("line 3000", { exact: true })).toBeVisible({ timeout: 30_000 });
    expect(await mounted()).toBeLessThan(1000);
    await accessible(page, "a long file");
    // Away and back within the app: the page unmounts and mounts again, its virtualizer
    // with it, and still follows the scroll.
    await page.getByRole("link", { name: "Conversation" }).click();
    await see(page.getByRole("heading", { name: "Conversation" })).toBeVisible();
    await page.getByRole("link", { name: "Files changed" }).click();
    await see(drawn.getByText("line 1", { exact: true })).toBeVisible({ timeout: 30_000 });
    expect(await mounted()).toBeLessThan(1000);
    await page.keyboard.press("End");
    await see(drawn.getByText("line 3000", { exact: true })).toBeVisible({ timeout: 30_000 });
    expect(await mounted()).toBeLessThan(1000);
  });

  it("asks for the verdict again when the head moves under an unfinished review", async () => {
    // Someone else's pull request, so ada may approve it.
    const author = await rest<{ id: string }>("POST", "/admin/users", { handle: "bo" });
    const { token } = await rest<{ token: string }>("POST", `/admin/users/${author.id}/tokens`, {
      type: "pat",
      scopes: [],
      expires_in_days: 1,
    });
    await rest("PUT", `/repos/${handle}/${name}/collaborators/bo`, { permission: "pull" });
    await pushBranch("verdict", { "verdict.txt": "first\n" });
    const number = await openPull("verdict", "Verdict", { token });
    const first = await headOf(number);
    await page.goto(`${stack.origin}/${handle}/${name}/pull/${number}`);
    const review = page.locator("section", { has: page.getByRole("heading", { name: "Review" }) });
    await see(review.locator("legend")).toContainText(first.slice(0, 7));
    await review.getByLabel("Approve").check();
    await review.getByLabel(/^Review comment/).fill("Read the first version.");
    // The head moves, and the page reads the pull request again (after another change).
    await pushFile("verdict", "second.txt");
    const moved = await headOf(number);
    await page.getByRole("button", { name: "Convert to draft" }).click();
    await see(page.locator(".badge.status-draft")).toBeVisible();
    // The draft is now of the new head, its text kept and its verdict asked for again.
    await see(review.locator("legend")).toContainText(moved.slice(0, 7));
    await see(review.getByRole("alert")).toContainText(
      `The pull request moved to ${moved.slice(0, 7)}`,
    );
    await see(review.getByLabel("Approve")).not.toBeChecked();
    await see(review.getByLabel("Comment", { exact: true })).toBeChecked();
    await see(review.getByLabel(/^Review comment/)).toHaveValue("Read the first version.");
    await accessible(page, "review of a moved head");
    await review.getByLabel("Approve").check();
    await review.getByRole("button", { name: "Submit review" }).click();
    await see(review.getByRole("status")).toHaveText("Review submitted.");
    await see(review.getByRole("alert")).toHaveCount(0);
    const { reviews } = await rest<{ reviews: { state: string; commit_id: string }[] }>(
      "GET",
      `/repos/${handle}/${name}/pulls/${number}/reviews`,
    );
    expect(reviews.map((r) => [r.state, r.commit_id])).toEqual([["APPROVED", moved]]);
  });

  it("keeps unsent text while the page changes around it", async () => {
    await pushBranch("drafts", { "drafts.txt": `${lines(8).join("\n")}\n` });
    const number = await openPull("drafts", "Drafts");
    const first = await headOf(number);
    const pullApi = `/repos/${handle}/${name}/pulls/${number}`;
    const comment = (line: number, body: string) =>
      rest("POST", `${pullApi}/comments`, {
        body,
        commit_id: first,
        path: "drafts.txt",
        line,
        side: "RIGHT",
      });
    await comment(2, '```suggestion\nconst line2 = "two";\n```');
    await comment(6, "A plain remark.");
    // A comment being written survives a review joining the conversation.
    await page.goto(`${stack.origin}/${handle}/${name}/pull/${number}`);
    await page.getByLabel("Comment (Markdown)").fill("An unsent comment.");
    const review = page.locator("section", { has: page.getByRole("heading", { name: "Review" }) });
    await review.getByLabel(/^Review comment/).fill("A review meanwhile.");
    await review.getByRole("button", { name: "Submit review" }).click();
    await see(page.locator(".timeline").getByText("A review meanwhile.")).toBeVisible();
    await see(page.getByLabel("Comment (Markdown)")).toHaveValue("An unsent comment.");
    // A line comment being written survives picking other lines.
    await page.getByRole("link", { name: "Files changed" }).click();
    const file = page.locator("section.file", { hasText: "drafts.txt" });
    const drawn = file.locator("diffs-container");
    await see(drawn.getByText("const line8 = 8;")).toBeVisible({ timeout: 30_000 });
    await drawn.locator('[data-column-number="3"]').first().click();
    await see(file.getByLabel("Line", { exact: true })).toHaveValue("3");
    await file.getByLabel(/^Comment \(Markdown/).fill("An unsent line comment.");
    await drawn.locator('[data-column-number="5"]').first().click();
    await see(file.getByLabel("Line", { exact: true })).toHaveValue("5");
    await see(file.getByLabel(/^Comment \(Markdown/)).toHaveValue("An unsent line comment.");
    // A reply being written survives its thread leaving the diff: applying the other
    // thread's suggestion moves the head, and both threads go outdated.
    const remark = file.locator(".thread", { hasText: "A plain remark." });
    await remark.getByLabel("Reply").fill("An unsent reply.");
    await file.getByRole("button", { name: "Apply suggestion" }).click();
    await see(file.locator(".threads .thread", { hasText: "A plain remark." })).toBeVisible();
    await see(file.getByRole("status").filter({ hasText: "Suggestion applied." })).toBeVisible();
    await see(remark.getByLabel("Reply")).toHaveValue("An unsent reply.");
    await see(file.getByLabel(/^Comment \(Markdown/)).toHaveValue("An unsent line comment.");
    // Sent, a reply's box empties.
    await remark.getByRole("button", { name: "Reply" }).click();
    await see(remark.getByText("An unsent reply.")).toBeVisible();
    await see(remark.getByLabel("Reply")).toHaveValue("");
  });

  it("draws every diagram on the page, a later one leaving the earlier ones", async () => {
    await pushBranch("diagrams", { "diagrams.txt": "x\n" });
    const number = await openPull("diagrams", "Diagrams", {
      body: "```mermaid\ngraph TD\n  Start --> Stop\n```\n",
    });
    await page.goto(`${stack.origin}/${handle}/${name}/pull/${number}`);
    const description = page.locator("section", { has: page.locator("#pull-description") });
    await see(description.locator("figure.mermaid svg")).toHaveCount(1, { timeout: 30_000 });
    await page
      .getByLabel("Comment (Markdown)")
      .fill("```mermaid\ngraph LR\n  Here --> There\n```\n");
    await page.getByRole("button", { name: "Comment", exact: true }).click();
    const timeline = page.locator(".timeline");
    await see(timeline.locator("figure.mermaid svg")).toHaveCount(1, { timeout: 30_000 });
    await see(description.locator("figure.mermaid svg")).toHaveCount(1);
    await see(description.locator("figure.mermaid")).toContainText("Start");
    await see(timeline.locator("figure.mermaid")).toContainText("There");
  });

  it("never had a script, style or image refused by the policy on any page", () => {
    expect(stack.refused).toEqual([]);
  });
});
