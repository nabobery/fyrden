// "Go to file" in a real browser against both Workers: an ARIA combobox and listbox with focus
// staying in the input, the `t` shortcut and its checkbox, every way a list can end, axe in all
// six pairs of OS and forced theme, and the keyboard in Chromium, Firefox and WebKit. Answers the
// API gives only for trees it can't be pushed (a cap, a damaged tree, busy memory) are mocked at
// the page's route. Needs `pnpm --filter @fyrden/web build` first (turbo does it).

import {
  type Browser,
  type ConsoleMessage,
  chromium,
  firefox,
  type Page,
  type Route,
  expect as see,
  webkit,
} from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accessible, startWebStack, visit, type WebStack } from "./web-stack.js";

let stack: WebStack;
let page: Page;
const REPO = "/ada/finder";
const FILES = [
  "README.md",
  "docs/Guide.md",
  "src/index.ts",
  "src/lib/guide.ts",
  "with space/a b.ts",
];

const home = () => `${stack.origin}${REPO}`;
const opener = (on: Page = page) => on.getByRole("link", { name: "Go to file" });
const box = (on: Page = page) => on.getByRole("combobox", { name: /File path/ });
const dialog = (on: Page = page) => on.getByRole("dialog", { name: "Go to file" });
const options = (on: Page = page) => on.getByRole("option");
const activeOption = (on: Page = page) => on.locator('[role="option"][aria-selected="true"]');

/** Answers the page's path requests in turn, and counts them. */
async function answering(on: Page, ...replies: unknown[]) {
  const asked: URL[] = [];
  await on.unroute("**/ada/finder/paths*");
  await on.route("**/ada/finder/paths*", async (route: Route) => {
    asked.push(new URL(route.request().url()));
    const reply = replies.shift();
    if (!reply) return route.abort();
    const { status = 200, ...body } = reply as { status?: number };
    return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  });
  return asked;
}

const answer = (fields: object) => ({
  commit: "c".repeat(40),
  tree: "d".repeat(40),
  state: "complete",
  reason: null,
  paths: [],
  visited: 0,
  total_paths: null,
  unlisted_names: 0,
  next_cursor: null,
  retry_after_ms: null,
  ...fields,
});

/** Opens the home page's finder afresh, on the answers given (none: the real API). */
async function openFinder(...replies: unknown[]) {
  await page.unroute("**/ada/finder/paths*");
  const asked = replies.length > 0 ? await answering(page, ...replies) : [];
  await visit(page, home());
  await opener().click();
  await see(dialog()).toBeVisible();
  return asked;
}

/** No axe finding in the six pairs of OS scheme and forced theme, with `what` on the page. */
async function accessibleEverywhere(what: string) {
  const set = (theme: string | null) =>
    page.locator("html").evaluate(
      `(html, theme) => {
        if (theme) html.dataset.theme = theme;
        else delete html.dataset.theme;
      }`,
      theme,
    );
  for (const forced of [null, "light", "dark"]) {
    await set(forced);
    await accessible(page, `${what}, forced ${forced ?? "no theme"}`);
  }
  await set(null);
}

