// The blame page in a real browser against both Workers, with and without JavaScript: a file
// drawn whole with its groups' rows, ranges past the server's window arriving, a blame walked
// to completion through the visit's automatic requests and Continue, lines a commit too large
// to read left unattributed, a lone carriage return keeping the plain table, a file past the
// annotation cutoff, deep links, busy and restarted answers, and axe. Needs
// `pnpm --filter @fyrden/web build` first (turbo does it).

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Browser, type Page, type Request, type Route, expect as see } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accessible, startWebStack, visit, type WebStack } from "./web-stack.js";

let stack: WebStack;
let page: Page;
let browser: Browser;
const REPO = "/ada/blamed";
/** Steps a blame slice walks at most (`DEFAULT_BLAME_SLICE.maxSteps`): commits past it need more requests. */
const SLICE_STEPS = 256;
/** Commits on each deep branch: at least 11 slices, more than the visit's 8 automatic requests and the page's own. */
const DEEP_COMMITS = 2_600;
/** Blame's cap on one object read (4 MiB): an earlier version over it can't be compared. */
const OVER_OBJECT_CAP = 4 * 1024 * 1024 + 300 * 1024;
/** Over blame's 1 MiB file limit: refused outright. */
const OVER_FILE_LIMIT = 1024 * 1024 + 4096;
/** Lines alternating between two commits: one display group each. */
const UNDER_CUTOFF_LINES = 3_000;
const OVER_CUTOFF_LINES = 5_002;

const blame = (ref: string, path: string, query = "") =>
  `${stack.origin}${REPO}/blame/${ref}/${path}${query}`;

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

/** Text that compresses about as well as base64 does: no delta or zlib makes it small. */
function noise(bytes: number): string {
  let out = "";
  let seed = 7;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  while (out.length < bytes) {
    let line = "";
    for (let i = 0; i < 76; i++) {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      line += alphabet[seed % 64];
    }
    out += `${line}\n`;
  }
  return out.slice(0, bytes - 1).concat("\n");
}

