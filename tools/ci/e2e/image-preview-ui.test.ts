// An image on a file's page in a real browser against both Workers: real images drawn, files
// that only look like images not drawn, a failure before and after the page's scripts take
// over, and another origin kept from using the bytes with the viewer's cookie. Needs
// `pnpm --filter @fyrden/web build` first (turbo does it).

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { crc32, deflateSync } from "node:zlib";
import { type Page, expect as see } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accessible, startWebStack, visit, type WebStack } from "./web-stack.js";

let stack: WebStack;
let page: Page;
const REPO = "/ada/pictures";
/** A failed image's request takes as long as a loaded machine does: a limit, not a wait. */
const SETTLED = { timeout: 30_000 };

function pngChunk(type: string, body: Uint8Array): Buffer {
  const named = Buffer.concat([Buffer.from(type, "latin1"), body]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  const check = Buffer.alloc(4);
  check.writeUInt32BE(crc32(named));
  return Buffer.concat([length, named, check]);
}

/** A PNG's signature and header, for 8-bit RGB pixels. */
function pngHeader(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
  ]);
}

/** A whole PNG a browser decodes: one colour, its pixels deflated at `level`. */
function solidPng(width: number, height: number, level = 9): Buffer {
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set([0x2a, 0x7f, 0xb8], 1 + x * 3);
  const rows = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    pngHeader(width, height),
    pngChunk("IDAT", deflateSync(rows, { level })),
    pngChunk("IEND", new Uint8Array()),
  ]);
}

const MIB = 1024 * 1024;
const FILES: Readonly<Record<string, Buffer>> = {
  "small.png": solidPng(64, 48),
  "no-extension": solidPng(32, 32),
  "pic.data": solidPng(16, 16),
  // Over the inline limit: stored, not compressed, so its size is real.
  "large.png": solidPng(640, 640, 0),
  "spoof.png": Buffer.from(
    "<svg xmlns='http://www.w3.org/2000/svg'><text>not an image</text></svg>",
  ),
  // Text that starts as a GIF's header would: a browser draws the first as a blank image.
  "looks-drawable.txt": Buffer.from("GIF89a\n\n\n\nsome words\n"),
  "looks-vast.txt": Buffer.from("GIF89aWORDS and more words\n"),
  "not-really.png": Buffer.alloc(MIB + 1024, "not an image\n"),
  // Only a header claiming more pixels than the limit: nothing has to draw to tell.
  "vast.png": pngHeader(4001, 4000),
};

async function api(method: string, path: string, body: unknown): Promise<void> {
  const res = await fetch(`${stack.origin}/api${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${stack.token}`,
      "Content-Type": "application/json",
      "Idempotency-Key": crypto.randomUUID(),
    },
    body: JSON.stringify(body),
  });
  expect(res.ok, `${path}: ${await res.text()}`).toBe(true);
}

beforeAll(async () => {
  stack = await startWebStack("ada");
  ({ page } = stack);
  await api("POST", "/user/repos", { name: "pictures" });
  for (const [path, bytes] of Object.entries(FILES))
    await api("PUT", `/repos${REPO}/contents/${path}`, {
      message: `Add ${path}`,
      content: bytes.toString("base64"),
    });
}, 240_000);

afterAll(async () => {
  await stack?.stop();
});

const blob = (path: string) => `${stack.origin}${REPO}/blob/main/${path}`;
const image = (name: string) => page.getByRole("img", { name, exact: true });
const raw = () => page.getByRole("link", { name: "Raw", exact: true });
const failure = () => page.getByText("This image can't be previewed.");

