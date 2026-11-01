// Live hints in a real browser against both Workers, with the deployment's
// live hints on: an open inbox shows a thread another person notified it
// of without being reloaded (read again after the hint, not only on
// connecting), and the page acknowledges what it heard.
// Needs `pnpm --filter @fyrden/web build` first (turbo does it).
import { type Page, expect as see, type WebSocket } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startWebStack, visit, type WebStack } from "./web-stack.js";

let stack: WebStack;
let page: Page;
const handle = "ada";
const name = "live";

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
  stack = await startWebStack(handle, { vars: { FYRDEN_LIVE: "on" } });
  page = stack.page;
  await rest("POST", "/user/repos", { name });
  await rest("POST", `/repos/${handle}/${name}/issues`, { title: "Heard live" });
}, 180_000);

afterAll(async () => {
  await stack?.stop();
});

describe("live hints", () => {
  it("bring a new thread into an open inbox, read after the hint, acknowledged", async () => {
    const { id: repoId } = await rest<{ id: string }>("GET", `/repos/${handle}/${name}`);
    // When each read of the page's data started, and when the hint came.
    const reads: number[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/notifications.data") reads.push(Date.now());
    });
    const opened = page.waitForEvent("websocket", { timeout: 30_000 });
    // The read every connect makes (waited for from before it can start).
    const connectRead = page.waitForResponse(
      (r) => new URL(r.url()).pathname === "/notifications.data",
      { timeout: 30_000 },
    );
    await visit(page, `${stack.origin}/notifications`);
    await see(page.getByText("Nothing here.")).toBeVisible();
    const socket: WebSocket = await opened;
    expect(new URL(socket.url()).pathname).toBe("/api/notifications/live");
    // Finished before anything happens.
    await connectRead;
    let heardAt = 0;
    const heard = socket.waitForEvent("framereceived", {
      predicate: (frame) => {
        const hint = JSON.parse(String(frame.payload)) as {
          t?: string;
          streams?: { repo: string }[];
        };
        const ours = hint.t === "changed" && !!hint.streams?.some((s) => s.repo === repoId);
        if (ours) heardAt = Date.now();
        return ours;
      },
      timeout: 90_000,
    });
    const acked = socket.waitForEvent("framesent", {
      predicate: (frame) => String(frame.payload).includes('"t":"ack"'),
      timeout: 120_000,
    });
    const bo = await rest<{ id: string }>("POST", "/admin/users", { handle: "bo" });
    const { token } = await rest<{ token: string }>("POST", `/admin/users/${bo.id}/tokens`, {
      type: "pat",
      scopes: [],
      expires_in_days: 1,
    });
    await rest("PUT", `/repos/${handle}/${name}/collaborators/bo`, { permission: "push" });
    await rest(
      "POST",
      `/repos/${handle}/${name}/issues/1/comments`,
      { body: `@${handle} have a look` },
      token,
    );
    const hint = JSON.parse(String((await heard).payload)) as { n: number };
    // No reload: the hint makes the page read itself again.
    await see(page.getByRole("listitem").filter({ hasText: "Heard live" })).toBeVisible({
      timeout: 60_000,
    });
    expect(reads.some((at) => at >= heardAt)).toBe(true);
    // A lone frame is acknowledged a minute after it came.
    const ack = JSON.parse(String((await acked).payload)) as { t: string; n: number };
    expect(ack.n).toBeGreaterThanOrEqual(hint.n);
  }, 180_000);

  it("keeps what an action answered through the reread its own change brings", async () => {
    const reread = page.waitForResponse(
      (r) => new URL(r.url()).pathname === "/notifications.data" && r.request().method() === "GET",
      { timeout: 60_000 },
    );
    await page.getByRole("button", { name: /^Mark read:/ }).click();
    await see(page.getByRole("status")).toHaveText("Marked read.");
    // The read's own hint reaches this tab's socket, and the page reads itself again.
    await reread;
    await see(page.getByRole("status")).toHaveText("Marked read.");
  }, 120_000);
});