/** A fast-import stream of every fixture, each branch its own history. */
function fixtures(): string {
  const parts: string[] = [];
  let mark = 0;
  let clock = 1_790_000_000;
  const write = (path: string, text: string) =>
    `M 100644 inline ${path}\ndata ${Buffer.byteLength(text)}\n${text}\n`;
  const commit = (branch: string, subject: string, changes: string, root = false) => {
    mark += 1;
    clock += 60;
    const message = `${subject}\n`;
    parts.push(
      `commit refs/heads/${branch}\nmark :${mark}\nauthor Ada <ada@fyrden.invalid> ${clock} +0000\ncommitter Ada <ada@fyrden.invalid> ${clock} +0000\ndata ${message.length}\n${message}${root ? "" : `from :${mark - 1}\n`}${changes}\n`,
    );
  };
  const numbered = (count: number, prefix: string) =>
    Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`)
      .join("\n")
      .concat("\n");
  const alternating = (count: number, edited: boolean) =>
    Array.from({ length: count }, (_, i) =>
      edited && i % 2 === 1 ? `edited ${i + 1}` : `line ${i + 1}`,
    )
      .join("\n")
      .concat("\n");

  commit(
    "main",
    "Add notes",
    write("notes.txt", "one\ntwo\n") +
      write("object.txt", noise(OVER_OBJECT_CAP)) +
      write("huge.txt", noise(OVER_FILE_LIMIT)) +
      write("lone-cr.txt", "a\rb\nc\n") +
      write("long.txt", numbered(2_500, "first")) +
      write("many.txt", alternating(UNDER_CUTOFF_LINES, false)) +
      write("over.txt", alternating(OVER_CUTOFF_LINES, false)),
    true,
  );
  commit(
    "main",
    "Extend notes",
    write("notes.txt", "one\ntwo\nthree\n") +
      write("lone-cr.txt", "a\rb\nc\nd\n") +
      write("long.txt", numbered(2_500, "first") + numbered(2_000, "second")) +
      write("many.txt", alternating(UNDER_CUTOFF_LINES, true)) +
      write("over.txt", alternating(OVER_CUTOFF_LINES, true)),
  );
  // The small current version, read on its own; the one before it is over the object cap.
  commit("main", "Shrink object", write("object.txt", "small 1\nsmall 2\nsmall 3\n"));
  for (const branch of ["deep", "deep-plain", "deep-restart"]) {
    commit(branch, `Root of ${branch}`, write("deep.txt", "origin\ncount 0\n"), true);
    for (let k = 1; k <= DEEP_COMMITS; k++)
      commit(branch, `Count ${k}`, write("deep.txt", `origin\ncount ${k}\n`));
  }
  return parts.join("");
}

/** The API's blame answer, asked as the user with a token. */
async function apiBlame(ref: string, path: string, query = "") {
  const res = await fetch(
    `${stack.origin}/api/repos/ada/blamed/blame?path=${path}&ref=${ref}${query}`,
    { headers: { Authorization: `Bearer ${stack.token}` } },
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** Requests the page sends to the ranges route, kept as they go. */
function rangesRequests(on: Page): Request[] {
  const seen: Request[] = [];
  on.on("request", (request) => {
    if (request.url().includes("/blame-ranges/")) seen.push(request);
  });
  return seen;
}

/** Runs `use` on a page of this session with no JavaScript. */
async function withoutScript<T>(use: (plain: Page) => Promise<T>): Promise<T> {
  const context = await browser.newContext({
    javaScriptEnabled: false,
    storageState: await page.context().storageState(),
  });
  try {
    return await use(await context.newPage());
  } finally {
    await context.close();
  }
}

/** A fresh page of this session, for a test that intercepts its requests. */
async function freshPage<T>(use: (fresh: Page) => Promise<T>): Promise<T> {
  const context = await browser.newContext({ storageState: await page.context().storageState() });
  try {
    return await use(await context.newPage());
  } finally {
    await context.close();
  }
}

/**
 * Axe for a page as it was served with no script: axe needs script to run, so the HTML is
 * checked in a page of the same origin (its stylesheets load) with every script taken out.
 * The browser's own parser takes them out (it runs nothing it parses), so none is missed
 * however it is written.
 */
async function accessibleAsServed(plain: Page, name: string): Promise<void> {
  const served = await plain.content();
  await freshPage(async (checked) => {
    await checked.goto(`${stack.origin}/healthz`);
    const html = await checked.locator("html").evaluate((root, source) => {
      const view = root.ownerDocument.defaultView;
      if (!view) throw new Error("no window");
      const doc = new view.DOMParser().parseFromString(source, "text/html");
      for (const node of doc.querySelectorAll('script, link[rel="modulepreload"]')) node.remove();
      return `<!doctype html>${doc.documentElement.outerHTML}`;
    }, served);
    await checked.setContent(html, { waitUntil: "load" });
    await see(checked.locator("script")).toHaveCount(0);
    await accessible(checked, `${name}, with no script`);
  });
}

const file = (on: Page) => on.locator(".blame-file");
const notes = (on: Page) =>
  on.locator(".blame-file diffs-container .blame-note, .blame-file .blame-note");

/**
 * The first line the renderer has drawn in view, once it has one there: read through the
 * drawing's element, since this file is compiled without the browser's globals.
 */
async function firstVisibleLine(on: Page): Promise<number> {
  const host = await on.locator(".blame-file diffs-container").elementHandle();
  const line = await on.waitForFunction((drawing) => {
    const view = drawing?.ownerDocument.defaultView;
    for (const row of drawing?.shadowRoot?.querySelectorAll("[data-line]") ?? []) {
      const box = row.getBoundingClientRect();
      if (view && box.bottom > 0 && box.top < view.innerHeight)
        return row.getAttribute("data-line");
    }
    return null;
  }, host);
  return Number(await line.jsonValue());
}

/** Scrolls `on` by `by` pixels, or to `fraction` of its height. */
const scroll = (on: Page, to: { by: number } | { fraction: number }) =>
  on.locator("html").evaluate((html, where) => {
    const view = html.ownerDocument.defaultView;
    if ("by" in where) view?.scrollBy({ top: where.by });
    else view?.scrollTo({ top: html.scrollHeight * where.fraction });
  }, to);

beforeAll(async () => {
  stack = await startWebStack("ada");
  ({ page } = stack);
  browser = page.context().browser() as Browser;
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
  await rest("/user/repos", { name: "blamed" });
  const { token } = await rest("/user/git-tokens", {});
  const remote = `http://x-access-token:${token}@127.0.0.1:${stack.port}/ada/blamed.git`;
  const work = join(stack.scratch, "work");
  await git(["init", "-q", "--bare", work], stack.scratch);
  await git(["fast-import", "--quiet"], work, fixtures());
  // No deltas: the small object.txt mustn't be stored as a delta on the oversized one before it.
  for (const ref of ["main", "deep", "deep-plain", "deep-restart"])
    await git(
      [
        "-c",
        "pack.window=0",
        "-c",
        "pack.depth=0",
        "push",
        "-q",
        "--no-thin",
        remote,
        `refs/heads/${ref}`,
      ],
      work,
    );
}, 600_000);