beforeAll(async () => {
  stack = await startWebStack("ada");
  page = stack.page;
  const headers = {
    Authorization: `Bearer ${stack.token}`,
    "Content-Type": "application/json",
  };
  const res = await fetch(`${stack.origin}/api/user/repos`, {
    method: "POST",
    headers: { ...headers, "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({ name: "finder" }),
  });
  expect(res.status, await res.text()).toBe(201);
  for (const path of FILES) {
    const put = await fetch(
      `${stack.origin}/api/repos/ada/finder/contents/${path.split("/").map(encodeURIComponent).join("/")}`,
      {
        method: "PUT",
        headers: { ...headers, "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ message: `add ${path}`, content: btoa(`${path}\n`) }),
      },
    );
    expect(put.status, `${path}: ${await put.clone().text()}`).toBeLessThan(300);
  }
}, 180_000);

afterAll(async () => {
  await stack?.stop();
});

describe("Go to file", () => {
  it("is a link to the ref's folders without scripts", async () => {
    const context = await page
      .context()
      .browser()
      ?.newContext({
        javaScriptEnabled: false,
        storageState: await page.context().storageState(),
      });
    const plain = await context?.newPage();
    if (!plain) throw new Error("no page");
    await plain.goto(home());
    await opener(plain).click();
    await see(plain).toHaveURL(`${home()}/tree/main/`);
    await see(plain.getByRole("link", { name: "README.md" })).toBeVisible();
    await context?.close();
  });

  it("is on the home, folder and file pages", async () => {
    for (const path of ["", "/tree/main/src", "/blob/main/README.md"]) {
      await visit(page, `${home()}${path}`);
      await see(opener()).toBeVisible();
      await see(opener()).toHaveAttribute("aria-keyshortcuts", "t");
    }
  });

  // A mismatch doesn't show in the page: React renders it again on the client, the page still
  // gets marked hydrated, and only this report says so.
  it.each(["", "/tree/main/", "/tree/main/src", "/blob/main/README.md"])(
    "hydrates %s, loaded directly, without an error",
    async (path) => {
      const errors: string[] = [];
      const onError = (error: Error) => errors.push(error.message);
      const onConsole = (message: ConsoleMessage) => {
        if (message.type() === "error") errors.push(message.text());
      };
      page.on("pageerror", onError);
      page.on("console", onConsole);
      try {
        await visit(page, `${home()}${path}`);
        await page.evaluate("new Promise((done) => setTimeout(done))");
        expect(errors).toEqual([]);
      } finally {
        page.off("pageerror", onError);
        page.off("console", onConsole);
      }
    },
  );

  it("lists the real tree, with the combobox's roles and focus in its input", async () => {
    await openFinder();
    await see(box()).toBeFocused();
    await see(options()).toHaveCount(FILES.length);
    await see(dialog().getByRole("status").first()).toHaveText(`${FILES.length} files`);
    await see(box()).toHaveAttribute("aria-autocomplete", "list");
    await see(box()).toHaveAttribute("aria-expanded", "true");
    await see(box()).toHaveAttribute("aria-controls", "file-finder-list");
    await see(page.getByRole("listbox", { name: "Matching files" })).toHaveId("file-finder-list");
    await see(box()).not.toHaveAttribute("aria-activedescendant");
    await accessibleEverywhere("the finder, the whole list");
    expect(stack.refused).toEqual([]);
  });

  it("filters by substring whatever the case, and marks the first match active", async () => {
    await openFinder();
    await see(options()).toHaveCount(FILES.length);
    await box().fill("GUIDE");
    await see(options()).toHaveText(["docs/Guide.md", "src/lib/guide.ts"]);
    await see(dialog().getByRole("status").first()).toHaveText("2 files match");
    await see(activeOption()).toHaveText("docs/Guide.md");
    await see(box()).toHaveAttribute("aria-activedescendant", "file-finder-option-0");
    await accessibleEverywhere("the finder, a search with matches");
    await box().fill("zzz-nothing");
    await see(options()).toHaveCount(0);
    await see(dialog().getByRole("status").first()).toHaveText("No files match");
    await see(box()).toHaveAttribute("aria-expanded", "false");
    await see(box()).not.toHaveAttribute("aria-activedescendant");
    await accessibleEverywhere("the finder, no match");
  });

  it("goes to the file on Enter or a click, keeping the ref and encoding the path", async () => {
    await openFinder();
    await box().fill("a b");
    await see(activeOption()).toHaveText("with space/a b.ts");
    await box().press("Enter");
    await see(page).toHaveURL(`${home()}/blob/main/with%20space/a%20b.ts`);
    await see(dialog()).toBeHidden();
    await opener().click();
    await box().fill("index");
    await options().first().click();
    await see(page).toHaveURL(`${home()}/blob/main/src/index.ts`);
  });

  it("does nothing on Enter with nothing active", async () => {
    await openFinder();
    await see(options()).toHaveCount(FILES.length);
    const url = page.url();
    await box().press("Enter");
    await see(dialog()).toBeVisible();
    expect(page.url()).toBe(url);
  });

  it("shows the first matches of many and says how many there are", async () => {
    const paths = Array.from({ length: 1234 }, (_, i) => `f/${String(i).padStart(4, "0")}`);
    await openFinder(answer({ paths }));
    await see(dialog().getByRole("status").first()).toHaveText(
      "Showing the first 100 of 1,234 files. Type to narrow them.",
    );
    await see(options()).toHaveCount(100);
    await box().fill("f/1");
    await see(dialog().getByRole("status").first()).toHaveText(
      "Showing the first 100 of 234 matches. Type more to narrow them.",
    );
    await see(options()).toHaveCount(100);
    await accessibleEverywhere("the finder, matches cut short");
    // The active row stays in view, far down the list.
    for (let i = 0; i < 99; i++) await box().press("ArrowDown");
    await see(activeOption()).toBeInViewport();
  });

  it("shows pages as they arrive, keeping the active row", async () => {
    await page.unroute("**/ada/finder/paths*");
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const replies = [
      answer({
        state: "incomplete",
        reason: "more_pages",
        paths: ["a/1", "a/2"],
        next_cursor: "n",
      }),
      answer({ paths: ["a/3"] }),
    ];
    await page.route("**/ada/finder/paths*", async (route: Route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.has("cursor")) await held;
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(replies.shift()),
      });
    });
    await visit(page, home());
    await opener().click();
    await see(dialog().getByRole("status").first()).toHaveText("Loading… 2 files so far");
    await box().fill("a/");
    await see(dialog().getByRole("status").first()).toHaveText("2 files match so far");
    await box().press("ArrowDown");
    await see(activeOption()).toHaveText("a/2");
    release();
    await see(dialog().getByRole("status").first()).toHaveText("3 files match");
    await see(activeOption()).toHaveText("a/2");
  });
});

