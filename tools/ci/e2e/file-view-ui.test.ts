// The file page in a real browser against both Workers, with and without JavaScript: numbered
// lines that agree with the renderer's rows, line links, go to line, a file paged in blocks,
// the fall back to plain text, Fjord's colours and a scheme change in place. Needs
// `pnpm --filter @fyrden/web build` first (turbo does it).

import { type Browser, type Locator, type Page, type Route, expect as see } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FJORD, type Scheme } from "../../../apps/web/app/lib/fjord.js";
import { accessible, startWebStack, visit, type WebStack } from "./web-stack.js";

let stack: WebStack;
let page: Page;
let browser: Browser;
const REPO = "/ada/files";
const blob = (path: string) => `${stack.origin}${REPO}/blob/main/${path}`;

/** `count` lines of TypeScript, each naming its number, with no final line ending. */
const code = (count: number) =>
  Array.from({ length: count }, (_, i) => `const line${i + 1} = ${i + 1};`).join("\n");

/** Each file's bytes, and the lines it has: written out, never worked out by the page's helper. */
const NUMBERING: readonly (readonly [string, string, number])[] = [
  ["crlf.ts", "const a = 1;\r\nconst b = 2;\r\n", 2],
  ["no-final-newline.ts", "const a = 1;\nconst b = 2;", 2],
  ["final-newline.ts", "const a = 1;\n", 1],
  ["blank-last-line.ts", "const a = 1;\n\n", 2],
  ["lone-cr.ts", "const a = 1;\rconst b = 2;", 2],
  ["mixed.ts", "const a = 1;\nconst b = 2;\r\nconst c = 3;\rconst d = 4;\n", 4],
  ["only-newline.ts", "\n", 1],
];

/** The renderer highlights up to these, and draws plain text above either. */
const HIGHLIGHT_BYTES = 256 * 1024;
const HIGHLIGHT_LINES = 10_000;
const LIMIT = {
  bytesAt: "limit-bytes-at.ts",
  bytesOver: "limit-bytes-over.ts",
  linesAt: "limit-lines-at.ts",
  linesOver: "limit-lines-over.ts",
};

/** Exactly `size` bytes of TypeScript, far under the limit on lines. */
function ofBytes(size: number): string {
  const line = `const padded = "${"x".repeat(200)}";\n`;
  const lines = line.repeat(Math.floor(size / line.length) - 1);
  const rest = size - lines.length - "const last = 1; //\n".length;
  return `${lines}const last = 1; //${"x".repeat(rest)}\n`;
}

async function put(path: string, bytes: string | Buffer): Promise<void> {
  const res = await fetch(`${stack.origin}/api/repos/ada/files/contents/${path}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${stack.token}`,
      "Content-Type": "application/json",
      "Idempotency-Key": crypto.randomUUID(),
    },
    body: JSON.stringify({
      message: `Add ${path}`,
      content: Buffer.from(bytes).toString("base64"),
    }),
  });
  expect(res.status, `${path}: ${await res.clone().text()}`).toBeLessThan(300);
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

/** The renderer's rows have taken over from the plain view. */
async function drawn(on: Page = page): Promise<Locator> {
  await see(on.locator(".file-view")).toHaveAttribute("data-drawn", "file", { timeout: 30_000 });
  await see(on.locator(".file-lines")).toHaveCount(0);
  return on.locator(".file-view diffs-container");
}

const row = (view: Locator, line: number) => view.locator(`[data-line="${line}"]`);
const numberCell = (view: Locator, line: number) =>
  view.locator(`[data-column-number][data-line-index="${line - 1}"]`);
const search = (on: Page = page) => {
  const { search: query, hash } = new URL(on.url());
  return `${query}${hash}`;
};

/**
 * Does `act`, and returns once `on` is at `expected` (a query and fragment): armed first, so
 * it is the browser's own navigation event that ends the wait, never a timed look at the URL.
 */
async function arrives(expected: string, act: () => Promise<unknown>, on: Page = page) {
  const there = on.waitForURL((url) => `${url.search}${url.hash}` === expected);
  await act();
  await there;
}

/**
 * Does `act`, a navigation on the same document, and returns once the router has committed it:
 * its `ScrollRestoration` has run by then, so the view is not on its way to anywhere else.
 */
async function committed(act: () => Promise<unknown>): Promise<void> {
  const view = page.locator(".file-view");
  const before = (await view.getAttribute("data-router-commits")) ?? "";
  await act();
  await see(view).not.toHaveAttribute("data-router-commits", before);
}