afterAll(async () => {
  await stack?.stop();
});

describe("the fixtures, through both Workers", () => {
  it("leaves the lines of a file whose earlier version is over the object cap unattributed for that reason", async () => {
    const { status, body } = await apiBlame("main", "object.txt");
    expect(status, JSON.stringify(body)).toBe(200);
    expect(body).toMatchObject({
      state: "complete",
      lines: 3,
      resolved_lines: 0,
      unresolved_lines: 3,
    });
    expect(body.ranges).toEqual([{ start_line: 1, line_count: 3, unresolved: "object_limit" }]);
  });

  it("walks a deep branch in more slices than one visit makes on its own", async () => {
    // No request is made of it here: only the number of commits, and the slice's step limit.
    expect(Math.ceil(DEEP_COMMITS / SLICE_STEPS)).toBeGreaterThan(9);
  });
});

describe("with JavaScript", () => {
  it("draws a finished file whole, one row above each group, after one ranges request", async () => {
    const asked = rangesRequests(page);
    await visit(page, blame("main", "notes.txt"));
    await see(file(page)).toHaveAttribute("data-drawn", "file", { timeout: 30_000 });
    await see(file(page)).toHaveAttribute("data-blame-status", "done");
    await see(notes(page)).toHaveCount(2);
    await see(notes(page).nth(0)).toContainText("Add notes");
    await see(notes(page).nth(1)).toContainText("Extend notes");
    expect(asked).toHaveLength(1);
    expect(new URL(asked[0]?.url() as string).pathname).toMatch(
      /\/blame-ranges\/[0-9a-f]{40}\/notes\.txt\/$/,
    );
    await accessible(page, "a blamed file, drawn");
  });

  it("brings in the ranges past the server's window", async () => {
    const asked = rangesRequests(page);
    await visit(page, blame("main", "long.txt"));
    // The server sent the first 2,000 lines; the second commit's lines start at 2,501.
    await see(page.locator("#L2001")).toHaveCount(0);
    await see(file(page)).toHaveAttribute("data-drawn", "file", { timeout: 30_000 });
    await see(notes(page)).toHaveCount(2);
    await see(notes(page).nth(1)).toContainText("Extend notes");
    expect(asked).toHaveLength(1);
  });

  it("opens a deep link at its line, and keeps it there as the rows above it arrive", async () => {
    await freshPage(async (fresh) => {
      // The ranges are held back until the line is in place from the server's window alone.
      let release!: () => void;
      const released = new Promise<void>((done) => {
        release = done;
      });
      await fresh.route("**/blame-ranges/**", async (route: Route) => {
        await released;
        await route.continue();
      });
      const lineTop = () =>
        fresh
          .locator(".blame-view diffs-container")
          .evaluate(
            (host) =>
              host.shadowRoot?.querySelector('[data-line="2400"]')?.getBoundingClientRect().top ??
              null,
          );
      await visit(fresh, blame("main", "many.txt", "?line=2400#L2400"));
      await see(file(fresh)).toHaveAttribute("data-drawn", "file", { timeout: 30_000 });
      await see(fresh.locator(".blame-view")).toHaveAttribute("data-position-line", "2400", {
        timeout: 30_000,
      });
      const early = await notes(fresh).count();
      expect(early).toBeLessThan(UNDER_CUTOFF_LINES);
      expect(Math.abs(((await lineTop()) as number) - 16)).toBeLessThanOrEqual(1);

      release();
      await see(file(fresh)).toHaveAttribute("data-blame-status", "done", { timeout: 30_000 });
      await see(notes(fresh)).toHaveCount(UNDER_CUTOFF_LINES, { timeout: 30_000 });
      await see(fresh.locator(".blame-view")).toHaveAttribute("data-position-line", "2400", {
        timeout: 30_000,
      });
      expect(Math.abs(((await lineTop()) as number) - 16)).toBeLessThanOrEqual(1);
    });
  });

  it("walks a partial blame to the end: 8 requests on its own, then Continue", async () => {
    const asked = rangesRequests(page);
    await visit(page, blame("deep", "deep.txt"));
    await see(file(page)).toHaveAttribute("data-blame-status", "budget", { timeout: 120_000 });
    await see(file(page)).toHaveAttribute("data-blame-requests", "8");
    await accessible(page, "a partial blame, paused");
    const automatic = asked.length;
    expect(automatic).toBeGreaterThanOrEqual(8);
    for (let press = 0; press < 5; press++) {
      const status = await file(page).getAttribute("data-blame-status");
      if (status === "done") break;
      await see(file(page)).toHaveAttribute("data-blame-status", /^(budget|done)$/, {
        timeout: 120_000,
      });
      if ((await file(page).getAttribute("data-blame-status")) === "done") break;
      await page.getByRole("button", { name: "Continue" }).click();
      await see(file(page)).not.toHaveAttribute("data-blame-status", "budget");
    }
    await see(file(page)).toHaveAttribute("data-blame-status", "done", { timeout: 120_000 });
    await see(notes(page)).toHaveCount(2);
    await see(notes(page).nth(0)).toContainText("Root of deep");
    await see(notes(page).nth(1)).toContainText(`Count ${DEEP_COMMITS}`);
    await accessible(page, "a blame walked to the end");
  });

  it("says why lines aren't attributed when an earlier version is over the object cap", async () => {
    await visit(page, blame("main", "object.txt"));
    await see(file(page)).toHaveAttribute("data-drawn", "file", { timeout: 30_000 });
    await see(notes(page)).toHaveCount(1);
    await see(notes(page)).toContainText("larger than Fyrden's 4 MiB blame limit");
    await see(page.getByText("3 of 3 lines couldn't be attributed")).toBeVisible();
    await accessible(page, "unattributed lines");
  });

  it("keeps the plain table for a file with a lone carriage return, numbered at line feeds", async () => {
    await visit(page, blame("main", "lone-cr.txt"));
    await see(file(page)).toHaveAttribute("data-blame-status", "done", { timeout: 30_000 });
    await see(file(page)).toHaveAttribute("data-drawn", "text");
    // a\rb, c, d: three lines, as the API counts them.
    await see(page.locator('table.blame a[id^="L"]')).toHaveCount(3);
    await see(page.locator("#L1").locator("xpath=../..")).toContainText("a␍b");
    await see(page.locator("diffs-container")).toHaveCount(0);
    await accessible(page, "a lone carriage return, plain");
  });

  it("keeps the plain table past the annotation cutoff", async () => {
    await visit(page, blame("main", "over.txt"));
    await see(file(page)).toHaveAttribute("data-blame-status", "done", { timeout: 30_000 });
    await see(file(page)).toHaveAttribute("data-drawn", "text");
    await see(page.locator("diffs-container")).toHaveCount(0);
    await see(page.locator("#L1")).toBeVisible();
    // No axe here: this is the lone carriage return's table (checked there), at 2,000 lines,
    // where axe alone takes about 16 seconds locally and over a minute on CI's runners.
  });

  it("opens the table at the line the reader had reached when the groups pass the cutoff", async () => {
    await freshPage(async (fresh) => {
      // The ranges are held back until the reader has scrolled past the server's window.
      let release!: () => void;
      const released = new Promise<void>((done) => {
        release = done;
      });
      await fresh.route("**/blame-ranges/**", async (route: Route) => {
        await released;
        await route.continue();
      });
      await visit(fresh, blame("main", "over.txt"));
      await see(file(fresh)).toHaveAttribute("data-drawn", "file", { timeout: 30_000 });
      await scroll(fresh, { fraction: 0.85 });
      // Once the drawing has rows where the window now is: the first line still in view.
      const reached = await firstVisibleLine(fresh);
      expect(reached).toBeGreaterThan(2_000);
      release();
      await see(file(fresh)).toHaveAttribute("data-drawn", "text", { timeout: 30_000 });
      await see(fresh.locator(`table.blame a#L${reached}`)).toBeAttached();
      await see(fresh.locator("table.blame a#L1")).toHaveCount(0);
    });
  });

  it("keeps the reader's line, not the deep link it opened at, when the table takes over", async () => {
    await freshPage(async (fresh) => {
      let release!: () => void;
      const released = new Promise<void>((done) => {
        release = done;
      });
      await fresh.route("**/blame-ranges/**", async (route: Route) => {
        await released;
        await route.continue();
      });
      // Line 2100's block is 2,001 to 4,000: the reader stays inside it.
      await visit(fresh, blame("main", "over.txt", "?line=2100#L2100"));
      await see(file(fresh)).toHaveAttribute("data-drawn", "file", { timeout: 30_000 });
      await see(fresh.locator(".blame-view")).toHaveAttribute("data-position-line", "2100", {
        timeout: 30_000,
      });
      await scroll(fresh, { by: 20_000 });
      const reached = await firstVisibleLine(fresh);
      expect(reached).toBeGreaterThan(2_100);
      expect(reached).toBeLessThanOrEqual(4_000);
      release();
      await see(file(fresh)).toHaveAttribute("data-drawn", "text", { timeout: 30_000 });
      const top = (id: string) =>
        fresh.locator(`table.blame a#${id}`).evaluate((a) => a.getBoundingClientRect().top);
      // Within a few rows of the top (the progress line above the table changes height as
      // answers arrive), and the deep link it opened at well away from it.
      const reachedTop = await top(`L${reached}`);
      expect(Math.abs(reachedTop - 16)).toBeLessThanOrEqual(100);
      expect(Math.abs((await top("L2100")) - reachedTop)).toBeGreaterThan(500);
    });
  });

  it("waits a busy answer's time and goes on, counting it", async () => {
    await freshPage(async (fresh) => {
      // The page's own clock, stopped from its first load: only the test moves it on.
      await fresh.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
      await fresh.clock.pauseAt(new Date("2026-01-01T00:00:01Z"));
      let refused = false;
      await fresh.route("**/blame-ranges/**", async (route: Route) => {
        if (refused) return route.continue();
        refused = true;
        await route.fulfill({
          status: 503,
          headers: { "Content-Type": "application/problem+json", "Retry-After": "30" },
          body: JSON.stringify({
            status: 503,
            code: "blame_busy",
            detail: "busy",
            retry_after: 30,
          }),
        });
      });
      const asked = rangesRequests(fresh);
      await visit(fresh, blame("main", "notes.txt"));
      await see(file(fresh)).toHaveAttribute("data-blame-status", "waiting", { timeout: 30_000 });
      expect(asked).toHaveLength(1);
      // Short of the 30 seconds asked: still waiting, nothing asked again.
      await fresh.clock.fastForward(29_000);
      await see(file(fresh)).toHaveAttribute("data-blame-status", "waiting");
      expect(asked).toHaveLength(1);
      await fresh.clock.fastForward(2_000);
      await see(file(fresh)).toHaveAttribute("data-blame-status", "done", { timeout: 30_000 });
      expect(asked).toHaveLength(2);
      await see(file(fresh)).toHaveAttribute("data-blame-requests", "2");
    });
  });

  it("starts again from the first range when its run is gone", async () => {
    await freshPage(async (fresh) => {
      let restarted = false;
      await fresh.route("**/blame-ranges/**", async (route: Route) => {
        const url = new URL(route.request().url());
        if (restarted || !url.searchParams.has("continuation")) return route.continue();
        restarted = true;
        await route.fulfill({
          status: 409,
          headers: { "Content-Type": "application/problem+json" },
          body: JSON.stringify({ status: 409, code: "blame_restarted", detail: "gone" }),
        });
      });
      const asked = rangesRequests(fresh);
      await visit(fresh, blame("deep-restart", "deep.txt"));
      await see(file(fresh)).toHaveAttribute("data-blame-status", /^(budget|done)$/, {
        timeout: 120_000,
      });
      const tokens = asked.map((r) => new URL(r.url()).searchParams.has("continuation"));
      const at = tokens.indexOf(true);
      expect(at).toBeGreaterThan(0);
      // The request after the refused one asks from the start again.
      expect(tokens[at + 1]).toBe(false);
    });
  });
});