describe("the t shortcut", () => {
  it("opens the finder, except while typing, with a modifier or in a dialog", async () => {
    await visit(page, home());
    await page.locator("#clone-url").focus();
    await page.keyboard.press("t");
    await see(dialog()).toBeHidden();
    await page.locator("#clone-url").blur();
    await page.keyboard.press("Shift+T");
    await page.keyboard.press("Control+t").catch(() => {});
    await see(dialog()).toBeHidden();
    await page.keyboard.press("t");
    await see(dialog()).toBeVisible();
    await see(box()).toBeFocused();
    // The key opened it: it isn't typed in it. And in it, `t` is only a letter.
    await see(box()).toHaveValue("");
    await page.keyboard.press("t");
    await see(box()).toHaveValue("t");
  });

  it("can be turned off, for this browser, and the link still opens the finder", async () => {
    await openFinder();
    const use = page.getByRole("checkbox", { name: /Use the t shortcut/ });
    await see(use).toBeChecked();
    await use.uncheck();
    await see(opener()).not.toHaveAttribute("aria-keyshortcuts");
    await visit(page, home());
    await see(opener()).not.toHaveAttribute("aria-keyshortcuts");
    await page.keyboard.press("t");
    await see(dialog()).toBeHidden();
    await opener().click();
    await see(dialog()).toBeVisible();
    await page.getByRole("checkbox", { name: /Use the t shortcut/ }).check();
    await see(opener()).toHaveAttribute("aria-keyshortcuts", "t");
  });
});