/** Sets the fragment, as a person editing the address would. */
const goToFragment = (hash: string) =>
  page.evaluate((to) => {
    (globalThis as unknown as { location: { hash: string } }).location.hash = to;
  }, hash);

/** `#rrggbb` as `getComputedStyle` reports it. */
function rgb(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

/** A row's token that reads `const` (a token holds the space after it). */
const keyword = (view: Locator, line: number) =>
  row(view, line).locator("span", { hasText: /^const\s*$/ });

/** `view` is drawn in `scheme`'s colours. */
async function coloured(view: Locator, scheme: Scheme): Promise<void> {
  await see(keyword(view, 1)).toHaveCSS("color", rgb(scheme.syntax.keyword));
  await see(numberCell(view, 1)).toHaveCSS("color", rgb(scheme.page.muted));
}

beforeAll(async () => {
  stack = await startWebStack("ada");
  ({ page } = stack);
  const context = page.context().browser();
  if (!context) throw new Error("The stack's page has no browser.");
  browser = context;
  const res = await fetch(`${stack.origin}/api/user/repos`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${stack.token}`,
      "Content-Type": "application/json",
      "Idempotency-Key": crypto.randomUUID(),
    },
    body: JSON.stringify({ name: "files" }),
  });
  expect(res.ok).toBe(true);
  await put("README.md", `# Title\n\n${"Some text.\n\n".repeat(10)}`);
  for (const [path, bytes] of NUMBERING) await put(path, bytes);
  await put("empty.ts", "");
  await put("failed.ts", "failed");
  await put("failed-newline.ts", "failed\n");
  await put(LIMIT.bytesAt, ofBytes(HIGHLIGHT_BYTES));
  await put(LIMIT.bytesOver, ofBytes(HIGHLIGHT_BYTES + 1));
  await put(LIMIT.linesAt, code(HIGHLIGHT_LINES));
  await put(LIMIT.linesOver, code(HIGHLIGHT_LINES + 1));
  await put("long-line.ts", `const a = 1;\nconst b = "${"x".repeat(70_000)}";\nconst c = 3;\n`);
  await put("binary.bin", Buffer.from([0x61, 0x00, 0x62]));
  await put("latin1.txt", Buffer.from([0x63, 0x61, 0x66, 0xe9]));
  await put("lines.ts", code(200));
  await put("big.ts", code(4_500));
  await put("notes.data", "first note\nsecond note\nthird note\n");
  await put("many.data", code(2_500));
}, 240_000);

afterAll(async () => {
  await stack?.stop();
});

describe("a file's lines", () => {
  it("draws a file where the browser has no crypto.randomUUID, as over plain HTTP", async () => {
    const context = await page
      .context()
      .browser()
      ?.newContext({
        storageState: await page.context().storageState(),
      });
    if (!context) throw new Error("The page has no browser.");
    try {
      await context.addInitScript(() => {
        delete (Crypto.prototype as { randomUUID?: unknown }).randomUUID;
      });
      const visitor = await context.newPage();
      const failures: string[] = [];
      visitor.on("pageerror", (error) => failures.push(error.message));
      await visitor.goto(blob("lines.ts"));
      await visitor.locator("html[data-hydrated]").waitFor({ state: "attached" });
      await see(visitor.locator(".file-view")).toBeVisible();
      expect(failures).toEqual([]);
    } finally {
      await context.close();
    }
  });

  it("numbers lines alike with and without JavaScript", async () => {
    for (const [path, , lines] of NUMBERING) {
      await visit(page, blob(path));
      const view = await drawn();
      await see(view.locator("[data-line]"), `${path}, drawn`).toHaveCount(lines);
      await see(view.locator("[data-column-number]"), `${path}, its gutter`).toHaveCount(lines);
      await withoutScript(async (plain) => {
        await plain.goto(blob(path));
        await see(plain.locator(".file-line"), `${path}, plain`).toHaveCount(lines);
        await see(plain.locator(`a#L${lines}`)).toHaveAttribute("href", `?line=${lines}#L${lines}`);
      });
    }
  });

  it("says what a file is that has no lines to show", async () => {
    for (const [path, message] of [
      ["empty.ts", "This file is empty."],
      ["binary.bin", "This is a binary file."],
      ["latin1.txt", "This file isn't valid UTF-8."],
    ] as const) {
      await visit(page, blob(path));
      await see(page.getByText(message)).toBeVisible();
      await see(page.locator("diffs-container")).toHaveCount(0);
      await see(page.getByRole("link", { name: "Raw" })).toBeVisible();
      await see(page.getByLabel("Go to line")).toHaveCount(0);
      await withoutScript(async (plain) => {
        await plain.goto(blob(path));
        await see(plain.getByText(message)).toBeVisible();
        await see(plain.locator(".file-line")).toHaveCount(0);
      });
    }
    await accessible(page, "a file with no lines to show");
  });

  it("lays the renderer's rows where the plain lines were", async () => {
    const topOf = (line: Locator) =>
      line.evaluate(
        (element) =>
          (
            element as unknown as { getBoundingClientRect(): { top: number } }
          ).getBoundingClientRect().top,
      );
    // A file sent whole, and one whose paging links give way to the renderer.
    for (const path of ["lines.ts", "big.ts"]) {
      const plainTop = await withoutScript(async (plain) => {
        await plain.goto(blob(path));
        return topOf(plain.locator(".file-line").nth(4));
      });
      await visit(page, blob(path));
      const view = await drawn();
      // Highlighting replaces the rows it arrives for, and a row replaced mid-measure reads 0.
      await coloured(view, FJORD.light);
      const drawnTop = await topOf(row(view, 5));
      expect(
        Math.abs(drawnTop - plainTop),
        `${path}: ${drawnTop} against ${plainTop}`,
      ).toBeLessThanOrEqual(1);
    }
  });
});

describe("line links", () => {
  it("opens a hand-written fragment, rewriting the URL as canonical", async () => {
    await visit(page, `${blob("lines.ts")}#L150`);
    const view = await drawn();
    await see(row(view, 150)).toBeInViewport();
    await see(row(view, 150)).toHaveAttribute("data-selected-line");
    expect(search()).toBe("?line=150#L150");
  });

  it("opens a canonical range from a fresh load", async () => {
    await visit(page, `${blob("lines.ts")}?line=12-20#L12`);
    const view = await drawn();
    await see(view.locator("[data-line][data-selected-line]")).toHaveCount(9);
    await see(row(view, 12)).toBeInViewport();
    await see(row(view, 11)).not.toHaveAttribute("data-selected-line");
    expect(search()).toBe("?line=12-20#L12");
    // Far down the file too, where only the page can bring it into view.
    await visit(page, `${blob("lines.ts")}?line=150-152#L150`);
    const far = await drawn();
    await see(far.locator("[data-line][data-selected-line]")).toHaveCount(3);
    await see(row(far, 150)).toBeInViewport();
    expect(search()).toBe("?line=150-152#L150");
  });

  it("follows a later change of fragment", async () => {
    await visit(page, `${blob("lines.ts")}?line=12#L12`);
    const view = await drawn();
    await committed(() => goToFragment("#L160-L162"));
    await see(view.locator("[data-line][data-selected-line]")).toHaveCount(3);
    await see(row(view, 160)).toBeInViewport();
    expect(search()).toBe("?line=160-162#L160");
  });

  it("goes back to the line when the same URL is navigated to again", async () => {
    await visit(page, `${blob("lines.ts")}?line=150#L150`);
    const view = await drawn();
    await see(row(view, 150)).toBeInViewport();
    // The router resets the view on the first such navigation.
    await committed(() => page.goto(page.url()));
    await see(row(view, 150)).toBeInViewport();
    await see(row(view, 150)).toHaveAttribute("data-selected-line");
    expect(search()).toBe("?line=150#L150");
    // It has nothing new to do on the next, and the page must go back all the same.
    await page.evaluate(() =>
      (globalThis as unknown as { scrollTo(x: number, y: number): void }).scrollTo(0, 0),
    );
    await see(row(view, 1)).toBeInViewport();
    await page.goto(page.url());
    await see(row(view, 150)).toBeInViewport();
  });

  it("follows a fragment after a selection the router has not seen", async () => {
    await visit(page, `${blob("lines.ts")}?line=150#L150`);
    const view = await drawn();
    await see(row(view, 150)).toBeInViewport();
    // Written with replaceState: the router still thinks the page is at #L150.
    await arrives("?line=152#L152", () => numberCell(view, 152).click());
    await see(row(view, 152)).toHaveAttribute("data-selected-line");
    await committed(() => goToFragment("#L150"));
    await see(row(view, 150)).toBeInViewport();
    await see(row(view, 150)).toHaveAttribute("data-selected-line");
    await see(row(view, 152)).not.toHaveAttribute("data-selected-line");
    expect(search()).toBe("?line=150#L150");
  });

  it("marks the same lines without JavaScript, and scrolls to the first", async () => {
    await withoutScript(async (plain) => {
      await plain.goto(`${blob("lines.ts")}?line=150-152#L150`);
      await see(plain.locator("mark.file-line")).toHaveCount(3);
      await see(plain.locator("a#L150")).toBeInViewport();
      await arrives("?line=151#L151", () => plain.locator("a#L151").click(), plain);
      await see(plain.locator("mark.file-line")).toHaveCount(1);
    });
  });

  it("writes the canonical link for what is selected on the page", async () => {
    await visit(page, blob("lines.ts"));
    const view = await drawn();
    await arrives("?line=5#L5", () => numberCell(view, 5).click());
    await see(row(view, 5)).toHaveAttribute("data-selected-line");
    await numberCell(view, 7).hover();
    await page.mouse.down();
    await numberCell(view, 9).hover();
    await arrives("?line=7-9#L7", () => page.mouse.up());
    await see(view.locator("[data-line][data-selected-line]")).toHaveCount(3);
    // It reads the same when opened again.
    await visit(page, page.url());
    await see((await drawn()).locator("[data-line][data-selected-line]")).toHaveCount(3);
  });

  it("goes to a line from the keyboard, with and without JavaScript", async () => {
    await visit(page, blob("lines.ts"));
    const view = await drawn();
    await page.getByLabel("Go to line").fill("150");
    await arrives("?line=150#L150", () => page.keyboard.press("Enter"));
    await see(row(await drawn(), 150)).toBeInViewport();
    await see(row(view, 150)).toHaveAttribute("data-selected-line");
    await page.getByLabel("Go to line").fill("99999");
    await arrives("?line=200#L200", () => page.keyboard.press("Enter"));
    await page.getByLabel("Go to line").fill("nonsense");
    await arrives("", () => page.keyboard.press("Enter"));
    await withoutScript(async (plain) => {
      await plain.goto(blob("lines.ts"));
      await plain.getByLabel("Go to line").fill("150");
      await arrives("?line=150#L150", () => plain.keyboard.press("Enter"), plain);
      await see(plain.locator("mark.file-line")).toHaveCount(1);
      await see(plain.locator("a#L150")).toBeInViewport();
    });
  });
});

/** Scrolls the page by script, as a person would, and returns where it came to rest. */
const scrollAwayTo = (y: number) =>
  page.evaluate((top) => {
    const view = globalThis as unknown as {
      scrollTo(x: number, y: number): void;
      scrollY: number;
    };
    view.scrollTo(0, top);
    return view.scrollY;
  }, y);
const scrollY = () => page.evaluate(() => (globalThis as unknown as { scrollY: number }).scrollY);
/** Follows a link where it is: a real click would scroll it into view, and move what is saved. */
const follow = (link: Locator) =>
  link.evaluate((element) => {
    (element as unknown as { click(): void }).click();
  });

describe("going back and forward", () => {
  const SAVED = 1_000;
  const history = () => page.getByRole("link", { name: "History" }).first();
  /** Opens `url` as a new document: from the same URL, a browser only moves within the page. */
  const openFresh = async (url: string) => {
    await page.goto("about:blank");
    await visit(page, url);
  };

  it("keeps where a rendered file was, its lines still selected", async () => {
    await openFresh(`${blob("lines.ts")}?line=150#L150`);
    let view = await drawn();
    await see(row(view, 150)).toBeInViewport();
    const saved = await scrollAwayTo(SAVED);
    await arrives("", () => follow(history()));
    await page.goBack();
    view = await drawn();
    await see(row(view, 150)).toHaveAttribute("data-selected-line");
    expect(await scrollY()).toBe(saved);
    expect(search()).toBe("?line=150#L150");
  });

  it("keeps it going forward too", async () => {
    await openFresh(`${stack.origin}${REPO}`);
    await arrives("", () => page.getByRole("link", { name: "lines.ts" }).click());
    let view = await drawn();
    await scrollAwayTo(3_000);
    await arrives("?line=150#L150", () => numberCell(view, 150).click());
    const saved = await scrollAwayTo(SAVED);
    await arrives("", () => follow(history()));
    await page.goBack();
    view = await drawn();
    expect(await scrollY()).toBe(saved);
    await page.goBack();
    await see(page.locator(".file-view")).toHaveCount(0);
    await page.goForward();
    view = await drawn();
    await see(row(view, 150)).toHaveAttribute("data-selected-line");
    expect(await scrollY()).toBe(saved);
    expect(search()).toBe("?line=150#L150");
  });

  it("keeps a line selected by a fragment, across fragments", async () => {
    await openFresh(`${blob("lines.ts")}?line=150#L150`);
    const view = await drawn();
    const saved = await scrollAwayTo(SAVED);
    await committed(() => goToFragment("#L180"));
    await see(row(view, 180)).toBeInViewport();
    await committed(() => page.goBack());
    await see(row(view, 150)).toHaveAttribute("data-selected-line");
    expect(await scrollY()).toBe(saved);
  });

  it("keeps where the plain text was, when nothing highlights", async () => {
    const refused = /\/assets\/(worker|shiki)-[^/]+\.js$/;
    await page.route(refused, (route) => route.abort());
    try {
      const plainText = () =>
        see(page.locator(".file-view")).toHaveAttribute("data-drawn", "text", { timeout: 30_000 });
      await openFresh(`${blob("lines.ts")}?line=150#L150`);
      await plainText();
      await see(page.locator("a#L150")).toBeInViewport();
      const saved = await scrollAwayTo(SAVED);
      await arrives("", () => follow(history()));
      await page.goBack();
      await plainText();
      await see(page.locator("mark a#L150")).toBeAttached();
      expect(await scrollY()).toBe(saved);
      await page.goForward();
      await see(page.locator(".file-view")).toHaveCount(0);
      await page.goBack();
      await plainText();
      await see(page.locator("mark a#L150")).toBeAttached();
      expect(await scrollY()).toBe(saved);
    } finally {
      await page.unroute(refused);
    }
  });

  it("keeps a large file's place past the block it first draws", async () => {
    await openFresh(`${blob("big.ts")}?line=4100#L4100`);
    const view = await drawn();
    await see(row(view, 4100)).toBeInViewport();
    const saved = await scrollAwayTo(60_000);
    await arrives("", () => follow(history()));
    await page.goBack();
    await drawn();
    // A place the plain view's one block is too short to hold: only the takeover can restore it.
    expect(await scrollY()).toBe(saved);
    expect(search()).toBe("?line=4100#L4100");
  });
});

describe("a file sent in blocks", () => {
  it("pages without JavaScript, keeping a range across blocks", async () => {
    await withoutScript(async (plain) => {
      await plain.goto(`${blob("big.ts")}?line=1999-2002`);
      await see(plain.locator(".file-line")).toHaveCount(2_000);
      await see(plain.locator("mark.file-line")).toHaveCount(2);
      await see(plain.locator("mark a#L1999")).toBeVisible();
      await arrives(
        "?from=2001&line=1999-2002",
        () => plain.getByRole("link", { name: "Next" }).first().click(),
        plain,
      );
      await see(plain.locator(".file-line")).toHaveCount(2_000);
      await see(plain.locator("mark.file-line")).toHaveCount(2);
      await see(plain.locator("mark a#L2002")).toBeVisible();
      await plain.getByRole("link", { name: "Next" }).first().click();
      await see(plain.locator(".file-line")).toHaveCount(500);
      await see(plain.getByRole("link", { name: "Next" })).toHaveCount(0);
      await plain.getByRole("link", { name: "Previous" }).first().click();
      await see(plain.locator("a#L2001")).toBeAttached();
      // A line's own link opens the block that holds it, with no `from` left to outvote it.
      await arrives("?line=2500#L2500", () => plain.locator("a#L2500").click(), plain);
      await see(plain.locator("a#L2500")).toBeInViewport();
    });
  });

  it("goes to a line in another block without JavaScript", async () => {
    await withoutScript(async (plain) => {
      await plain.goto(blob("big.ts"));
      await plain.getByLabel("Go to line").fill("4100");
      await arrives("?line=4100#L4100", () => plain.keyboard.press("Enter"), plain);
      await see(plain.locator("a#L4001")).toBeAttached();
      await see(plain.locator("a#L4100")).toBeInViewport();
    });
  });

  it("reads the whole text at the commit, and draws it with no paging", async () => {
    const bytes = page.waitForResponse((res) =>
      /\/ada\/files\/raw\/[0-9a-f]{40}\/big\.ts\/$/.test(new URL(res.url()).pathname),
    );
    await visit(page, blob("big.ts"));
    expect((await bytes).status()).toBe(200);
    const view = await drawn();
    await see(row(view, 1)).toBeVisible();
    await see(page.getByRole("link", { name: "Next" })).toHaveCount(0);
    await see(page.getByRole("link", { name: "Previous" })).toHaveCount(0);
    await see(page.getByLabel("Go to line")).toBeVisible();
  });

  it("opens a range across blocks at its from, the whole range selected", async () => {
    await visit(page, `${blob("big.ts")}?from=2001&line=1999-2002`);
    const view = await drawn();
    await see(view.locator("[data-line][data-selected-line]")).toHaveCount(4);
    await see(row(view, 2001)).toBeInViewport();
    expect(search()).toBe("?from=2001&line=1999-2002");
  });

  it("opens at from alone with nothing selected, and drops it on a selection", async () => {
    await visit(page, `${blob("big.ts")}?from=4001`);
    const view = await drawn();
    await see(row(view, 4001)).toBeInViewport();
    await see(view.locator("[data-line][data-selected-line]")).toHaveCount(0);
    await arrives("?line=4002#L4002", () => numberCell(view, 4002).click());
  });

  it("opens a fragment outside the block the server sent", async () => {
    await visit(page, `${blob("big.ts")}#L4100`);
    const view = await drawn();
    await see(row(view, 4100)).toBeInViewport();
    await see(row(view, 4100)).toHaveAttribute("data-selected-line");
    expect(search()).toBe("?line=4100#L4100");
  });
});

describe("when nothing highlights", () => {
  // No workers, and Shiki's backend refused on the page itself.
  const refused = /\/assets\/(worker|shiki)-[^/]+\.js$/;
  const plainAgain = async () => {
    await see(page.locator(".file-view")).toHaveAttribute("data-drawn", "text", {
      timeout: 30_000,
    });
    await see(page.locator("diffs-container")).toHaveCount(0);
  };

  it("leaves the plain text, its links and its paging", async () => {
    await page.route(refused, (route) => route.abort());
    try {
      await visit(page, `${blob("big.ts")}?line=1999-2002`);
      await plainAgain();
      await see(page.locator(".file-line")).toHaveCount(2_000);
      await see(page.locator("mark.file-line")).toHaveCount(2);
      await accessible(page, "a file as plain text");
      await arrives("?from=2001&line=1999-2002", () =>
        page.getByRole("link", { name: "Next" }).first().click(),
      );
      await plainAgain();
      await see(page.locator("a#L2001")).toBeAttached();
      await see(page.locator("mark.file-line")).toHaveCount(2);
      await see(page.getByRole("link", { name: "Previous" }).first()).toBeVisible();
      await arrives("?line=2500#L2500", () => page.locator("a#L2500").click());
      await plainAgain();
      await see(page.locator("a#L2500")).toBeInViewport();
    } finally {
      await page.unroute(refused);
    }
  });

  it("opens from alone, and a range's fragment, in the plain text too", async () => {
    await page.route(refused, (route) => route.abort());
    try {
      await visit(page, `${blob("big.ts")}?from=4001`);
      await plainAgain();
      await see(page.locator("a#L4001")).toBeInViewport();
      await see(page.locator("mark.file-line")).toHaveCount(0);
      await visit(page, `${blob("lines.ts")}#L150-L152`);
      await plainAgain();
      await see(page.locator("mark.file-line")).toHaveCount(3);
      await see(page.locator("a#L150")).toBeInViewport();
      expect(search()).toBe("?line=150-152#L150");
    } finally {
      await page.unroute(refused);
    }
  });

  it("asks the server for the block a fragment names", async () => {
    await page.route(refused, (route) => route.abort());
    try {
      await visit(page, `${blob("big.ts")}#L4100`);
      await see(page.locator("mark a#L4100")).toBeInViewport({ timeout: 30_000 });
      expect(search()).toBe("?line=4100#L4100");
      await plainAgain();
    } finally {
      await page.unroute(refused);
    }
  });

  const raw = /\/ada\/files\/raw\/[0-9a-f]{40}\/big\.ts\/$/;
  it.each<[string, (route: Route) => Promise<void>]>([
    ["is refused", (route) => route.abort()],
    ["answers 500", (route) => route.fulfill({ status: 500, body: "no" })],
    ["holds a NUL", (route) => route.fulfill({ body: Buffer.from([0x61, 0x00, 0x62]) })],
    ["is not UTF-8", (route) => route.fulfill({ body: Buffer.from([0xc3, 0x28]) })],
  ])("leaves the plain text when the whole file %s", async (_what, answer) => {
    await page.route(raw, answer);
    try {
      await visit(page, blob("big.ts"));
      await plainAgain();
      await see(page.locator(".file-line")).toHaveCount(2_000);
      await see(page.getByRole("link", { name: "Next" }).first()).toBeVisible();
    } finally {
      await page.unroute(raw);
    }
  });
});

describe("when highlighting fails in the renderer", () => {
  it("steps the session down, and the file is drawn by the next", async () => {
    const workers = /\/assets\/worker-[^/]+\.js$/;
    // Each worker starts, then answers every file it is asked to draw with an error.
    await page.route(workers, async (route) => {
      const response = await route.fetch();
      const erring = `const fyrdenPost = self.postMessage.bind(self);
self.postMessage = (m, t) => fyrdenPost(m && m.requestType === "file" ? { type: "error", id: m.id, error: "tokenizer failed" } : m, t);
`;
      await route.fulfill({ response, body: erring + (await response.text()) });
    });
    try {
      await visit(page, blob("lines.ts"));
      const shown = page.locator(".file-view [data-highlighter]");
      await see(shown).toHaveAttribute("data-highlighter", "shiki-js", { timeout: 30_000 });
      await see(shown).toHaveAttribute("data-pool", "none", { timeout: 30_000 });
      await coloured(await drawn(), FJORD.light);
    } finally {
      await page.unroute(workers);
    }
  });
});

describe("a file that reads as the page's own words", () => {
  it("draws text that is exactly what a failure might once have been called", async () => {
    for (const path of ["failed.ts", "failed-newline.ts"]) {
      await visit(page, blob(path));
      const view = await drawn();
      await see(view.locator("[data-line]"), path).toHaveCount(1);
      await see(row(view, 1)).toContainText("failed");
    }
  });
});

describe("the highlighting limits", () => {
  const tokens = (view: Locator, line: number) => keyword(view, line);
  /** Goes to `line`, by the form, and returns the view drawn there. */
  const goTo = async (path: string, line: number) => {
    await visit(page, blob(path));
    await drawn();
    await page.getByLabel("Go to line").fill(String(line));
    await arrives(`?line=${line}#L${line}`, () => page.keyboard.press("Enter"));
    const view = await drawn();
    await see(row(view, line)).toBeInViewport();
    await see(row(view, line)).toHaveAttribute("data-selected-line");
    return view;
  };

  it.each([
    ["256 KiB", LIMIT.bytesAt, () => ofBytes(HIGHLIGHT_BYTES).split("\n").length - 1],
    ["10,000 lines", LIMIT.linesAt, () => HIGHLIGHT_LINES],
  ])("highlights a file of exactly %s, to its last line", async (_limit, path, last) => {
    const view = await goTo(path, last());
    await see(tokens(view, last())).toHaveCSS("color", rgb(FJORD.light.syntax.keyword), {
      timeout: 30_000,
    });
  });

  it.each([
    ["256 KiB", LIMIT.bytesOver, () => ofBytes(HIGHLIGHT_BYTES + 1).split("\n").length - 1],
    ["10,000 lines", LIMIT.linesOver, () => HIGHLIGHT_LINES + 1],
  ])(
    "draws a file just over %s as plain text, its lines still reached",
    async (_limit, path, last) => {
      const view = await goTo(path, last());
      await see(row(view, last())).toContainText("const");
      // That no tokens ever come is proved at the renderer (`rendererFile`'s test): rows are
      // drawn before highlighting is asked for, so no look at the page here could tell.
    },
  );
});

describe("a line over 64 KiB", () => {
  it("is cut and marked as plain text, and whole and scrolled sideways once drawn", async () => {
    await withoutScript(async (plain) => {
      await plain.goto(`${blob("long-line.ts")}?line=2`);
      await see(plain.getByText("This line is cut at 64 KiB")).toBeVisible();
      await see(plain.locator(".file-line")).toHaveCount(1);
      await see(plain.getByRole("link", { name: "Raw" }).last()).toHaveAttribute(
        "href",
        `${REPO}/raw/main/long-line.ts/`,
      );
    });
    await visit(page, blob("long-line.ts"));
    const view = await drawn();
    await see(view.locator("[data-line]")).toHaveCount(3);
    await see(page.getByText("This line is cut at 64 KiB")).toHaveCount(0);
    await coloured(view, FJORD.light);
    // The code scrolls inside its frame, and the page itself stays the window's width.
    const scrolled = await view
      .locator("code")
      .first()
      .evaluate((code) => {
        const box = code as unknown as {
          scrollWidth: number;
          clientWidth: number;
          scrollLeft: number;
        };
        box.scrollLeft = 5_000;
        return { wide: box.scrollWidth > box.clientWidth, moved: box.scrollLeft };
      });
    expect(scrolled).toEqual({ wide: true, moved: 5_000 });
    const pageFits = await page.evaluate(() => {
      const { documentElement: root } = (
        globalThis as unknown as {
          document: { documentElement: { scrollWidth: number; clientWidth: number } };
        }
      ).document;
      return root.scrollWidth <= root.clientWidth;
    });
    expect(pageFits).toBe(true);
  });
});

describe("a Markdown file", () => {
  it("shows its rendered view, and its source with plain=1", async () => {
    await visit(page, blob("README.md"));
    await see(page.getByRole("heading", { name: "Title" })).toBeVisible();
    await see(page.locator(".file-view")).toHaveCount(0);
    await arrives("?plain=1", () => page.getByRole("link", { name: "Source" }).click());
    const view = await drawn();
    await see(row(view, 1)).toContainText("# Title");
    await arrives("?plain=1&line=3#L3", () => numberCell(view, 3).click());
    await page.getByLabel("Go to line").fill("5");
    await arrives("?plain=1&line=5#L5", () => page.keyboard.press("Enter"));
    await withoutScript(async (plain) => {
      await plain.goto(`${blob("README.md")}?plain=1`);
      await see(plain.locator("a#L3")).toHaveAttribute("href", "?plain=1&line=3#L3");
      await arrives("?plain=1&line=3#L3", () => plain.locator("a#L3").click(), plain);
      await see(plain.locator("mark.file-line")).toHaveCount(1);
    });
  });
});

describe("a name ending in .data", () => {
  it("draws the file, and goes to a line on its real path", async () => {
    await visit(page, blob("notes.data"));
    await see(page).toHaveURL(`${blob("notes.data")}/`);
    const view = await drawn();
    await see(view.locator("[data-line]")).toHaveCount(3);
    await page.getByLabel("Go to line").fill("2");
    await page.keyboard.press("Enter");
    await see(page).toHaveURL(`${blob("notes.data")}/?line=2#L2`);
    await see(row(await drawn(), 2)).toHaveAttribute("data-selected-line");
  });

  it("reads its raw bytes, not the router's data, for a file over the window", async () => {
    await visit(page, blob("many.data"));
    const view = await drawn();
    await see(row(view, 1)).toContainText("const line1 = 1;");
    await page.getByLabel("Go to line").fill("2400");
    await page.keyboard.press("Enter");
    await see(row(await drawn(), 2400)).toContainText("const line2400 = 2400;");
    const answer = await page.request.get(`${stack.origin}${REPO}/raw/main/many.data/`);
    expect((await answer.text()).startsWith("const line1 = 1;")).toBe(true);
  });
});

describe("Fjord on the file view", () => {
  it("colours code, gutter and selection in both schemes", async () => {
    await visit(page, `${blob("lines.ts")}?line=2`);
    const view = await drawn();
    for (const [colorScheme, scheme] of [
      ["light", FJORD.light],
      ["dark", FJORD.dark],
    ] as const) {
      await page.emulateMedia({ colorScheme });
      await coloured(view, scheme);
      await see(row(view, 2)).toHaveCSS("background-color", rgb(scheme.diff.selected));
      await see(numberCell(view, 2)).toHaveCSS("background-color", rgb(scheme.diff.selected));
    }
    await page.emulateMedia({ colorScheme: "light" });
    await accessible(page, "a file, a line selected");
  });

  it("changes scheme in place, every row kept", async () => {
    await visit(page, blob("lines.ts"));
    const view = await drawn();
    await coloured(view, FJORD.light);
    type Kept = { kept?: boolean };
    await row(view, 1).evaluate((element) => {
      (element as unknown as Kept).kept = true;
    });
    await page.evaluate(() => {
      (globalThis as unknown as Kept).kept = true;
    });
    await page.getByRole("button", { name: "Dark", exact: true }).click();
    await see(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await coloured(view, FJORD.dark);
    await page.getByRole("button", { name: "Light", exact: true }).click();
    await see(page.locator("html")).toHaveAttribute("data-theme", "light");
    await coloured(view, FJORD.light);
    await page.getByRole("button", { name: "System", exact: true }).click();
    await see(page.locator("html")).not.toHaveAttribute("data-theme", "light");
    await coloured(view, FJORD.light);
    await see(page.locator(".file-view")).toHaveAttribute("data-drawn", "file");
    expect(await page.evaluate(() => (globalThis as unknown as Kept).kept)).toBe(true);
    expect(await row(view, 1).evaluate((element) => (element as unknown as Kept).kept)).toBe(true);
  });

  it("had nothing refused under the Content Security Policy", () => {
    expect(stack.refused).toEqual([]);
  });
});