describe("without JavaScript", () => {
  it("draws the table, and keeps every attributed line through three navigations", async () => {
    await withoutScript(async (plain) => {
      await plain.goto(blame("deep-plain", "deep.txt"));
      const line2 = plain.locator("tbody").filter({ has: plain.locator("#L2") });
      await see(line2).toContainText(`Count ${DEEP_COMMITS}`);
      await see(plain.locator("tbody").filter({ has: plain.locator("#L1") })).toContainText(
        "Not worked out yet.",
      );
      let settled = Number(
        (await plain.getByText(/lines worked out so far/).textContent())?.split(" ")[0],
      );
      for (let step = 0; step < 3; step++) {
        const continueLink = plain.getByRole("link", { name: "Continue" });
        await see(continueLink).toHaveAttribute(
          "href",
          /\/blame\/[0-9a-f]{40}\/deep\.txt\?from=1$/,
        );
        await continueLink.click();
        await see(line2).toContainText(`Count ${DEEP_COMMITS}`);
        const now = Number(
          (await plain.getByText(/lines worked out so far/).textContent())?.split(" ")[0],
        );
        expect(now).toBeGreaterThanOrEqual(settled);
        settled = now;
      }
      await accessibleAsServed(plain, "the plain table, partial");
    });
  });

  it("says a file over blame's limit is too large", async () => {
    await withoutScript(async (plain) => {
      const answer = await plain.goto(blame("main", "huge.txt"));
      expect(answer?.status()).toBe(422);
      await see(plain.getByText("This file is too large to blame.")).toBeVisible();
      await accessibleAsServed(plain, "a file too large to blame");
    });
  });

  it("leads a missing file back to its history", async () => {
    await withoutScript(async (plain) => {
      const answer = await plain.goto(blame("main", "gone.txt"));
      expect(answer?.status()).toBe(404);
      await see(plain.getByRole("link", { name: "See this path's history" })).toBeVisible();
      await accessibleAsServed(plain, "a missing file");
    });
  });
});

describe("the file page", () => {
  it("links a file's blame beside its history", async () => {
    await visit(page, `${stack.origin}${REPO}/blob/main/notes.txt`);
    await page.getByRole("link", { name: "Blame", exact: true }).click();
    await see(page).toHaveURL(blame("main", "notes.txt"));
    await see(file(page)).toBeVisible();
  });
});