describe("a list that ends early", () => {
  const paths = ["a/1", "b/2"];
  const SAID: readonly (readonly [string, RegExp])[] = [
    ["too_many_paths", /Showing the first 2 files; this repository has more\./],
    ["too_many_bytes", /Showing the first 2 files: .*too long/],
    ["tree_too_large", /Showing the first 2 files: .*too large/],
    ["too_deep", /Showing the first 2 files: .*too deeply/],
    ["path_too_long", /Showing the first 2 files: a path/],
    ["malformed_tree", /Showing the first 2 files: .*damaged/],
    ["too_much_work", /Showing the first 2 files: .*too much work/],
  ];

  it.each(SAID)(
    "says so for %s, shows what it has, and points to the folders",
    async (reason, said) => {
      await openFinder(answer({ state: "incomplete", reason, paths }));
      await see(dialog()).toContainText(said);
      await see(options()).toHaveCount(2);
      await see(dialog().getByRole("link", { name: "Browse folders" })).toHaveAttribute(
        "href",
        `${REPO}/tree/main/`,
      );
    },
  );

  it("is clear of axe findings with a notice showing", async () => {
    await openFinder(answer({ state: "incomplete", reason: "malformed_tree", paths }));
    await see(dialog()).toContainText("damaged");
    await accessibleEverywhere("the finder, a damaged tree");
  });

  it("counts names it can't show", async () => {
    await openFinder(answer({ paths, unlisted_names: 3 }));
    await see(dialog()).toContainText("3 files have names that can't be shown.");
  });

  it("offers a retry when an object can't be read, going on from there", async () => {
    const asked = await openFinder(
      answer({ state: "incomplete", reason: "more_pages", paths, next_cursor: "n" }),
      answer({ state: "unavailable", reason: "unreadable" }),
      answer({ paths: ["c/3"] }),
    );
    await see(dialog()).toContainText("some files can't be read");
    await see(options()).toHaveCount(2);
    await accessibleEverywhere("the finder, unreadable");
    await dialog().getByRole("button", { name: "Retry" }).click();
    await see(options()).toHaveCount(3);
    await see(dialog().getByRole("button", { name: "Retry" })).toBeHidden();
    expect(asked.at(-1)?.searchParams.get("cursor")).toBe("n");
  });

  it("says so for a ref that isn't there and an empty tree, with nothing to retry", async () => {
    await openFinder({ status: 404, code: "ref_not_found" });
    await see(dialog()).toContainText("This branch, tag or commit wasn't found.");
    await see(dialog().getByRole("button", { name: "Retry" })).toBeHidden();
    await openFinder(answer({}));
    await see(dialog().getByRole("status").first()).toHaveText("No files");
  });

  it("says it is waiting on a busy repository", async () => {
    // How long it waits is the unit tests'. This wait outlasts the test.
    const asked = await openFinder(
      answer({ state: "unavailable", reason: "busy", retry_after_ms: 3_600_000 }),
    );
    await see(dialog()).toContainText("The repository is busy; trying again…");
    expect(asked).toHaveLength(1);
  });

  it("says when a busy repository stayed busy, and a retry goes on", async () => {
    const busy = answer({ state: "unavailable", reason: "busy", retry_after_ms: 0 });
    await openFinder(busy, busy, busy, busy, answer({ paths }));
    await see(dialog()).toContainText(
      "The file list isn't available right now: the repository is busy.",
    );
    await accessibleEverywhere("the finder, busy");
    await dialog().getByRole("button", { name: "Retry" }).click();
    await see(options()).toHaveCount(2);
  });

  it("stops at its budget on a list that goes on, says so, and goes on when asked", async () => {
    await page.unroute("**/ada/finder/paths*");
    const asked: URL[] = [];
    await page.route("**/ada/finder/paths*", async (route: Route) => {
      asked.push(new URL(route.request().url()));
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(
          answer({
            state: "incomplete",
            reason: "more_pages",
            paths: [`d/${asked.length}`],
            next_cursor: `c${asked.length}`,
          }),
        ),
      });
    });
    await visit(page, home());
    await opener().click();
    await see(dialog()).toContainText("isn't whole yet");
    const spent = asked.length;
    await accessibleEverywhere("the finder, a list not whole yet");
    await dialog().getByRole("button", { name: "Continue loading" }).click();
    await see.poll(() => asked.length).toBe(2 * spent);
    await see(dialog().getByRole("button", { name: "Continue loading" })).toBeVisible();
  });

  it("drops what it is asking when the dialog closes, and goes on when it opens again", async () => {
    await page.unroute("**/ada/finder/paths*");
    const asked: URL[] = [];
    await page.route("**/ada/finder/paths*", async (route: Route) => {
      const url = new URL(route.request().url());
      asked.push(url);
      if (asked.length === 1)
        return route.fulfill({
          contentType: "application/json",
          body: JSON.stringify(
            answer({ state: "incomplete", reason: "more_pages", paths, next_cursor: "n" }),
          ),
        });
      // The second is left hanging the first time, so closing is what ends it.
      if (asked.length === 2) return;
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(answer({ paths: ["c/3"] })),
      });
    });
    await visit(page, home());
    await opener().click();
    await see.poll(() => asked.length).toBe(2);
    const dropped = page.waitForEvent("requestfailed");
    await page.keyboard.press("Escape");
    await see(dialog()).toBeHidden();
    expect((await dropped).url()).toContain("cursor=n");
    await opener().click();
    await see(options()).toHaveCount(3);
    expect(asked).toHaveLength(3);
    expect(asked[2]?.searchParams.get("cursor")).toBe("n");
  });

  it.each([
    ["says it is composing", { key: "Enter", isComposing: true }],
    ["ends a composition, as Safari does", { key: "Enter", keyCode: 229 }],
  ])("leaves Enter alone when it %s", async (_how, init) => {
    await openFinder();
    await box().fill("index");
    await see(activeOption()).toHaveText("src/index.ts");
    const url = page.url();
    await box().dispatchEvent("keydown", { bubbles: true, cancelable: true, ...init });
    await box().dispatchEvent("keydown", {
      key: "ArrowDown",
      isComposing: true,
      bubbles: true,
      cancelable: true,
    });
    await see(dialog()).toBeVisible();
    await see(activeOption()).toHaveText("src/index.ts");
    expect(page.url()).toBe(url);
  });
});

