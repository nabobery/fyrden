// A long unbroken word in Markdown, on a phone, in a real browser against both
// Workers under one wrangler dev: the word breaks and the page does not scroll
// sideways. Needs `pnpm --filter @fyrden/web build` first (turbo does it).
import { type Page, expect as see } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startWebStack, visit, type WebStack } from "./web-stack.js";

const PHONE = 390;
const handle = "ada";
const name = "words";
const WORD = "w".repeat(100);

let stack: WebStack;
let page: Page;

async function rest<T>(path: string, body: unknown): Promise<T> {
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
  expect(res.ok, `POST ${path}: ${text}`).toBe(true);
  return JSON.parse(text) as T;
}

const issue = (title: string, body: string) =>
  rest<{ number: number }>(`/repos/${handle}/${name}/issues`, { title, body });

const pageOf = (number: number) => `${stack.origin}/${handle}/${name}/issues/${number}`;

/** The page once its Markdown is drawn: until then it shows the source in a `pre`, which scrolls by itself. */
async function drawn(number: number): Promise<void> {
  await visit(page, pageOf(number));
  await see(page.locator(".markdown").first()).toBeVisible();
  await see(page.locator(".markdown-source")).toHaveCount(0);
}

const widest = () => page.locator("html").evaluate((html) => html.scrollWidth);

beforeAll(async () => {
  stack = await startWebStack(handle);
  page = stack.page;
  await rest("/user/repos", { name });
  await page.setViewportSize({ width: PHONE, height: 800 });
}, 180_000);

afterAll(async () => {
  await stack?.stop();
});

describe("a long unbroken word in Markdown on a phone", () => {
  it("breaks in an issue's body, with no sideways scroll", async () => {
    const { number } = await issue("In the body", WORD);
    await drawn(number);
    await see(page.locator(".markdown p").getByText(WORD)).toBeVisible();
    expect(await widest()).toBeLessThanOrEqual(PHONE);
  });

  it("breaks in a comment, with no sideways scroll", async () => {
    const { number } = await issue("In a comment", "Short.");
    await rest(`/repos/${handle}/${name}/issues/${number}/comments`, { body: WORD });
    await drawn(number);
    await see(page.locator(".timeline .markdown p").getByText(WORD)).toBeVisible();
    expect(await widest()).toBeLessThanOrEqual(PHONE);
  });

  it("leaves a code block on one line, scrolling in its own panel", async () => {
    const { number } = await issue("In a code block", `\`\`\`\n${WORD}\n\`\`\``);
    await drawn(number);
    const panel = page.locator(".markdown pre");
    const { scrolls, lines } = await panel.evaluate((pre, length) => {
      const SHOW_TEXT = 4;
      const text = pre.ownerDocument.createTreeWalker(pre, SHOW_TEXT).nextNode();
      if (!text) throw new Error("no text in the code block");
      const range = pre.ownerDocument.createRange();
      range.setStart(text, 0);
      range.setEnd(text, length);
      return { scrolls: pre.scrollWidth > pre.clientWidth, lines: range.getClientRects().length };
    }, WORD.length);
    expect(scrolls).toBe(true);
    expect(lines).toBe(1);
    expect(await widest()).toBeLessThanOrEqual(PHONE);
  });

  it("leaves the words of a wide table whole", async () => {
    const cells = [
      "production",
      "deployment",
      "international",
      "authentication",
      "organization",
      "documentation",
    ];
    const row = (of: readonly string[]) => `| ${of.join(" | ")} |`;
    const { number } = await issue(
      "In a table",
      [row(cells), row(cells.map(() => "---")), row(cells)].join("\n"),
    );
    await drawn(number);
    const lines = await page.locator(".markdown tbody td").evaluateAll((all) =>
      all.map((cell) => {
        const range = cell.ownerDocument.createRange();
        range.selectNodeContents(cell);
        return range.getClientRects().length;
      }),
    );
    expect(lines).toEqual(cells.map(() => 1));
  });
});
