// Both Workers under one wrangler dev (the real service binding), a first
// user made through bootstrap, and a Chromium page signed in as that user:
// what a browser test of the web UI starts from. Needs `pnpm --filter
// @fyrden/web build` first (turbo does it).
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { type Browser, chromium, type Page, expect as see } from "@playwright/test";
import { expect } from "vitest";
import { startWranglerDev, type WranglerDev } from "./wrangler-dev.js";

const root = resolve(import.meta.dirname, "../../..");
const apiConfig = join(root, "apps/api/wrangler.jsonc");
const webConfig = join(root, "apps/web/build/server/wrangler.json");
const wranglerBin = join(
  dirname(createRequire(import.meta.url).resolve("wrangler/package.json")),
  "bin",
  "wrangler.js",
);

export interface WebStack {
  /** `http://localhost:<port>`: a secure context, so the browser keeps the `__Host-` cookie. */
  readonly origin: string;
  readonly port: number;
  /** The first user's personal access token. */
  readonly token: string;
  readonly handle: string;
  readonly page: Page;
  /** A scratch directory, removed by `stop`. */
  readonly scratch: string;
  /** What the browser refused under the pages' Content Security Policy, on any page. */
  readonly refused: string[];
  /** Everything both Workers wrote. */
  output(): string;
  stop(): Promise<void>;
}

function wrangler(args: string[], cwd: string): Promise<{ code: number | null; output: string }> {
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

export interface WebStackOptions {
  /** Sign the user in through the sign-in page before returning (default true). */
  readonly signIn?: boolean;
  /** Browser permissions for the page's context (the clipboard, say). */
  readonly permissions?: string[];
}

/**
 * Starts both Workers on fresh local state, makes `handle` the first user,
 * and opens a browser page (signed in unless asked not to). A start that
 * fails part way stops what it started and removes its scratch directory.
 */
export async function startWebStack(
  handle: string,
  options: WebStackOptions = {},
): Promise<WebStack> {
  const scratch = await mkdtemp(join(tmpdir(), "fyrden-web-stack-"));
  let output = "";
  let server: WranglerDev | undefined;
  let browser: Browser | undefined;
  const stop = async () => {
    try {
      await browser?.close().catch(() => undefined);
      await server?.stop();
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  };
  try {
    const persist = join(scratch, "state");
    const envFile = join(scratch, "test.env");
    const bootstrapSecret = `web-${crypto.randomUUID()}`;
    const signingSeed = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
    await writeFile(envFile, `BOOTSTRAP_SECRET=${bootstrapSecret}\nSIGNING_KEY=${signingSeed}\n`);
    for (const db of ["DIRECTORY", "ORG_READ"]) {
      const migrated = await wrangler(
        ["d1", "migrations", "apply", db, "--local", "--persist-to", persist, "-c", apiConfig],
        join(root, "apps/api"),
      );
      expect(migrated.code, migrated.output).toBe(0);
    }
    server = await startWranglerDev({
      args: ["-c", webConfig, "-c", apiConfig, "--persist-to", persist, "--env-file", envFile],
      cwd: join(root, "apps/web"),
      onOutput: (text) => {
        output += text;
      },
    });
    const origin = `http://localhost:${server.port}`;
    const boot = await fetch(`${origin}/v0/admin/bootstrap`, {
      method: "POST",
      headers: { "X-Fyrden-Bootstrap-Secret": bootstrapSecret, "Content-Type": "application/json" },
      body: JSON.stringify({ handle }),
    });
    expect(boot.status, await boot.clone().text()).toBe(201);
    const token = ((await boot.json()) as { token: string }).token;
    browser = await chromium.launch();
    const page = await (
      await browser.newContext(options.permissions ? { permissions: options.permissions } : {})
    ).newPage();
    const refused: string[] = [];
    page.on("console", (message) => {
      if (message.text().includes("Content Security Policy")) refused.push(message.text());
    });
    if (options.signIn !== false) {
      await page.goto(`${origin}/auth/sign-in?return_to=%2F`);
      await page.getByLabel(/personal access token/i).fill(token);
      await page.getByRole("button", { name: "Sign in with the token" }).click();
      await page.getByRole("button", { name: "Not now" }).click();
      await see(page).toHaveURL(`${origin}/`);
    }
    return {
      origin,
      port: server.port,
      token,
      handle,
      page,
      scratch,
      refused,
      output: () => output,
      stop,
    };
  } catch (error) {
    await stop();
    throw new Error(`The web stack did not start:\n${output}`, { cause: error });
  }
}

/**
 * Opens `url` and waits until the page's scripts have taken it over
 * (`html[data-hydrated]`, set once React has hydrated it): before that a
 * form posts as a plain HTML form (a whole new page), and a test that
 * acts at once on a slow machine would test that instead.
 */
export async function visit(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.locator("html[data-hydrated]").waitFor({ state: "attached" });
}

/** Loads the page again, waiting as `visit` does. */
export async function reload(page: Page): Promise<void> {
  await page.reload();
  await page.locator("html[data-hydrated]").waitFor({ state: "attached" });
}

/** `page` has no WCAG 2.x A or AA violation axe can find. */
export async function accessible(page: Page, name: string): Promise<void> {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(
    result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`),
    name,
  ).toEqual([]);
}
