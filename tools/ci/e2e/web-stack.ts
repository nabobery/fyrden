// Both Workers under one wrangler dev (the real service binding), a first
// user made through bootstrap, and a Chromium page signed in as that user:
// what a browser test of the web UI starts from. Needs `pnpm --filter
// @fyrden/web build` first (turbo does it).
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { type Browser, chromium, type Page, expect as see } from "@playwright/test";
import { expect } from "vitest";
import { FJORD } from "../../../apps/web/app/lib/fjord.js";
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
  /** The key unsubscribe links are signed with (base64url), to make one as an email would. */
  readonly emailKey: string;
  /** What the browser refused under the pages' Content Security Policy, on any page. */
  readonly refused: string[];
  /** Everything both Workers wrote. */
  output(): string;
  /**
   * The lines the Workers wrote after `from` (an offset into `output()`),
   * without wrangler dev's own access log (`[wrangler:info]`), which echoes
   * request URLs and is not Worker output.
   */
  workerLines(from?: number): string[];
  /**
   * Resolves when a Worker line written after `from` matches: as the output
   * arrives, not by polling. Rejects after `deadlineMs` without one.
   */
  waitForLine(match: RegExp, from: number, deadlineMs?: number): Promise<void>;
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
  /** fyrden-api's variables (`FYRDEN_LIVE`, say), set in a copy of its configuration. */
  readonly vars?: Readonly<Record<string, string>>;
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
  // Beside the original, so its relative paths hold; removed on stop (and ignored by git).
  const config = options.vars
    ? join(root, `apps/api/wrangler.e2e-${crypto.randomUUID()}.jsonc`)
    : apiConfig;
  let output = "";
  // Checks, run on each piece of output, of the waitForLine calls still pending.
  const waiters = new Set<() => void>();
  const workerLines = (from = 0) =>
    output
      .slice(from)
      .split("\n")
      .filter((line) => !line.startsWith("[wrangler:info]"));
  const waitForLine = (match: RegExp, from: number, deadlineMs = 15_000) =>
    new Promise<void>((done, fail) => {
      // A deadline for failing, not a wait: the line itself resolves the promise.
      // biome-ignore lint/style/noRestrictedGlobals: a deadline for failing, not a wait: the line itself resolves the promise.
      const deadline = setTimeout(() => {
        waiters.delete(check);
        fail(new Error(`no Worker log line matched ${match}`));
      }, deadlineMs);
      const check = () => {
        if (!workerLines(from).some((line) => match.test(line))) return;
        waiters.delete(check);
        clearTimeout(deadline);
        done();
      };
      waiters.add(check);
      check();
    });
  let server: WranglerDev | undefined;
  let browser: Browser | undefined;
  const stop = async () => {
    try {
      await browser?.close().catch(() => undefined);
      await server?.stop();
    } finally {
      await rm(scratch, { recursive: true, force: true });
      if (config !== apiConfig) await rm(config, { force: true });
    }
  };
  try {
    const persist = join(scratch, "state");
    const envFile = join(scratch, "test.env");
    const bootstrapSecret = `web-${crypto.randomUUID()}`;
    const signingSeed = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
    const emailKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
    await writeFile(
      envFile,
      `BOOTSTRAP_SECRET=${bootstrapSecret}\nSIGNING_KEY=${signingSeed}\nEMAIL_KEY=${emailKey}\n`,
    );
    if (config !== apiConfig) {
      const original = await readFile(apiConfig, "utf8");
      // The configuration opens with its object and has no variables of its own to merge.
      expect(original.startsWith("{") && !original.includes('"vars"')).toBe(true);
      await writeFile(config, `{\n  "vars": ${JSON.stringify(options.vars)},${original.slice(1)}`);
    }
    for (const db of ["DIRECTORY", "ORG_READ"]) {
      const migrated = await wrangler(
        ["d1", "migrations", "apply", db, "--local", "--persist-to", persist, "-c", config],
        join(root, "apps/api"),
      );
      expect(migrated.code, migrated.output).toBe(0);
    }
    server = await startWranglerDev({
      args: ["-c", webConfig, "-c", config, "--persist-to", persist, "--env-file", envFile],
      cwd: join(root, "apps/web"),
      onOutput: (text) => {
        output += text;
        for (const check of waiters) check();
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
      emailKey,
      refused,
      output: () => output,
      workerLines,
      waitForLine,
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

/** What axe finds against WCAG 2.x A and AA on `page` as it stands, one line each. */
async function violations(page: Page): Promise<string[]> {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  return result.violations.map(
    (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
  );
}

/** `page` has no WCAG 2.x A or AA violation axe can find, in either colour scheme. */
export async function accessible(page: Page, name: string): Promise<void> {
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    expect(await violations(page), `${name}, ${colorScheme}`).toEqual([]);
  }
  await page.emulateMedia({ colorScheme: "light" });
}

/** The colour schemes the site header offers, by its buttons' values. */
const PICKS = ["system", "light", "dark"] as const;
type Pick = (typeof PICKS)[number];
const OS_SCHEMES = ["light", "dark"] as const;
type OsScheme = (typeof OS_SCHEMES)[number];

/** The site header's colour scheme control, by what it posts. */
const CONTROL = 'form[action="/appearance"]';
const pickButton = (page: Page, pick: Pick) =>
  page.locator(`${CONTROL} button[name="mode"][value="${pick}"]`);

/** `#rrggbb` as `getComputedStyle` reports it. */
function rgbOf(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

/** How long a pick's post may take to be sent; a bound, so a failure is reported, not a hang. */
const POST_SENT_MS = 15_000;

/**
 * Picks `pick` in the site header as its own control does: the control's form is submitted
 * with the button as its submitter, which runs the page's handler exactly as a click would,
 * rather than clicked, since a modal dialog (the file finder) makes the header inert to the
 * pointer and pages are checked with one open. Returns the post it sent, once sent.
 *
 * The page queues picks and sends them one at a time; the post taken as this one's is the
 * first of `pick`'s mode sent after the submission. So no other pick of the page's may still
 * be waiting to be sent when it is made: callers wait for their own picks to be kept.
 */
async function submitPick(page: Page, pick: Pick, timeout = POST_SENT_MS) {
  const sent = page.waitForEvent("request", {
    predicate: (request) =>
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/appearance" &&
      new URLSearchParams(request.postData() ?? "").get("mode") === pick,
    timeout,
  });
  // Handled at once: if finding the button outlasts this wait, its timeout must not surface as
  // an unhandled rejection beside the failure being reported. Awaiting `sent` still throws.
  sent.catch(() => undefined);
  await pickButton(page, pick).evaluate(
    (button) => {
      const submitter = button as unknown as {
        form: { requestSubmit(by: unknown): void } | null;
      };
      submitter.form?.requestSubmit(button);
    },
    undefined,
    { timeout },
  );
  return sent;
}

/** Picks `pick` (see `submitPick`) and returns once the server has kept it. */
async function pickScheme(page: Page, pick: Pick): Promise<void> {
  const post = await submitPick(page, pick);
  // Ended, answered or not: the page posts with `redirect: "manual"`, and while any request is
  // routed (a test answering the API itself) Playwright reports that answer as a failure though
  // the server took it (measured with Playwright 1.63.0's Chromium). The cookie says which.
  await post.response().catch(() => null);
  const cookie = (await page.context().cookies()).find((c) => c.name === "fyrden_theme");
  // System keeps no cookie.
  expect(cookie?.value ?? "system", `the server kept ${pick}`).toBe(pick);
}

/**
 * Waits until the page shows `pick` under an operating system in `os`: the button reads
 * pressed, the root carries the choice, the page's background is drawn in the scheme that
 * results (its stylesheet applied), and no file view is still drawing.
 */
async function settled(page: Page, pick: Pick, os: OsScheme): Promise<void> {
  await see(pickButton(page, pick)).toHaveAttribute("aria-pressed", "true");
  const root = page.locator("html");
  if (pick === "system") await see(root).not.toHaveAttribute("data-theme");
  else await see(root).toHaveAttribute("data-theme", pick);
  const shown = pick === "system" ? os : pick;
  await see(page.locator("body")).toHaveCSS("background-color", rgbOf(FJORD[shown].page.bg));
  // The renderer draws in the browser, and a drawing under way is replaced when it lands.
  await see(page.locator('[data-drawn="waiting"]')).toHaveCount(0, { timeout: 30_000 });
}

/**
 * `page` has no WCAG 2.x A or AA violation axe can find in any of the six states a visitor
 * can see it in: System, Light and Dark picked in the site header, each under an operating
 * system in light and in dark. Each is picked through the header's own control, so the
 * page's theme state and whatever follows it change as they would for a visitor; the page
 * is left with the pick and the scheme it started with. Needs a hydrated page, and no pick of
 * its own still waiting to be sent (see `submitPick`).
 */
export async function accessibleInEveryTheme(page: Page, name: string): Promise<void> {
  await page.locator("html[data-hydrated]").waitFor({ state: "attached" });
  const startPick = await page
    .locator(`${CONTROL} button[aria-pressed="true"]`)
    .getAttribute("value");
  if (!PICKS.includes(startPick as Pick)) throw new Error(`No colour scheme is picked: ${name}`);
  const startOs: OsScheme = (await page.evaluate(
    () =>
      (globalThis as unknown as { matchMedia(query: string): { matches: boolean } }).matchMedia(
        "(prefers-color-scheme: dark)",
      ).matches,
  ))
    ? "dark"
    : "light";
  let failure: unknown = null;
  try {
    for (const pick of PICKS) {
      await pickScheme(page, pick);
      for (const os of OS_SCHEMES) {
        await page.emulateMedia({ colorScheme: os });
        await settled(page, pick, os);
        expect(await violations(page), `${name}, ${pick} picked, the system in ${os}`).toEqual([]);
      }
    }
  } catch (error) {
    failure = error;
  }
  if (failure !== null) {
    // Put back, best effort and bounded, without waiting on what failed: the failure is what
    // to report.
    await page.emulateMedia({ colorScheme: startOs }).catch(() => undefined);
    await submitPick(page, startPick as Pick, 5_000).catch(() => undefined);
    throw failure;
  }
  await page.emulateMedia({ colorScheme: startOs });
  await pickScheme(page, startPick as Pick);
  await settled(page, startPick as Pick, startOs);
}
