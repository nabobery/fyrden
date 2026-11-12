// Releases in a real browser against both Workers, through the service
// binding: the page is reachable from the repository's navigation; a tag
// that doesn't exist is refused with what was written kept; a draft is saved
// and published; a slashed tag survives every link; the source archive
// downloads the recorded commit after the tag has gone; assets upload from the
// page in parts (one retried, through the binding with its exact length), a
// replace warns first, and download through the web route with ranges and
// conditions, refused once access is lost; hostile files never run; and every
// page passes axe in each theme. Needs `pnpm --filter @fyrden/web build` first
// (turbo does it).
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { type APIResponse, type Page, type Request, expect as see } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accessibleInEveryTheme, startWebStack, visit, type WebStack } from "./web-stack.js";

let stack: WebStack;
let page: Page;
let work: string;
const handle = "ada";
const name = "shipping";
const REPO = `/${handle}/${name}`;
const HOSTILE = "<img src=x onerror=window.pwned=1> crash";
const PART = 5 * 1024 * 1024;

function git(args: string[], cwd: string): Promise<string> {
  return new Promise((done, fail) => {
    execFile(
      "git",
      args,
      {
        cwd,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Ada",
          GIT_AUTHOR_EMAIL: "ada@example.com",
          GIT_COMMITTER_NAME: "Ada",
          GIT_COMMITTER_EMAIL: "ada@example.com",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_TERMINAL_PROMPT: "0",
        },
      },
      (error, stdout, stderr) =>
        error ? fail(new Error(`${error.message}\n${stderr}`)) : done(stdout),
    );
  });
}

async function rest<T>(
  method: string,
  path: string,
  body?: unknown,
  token = stack.token,
): Promise<T> {
  const res = await fetch(`${stack.origin}/api${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined && {
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  expect(res.ok, `${method} ${path}: ${text}`).toBe(true);
  return (text ? JSON.parse(text) : undefined) as T;
}

beforeAll(async () => {
  // Parts of 5 MiB, the least R2 takes, so a file a little larger goes in two.
  stack = await startWebStack(handle, { vars: { GIT_UPLOAD_PART_BYTES: String(PART) } });
  page = stack.page;
  await rest("POST", "/user/repos", { name });
  work = join(stack.scratch, name);
  await mkdir(work);
  await git(["init", "-q", "-b", "main"], work);
  await git(["commit", "-q", "--allow-empty", "-m", "first"], work);
  await git(["tag", "-a", "v1/rc", "-m", "the first"], work);
  const { token } = await rest<{ token: string }>("POST", "/user/git-tokens", {});
  const remote = `http://x-access-token:${token}@127.0.0.1:${stack.port}/${handle}/${name}.git`;
  await git(["remote", "add", "origin", remote], work);
  await git(["push", "-q", "origin", "refs/heads/main", "refs/tags/v1/rc"], work);
}, 180_000);

afterAll(async () => {
  await stack?.stop();
});

/** Axe, in each of the six theme states. */
const checked = (what: string) => accessibleInEveryTheme(page, what);

