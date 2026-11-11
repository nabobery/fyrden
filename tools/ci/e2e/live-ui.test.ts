// Live hints in a real browser against both Workers, with the deployment's
// live hints on: an open inbox shows a thread another person notified it
// of without being reloaded (read again after the hint, not only on
// connecting), and the page acknowledges what it heard. A socket closed for
// a refusal (its close stood in for: the deployment's allowance is not spent
// here) pauses the tab's live updates for the day, through a reload, or has
// them retried, and the page says so.
// Needs `pnpm --filter @fyrden/web build` first (turbo does it).
import { type Page, expect as see, type WebSocket } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accessible, reload, startWebStack, visit, type WebStack } from "./web-stack.js";

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
  // The page's own clock, from its next load: time still flows as usual, and a
  // test moves it ahead to a timer instead of waiting it out.
  await page.clock.install();
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
    // Every ack from now on: the page's clock still runs on its own, so on a
    // slow run its minute can pass before the test moves it.
    const acked = new Promise<string>((done) => {
      socket.on("framesent", (frame) => {
        if (String(frame.payload).includes('"t":"ack"')) done(String(frame.payload));
      });
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
    // A lone frame is acknowledged a minute after it came: the page's clock
    // moves that minute on, and the frame the page sends is the real one.
    await page.clock.fastForward(60_000);
    let deadline: NodeJS.Timeout | undefined;
    const sent = await Promise.race([
      acked,
      new Promise<never>((_, fail) => {
        // biome-ignore lint/style/noRestrictedGlobals: a deadline for failing, from the moment the minute has passed, not a wait: the frame itself settles the race.
        deadline = setTimeout(() => fail(new Error("no ack within 30 s of the minute")), 30_000);
      }),
    ]).finally(() => clearTimeout(deadline));
    const ack = JSON.parse(sent) as { t: string; n: number };
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

  it("pauses a tab's live updates for the day when its socket is refused for today, through a reload", async () => {
    // Another tab of the same session: its own storage and socket.
    const tab = await page.context().newPage();
    // Refused while `refuse` holds, then the real socket.
    let refuse = true;
    await tab.routeWebSocket(/\/api\/notifications\/live\?/, (ws) => {
      if (refuse) ws.close({ code: 4413, reason: "live hints spent today's allowance" });
      else ws.connectToServer();
    });
    await visit(tab, `${stack.origin}/notifications`);
    const note = tab.getByRole("status").filter({ hasText: "Live updates are paused until" });
    await see(note).toHaveText(
      /^Live updates are paused until .+\. You can still refresh this page\.$/,
      { timeout: 30_000 },
    );
    await accessible(tab, "the inbox, its live updates paused");
    // A socket would open now: the note after the reload is the tab's kept pause.
    refuse = false;
    await reload(tab);
    await see(note).toBeVisible();
    await tab.close();
  }, 120_000);

  it("says live updates are retried when its socket is refused for now", async () => {
    const tab = await page.context().newPage();
    await tab.routeWebSocket(/\/api\/notifications\/live\?/, (ws) => {
      ws.close({ code: 4412, reason: "try again soon" });
    });
    await visit(tab, `${stack.origin}/notifications`);
    await see(
      tab.getByRole("status").filter({ hasText: "Live updates are temporarily unavailable" }),
    ).toHaveText("Live updates are temporarily unavailable. Retrying.", { timeout: 30_000 });
    await tab.close();
  }, 120_000);
});
