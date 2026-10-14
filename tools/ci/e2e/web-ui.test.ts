// The web UI in a real browser (Chromium through Playwright) against both
// Workers under one wrangler dev (the real service binding): a person signs
// in, creates a repository, adds a README (GitHub-flavored Markdown with a
// Mermaid diagram) and sees it rendered, sees the commit signed and
// verified, copies the clone URL, edits the README into hostile Markdown that
// stays inert, follows its relative link, downloads an archive, creates a
// git token and an agent; no form takes a post from another origin. Every
// page it visits is checked with axe for WCAG 2.x A and AA. Needs `pnpm
// --filter @fyrden/web build` first (turbo does it).
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { mentionsToken } from "@fyrden/domain";
import { type Browser, chromium, type Page, expect as see } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const apiConfig = join(root, "apps/api/wrangler.jsonc");
const webConfig = join(root, "apps/web/build/server/wrangler.json");
const wranglerBin = join(
  dirname(createRequire(import.meta.url).resolve("wrangler/package.json")),
  "bin",
  "wrangler.js",
);
const port = 40_000 + Math.floor(Math.random() * 10_000);
// localhost: a secure context, so the browser keeps the __Host- session cookie over http.
const origin = `http://localhost:${port}`;
const bootstrapSecret = `web-${crypto.randomUUID()}`;
const signingSeed = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");

let scratch = "";
let dev: ChildProcess | undefined;
let closed: Promise<void> = Promise.resolve();
let output = "";
let browser: Browser | undefined;
let page: Page;
let token = "";
let envFile = "";
/** What the browser refused under the pages' Content Security Policy, on any page. */
const refused: string[] = [];

function run(args: string[], cwd: string): Promise<{ code: number | null; output: string }> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [wranglerBin, ...args], {
      cwd,
      env: { ...process.env, NO_COLOR: "1", WRANGLER_SEND_METRICS: "false" },
    });
    let text = "";
    child.stdout.on("data", (d: Buffer) => {
      text += d;
    });
    child.stderr.on("data", (d: Buffer) => {
      text += d;
    });
    child.on("error", fail);
    child.on("close", (code) => done({ code, output: text }));
  });
}

/** The page has no WCAG 2.x A or AA violation axe can find. */
async function accessible(name: string): Promise<void> {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(
    result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`),
    name,
  ).toEqual([]);
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "fyrden-web-ui-"));
  const persist = join(scratch, "state");
  envFile = join(scratch, "test.env");
  await writeFile(envFile, `BOOTSTRAP_SECRET=${bootstrapSecret}\nSIGNING_KEY=${signingSeed}\n`);
  for (const db of ["DIRECTORY", "ORG_READ"]) {
    const migrated = await run(
      ["d1", "migrations", "apply", db, "--local", "--persist-to", persist, "-c", apiConfig],
      join(root, "apps/api"),
    );
    expect(migrated.code, migrated.output).toBe(0);
  }
  dev = spawn(
    process.execPath,
    [
      wranglerBin,
      "dev",
      "-c",
      webConfig,
      "-c",
      apiConfig,
      "--persist-to",
      persist,
      // An env file reaches both Workers (`--var` only the first config's).
      "--env-file",
      envFile,
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      // Its own inspector port: concurrent servers each probing up from
      // 9229 can pick the same one, and the later fails to bind.
      "--inspector-port",
      String(port + 1),
    ],
    {
      cwd: join(root, "apps/web"),
      env: { ...process.env, NO_COLOR: "1", WRANGLER_SEND_METRICS: "false" },
    },
  );
  const child = dev;
  closed = new Promise((done) => child.once("close", () => done()));
  await new Promise<void>((ready, fail) => {
    const timer = setTimeout(
      () => fail(new Error(`wrangler dev did not start:\n${output}`)),
      90_000,
    );
    const onData = (d: Buffer) => {
      output += d;
      if (/Ready on/.test(output)) {
        clearTimeout(timer);
        ready();
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("exit", (code) => fail(new Error(`wrangler dev exited (${code}):\n${output}`)));
  });
  // The first user, through the web origin (the binding carries it to fyrden-api).
  const boot = await fetch(`${origin}/v0/admin/bootstrap`, {
    method: "POST",
    headers: { "X-Fyrden-Bootstrap-Secret": bootstrapSecret, "Content-Type": "application/json" },
    body: JSON.stringify({ handle: "ada" }),
  });
  expect(boot.status, await boot.clone().text()).toBe(201);
  token = ((await boot.json()) as { token: string }).token;
  browser = await chromium.launch();
  const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  page = await context.newPage();
  page.on("console", (message) => {
    if (message.text().includes("Content Security Policy")) refused.push(message.text());
  });
}, 180_000);

afterAll(async () => {
  await browser?.close();
  if (dev && dev.exitCode === null && dev.signalCode === null) dev.kill("SIGTERM");
  await Promise.race([closed, new Promise((give) => setTimeout(give, 10_000))]);
  if (scratch) await rm(scratch, { recursive: true, force: true });
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
    await see(page.locator("figure.mermaid svg")).toBeVisible({ timeout: 20_000 });
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
    await see(page.locator("figure.mermaid svg")).toHaveCount(3, { timeout: 20_000 });
    const node = page.locator("figure.mermaid g.node").first();
    if ((await node.count()) > 0) await node.click();
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
    expect(refused).toEqual([]);
  });
});