describe("releases", () => {
  it("are reached from the repository, empty at first", async () => {
    await visit(page, `${stack.origin}${REPO}`);
    await page.getByRole("link", { name: "Releases", exact: true }).click();
    await see(page.getByText("No releases yet.")).toBeVisible();
    await checked("the empty list");
  });

  it("refuses a tag that doesn't exist, keeping what was written", async () => {
    await visit(page, `${stack.origin}${REPO}/releases/new`);
    await page.getByLabel("Tag", { exact: true }).fill("absent");
    await page.getByLabel(/^Title/).fill(HOSTILE);
    await page.getByLabel(/^Notes/).fill("Keep me.");
    await page.getByRole("button", { name: "Publish release" }).click();
    await see(page.getByRole("alert")).toContainText("Push it first");
    await see(page.getByLabel(/^Notes/)).toHaveValue("Keep me.");
    await checked("the refused form");
  });

  it("saves a draft, then publishes it, through a slashed tag", async () => {
    await page.getByLabel("Tag", { exact: true }).fill("v1/rc");
    await page.getByRole("button", { name: "Save draft" }).click();
    await see(page).toHaveURL(new RegExp(`${REPO}/releases/tag/v1/rc$`));
    await see(page.getByText("Draft", { exact: true })).toBeVisible();
    await see(page.getByRole("link", { name: /tar\.gz/ })).toHaveCount(0);
    await checked("a draft's page");
    await page.getByRole("link", { name: "Edit release" }).click();
    await page.getByRole("button", { name: "Publish release" }).click();
    await see(page).toHaveURL(new RegExp(`${REPO}/releases/tag/v1/rc$`));
    await see(page.getByText("Published", { exact: true })).toBeVisible();
    await see(page.getByRole("heading", { level: 2 })).toContainText(HOSTILE);
    expect(await page.evaluate("window.pwned")).toBeUndefined();
    await checked("a published release");
  });

  it("records a tag of a tag as the commit it finally peels to", async () => {
    await git(["tag", "-a", "nested", "v1/rc", "-m", "a tag of a tag"], work);
    await git(["push", "-q", "origin", "refs/tags/nested"], work);
    const commit = (await git(["rev-parse", "nested^{commit}"], work)).trim();
    const object = (await git(["rev-parse", "nested"], work)).trim();
    const made = await rest<{ id: number; tag_sha: string; commit_sha: string }>(
      "POST",
      `/repos/${handle}/${name}/releases`,
      { tag_name: "nested" },
    );
    expect(made).toMatchObject({ tag_sha: object, commit_sha: commit });
    await rest("DELETE", `/repos/${handle}/${name}/releases/${made.id}`);
  });

  it("keeps its source archive after the tag is deleted, and says so", async () => {
    const release = await rest<{ commit_sha: string }>(
      "GET",
      `/repos/${handle}/${name}/releases/tags/v1/rc`,
    );
    await git(["push", "-q", "origin", ":refs/tags/v1/rc"], work);
    await visit(page, `${stack.origin}${REPO}/releases/tag/v1/rc`);
    await see(page.getByRole("note")).toContainText("has been deleted");
    const link = page.getByRole("link", { name: "Source (tar.gz)" });
    await see(link).toHaveAttribute("href", `${REPO}/archive/tar.gz?ref=${release.commit_sha}`);
    const answer = await page.request.get(`${stack.origin}${await link.getAttribute("href")}`);
    expect(answer.status()).toBe(200);
    await checked("a release whose tag is gone");
  });

  it("is listed, and goes when deleted", async () => {
    await visit(page, `${stack.origin}${REPO}/releases`);
    const entry = page.getByRole("link", { name: HOSTILE });
    await see(entry).toBeVisible();
    await checked("the list");
    await entry.click();
    await page.getByText("Delete", { exact: true }).click();
    await page.getByRole("button", { name: "Delete release v1/rc" }).click();
    await see(page.getByText("No releases yet.")).toBeVisible();
  });
});