describe("an image on a file's page", () => {
  it("draws an image, at its size, from its commit, with the guarding headers", async () => {
    await visit(page, blob("small.png"));
    const small = image("small.png");
    await see(small).toHaveJSProperty("naturalWidth", 64);
    await see(small).toHaveAttribute("width", "64");
    await see(small).toHaveAttribute("height", "48");
    const src = (await small.getAttribute("src")) ?? "";
    expect(src).toMatch(new RegExp(`^${REPO}/preview/[0-9a-f]{40}/small\\.png/$`));
    await see(raw()).toBeVisible();
    await accessible(page, "an image's page");

    const res = await page.request.get(`${stack.origin}${src}`);
    expect(res.status()).toBe(200);
    expect(Buffer.compare(await res.body(), FILES["small.png"] as Buffer)).toBe(0);
    expect(res.headers()).toMatchObject({
      "content-type": "image/png",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'; sandbox",
      "x-frame-options": "DENY",
      "cross-origin-resource-policy": "same-origin",
      "cache-control": "private, no-store",
    });
  });

  it("goes by the bytes up to 1 MiB, whatever the name", async () => {
    await visit(page, blob("no-extension"));
    await see(image("no-extension")).toHaveJSProperty("naturalWidth", 32);
    await visit(page, blob("spoof.png"));
    await see(page.getByText("not an image")).toBeVisible();
    await see(page.getByRole("img")).toHaveCount(0);
  });

  it("serves a name ending in .data, not React Router's data for its page", async () => {
    await visit(page, blob("pic.data/"));
    const pic = image("pic.data");
    await see(pic).toHaveJSProperty("naturalWidth", 16);
    const res = await page.request.get(`${stack.origin}${await pic.getAttribute("src")}`);
    expect(res.headers()["content-type"]).toBe("image/png");
    expect(Buffer.compare(await res.body(), FILES["pic.data"] as Buffer)).toBe(0);
  });

  it("tries a raster name past 1 MiB, with the route checking the bytes", async () => {
    expect(FILES["large.png"]?.length).toBeGreaterThan(MIB);
    await visit(page, blob("large.png"));
    const large = image("large.png");
    await see(large).toHaveJSProperty("naturalWidth", 640, SETTLED);
    await accessible(page, "a large image's page");
    expect(await large.getAttribute("width")).toBeNull();
  });

  it("says an image over 16 megapixels is too large, without trying it", async () => {
    await visit(page, blob("vast.png"));
    await see(page.getByText("This image is too large to preview.")).toBeVisible();
    await see(page.getByRole("img")).toHaveCount(0);
    await see(raw()).toBeVisible();
    await accessible(page, "an image too large to preview");
  });

  it("shows text that only starts like an image as its text", async () => {
    await visit(page, blob("looks-drawable.txt"));
    await see(page.getByText("some words")).toBeVisible(SETTLED);
    await see(failure()).toHaveCount(0);
    await see(page.getByRole("link", { name: "Edit", exact: true })).toBeVisible();

    await visit(page, blob("looks-vast.txt"));
    await see(page.getByText("and more words")).toBeVisible(SETTLED);
    await see(page.getByText("This image is too large to preview.")).toHaveCount(0);
    await accessible(page, "text that starts like an image");
  });

  it("says so when an image fails after the page has taken over", async () => {
    await visit(page, `${stack.origin}${REPO}/tree/main`);
    await page.getByRole("link", { name: "not-really.png" }).click();
    await see(failure()).toBeVisible(SETTLED);
    await see(page.getByRole("img")).toHaveCount(0);
    await see(raw()).toBeVisible();
    // A later file on the same page component starts afresh.
    await page.goBack();
    await page.getByRole("link", { name: "small.png" }).click();
    await see(image("small.png")).toHaveJSProperty("naturalWidth", 64, SETTLED);
  });

  it("tries a failed image again when it is opened again from another file", async () => {
    await visit(page, blob("small.png"));
    // Client navigation with no link between two files: the page component stays mounted.
    const navigate = (to: string) =>
      page.evaluate((path) => {
        const { __reactRouterDataRouter: router } = globalThis as unknown as {
          __reactRouterDataRouter: { navigate(path: string): Promise<void> };
        };
        return router.navigate(path);
      }, to);
    const refuseImages = "**/preview/**";
    await page.route(refuseImages, (route) => route.fulfill({ status: 503 }));
    await page.reload();
    await page.locator("html[data-hydrated]").waitFor({ state: "attached" });
    await see(failure()).toBeVisible(SETTLED);
    await page.unroute(refuseImages);
    await navigate(`${REPO}/blob/main/no-extension`);
    await see(image("no-extension")).toHaveJSProperty("naturalWidth", 32, SETTLED);
    await navigate(`${REPO}/blob/main/small.png`);
    await see(image("small.png")).toHaveJSProperty("naturalWidth", 64, SETTLED);
    await see(failure()).toHaveCount(0);
  });

  it("says so when an image failed before the page's scripts ran", async () => {
    let release = () => {};
    const released = new Promise<void>((done) => {
      release = done;
    });
    await page.route("**/assets/**/*.js", async (route) => {
      await released;
      await route.continue();
    });
    try {
      await page.goto(blob("not-really.png"), { waitUntil: "commit" });
      const failed = image("not-really.png");
      await see(failed).toHaveJSProperty("complete", true, SETTLED);
      await see(failed).toHaveJSProperty("naturalWidth", 0);
      expect(await page.locator("html[data-hydrated]").count()).toBe(0);
      release();
      await page.locator("html[data-hydrated]").waitFor({ state: "attached" });
    } finally {
      release();
      await page.unroute("**/assets/**/*.js");
    }
    await see(failure()).toBeVisible();
    await see(raw()).toBeVisible();
    await accessible(page, "an image that failed");
    // The CSP allows every image above; nothing here depended on a refusal.
    expect(stack.refused).toEqual([]);
  });
});

describe("another origin's page", () => {
  let other: Server;

  afterAll(async () => {
    await new Promise((done) => other?.close(done));
  });

  it("can neither draw a private image nor frame it, though the viewer's cookie goes along", async () => {
    await visit(page, blob("small.png"));
    const src = await image("small.png").getAttribute("src");
    const target = `${stack.origin}${src}`;
    // Another port on the same host: same site, so the cookie is sent, and another origin.
    other = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html");
      response.end(
        `<!doctype html><title>Other</title><img alt="taken" src="${target}"><iframe title="framed" src="${target}"></iframe>`,
      );
    });
    await new Promise<void>((done) => other.listen(0, "localhost", done));
    const { port } = other.address() as AddressInfo;

    const served = page.waitForResponse(
      (res) => res.url() === target && res.request().resourceType() === "document",
    );
    await page.goto(`http://localhost:${port}/`);
    // The viewer's cookie was accepted: the refusal below is the headers', not a 404's.
    expect((await served).status()).toBe(200);
    const taken = image("taken");
    await see(taken).toHaveJSProperty("complete", true, SETTLED);
    await see(taken).toHaveJSProperty("naturalWidth", 0);
    const frame = page.frames().find((candidate) => candidate !== page.mainFrame());
    // Chromium's page for a frame it refused.
    expect(frame?.url()).toMatch(/^chrome-error:/);
  });
});