/** The whole keyboard path, in one browser. */
async function keyboardPath(on: Page) {
  await visit(on, home());
  await on.keyboard.press("t");
  await see(box(on)).toBeFocused();
  await see(options(on)).toHaveCount(FILES.length);
  await see(on.locator('[role="option"][aria-selected="true"]')).toHaveCount(0);

  await on.keyboard.press("ArrowDown");
  await see(activeOption(on)).toHaveText(FILES[0] as string);
  await on.keyboard.press("ArrowDown");
  await see(activeOption(on)).toHaveText(FILES[1] as string);
  await on.keyboard.press("ArrowUp");
  await see(activeOption(on)).toHaveText(FILES[0] as string);
  await on.keyboard.press("ArrowUp");
  await see(activeOption(on)).toHaveText(FILES.at(-1) as string);
  await on.keyboard.press("ArrowDown");
  await see(activeOption(on)).toHaveText(FILES[0] as string);
  // Focus never left the input, and the active option is the one it names.
  await see(box(on)).toBeFocused();
  await see(box(on)).toHaveAttribute(
    "aria-activedescendant",
    (await activeOption(on).getAttribute("id")) as string,
  );

  await on.keyboard.type("guide");
  await see(options(on)).toHaveCount(2);
  await see(activeOption(on)).toHaveText("docs/Guide.md");
  // First Escape clears, second closes, focus back where it came from.
  await on.keyboard.press("Escape");
  await see(box(on)).toHaveValue("");
  await see(dialog(on)).toBeVisible();
  await see(options(on)).toHaveCount(FILES.length);
  await on.keyboard.press("Escape");
  await see(dialog(on)).toBeHidden();

  await opener(on).focus();
  await on.keyboard.press("Enter");
  await see(box(on)).toBeFocused();
  await on.keyboard.press("Escape");
  await see(dialog(on)).toBeHidden();
  await see(opener(on)).toBeFocused();

  // Tab stays in the dialog: the browser's own trap, the page behind is inert.
  await opener(on).focus();
  await on.keyboard.press("Enter");
  await see(box(on)).toBeFocused();
  for (let i = 0; i < 6; i++) {
    await on.keyboard.press("Tab");
    const outside = await on.evaluate<boolean>(
      `(() => {
        const at = document.activeElement;
        return !!at && at !== document.body && !at.closest("dialog");
      })()`,
    );
    expect(outside).toBe(false);
  }
  await box(on).focus();

  await on.keyboard.type("index");
  await see(options(on)).toHaveCount(1);
  await on.keyboard.press("Enter");
  await see(on).toHaveURL(`${home()}/blob/main/src/index.ts`);
}

