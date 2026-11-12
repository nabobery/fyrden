// The web UI in a real browser (Chromium through Playwright) against both
// Workers under one wrangler dev (the real service binding): a person signs
// in, creates a repository, adds a README (GitHub-flavored Markdown with a
// Mermaid diagram) and sees it rendered, sees the commit signed and
// verified, copies the clone URL, edits the README into hostile Markdown that
// stays inert, follows its relative link, downloads an archive, opens a file
// whose name ends in `.data`, creates a git token and an agent; no form takes
// a post from another origin and no page's data is cached. Every
// page it visits is checked with axe for WCAG 2.x A and AA. Needs `pnpm
// --filter @fyrden/web build` first (turbo does it).
import { createHmac, randomBytes } from "node:crypto";
import { generateToken, mentionsToken, secureRandomBytes } from "@fyrden/domain";
import { type Page, expect as see } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FJORD } from "../../../apps/web/app/lib/fjord.js";
import { runSmoke, webChecks } from "../src/smoke.ts";
import {
  accessibleInEveryTheme,
  accessible as axe,
  startWebStack,
  type WebStack,
} from "./web-stack.js";

/** `#rrggbb` as `getComputedStyle` reports it. */
function rgbOf(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

let stack: WebStack | undefined;
let page: Page;
// localhost: a secure context, so the browser keeps the __Host- session cookie over http.
let origin = "";
let token = "";

/** Picks a colour scheme in the header, and waits until the server has kept it. */
async function pickScheme(name: "System" | "Light" | "Dark"): Promise<void> {
  const kept = page.waitForResponse((res) => new URL(res.url()).pathname === "/appearance");
  await page.getByRole("button", { name, exact: true }).click();
  await kept;
}

/** The page has no WCAG 2.x A or AA violation axe can find. */
const accessible = (name: string) => axe(page, name);

beforeAll(async () => {
  // Signed in by the first test, through the sign-in page.
  stack = await startWebStack("ada", {
    signIn: false,
    permissions: ["clipboard-read", "clipboard-write"],
  });
  ({ page, origin, token } = stack);
}, 180_000);

afterAll(async () => {
  await stack?.stop();
  // Neither Worker logs a token (wrangler's own access log lines aside),
  // lines written late, after the test that caused them, included.
  expect(stack?.workerLines().filter(mentionsToken) ?? []).toEqual([]);
});

// The service binding and the logs, apart from the browser: plain requests,
// signed out, that leave the page and the repositories alone.
describe("fyrden-web and fyrden-api running together", () => {
  it("serves the page and health check through the API service binding", async () => {
    const results = await runSmoke(webChecks(`${origin}/`));
    expect(results.filter((r) => !r.ok)).toEqual([]);
  });

  it("never logs a token from a URL React Router cannot match", async () => {
    const live = stack as WebStack;
    const token = generateToken("pat", secureRandomBytes);
    const before = live.output().length;
    const res = await fetch(`${origin}/no/such/page/${token}`);
    expect(res.status).toBe(404);
    await res.text();
    // This request's own error line: proves the log was written before checking it.
    await live.waitForLine(/"msg":"web server error".*no\/such\/page/, before);
    const written = live.workerLines(before);
    expect(written.filter(mentionsToken).map((l) => l.replaceAll(token, "<TOKEN>"))).toEqual([]);
  });
});

describe("the web UI", () => {
  it("signs a person in and shows their repositories", async () => {
    await page.goto(`${origin}/`);
    await accessible("landing");
    await page.getByRole("link", { name: "Sign in" }).first().click();
    await accessible("sign-in");
    await page.getByLabel(/personal access token/i).fill(token);
    await page.getByRole("button", { name: "Sign in with the token" }).click();
    await page.getByRole("button", { name: "Not now" }).click();
    await see(page).toHaveURL(`${origin}/`);
    await see(page.getByRole("heading", { name: "Your repositories" })).toBeVisible();
    await accessible("home");
  });

  it("creates a repository, adds a README and renders it with its diagram", async () => {
    await page.getByLabel("Name").fill("demo");
    await page.getByLabel("Description (optional)").fill("A demonstration");
    await page.getByRole("button", { name: "Create" }).click();
    await see(page).toHaveURL(`${origin}/ada/demo`);
    await see(page.getByText("This repository is empty")).toBeVisible();
    await accessible("empty repository");
    await page.getByRole("link", { name: "Add a file" }).click();
    await page.getByLabel("File name").fill("README.md");
    await page
      .getByLabel("Content")
      .fill("# Demo\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```mermaid\ngraph TD; A-->B\n```\n");
    await accessible("editor");
    await page.getByRole("button", { name: "Commit" }).click();
    await see(page).toHaveURL(/\/ada\/demo\/blob\//);
    await page.goto(`${origin}/ada/demo`);
    await see(page.getByRole("heading", { name: "Demo", exact: true })).toBeVisible();
    await see(page.locator(".markdown table")).toBeVisible();
    await see(page.locator("figure.mermaid img")).toBeVisible({ timeout: 20_000 });
    await accessible("repository with README");
    // The clone URL, copied as shown.
    await page.getByRole("button", { name: "Copy" }).click();
    expect(
      await page.evaluate(() =>
        (
          navigator as unknown as { clipboard: { readText(): Promise<string> } }
        ).clipboard.readText(),
      ),
    ).toBe(`${origin}/ada/demo.git`);
  });

  it("lists the commit, signed and verified", async () => {
    await page.getByRole("link", { name: "Commits" }).click();
    await see(page.getByText("Add README.md")).toBeVisible();
    await see(page.getByText("Verified")).toBeVisible();
    await accessible("commits");
  });

  it("edits a file into hostile Markdown that stays inert, and follows its relative link", async () => {
    // A file in a directory for the README to link to.
    await page.goto(`${origin}/ada/demo/edit/main/?new=1`);
    await page.getByLabel("File name").fill("docs/guide.md");
    await page.getByLabel("Content").fill("# Guide\n");
    await page.getByRole("button", { name: "Commit" }).click();
    await see(page).toHaveURL(/\/ada\/demo\/blob\/main\/docs\/guide\.md$/);
    await accessible("file");
    await page.goto(`${origin}/ada/demo/tree/main/docs`);
    await see(page.getByRole("link", { name: "guide.md" })).toBeVisible();
    await accessible("directory");
    // The README, edited where it is.
    await page.goto(`${origin}/ada/demo/blob/main/README.md`);
    await page.getByRole("link", { name: "Edit" }).click();
    await accessible("editor, an existing file");
    await page.getByLabel("Content").fill(
      [
        "# Demo",
        "",
        "[Guide](docs/guide.md) [Bad](javascript:window.pwned=1)",
        "",
        '<img src=x onerror="window.pwned=2"><script>window.pwned=3</script>',
        "",
        "```mermaid",
        'graph TD; A["<img src=x onerror=window.pwned=4>"]-->B',
        'click A "javascript:window.pwned=5"',
        "```",
        "",
        // A diagram's own settings may not turn HTML labels back on.
        "```mermaid",
        '%%{init: {"htmlLabels": true, "flowchart": {"htmlLabels": true}}}%%',
        'graph TD; C["<img src=x onerror=window.pwned=6>"]-->D',
        "```",
        "",
        "```mermaid",
        "---",
        "config:",
        "  htmlLabels: true",
        "  flowchart:",
        "    htmlLabels: true",
        "---",
        'graph TD; E["<img src=x onerror=window.pwned=7>"]-->F',
        "```",
        "",
      ].join("\n"),
    );
    await page.getByRole("button", { name: "Commit" }).click();
    await see(page).toHaveURL(/\/ada\/demo\/blob\/main\/README\.md$/);
    await page.goto(`${origin}/ada/demo`);
    await see(page.locator("figure.mermaid img")).toHaveCount(3, { timeout: 20_000 });
    // Drawings are images: none of their markup is in the page to act on.
    expect(await page.locator(".markdown svg").count()).toBe(0);
    // Nothing the README holds ran, or made an element of its own.
    expect(await page.evaluate(() => (globalThis as { pwned?: unknown }).pwned)).toBeUndefined();
    expect(
      await page
        .locator(".markdown script, .markdown img[src='x']")
        .evaluateAll((found) =>
          found.map((e) => (e as unknown as { outerHTML: string }).outerHTML),
        ),
    ).toEqual([]);
    expect(await page.locator(".markdown a[href^='javascript']").count()).toBe(0);
    await page.getByRole("link", { name: "Guide" }).click();
    await see(page).toHaveURL(`${origin}/ada/demo/blob/main/docs/guide.md`);
    await see(page.getByRole("heading", { name: "Guide", exact: true })).toBeVisible();
  });

  it("downloads an archive, and shows the repository's settings", async () => {
    await page.goto(`${origin}/ada/demo`);
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 60_000 }),
      page.getByRole("link", { name: "Download .zip" }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^ada-demo-[0-9a-f]{7}\.zip$/);
    await page.goto(`${origin}/ada/demo/settings`);
    await see(page.getByLabel("Description")).toHaveValue("A demonstration");
    await accessible("repository settings");
  });

  it("opens a file whose name ends in .data, and keeps the pages' data out of caches", async () => {
    const put = await fetch(`${origin}/api/repos/ada/demo/contents/notes.data`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify({
        message: "Add notes.data",
        content: Buffer.from("plain notes\n").toString("base64"),
      }),
    });
    expect(put.status).toBe(200);
    // React Router would take the path for its own data request: opened with a slash.
    await page.goto(`${origin}/ada/demo/blob/main/notes.data`);
    await see(page).toHaveURL(`${origin}/ada/demo/blob/main/notes.data/`);
    await see(page.getByText("plain notes")).toBeVisible();
    // The data a page navigates with, as the signed-in browser fetches it.
    const data = await page.request.get(`${origin}/ada/demo.data`);
    expect(data.status()).toBe(200);
    expect(data.headers()["cache-control"]).toBe("private, no-store");
  });

  it("keeps the colour scheme picked in the header, over the operating system's", async () => {
    // Retrying: a page's elements are there before its stylesheet has loaded.
    const backgroundIs = (colour: string) =>
      see(page.locator("body")).toHaveCSS("background-color", colour);
    const theme = () => page.locator("html").getAttribute("data-theme");
    const pressed = (name: string) =>
      see(page.getByRole("button", { name, exact: true })).toHaveAttribute("aria-pressed", "true");
    const LIGHT = rgbOf(FJORD.light.page.bg);
    const DARK = rgbOf(FJORD.dark.page.bg);
    const path = "/ada/demo/commits";
    await page.goto(`${origin}${path}?from=header`);
    await pressed("System");
    expect(await theme()).toBeNull();

    // Picked: the same page again, in the choice, whatever the operating system says.
    await pickScheme("Dark");
    expect(page.url()).toBe(`${origin}${path}?from=header`);
    await pressed("Dark");
    expect(await theme()).toBe("dark");
    await backgroundIs(DARK);
    await accessible("forced dark");
    await backgroundIs(DARK);

    // Already there in the first bytes: no flash, and no script needed to apply it.
    const html = await (await page.request.get(`${origin}${path}`)).text();
    expect(html).toContain('<html lang="en" data-theme="dark"');
    await page.reload();
    await backgroundIs(DARK);

    await pickScheme("Light");
    await pressed("Light");
    await page.emulateMedia({ colorScheme: "dark" });
    await backgroundIs(LIGHT);
    await page.emulateMedia({ colorScheme: "light" });
    await accessible("forced light");

    // System: the choice is gone, and the page follows the operating system again.
    await pickScheme("System");
    await pressed("System");
    expect(await theme()).toBeNull();
    expect((await page.context().cookies()).some((c) => c.name === "fyrden_theme")).toBe(false);
    await backgroundIs(LIGHT);
    await page.emulateMedia({ colorScheme: "dark" });
    await backgroundIs(DARK);
    await page.emulateMedia({ colorScheme: "light" });
  });

  it("keeps what is being written when the colour scheme changes", async () => {
    await page.goto(`${origin}/ada/demo/edit/main/?new=1`);
    await page.locator("html[data-hydrated]").waitFor({ state: "attached" });
    const content = page.getByLabel("Content");
    await content.fill("Half a thought");
    // Set on this document: a reload or a navigation would lose it.
    await page.evaluate(() => {
      (globalThis as { sameDocument?: boolean }).sameDocument = true;
    });
    const url = page.url();
    await pickScheme("Dark");
    await see(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await see(page.locator("body")).toHaveCSS("background-color", rgbOf(FJORD.dark.page.bg));
    await see(content).toHaveValue("Half a thought");
    expect(page.url()).toBe(url);
    expect(await page.evaluate(() => (globalThis as { sameDocument?: boolean }).sameDocument)).toBe(
      true,
    );
    // Kept for the next page, by the server.
    await page.reload();
    await see(page.locator("html")).toHaveAttribute("data-theme", "dark");

    // A choice that could not be kept is not shown as if it were.
    await page.route("**/appearance", (route) => route.abort());
    await page.getByRole("button", { name: "Light", exact: true }).click();
    await see(page.getByRole("button", { name: "Dark", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await see(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.unroute("**/appearance");
    await pickScheme("System");
    await see(page.locator("html")).not.toHaveAttribute("data-theme", "dark");
  });

  it("checks a page in all six colour scheme states through the header's control, and puts it back", async () => {
    await page.goto(`${origin}/ada/demo/commits`);
    await page.locator("html[data-hydrated]").waitFor({ state: "attached" });
    // A start other than the default, to see it come back.
    await pickScheme("Light");
    await page.emulateMedia({ colorScheme: "dark" });
    try {
      // A fault only Dark picked shows: the brand in a colour barely apart from its background
      // (exactly equal axe takes for hidden text). Through the stylesheet's own rules, which
      // the pages' Content Security Policy allows.
      await page.locator("html").evaluate(
        (html, [background, colour]) => {
          type Sheet = { href: string | null; cssRules: { length: number } };
          const root = html as unknown as {
            ownerDocument: {
              styleSheets: Iterable<Sheet & { insertRule(rule: string, at: number): void }>;
            };
          };
          const sheet = [...root.ownerDocument.styleSheets].find((s) =>
            s.href?.includes("/assets/"),
          );
          if (!sheet) throw new Error("no stylesheet");
          sheet.insertRule(
            `html[data-theme="dark"] header.site .brand { background-color: ${background} !important; color: ${colour} !important }`,
            sheet.cssRules.length,
          );
        },
        [FJORD.dark.page.bg, FJORD.dark.page.panel] as const,
      );
      const posted: string[] = [];
      const noted = (request: { url(): string; postData(): string | null }) => {
        if (new URL(request.url()).pathname === "/appearance")
          posted.push(new URLSearchParams(request.postData() ?? "").get("mode") ?? "");
      };
      page.on("request", noted);
      // On a failure the start is put back without waiting for the server (the failure is
      // what to report), so this waits for that post itself: the second Light one.
      let lights = 0;
      const restored = page.waitForEvent("requestfinished", {
        predicate: (request) =>
          new URL(request.url()).pathname === "/appearance" &&
          new URLSearchParams(request.postData() ?? "").get("mode") === "light" &&
          ++lights === 2,
      });
      const failure = await accessibleInEveryTheme(page, "a page with a fault").then(
        () => "no violation found",
        (error: Error) => error.message,
      );
      await restored;
      page.off("request", noted);
      expect(failure).toContain("dark picked, the system in light");
      expect(failure).toContain("color-contrast");
      // Each pick went through the server, as a visitor's does, then the starting one again.
      expect(posted).toEqual(["system", "light", "dark", "light"]);
      await see(page.getByRole("button", { name: "Light", exact: true })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(await page.evaluate('matchMedia("(prefers-color-scheme: dark)").matches')).toBe(true);
      const kept = (await page.context().cookies()).find((c) => c.name === "fyrden_theme");
      expect(kept?.value).toBe("light");

      // Without the fault, every state passes.
      await page.reload();
      await accessibleInEveryTheme(page, "commits");
    } finally {
      // The next tests start from System under a light system, whatever happened here.
      await page.emulateMedia({ colorScheme: "light" });
      await pickScheme("System");
    }
  });

  it("waits for the server to keep its own pick, not one still on its way", async () => {
    await page.goto(`${origin}/ada/demo/commits`);
    await page.locator("html[data-hydrated]").waitFor({ state: "attached" });
    let release = () => {};
    const held = new Promise<void>((done) => {
      release = done;
    });
    let first = true;
    await page.route("**/appearance", async (route) => {
      if (first) {
        first = false;
        await held;
      }
      await route.continue();
    });
    try {
      // A pick of Light whose post is held on its way; the page shows it at once.
      await page.getByRole("button", { name: "Light", exact: true }).click();
      await see(page.locator("html")).toHaveAttribute("data-theme", "light");
      const checked = accessibleInEveryTheme(page, "commits, with a pick still on its way");
      // The check's own first pick (System) is shown, its post queued behind Light's: let
      // Light's land now, which must not count as System's.
      await see(page.getByRole("button", { name: "System", exact: true })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      release();
      await checked;
    } finally {
      release();
      await page.unroute("**/appearance");
      await page.emulateMedia({ colorScheme: "light" });
      await pickScheme("System");
    }
  });

  it("keeps the header's control on screen on a phone", async () => {
    const before = page.viewportSize();
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`${origin}/ada/demo`);
      for (const name of ["System", "Light", "Dark"]) {
        await see(page.getByRole("button", { name, exact: true })).toBeInViewport({ ratio: 1 });
      }
      const widest = await page.locator("html").evaluate((html) => html.scrollWidth);
      expect(widest, `${width}px wide`).toBeLessThanOrEqual(width);
    }
    if (before) await page.setViewportSize(before);
  });

  it("draws a README's diagram again when the operating system's scheme changes", async () => {
    await page.goto(`${origin}/ada/demo`);
    const diagram = page.getByRole("img", { name: "Diagram" }).first();
    await see(diagram).toBeVisible();
    const light = await diagram.getAttribute("src");
    const drawnIn = (colour: string) => new RegExp(encodeURIComponent(colour));
    expect(light).toMatch(drawnIn(FJORD.light.page.panel));
    await page.emulateMedia({ colorScheme: "dark" });
    await see(diagram).toHaveAttribute("src", drawnIn(FJORD.dark.page.panel));
    await page.emulateMedia({ colorScheme: "light" });
    await see(diagram).toHaveAttribute("src", drawnIn(FJORD.light.page.panel));
  });

  it("takes a colour scheme without JavaScript, signed out", async () => {
    const browser = page.context().browser();
    if (!browser) throw new Error("The stack's page has no browser.");
    const context = await browser.newContext({ javaScriptEnabled: false });
    try {
      const visitor = await context.newPage();
      await visitor.goto(`${origin}/`);
      await visitor.getByRole("button", { name: "Dark", exact: true }).click();
      await see(visitor.locator("html")).toHaveAttribute("data-theme", "dark");
      await see(visitor.getByRole("button", { name: "Dark", exact: true })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await see(visitor).toHaveURL(`${origin}/`);
    } finally {
      await context.close();
    }
  });

  it("takes no form post from another origin, and changes nothing", async () => {
    const cookie = (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
    const readme = () =>
      fetch(`${origin}/api/repos/ada/demo/readme`, {
        headers: { Authorization: `Bearer ${token}` },
      }).then((r) => r.json() as Promise<{ sha: string }>);
    const before = await readme();
    for (const [path, fields] of [
      ["/?index", { name: "evil" }],
      ["/settings/tokens", { type: "git", days: "30" }],
      ["/settings/agents", { intent: "create-agent", handle: "evil-bot" }],
      ["/settings/notifications", { intent: "settings", watching: "on" }],
      ["/ada/demo/settings", { intent: "delete", confirm: "demo" }],
      ["/ada/demo/edit/main/README.md", { intent: "save", content: "pwned" }],
    ] as const) {
      const res = await fetch(`${origin}${path}`, {
        method: "POST",
        redirect: "manual",
        headers: { Origin: "https://evil.example", Cookie: cookie },
        body: new URLSearchParams(fields),
      });
      // Refused by React Router's own origin check (400) or the page's (403).
      expect([400, 403], path).toContain(res.status);
    }
    const api = (path: string) =>
      fetch(`${origin}/api${path}`, { headers: { Authorization: `Bearer ${token}` } });
    expect((await api("/repos/ada/demo")).status).toBe(200);
    expect((await api("/repos/ada/evil")).status).toBe(404);
    expect((await api("/agents/evil-bot")).status).toBe(404);
    expect((await readme()).sha).toBe(before.sha);
  });

  it("sends a Content Security Policy whose nonce only the page's own scripts carry", async () => {
    const response = await page.goto(`${origin}/ada/demo`);
    const policy = response?.headers()["content-security-policy"] ?? "";
    const nonce = /script-src 'self' 'nonce-([^']+)'/.exec(policy)?.[1];
    expect(nonce, policy).toBeTruthy();
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("frame-ancestors 'none'");
    // Every inline script React Router rendered carries it (the browser hides the
    // attribute's value from the DOM, but keeps it in the `nonce` property).
    const inline = await page.evaluate(() => {
      // In the page (this package has no DOM types).
      const { document } = globalThis as unknown as {
        document: { querySelectorAll(selector: string): ArrayLike<{ nonce: string }> };
      };
      return Array.from(document.querySelectorAll("script:not([src])"), (s) => s.nonce);
    });
    expect(inline.length).toBeGreaterThan(0);
    expect(inline.every((n) => n === nonce)).toBe(true);
    // HEAD answers the same headers.
    const head = await fetch(`${origin}/`, { method: "HEAD" });
    expect(head.headers.get("content-security-policy")).toMatch(/script-src 'self' 'nonce-/);
    // A new one on the next response.
    const again = await page.goto(`${origin}/ada/demo`);
    expect(again?.headers()["content-security-policy"]).not.toContain(nonce);
  });

  it("creates a git token and an agent", async () => {
    await page.goto(`${origin}/settings/tokens`);
    await page.getByRole("button", { name: "Create token" }).click();
    await see(page.locator("pre.secret")).toContainText("fyrden_git_");
    await accessible("tokens");
    await page.goto(`${origin}/settings/agents`);
    await page.getByPlaceholder("handle").fill("ada-bot");
    await page.getByRole("button", { name: "Create agent" }).click();
    await see(page.getByRole("cell", { name: "ada-bot" })).toBeVisible();
    await accessible("agents");
  });

  it("sets what notification email is sent, and says the deployment sends none yet", async () => {
    await page.goto(`${origin}/settings/notifications`);
    await see(page.getByText("No address yet")).toBeVisible();
    await page.getByLabel("Threads you take part in").check();
    await page.getByRole("button", { name: "Save" }).click();
    await see(page.getByRole("status")).toContainText("saved");
    // Kept: read back from the API.
    await page.goto(`${origin}/settings/notifications`);
    await see(page.getByLabel("Threads you take part in")).toBeChecked();
    await see(page.getByLabel("Repositories you watch")).not.toBeChecked();
    // This stack sends no email: adding an address is refused, and the page says why.
    await page.getByLabel("Add an address").fill("ada@example.com");
    await page.getByRole("button", { name: "Add address" }).click();
    await see(page.getByRole("alert")).toContainText("sends no email");
    await accessible("notifications");
  });

  it("never had a script, style or image refused by the policy on any page", () => {
    expect(stack?.refused).toEqual([]);
  });
  it("serves unsubscribe links on the public origin, with no credential", async () => {
    // A link as an email carries it (signed with the deployment's key), for an address it never
    // had: answered as any, nothing written.
    const id = `eml_${randomBytes(16)
      .toString("hex")
      .toUpperCase()
      .replace(/[ILOU]/g, "0")
      .slice(0, 26)}`;
    const payload = `v1.${id}.watching`;
    const mac = createHmac("sha256", Buffer.from((stack as WebStack).emailKey, "base64url"))
      .update(payload)
      .digest("base64url");
    const link = `${origin}/unsubscribe?t=${encodeURIComponent(`${payload}.${mac}`)}`;
    const opened = await fetch(link);
    expect(opened.status).toBe(200);
    expect(await opened.text()).toContain('method="post"');
    const head = await fetch(link, { method: "HEAD" });
    expect(head.status).toBe(200);
    const oneClick = await fetch(link, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click",
      redirect: "manual",
    });
    expect(oneClick.status).toBe(200);
    const forged = await fetch(`${origin}/unsubscribe?t=v1.forged`, { method: "POST" });
    // On a wrong answer, what the Workers logged says why.
    expect(forged.status, `${await forged.text()}\n${stack?.output().slice(-6000)}`).toBe(400);
  });
});
