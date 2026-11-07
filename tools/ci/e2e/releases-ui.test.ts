// Releases in a real browser against both Workers, through the service
// binding: the page is reachable from the repository's navigation; a tag
// that doesn't exist is refused with what was written kept; a draft is saved
// and published; a slashed tag survives every link; the source archive
// downloads the recorded commit after the tag has gone; and every page passes
// axe in each theme. Needs `pnpm --filter @fyrden/web build` first (turbo does it).
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { type Page, expect as see } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accessible, startWebStack, visit, type WebStack } from "./web-stack.js";

let stack: WebStack;
let page: Page;
let work: string;
const handle = "ada";
const name = "shipping";
const REPO = `/${handle}/${name}`;
const HOSTILE = "<img src=x onerror=window.pwned=1> crash";

function git(args: string[], cwd: string): Promise<string> {
  return new Promise((done, fail) => {
    execFile(
      "git",
      args,
      {
        cwd,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Ada",
          GIT_AUTHOR_EMAIL: "ada@example.com",
          GIT_COMMITTER_NAME: "Ada",
          GIT_COMMITTER_EMAIL: "ada@example.com",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_TERMINAL_PROMPT: "0",
        },
      },
      (error, stdout, stderr) =>
        error ? fail(new Error(`${error.message}\n${stderr}`)) : done(stdout),
    );
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
  return (text ? JSON.parse(text) : undefined) as T;
}

beforeAll(async () => {
  stack = await startWebStack(handle);
  page = stack.page;
  await rest("POST", "/user/repos", { name });
  work = join(stack.scratch, name);
  await mkdir(work);
  await git(["init", "-q", "-b", "main"], work);
  await git(["commit", "-q", "--allow-empty", "-m", "first"], work);
  await git(["tag", "-a", "v1/rc", "-m", "the first"], work);
  const { token } = await rest<{ token: string }>("POST", "/user/git-tokens", {});
  const remote = `http://x-access-token:${token}@127.0.0.1:${stack.port}/${handle}/${name}.git`;
  await git(["remote", "add", "origin", remote], work);
  await git(["push", "-q", "origin", "refs/heads/main", "refs/tags/v1/rc"], work);
}, 180_000);

afterAll(async () => {
  await stack?.stop();
});

/** Axe, in each colour scheme. */
const checked = (what: string) => accessible(page, what);

describe("releases", () => {
  it("are reached from the repository, empty at first", async () => {
    await visit(page, `${stack.origin}${REPO}`);
    await page.getByRole("link", { name: "Releases", exact: true }).click();
    await see(page.getByText("No releases yet.")).toBeVisible();
    await checked("the empty list");
  });

  it("refuses a tag that doesn't exist, keeping what was written", async () => {
    await visit(page, `${stack.origin}${REPO}/releases/new`);
    await page.getByLabel("Tag", { exact: true }).fill("absent");
    await page.getByLabel(/^Title/).fill(HOSTILE);
    await page.getByLabel(/^Notes/).fill("Keep me.");
    await page.getByRole("button", { name: "Publish release" }).click();
    await see(page.getByRole("alert")).toContainText("Push it first");
    await see(page.getByLabel(/^Notes/)).toHaveValue("Keep me.");
    await checked("the refused form");
  });

  it("saves a draft, then publishes it, through a slashed tag", async () => {
    await page.getByLabel("Tag", { exact: true }).fill("v1/rc");
    await page.getByRole("button", { name: "Save draft" }).click();
    await see(page).toHaveURL(new RegExp(`${REPO}/releases/tag/v1/rc$`));
    await see(page.getByText("Draft", { exact: true })).toBeVisible();
    await see(page.getByRole("link", { name: /tar\.gz/ })).toHaveCount(0);
    await checked("a draft's page");
    await page.getByRole("link", { name: "Edit release" }).click();
    await page.getByRole("button", { name: "Publish release" }).click();
    await see(page).toHaveURL(new RegExp(`${REPO}/releases/tag/v1/rc$`));
    await see(page.getByText("Published", { exact: true })).toBeVisible();
    await see(page.getByRole("heading", { level: 2 })).toContainText(HOSTILE);
    expect(await page.evaluate("window.pwned")).toBeUndefined();
    await checked("a published release");
  });

  it("records a tag of a tag as the commit it finally peels to", async () => {
    await git(["tag", "-a", "nested", "v1/rc", "-m", "a tag of a tag"], work);
    await git(["push", "-q", "origin", "refs/tags/nested"], work);
    const commit = (await git(["rev-parse", "nested^{commit}"], work)).trim();
    const object = (await git(["rev-parse", "nested"], work)).trim();
    const made = await rest<{ id: number; tag_sha: string; commit_sha: string }>(
      "POST",
      `/repos/${handle}/${name}/releases`,
      { tag_name: "nested" },
    );
    expect(made).toMatchObject({ tag_sha: object, commit_sha: commit });
    await rest("DELETE", `/repos/${handle}/${name}/releases/${made.id}`);
  });

  it("keeps its source archive after the tag is deleted, and says so", async () => {
    const release = await rest<{ commit_sha: string }>(
      "GET",
      `/repos/${handle}/${name}/releases/tags/v1/rc`,
    );
    await git(["push", "-q", "origin", ":refs/tags/v1/rc"], work);
    await visit(page, `${stack.origin}${REPO}/releases/tag/v1/rc`);
    await see(page.getByRole("note")).toContainText("has been deleted");
    const link = page.getByRole("link", { name: "Source (tar.gz)" });
    await see(link).toHaveAttribute("href", `${REPO}/archive/tar.gz?ref=${release.commit_sha}`);
    const answer = await page.request.get(`${stack.origin}${await link.getAttribute("href")}`);
    expect(answer.status()).toBe(200);
    await checked("a release whose tag is gone");
  });

  it("is listed, and goes when deleted", async () => {
    await visit(page, `${stack.origin}${REPO}/releases`);
    const entry = page.getByRole("link", { name: HOSTILE });
    await see(entry).toBeVisible();
    await checked("the list");
    await entry.click();
    await page.getByText("Delete", { exact: true }).click();
    await page.getByRole("button", { name: "Delete release v1/rc" }).click();
    await see(page.getByText("No releases yet.")).toBeVisible();
  });

  it("broke no Content Security Policy on the way", () => {
    expect(stack.refused).toEqual([]);
  });
});