describe("release assets", () => {
  const TAG = "v2/rc";
  const NAME = "tool.bin";
  /** A file of two parts, the second short, each byte telling where it is. */
  const BYTES = Buffer.from(Array.from({ length: PART + 7 }, (_, i) => (i * 7 + (i >> 8)) & 255));
  let releaseId = 0;
  const releaseUrl = () => `${stack.origin}${REPO}/releases/tag/${TAG}`;
  const editUrl = () => `${stack.origin}${REPO}/releases/edit/${TAG}`;
  const downloadUrl = (name: string, tag = TAG) =>
    `${stack.origin}${REPO}/releases/download/${tag}/${encodeURIComponent(name)}`;

  /** The release's assets as the API lists them now. */
  const assets = async () =>
    (
      await rest<{ assets: { id: number; name: string; updated_at: number }[] }>(
        "GET",
        `/repos/${handle}/${name}/releases/${releaseId}`,
      )
    ).assets;

  /** Through the page's own upload route, as the page's script asks it. */
  const route = (on: Page, body: unknown) =>
    on.request.post(`${stack.origin}${REPO}/releases/uploads`, {
      headers: { Origin: stack.origin, "Content-Type": "application/json" },
      data: JSON.stringify(body),
    });

  /** Begins an upload of `bytes` as `file` and sends its one part, as the page does. */
  async function uploadByRoute(file: string, bytes: Buffer, contentType: string) {
    const begun = await route(page, {
      intent: "begin",
      release_id: releaseId,
      name: file,
      size: bytes.length,
      content_type: contentType,
      replace: false,
      key: crypto.randomUUID(),
    });
    expect(begun.status(), await begun.text()).toBe(201);
    const session = (await begun.json()) as { id: string; part_count: number };
    expect(session.part_count).toBe(1);
    const part = await page.request.put(
      `${stack.origin}/api/repos/${handle}/${name}/releases/assets/uploads/${session.id}/parts/1`,
      { headers: { "X-Fyrden-Session": "1" }, data: bytes },
    );
    expect(part.status(), await part.text()).toBe(200);
    const { etag } = (await part.json()) as { etag: string };
    return { session, parts: [{ part_number: 1, etag }] };
  }

  /** The session `id` takes no more parts: ended (its row ended, or already cleared away). */
  async function takesNoParts(id: string) {
    const part = await page.request.put(
      `${stack.origin}/api/repos/${handle}/${name}/releases/assets/uploads/${id}/parts/1`,
      { headers: { "X-Fyrden-Session": "1" }, data: Buffer.from("x") },
    );
    expect(((await part.json()) as { code: string }).code).toMatch(
      /^(upload_not_receiving|upload_not_found)$/,
    );
  }

  /** The page's own `intent` post to its upload route. */
  const uploadPost = (intent: string) => (request: Request) =>
    new URL(request.url()).pathname === `${REPO}/releases/uploads` &&
    JSON.parse(request.postData() ?? "{}").intent === intent;

  beforeAll(async () => {
    await git(["tag", "-a", TAG, "-m", "assets"], work);
    await git(["push", "-q", "origin", `refs/tags/${TAG}`], work);
    const made = await rest<{ id: number }>("POST", `/repos/${handle}/${name}/releases`, {
      tag_name: TAG,
      name: "With assets",
    });
    releaseId = made.id;
  });

  it("uploads from the release's page in parts, one retried, and lists it", async () => {
    await visit(page, editUrl());
    await see(page.getByText("No assets.")).toBeVisible();
    // Part 2's first try fails as an overloaded Worker would; the page tries it again.
    let failed = 0;
    await page.route("**/parts/2", async (r) => {
      if (failed++ === 0) return r.fulfill({ status: 502, body: "" });
      return r.continue();
    });
    // Each part reaches the API through the web Worker with its length, or it would be refused (411).
    const parts: string[] = [];
    const noted = (request: { url(): string }) => {
      const n = /\/parts\/(\d+)$/.exec(request.url())?.[1];
      if (n) parts.push(n);
    };
    page.on("request", noted);
    await page.getByLabel("Add files").setInputFiles({
      name: NAME,
      mimeType: "application/octet-stream",
      buffer: BYTES,
    });
    await see(page.getByText("Uploaded.", { exact: true })).toBeVisible({ timeout: 60_000 });
    await see(page.getByRole("status").filter({ hasText: `${NAME} uploaded.` })).toBeAttached();
    page.off("request", noted);
    await page.unroute("**/parts/2");
    expect(failed).toBe(2);
    expect(parts.sort()).toEqual(["1", "2", "2"]);
    await see(
      page.getByRole("table", { name: "Assets" }).getByRole("link", { name: NAME }),
    ).toBeVisible();
    await visit(page, releaseUrl());
    const link = page.getByRole("table", { name: "Assets" }).getByRole("link", { name: NAME });
    await see(link).toHaveAttribute("href", `${REPO}/releases/download/${TAG}/${NAME}`);
    await accessibleInEveryTheme(page, "a release with an asset");
  });

  it("downloads the same bytes through the site, with ranges and conditions through the binding", async () => {
    const whole = await page.request.get(downloadUrl(NAME));
    expect(whole.status()).toBe(200);
    expect(Buffer.from(await whole.body()).equals(BYTES)).toBe(true);
    const headers = whole.headers();
    expect(headers["content-type"]).toBe("application/octet-stream");
    expect(headers["content-disposition"]).toContain(`filename="${NAME}"`);
    expect(headers["cache-control"]).toBe("private, no-store");
    expect(headers["accept-ranges"]).toBe("bytes");
    const etag = headers.etag ?? "";
    expect(etag).toMatch(/^"/);

    const part = await page.request.get(downloadUrl(NAME), { headers: { Range: "bytes=2-5" } });
    expect(part.status()).toBe(206);
    expect(part.headers()["content-range"]).toBe(`bytes 2-5/${BYTES.length}`);
    expect(Buffer.from(await part.body()).equals(BYTES.subarray(2, 6))).toBe(true);
    const resumed = await page.request.get(downloadUrl(NAME), {
      headers: { Range: `bytes=${PART}-`, "If-Range": etag },
    });
    expect(resumed.status()).toBe(206);
    expect(Buffer.from(await resumed.body()).equals(BYTES.subarray(PART))).toBe(true);
    const unchanged = await page.request.get(downloadUrl(NAME), {
      headers: { "If-None-Match": etag },
    });
    expect(unchanged.status()).toBe(304);
    const past = await page.request.get(downloadUrl(NAME), {
      headers: { Range: `bytes=${BYTES.length + 10}-` },
    });
    expect(past.status()).toBe(416);
    expect(past.headers()["content-range"]).toBe(`bytes */${BYTES.length}`);
    const head = await page.request.head(downloadUrl(NAME));
    expect(head.status()).toBe(200);
    expect(head.headers()["content-length"]).toBe(String(BYTES.length));
    // The tag's slash encoded reaches the same asset.
    const encoded = await page.request.get(downloadUrl(NAME, "v2%2Frc"), {
      headers: { Range: "bytes=0-0" },
    });
    expect(encoded.status()).toBe(206);
  });

  it("warns before a replace, then keeps the old file on the quota for an admin to purge", async () => {
    await visit(page, editUrl());
    const before = (await assets()).find((a) => a.name === NAME);
    await page.getByLabel("Add files").setInputFiles({
      name: NAME.toUpperCase(),
      mimeType: "application/octet-stream",
      buffer: Buffer.from("replaced"),
    });
    await see(
      page.getByText(/Replacing it keeps the old file on the account's storage quota for 30 days/),
    ).toBeVisible();
    await accessibleInEveryTheme(page, "a replace waiting to be confirmed");
    await page.getByRole("button", { name: `Replace ${NAME.toUpperCase()}` }).click();
    await see(page.getByText("Uploaded.", { exact: true })).toBeVisible({ timeout: 60_000 });
    const after = (await assets()).filter((a) => a.name.toLowerCase() === NAME);
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(before?.id);
    const fresh = await page.request.get(downloadUrl(NAME));
    expect(await fresh.text()).toBe("replaced");

    await visit(page, `${stack.origin}${REPO}/releases`);
    await see(page.getByText(/1 file of replaced or deleted assets/)).toBeVisible();
    await page.getByText("Purge now").click();
    await see(page.getByText(/A restore can't bring them back/)).toBeVisible();
    await accessibleInEveryTheme(page, "the list with a purge to confirm");
    await page.getByRole("button", { name: "Purge retained files" }).click();
    await see(page.getByRole("status").filter({ hasText: "Purging 1 file" })).toBeVisible();
  });

  it("says why an upload stopped, and lets it go", async () => {
    await visit(page, editUrl());
    await page.route("**/parts/1", (r) =>
      r.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ code: "upload_not_found", detail: "No such upload session." }),
      }),
    );
    await page.getByLabel("Add files").setInputFiles({
      name: "stops.bin",
      mimeType: "application/octet-stream",
      buffer: Buffer.from("x"),
    });
    await see(page.getByText("No such upload session.", { exact: true })).toBeVisible();
    await accessibleInEveryTheme(page, "an upload that stopped");
    await page.unroute("**/parts/1");
    await page.getByRole("button", { name: "Dismiss" }).click();
    await see(page.getByText("No such upload session.", { exact: true })).toBeHidden();
    expect((await assets()).map((a) => a.name)).not.toContain("stops.bin");
  });

  it("offers no Retry while a Cancel is ending a stopped upload", async () => {
    await visit(page, editUrl());
    // Every try of part 1 fails as an overloaded Worker would, until the upload stops.
    await page.route("**/parts/1", (r) => r.fulfill({ status: 502, body: "" }));
    let release = () => {};
    const held = new Promise<void>((done) => {
      release = done;
    });
    await page.route(`**${REPO}/releases/uploads`, async (r) => {
      if (JSON.parse(r.request().postData() ?? "{}").intent === "abort") await held;
      await r.continue();
    });
    try {
      await page.getByLabel("Add files").setInputFiles({
        name: "held.bin",
        mimeType: "application/octet-stream",
        buffer: Buffer.from("held"),
      });
      const item = page.getByRole("list", { name: "Uploads" }).getByRole("listitem");
      await see(item.getByText("Part 1 was not stored.", { exact: true })).toBeVisible({
        timeout: 30_000,
      });
      await item.getByRole("button", { name: "Cancel" }).click();
      await see(item.getByText("Cancelling…", { exact: true })).toBeVisible();
      await see(item.getByRole("button", { name: "Retry" })).toHaveCount(0);
      await see(item.getByRole("button", { name: "Cancel" })).toHaveCount(0);
      release();
      await see(item).toHaveCount(0);
      expect((await assets()).map((a) => a.name)).not.toContain("held.bin");
    } finally {
      release();
      await page.unroute("**/parts/1");
      await page.unroute(`**${REPO}/releases/uploads`);
    }
  });

  it("ends a stopped upload's session when the page is left for another", async () => {
    await visit(page, editUrl());
    await page.route("**/parts/1", (r) => r.fulfill({ status: 502, body: "" }));
    try {
      await page.getByLabel("Add files").setInputFiles({
        name: "left.bin",
        mimeType: "application/octet-stream",
        buffer: Buffer.from("left"),
      });
      const item = page.getByRole("list", { name: "Uploads" }).getByRole("listitem");
      await see(item.getByText("Part 1 was not stored.", { exact: true })).toBeVisible({
        timeout: 30_000,
      });
    } finally {
      await page.unroute("**/parts/1");
    }
    const ended = page.waitForResponse(
      (res) =>
        new URL(res.url()).pathname === `${REPO}/releases/uploads` &&
        JSON.parse(res.request().postData() ?? "{}").intent === "abort",
    );
    // Within the app, so the uploader is taken off the page rather than the page unloaded.
    await page
      .getByRole("navigation", { name: "Repository" })
      .getByRole("link", { name: "Commits" })
      .click();
    const res = await ended;
    // Its body went with the page it was asked from; the status stays.
    expect(res.status()).toBe(200);
    // Ended at the API.
    const { upload_id } = JSON.parse(res.request().postData() ?? "{}") as { upload_id: string };
    await takesNoParts(upload_id);
    expect((await assets()).map((a) => a.name)).not.toContain("left.bin");
  });

  it("ends a stopped upload's session when the page is reloaded", async () => {
    await visit(page, editUrl());
    await page.route("**/parts/1", (r) => r.fulfill({ status: 502, body: "" }));
    const begun = page.waitForResponse((res) => uploadPost("begin")(res.request()));
    let id = "";
    try {
      await page.getByLabel("Add files").setInputFiles({
        name: "reloaded.bin",
        mimeType: "application/octet-stream",
        buffer: Buffer.from("reloaded"),
      });
      id = ((await (await begun).json()) as { id: string }).id;
      const item = page.getByRole("list", { name: "Uploads" }).getByRole("listitem");
      await see(item.getByText("Part 1 was not stored.", { exact: true })).toBeVisible({
        timeout: 30_000,
      });
    } finally {
      await page.unroute("**/parts/1");
    }
    // Sent by the page as it unloads, which the browser doesn't report: wrangler dev's log of
    // answering it is the sign it landed (the reloaded page posts nothing to the route).
    const from = stack.output().length;
    await page.reload();
    await stack.waitForLine(
      new RegExp(`^\\[wrangler:info\\] POST ${REPO}/releases/uploads 200 `),
      from,
      15_000,
      { accessLog: true },
    );
    await takesNoParts(id);
  });

  it("ends the session a start made when its answer was lost and the upload is cancelled", async () => {
    await visit(page, editUrl());
    // The API makes the session; its answer never reaches the page.
    let made = "";
    await page.route(`**${REPO}/releases/uploads`, async (r) => {
      if (made !== "" || JSON.parse(r.request().postData() ?? "{}").intent !== "begin")
        return r.continue();
      const answer = await r.fetch();
      made = ((await answer.json()) as { id: string }).id;
      return r.abort("internetdisconnected");
    });
    try {
      await page.getByLabel("Add files").setInputFiles({
        name: "unanswered.bin",
        mimeType: "application/octet-stream",
        buffer: Buffer.from("unanswered"),
      });
      const item = page.getByRole("list", { name: "Uploads" }).getByRole("listitem");
      await see(item.getByRole("button", { name: "Retry" })).toBeVisible();
      expect(made).not.toBe("");
      const ended = page.waitForResponse((res) => uploadPost("abort")(res.request()));
      // Handled at once: a click that fails first is the failure to report.
      ended.catch(() => undefined);
      await item.getByRole("button", { name: "Cancel" }).click();
      const { upload_id } = JSON.parse((await ended).request().postData() ?? "{}") as {
        upload_id: string;
      };
      expect(upload_id).toBe(made);
      await see(item).toHaveCount(0);
      await takesNoParts(made);
    } finally {
      await page.unroute(`**${REPO}/releases/uploads`);
    }
  });

  it("holds a running upload left by the page until its ending is known", async () => {
    await visit(page, editUrl());
    let release = () => {};
    const held = new Promise<void>((done) => {
      release = done;
    });
    // The part never answers while the page is there; the ending is held, then lost.
    await page.route("**/parts/1", async (r) => {
      await held;
      await r.fulfill({ status: 502, body: "" }).catch(() => undefined);
    });
    await page.route(`**${REPO}/releases/uploads`, async (r) => {
      if (JSON.parse(r.request().postData() ?? "{}").intent !== "abort") return r.continue();
      await held;
      await r.abort("internetdisconnected");
    });
    try {
      const sending = page.waitForRequest("**/parts/1");
      await page.getByLabel("Add files").setInputFiles({
        name: "kept.bin",
        mimeType: "application/octet-stream",
        buffer: Buffer.from("kept"),
      });
      await sending;
      const item = page.getByRole("list", { name: "Uploads" }).getByRole("listitem");
      // As a page kept in the back-forward cache is left, and comes back before its ending is.
      await page.evaluate(() => {
        const win = globalThis as unknown as {
          dispatchEvent(event: unknown): void;
          PageTransitionEvent: new (type: string, init: { persisted: boolean }) => unknown;
        };
        win.dispatchEvent(new win.PageTransitionEvent("pagehide", { persisted: true }));
      });
      await see(item.getByText("Cancelling…", { exact: true })).toBeVisible();
      await see(item.getByRole("button")).toHaveCount(0);
      release();
      await see(item.getByText(/may not have ended/)).toBeVisible();
      await see(item.getByRole("button", { name: "Cancel" })).toBeVisible();
    } finally {
      release();
      await page.unroute("**/parts/1");
      await page.unroute(`**${REPO}/releases/uploads`);
    }
    const item = page.getByRole("list", { name: "Uploads" }).getByRole("listitem");
    const ended = page.waitForResponse((res) => uploadPost("abort")(res.request()));
    ended.catch(() => undefined);
    await item.getByRole("button", { name: "Cancel" }).click();
    const { upload_id } = JSON.parse((await ended).request().postData() ?? "{}") as {
      upload_id: string;
    };
    await see(item).toHaveCount(0);
    await takesNoParts(upload_id);
  });

  it("offers Cancel again when ending an upload couldn't be confirmed, and asks again on Dismiss", async () => {
    await visit(page, editUrl());
    await page.route("**/parts/1", (r) => r.fulfill({ status: 502, body: "" }));
    // Each upload's first ending is lost on the network; the next goes through.
    const lost = new Set<string>();
    await page.route(`**${REPO}/releases/uploads`, (r) => {
      const sent = JSON.parse(r.request().postData() ?? "{}") as Record<string, string>;
      if (sent.intent !== "abort" || lost.has(sent.upload_id ?? "")) return r.continue();
      lost.add(sent.upload_id ?? "");
      return r.abort("internetdisconnected");
    });
    try {
      for (const [file, then] of [
        ["unsure.bin", "Cancel"],
        ["dismissed.bin", "Dismiss"],
      ] as const) {
        await page.getByLabel("Add files").setInputFiles({
          name: file,
          mimeType: "application/octet-stream",
          buffer: Buffer.from(file),
        });
        const item = page
          .getByRole("list", { name: "Uploads" })
          .getByRole("listitem")
          .filter({ hasText: file });
        await see(item.getByText("Part 1 was not stored.", { exact: true })).toBeVisible({
          timeout: 30_000,
        });
        await item.getByRole("button", { name: "Cancel" }).click();
        await see(item.getByText(/may not have ended/)).toBeVisible();
        await see(item.getByRole("button", { name: "Retry" })).toHaveCount(0);
        if (then === "Cancel")
          await accessibleInEveryTheme(page, "an upload whose ending is unknown");
        const ended = page.waitForResponse((res) => uploadPost("abort")(res.request()));
        // Handled at once: a click that fails first is the failure to report.
        ended.catch(() => undefined);
        await item.getByRole("button", { name: then }).click();
        const { upload_id } = JSON.parse((await ended).request().postData() ?? "{}") as {
          upload_id: string;
        };
        await see(item).toHaveCount(0);
        await takesNoParts(upload_id);
      }
    } finally {
      await page.unroute("**/parts/1");
      await page.unroute(`**${REPO}/releases/uploads`);
    }
  });

  it("answers a second completion of a committed upload as completed, committing nothing twice", async () => {
    const { session, parts } = await uploadByRoute("once.txt", Buffer.from("once"), "text/plain");
    const complete = (key: string) =>
      route(page, { intent: "complete", upload_id: session.id, parts, key });
    const first = await complete(crypto.randomUUID());
    expect(first.status(), await first.text()).toBe(200);
    const made = (await first.json()) as {
      state: string;
      asset: { id: number; updated_at: number };
    };
    expect(made.state).toBe("completed");
    // As after an answer never learnt: the same request with a new key.
    const second = await complete(crypto.randomUUID());
    expect(second.status(), await second.text()).toBe(200);
    expect(await second.json()).toMatchObject({ state: "completed", asset: made.asset });
    const listed = (await assets()).filter((a) => a.name === "once.txt");
    expect(listed).toEqual([
      expect.objectContaining({ id: made.asset.id, updated_at: made.asset.updated_at }),
    ]);
    // A key that isn't a UUID never reaches the API.
    expect((await complete("not-a-uuid")).status()).toBe(400);
  });

  it("sends hostile HTML and SVG as downloads that never run", async () => {
    for (const [file, type, body] of [
      ["evil.html", "text/html", "<script>window.pwned = 1</script><h1>hi</h1>"],
      [
        "evil.svg",
        "image/svg+xml",
        '<svg xmlns="http://www.w3.org/2000/svg" onload="window.pwned = 1"><script>window.pwned = 1</script></svg>',
      ],
    ] as const) {
      const { session, parts } = await uploadByRoute(file, Buffer.from(body), type);
      const done = await route(page, {
        intent: "complete",
        upload_id: session.id,
        parts,
        key: crypto.randomUUID(),
      });
      expect(done.status()).toBe(200);
      const answer = await page.request.get(downloadUrl(file));
      expect(answer.headers()).toMatchObject({
        "content-type": "application/octet-stream",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; frame-ancestors 'none'; sandbox",
      });
      expect(answer.headers()["content-disposition"]).toMatch(/^attachment;/);
    }
    await visit(page, releaseUrl());
    for (const file of ["evil.html", "evil.svg"]) {
      const saved = page.waitForEvent("download");
      await page.getByRole("link", { name: file }).click();
      expect((await saved).suggestedFilename()).toBe(file);
      // Opened in a tab of its own, it is a download there too, and nothing runs.
      const tab = await page.context().newPage();
      const opened = tab.waitForEvent("download");
      await tab.goto(downloadUrl(file)).catch(() => undefined);
      await opened;
      expect(await tab.evaluate(() => (globalThis as { pwned?: unknown }).pwned)).toBeUndefined();
      await tab.close();
    }
    expect(await page.evaluate(() => (globalThis as { pwned?: unknown }).pwned)).toBeUndefined();
  });

  it("downloads a name ending in .data as the file, by navigation, fetch and HEAD", async () => {
    const { session, parts } = await uploadByRoute(
      "notes.data",
      Buffer.from("data!"),
      "text/plain",
    );
    expect(
      (
        await route(page, {
          intent: "complete",
          upload_id: session.id,
          parts,
          key: crypto.randomUUID(),
        })
      ).status(),
    ).toBe(200);
    for (const method of ["GET", "HEAD"] as const) {
      const moved = await page.request.fetch(downloadUrl("notes.data"), {
        method,
        maxRedirects: 0,
      });
      expect(moved.status(), method).toBe(308);
      expect(moved.headers().location).toBe(`${downloadUrl("notes.data")}/`);
    }
    const followed = await page.request.get(downloadUrl("notes.data"));
    expect(followed.status()).toBe(200);
    expect(await followed.text()).toBe("data!");
    expect(followed.headers()["content-type"]).toBe("application/octet-stream");
  });

  it("works without JavaScript but for uploading, which names the API", async () => {
    const browser = page.context().browser();
    if (!browser) throw new Error("no browser");
    const context = await browser.newContext({
      javaScriptEnabled: false,
      storageState: await page.context().storageState(),
    });
    try {
      const plain = await context.newPage();
      await plain.goto(editUrl());
      await see(plain.getByText(/Uploading from this page needs JavaScript/)).toBeVisible();
      await see(
        plain.locator("code", {
          hasText: `POST /api/repos/${handle}/${name}/releases/${releaseId}/assets/uploads`,
        }),
      ).toBeVisible();
      await see(plain.getByLabel("Add files")).toBeDisabled();
      await plain.goto(releaseUrl());
      const href = await plain.getByRole("link", { name: NAME }).getAttribute("href");
      expect((await plain.request.get(`${stack.origin}${href}`)).status()).toBe(200);
    } finally {
      await context.close();
    }
  });

  describe("once access is lost", () => {
    /** Each kind of answer a download can give but a whole file, asked of `path`. */
    const KINDS = (etag: string) =>
      ({
        206: { Range: "bytes=0-1" },
        304: { "If-None-Match": etag },
        412: { "If-Match": '"another"' },
        416: { Range: `bytes=${BYTES.length * 4}-` },
      }) as const;
    let etag = "";
    let bo: { id: string; token: string };

    /** What `ask` answers for each kind. */
    async function answers(
      ask: (headers: Record<string, string>) => Promise<{ status: number; location?: string }>,
    ) {
      const seen: Record<string, unknown> = {};
      for (const [kind, headers] of Object.entries(KINDS(etag))) seen[kind] = await ask(headers);
      return seen;
    }

    /** A browser signed in as bo with `token`. */
    async function signedIn(token: string) {
      const browser = page.context().browser();
      if (!browser) throw new Error("no browser");
      const context = await browser.newContext();
      const tab = await context.newPage();
      await tab.goto(`${stack.origin}/auth/sign-in?return_to=%2F`);
      await tab.getByLabel(/personal access token/i).fill(token);
      await tab.getByRole("button", { name: "Sign in with the token" }).click();
      await tab.getByRole("button", { name: "Not now" }).click();
      await see(tab).toHaveURL(`${stack.origin}/`);
      return { context, tab };
    }

    const viaPage = (tab: Page) => (headers: Record<string, string>) =>
      tab.request
        .get(downloadUrl(NAME), { headers, maxRedirects: 0 })
        .then((res: APIResponse) => ({ status: res.status() }));

    beforeAll(async () => {
      etag = (await page.request.head(downloadUrl(NAME))).headers().etag ?? "";
      const made = await rest<{ id: string }>("POST", "/admin/users", { handle: "bo" });
      const { token } = await rest<{ token: string }>("POST", `/admin/users/${made.id}/tokens`, {
        type: "pat",
        scopes: [],
        expires_in_days: 1,
      });
      bo = { id: made.id, token };
      await rest("PUT", `/repos/${handle}/${name}/collaborators/bo`, { permission: "pull" });
    });

    it("refuses a signed-out session at once, sending it to sign in", async () => {
      const { context, tab } = await signedIn(bo.token);
      try {
        expect(await answers(viaPage(tab))).toEqual({
          206: { status: 206 },
          304: { status: 304 },
          412: { status: 412 },
          416: { status: 416 },
        });
        const cookie = (await context.cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
        await tab.getByRole("button", { name: "Sign out" }).click();
        await see(tab.getByRole("banner").getByRole("link", { name: "Sign in" })).toBeVisible();
        // The old cookie, sent on: the session it named is over.
        const replayed = await answers(async (headers) => {
          const res = await fetch(downloadUrl(NAME), {
            headers: { ...headers, Cookie: cookie },
            redirect: "manual",
          });
          return { status: res.status, location: res.headers.get("Location") ?? "" };
        });
        const signIn = `/auth/sign-in?return_to=${encodeURIComponent(`${REPO}/releases/download/${TAG}/${NAME}`)}`;
        for (const answer of Object.values(replayed))
          expect(answer).toEqual({ status: 302, location: signIn });
      } finally {
        await context.close();
      }
    });

    it("refuses a removed collaborator at once, as if nothing were there", async () => {
      const { context, tab } = await signedIn(bo.token);
      try {
        expect((await viaPage(tab)({ Range: "bytes=0-1" })).status).toBe(206);
        await rest("DELETE", `/repos/${handle}/${name}/collaborators/bo`);
        expect(await answers(viaPage(tab))).toEqual({
          206: { status: 404 },
          304: { status: 404 },
          412: { status: 404 },
          416: { status: 404 },
        });
      } finally {
        await context.close();
      }
    });

    it("refuses a revoked token at the API, read for the first time after it was revoked", async () => {
      await rest("PUT", `/repos/${handle}/${name}/collaborators/bo`, { permission: "pull" });
      const fresh = await rest<{ id: string; token: string }>(
        "POST",
        "/user/tokens",
        { type: "pat", scopes: [], expires_in_days: 1 },
        bo.token,
      );
      await rest("DELETE", `/user/tokens/${fresh.id}`, undefined, bo.token);
      const api = `${stack.origin}/api/repos/${handle}/${name}/releases/download/${TAG}/${NAME}`;
      expect(
        await answers(async (headers) => ({
          status: (
            await fetch(api, { headers: { ...headers, Authorization: `Bearer ${fresh.token}` } })
          ).status,
        })),
      ).toEqual({
        206: { status: 401 },
        304: { status: 401 },
        412: { status: 401 },
        416: { status: 401 },
      });
      // bo's own token, still good, gets the range.
      expect(
        (await fetch(api, { headers: { Range: "bytes=0-1", Authorization: `Bearer ${bo.token}` } }))
          .status,
      ).toBe(206);
    });
  });
});

describe("the pages", () => {
  it("broke no Content Security Policy on the way", () => {
    expect(stack.refused).toEqual([]);
  });
});
