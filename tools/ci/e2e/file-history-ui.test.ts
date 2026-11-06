// A file's history in a real browser against both Workers: on a branch whose name holds a
// slash and on a tag, through stretches of history that change nothing for the file, to a
// file a commit deleted. Needs `pnpm --filter @fyrden/web build` first (turbo does it).

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Page, expect as see } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accessible, startWebStack, visit, type WebStack } from "./web-stack.js";

let stack: WebStack;
let page: Page;
const REPO = "/ada/history";
/** Enough commits between the file's two changes that a whole page of history (2,000 examined) has none. */
const FILLER_COMMITS = 4_500;

function git(args: string[], cwd: string, input?: string): Promise<string> {
  return new Promise((done, fail) => {
    const child = spawn("git", args, {
      cwd,
      env: {
        ...process.env,
        HOME: join(stack.scratch, "home"),
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: join(stack.scratch, "home/.gitconfig"),
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    let out = "";
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (d: Buffer) => {
        out += d;
      });
    child.on("error", fail);
    child.on("close", (code) =>
      code === 0
        ? done(out)
        : fail(new Error(`git ${args[0]}: ${out.replace(/\/\/[^/@\s]*@/g, "//***@")}`)),
    );
    child.stdin.end(input);
  });
}

/** A fast-import stream: the file, filler that never touches it, a change, then a deletion. */
function history(): string {
  const parts: string[] = [];
  let mark = 0;
  const commit = (subject: string, change: string) => {
    mark += 1;
    const from = mark > 1 ? `from :${mark - 1}\n` : "";
    const message = `${subject}\n`;
    parts.push(
      `commit refs/heads/topic/next\nmark :${mark}\ncommitter Ada <ada@fyrden.invalid> ${1_790_000_000 + mark} +0000\ndata ${message.length}\n${message}${from}${change}\n`,
    );
  };
  const write = (path: string, text: string) =>
    `M 100644 inline ${path}\ndata ${text.length}\n${text}\n`;
  commit("First version of notes", `${write("notes.txt", "one\n")}${write("old.txt", "old\n")}`);
  for (let i = 0; i < FILLER_COMMITS; i++) commit(`Filler ${i}`, write("filler.txt", `${i}\n`));
  commit("Second version of notes", write("notes.txt", "two\n"));
  commit("Remove old", "D old.txt\n");
  return parts.join("");
}

beforeAll(async () => {
  stack = await startWebStack("ada");
  ({ page } = stack);
  await mkdir(join(stack.scratch, "home"), { recursive: true });
  await writeFile(join(stack.scratch, "home/.gitconfig"), "");
  const rest = async (path: string, body: unknown) => {
    const res = await fetch(`${stack.origin}/api${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${stack.token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    expect(res.ok, `${path}: ${text}`).toBe(true);
    return JSON.parse(text) as { token: string };
  };
  await rest("/user/repos", { name: "history" });
  const { token } = await rest("/user/git-tokens", {});
  const remote = `http://x-access-token:${token}@127.0.0.1:${stack.port}/ada/history.git`;
  const work = join(stack.scratch, "work");
  await git(["init", "-q", "--bare", work], stack.scratch);
  await git(["fast-import", "--quiet"], work, history());
  await git(["tag", "v1", "refs/heads/topic/next"], work);
  const first = (await git(["rev-list", "--max-parents=0", "refs/heads/topic/next"], work)).trim();
  await git(["branch", "short", first], work);
  await git(["push", "-q", remote, "refs/heads/topic/next:refs/heads/main"], work);
  await git(
    ["push", "-q", remote, "refs/heads/topic/next", "refs/heads/short", "refs/tags/v1"],
    work,
  );
}, 240_000);

afterAll(async () => {
  await stack?.stop();
});

/** Follows the pager to the older commit named `subject`: how many empty stretches it crossed. */
async function pageTo(subject: string): Promise<number> {
  const row = page.getByRole("cell", { name: subject });
  const pager = page.getByRole("link", { name: /^(Continue|Older commits)$/ });
  let emptyStretches = 0;
  for (let step = 0; step < 20; step++) {
    await see(row.or(pager).first()).toBeVisible();
    if (await row.isVisible()) return emptyStretches;
    if ((await pager.textContent()) === "Continue") {
      emptyStretches += 1;
      await accessible(page, "an empty stretch of history");
    }
    const before = page.url();
    await pager.click();
    await see(page).not.toHaveURL(before);
  }
  throw new Error(`${subject} is not within 20 pages.`);
}

describe("a file's history", () => {
  it("opens from the file, staying on its revision, and pages to its first change", async () => {
    await visit(page, `${stack.origin}${REPO}/blob/topic%2Fnext/notes.txt`);
    await page.getByRole("link", { name: "History", exact: true }).click();
    const history = `${stack.origin}${REPO}/commits/topic%2Fnext/notes.txt`;
    await see(page).toHaveURL(history);
    await see(page.getByText("Renames aren't followed")).toBeVisible();
    await see(page.getByRole("cell", { name: "Second version of notes" })).toBeVisible();
    await see(page.getByRole("cell", { name: "Filler 1" })).toHaveCount(0);
    await accessible(page, "a file's history");

    const empty = await pageTo("First version of notes");
    expect(empty, "stretches with no change for this file").toBeGreaterThanOrEqual(1);
    await see(page).toHaveURL(new RegExp(`^${history}\\?cursor=`));

    // The rows lead to the file at each commit, and to the tree at each commit.
    await page.getByRole("link", { name: "View file" }).first().click();
    await see(page).toHaveURL(/\/blob\/[0-9a-f]{40}\/notes\.txt$/);
    await see(page.getByText("one")).toBeVisible();
    await page.goBack();
    const sha = page.locator("tbody tr").first().getByRole("link").first();
    await sha.click();
    await see(page).toHaveURL(/\/tree\/[0-9a-f]{40}/);
  });

  it("stays on a tag", async () => {
    await visit(page, `${stack.origin}${REPO}/commits/v1/notes.txt`);
    await see(page.getByRole("cell", { name: "Second version of notes" })).toBeVisible();
    await page
      .getByRole("link", { name: "Older commits" })
      .or(page.getByRole("link", { name: "Continue" }))
      .first()
      .click();
    await see(page).toHaveURL(/\/commits\/v1\/notes\.txt\?cursor=/);
  });

  it("shows a whole revision's history with no path", async () => {
    await visit(page, `${stack.origin}${REPO}/commits/topic%2Fnext`);
    await see(page.getByRole("cell", { name: "Remove old" })).toBeVisible();
    await see(page.getByRole("link", { name: "View file" })).toHaveCount(0);
  });

  it("says when nothing changed a path, without calling the repository empty", async () => {
    await visit(page, `${stack.origin}${REPO}/commits/short/never-there.txt`);
    await see(page.getByText("No commits changed this path at this revision.")).toBeVisible();
    await see(page.getByText("No commits yet.")).toHaveCount(0);
    await accessible(page, "a path with no history");
  });

  it("leads from a commit that deleted a file to that file's history", async () => {
    await visit(page, `${stack.origin}${REPO}/commits/main/old.txt`);
    await see(page.getByRole("cell", { name: "Remove old" })).toBeVisible();
    await page
      .getByRole("row", { name: /Remove old/ })
      .getByRole("link", { name: "View file" })
      .click();
    await see(page.getByText(/This file doesn't exist at/)).toBeVisible();
    await accessible(page, "a deleted file");
    await page.getByRole("link", { name: "See this path's history" }).click();
    await see(page).toHaveURL(/\/commits\/[0-9a-f]{40}\/old\.txt$/);
    await see(page.getByRole("cell", { name: "Remove old" })).toBeVisible();
    expect(stack.refused).toEqual([]);
  });
});
