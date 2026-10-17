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
import { mentionsToken } from "@fyrden/domain";
import { type Page, expect as see } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accessible as axe, startWebStack, type WebStack } from "./web-stack.js";

let stack: WebStack | undefined;
let page: Page;
// localhost: a secure context, so the browser keeps the __Host- session cookie over http.
let origin = "";
let token = "";

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

  it("never had a script, style or image refused by the policy on any page", () => {
    expect(stack?.refused).toEqual([]);
  });
});