describe("a dialog that closes and opens", () => {
  it("keeps loading when it opens again before the close has been told", async () => {
    await page.unroute("**/ada/finder/paths*");
    const page1 = { state: "incomplete", reason: "more_pages", paths: ["a/1"], next_cursor: "n" };
    let asked = 0;
    let release: () => void = () => {};
    const released = new Promise<void>((done) => {
      release = done;
    });
    await page.route("**/ada/finder/paths*", async (route: Route) => {
      asked++;
      if (asked === 1)
        return route.fulfill({
          contentType: "application/json",
          body: JSON.stringify(answer(page1)),
        });
      // What the first close drops, if it wrongly reaches the dialog that opened again.
      if (asked === 2) await released;
      return route
        .fulfill({
          contentType: "application/json",
          body: JSON.stringify(answer({ paths: ["b/2"] })),
        })
        .catch(() => undefined);
    });
    await visit(page, home());
    await opener().click();
    await see.poll(() => asked).toBe(2);
    // In one task, so the close's event is still to come when the dialog is open again.
    await page.evaluate(
      `(() => {
        document.querySelector("dialog.file-finder").close();
        document.querySelector('a[aria-haspopup="dialog"]').click();
      })()`,
    );
    await see(dialog()).toBeVisible();
    await page.evaluate("new Promise((done) => setTimeout(done))");
    release();
    await see(options()).toHaveCount(2);
    await see(dialog().getByRole("status").first()).toHaveText("2 files");
  });

  it("closes when the revision changes under it, and opens again on the new list", async () => {
    await page.unroute("**/ada/finder/paths*");
    const res = await fetch(`${stack.origin}/api/repos/ada/finder/commits?per_page=100`, {
      headers: { Authorization: `Bearer ${stack.token}` },
    });
    const { commits } = (await res.json()) as { commits: { sha: string }[] };
    const first = commits.at(-1)?.sha as string;
    await visit(page, `${home()}/tree/main/`);
    // The router's own way to another revision of this page, leaving a history entry to go back
    // from: no link on it leads straight to another revision.
    await page.evaluate(
      `(() => {
        history.pushState(null, "", ${JSON.stringify(`${REPO}/tree/${first}/`)});
        dispatchEvent(new PopStateEvent("popstate"));
      })()`,
    );
    await see(page.getByRole("link", { name: "with space/" })).toBeHidden();
    await opener().click();
    await see(dialog().locator("label code")).toHaveText(first);
    await see(options()).toHaveCount(1);
    await page.goBack();
    await see(page).toHaveURL(`${home()}/tree/main/`);
    await see(dialog()).toBeHidden();
    await opener().click();
    await see(dialog().locator("label code")).toHaveText("main");
    await see(options()).toHaveCount(FILES.length);
  });
});

describe("a list that starts over", () => {
  it("drops the old options as soon as a cursor's commit is gone", async () => {
    await page.unroute("**/ada/finder/paths*");
    let asked = 0;
    let release: () => void = () => {};
    const released = new Promise<void>((done) => {
      release = done;
    });
    await page.route("**/ada/finder/paths*", async (route: Route) => {
      asked++;
      if (asked === 1)
        return route.fulfill({
          contentType: "application/json",
          body: JSON.stringify(
            answer({
              state: "incomplete",
              reason: "more_pages",
              paths: ["old/1"],
              next_cursor: "n",
            }),
          ),
        });
      if (asked === 2)
        return route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({ code: "ref_not_found" }),
        });
      await released;
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(answer({ paths: ["new/2"] })),
      });
    });
    await visit(page, home());
    await opener().click();
    await see.poll(() => asked).toBe(3);
    await see(options()).toHaveCount(0);
    release();
    await see(options()).toHaveText(["new/2"]);
  });
});

describe("the keyboard", () => {
  it.each([
    ["Chromium", chromium],
    ["Firefox", firefox],
    ["WebKit", webkit],
  ] as const)("takes the whole path in %s", async (_name, type) => {
    const browser: Browser = await type.launch();
    try {
      // The session as a header: WebKit won't store a `Secure` cookie over http://localhost
      // (measured, WebKit 26.6), though it sends one given this way.
      const cookies = await page.context().cookies();
      const Cookie = cookies.map(({ name, value }) => `${name}=${value}`).join("; ");
      const context = await browser.newContext({ extraHTTPHeaders: { Cookie } });
      await keyboardPath(await context.newPage());
    } finally {
      await browser.close();
    }
  });
});
