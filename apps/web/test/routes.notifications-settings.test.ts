// The notification settings page: it reads the account's addresses and
// email settings (three calls with the session check), signs a signed-out
// visitor in, refuses posts from other origins, and does each intent with
// one call, saying what the API answered.

import { describe, expect, it } from "vitest";
import { action, loader } from "../app/routes/settings.notifications.js";
import { fakeApi, formPost, json } from "./helpers/context.js";

const ORIGIN = "https://fyrden.test";

const session = () => json({ user: { id: "usr_1", handle: "ada" } });

/** The API answering `answer`, and the session as usr_1's. */
const api = (answer: (req: Request) => Response) =>
  fakeApi((req) => (new URL(req.url).pathname === "/auth/session" ? session() : answer(req)));
const post = (path: string, fields: Record<string, string>) =>
  formPost(path, { viewer: "usr_1", ...fields });
/** The API calls made, the session checks left out. */
const apiCalls = (calls: Request[]) =>
  calls.filter((c) => new URL(c.url).pathname !== "/auth/session");

describe("the notification settings page", () => {
  it("shows the addresses and settings, in three calls", async () => {
    const addresses = [
      { email: "a@example.com", primary: true, verified: true, deliverable: true },
    ];
    const settings = { email: { direct: true, participating: false, watching: false } };
    const { context, calls } = fakeApi((req) => {
      const path = new URL(req.url).pathname;
      if (path === "/auth/session") return session();
      if (path === "/api/user/emails") return json(addresses);
      return json(settings);
    });
    const request = new Request(`${ORIGIN}/settings/notifications`, {
      headers: { Cookie: "fyrden_session=s" },
    });
    expect(await loader({ request, context, params: {} } as never)).toEqual({
      addresses,
      settings: settings.email,
      viewer: "usr_1",
    });
    expect(calls.map((c) => new URL(c.url).pathname).sort()).toEqual([
      "/api/user/emails",
      "/api/user/notification-settings",
      "/auth/session",
    ]);
  });

  it("sends a signed-out visitor to sign in", async () => {
    const { context } = fakeApi(() => json({}, 401));
    const request = new Request(`${ORIGIN}/settings/notifications`);
    const thrown = await loader({ request, context, params: {} } as never).catch((e) => e);
    expect((thrown as Response).headers.get("Location")).toBe(
      `/auth/sign-in?return_to=${encodeURIComponent("/settings/notifications")}`,
    );
  });

  it("refuses a post from another origin", async () => {
    const { context, calls } = fakeApi(() => json({}));
    const request = new Request(`${ORIGIN}/settings/notifications`, {
      method: "POST",
      headers: { Origin: "https://evil.test", Cookie: "fyrden_session=s" },
      body: new URLSearchParams({ intent: "add", email: "a@example.com" }),
    });
    const thrown = await action({ request, context, params: {} } as never).catch((e) => e);
    expect((thrown as { init?: { status?: number } }).init?.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it.each([
    [
      { intent: "add", email: " a@example.com " },
      "POST /api/user/emails",
      { emails: ["a@example.com"] },
      201,
      {
        done: expect.stringMatching(/a@example.com was added. A link to confirm it is on its way/),
      },
    ],
    [
      { intent: "remove", email: "a@example.com" },
      "DELETE /api/user/emails",
      { emails: ["a@example.com"] },
      204,
      { done: "a@example.com was removed." },
    ],
    [
      { intent: "resend", email: "a@example.com" },
      "POST /api/user/emails/confirmation",
      { email: "a@example.com" },
      204,
      { done: expect.stringMatching(/A new link to confirm a@example.com is on its way/) },
    ],
    [
      { intent: "settings", direct: "on", watching: "on" },
      "PUT /api/user/notification-settings",
      { email: { direct: true, participating: false, watching: true } },
      200,
      { done: expect.stringMatching(/saved/) },
    ],
  ])("does %o with one call", async (fields, call, sent, status, shown) => {
    const { context, calls } = api(() =>
      status === 204 ? new Response(null, { status }) : json({}, status),
    );
    const result = await action({
      request: post("/settings/notifications", fields),
      context,
      params: {},
    } as never);
    expect(result).toEqual(shown);
    expect(apiCalls(calls).map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([call]);
    expect(await apiCalls(calls)[0]?.json()).toEqual(sent);
  });

  it("says an address confirmed already was only kept", async () => {
    const { context } = api(() =>
      json([{ email: "a@example.com", primary: true, verified: true, deliverable: true }], 201),
    );
    const result = await action({
      request: post("/settings/notifications", { intent: "add", email: "a@example.com" }),
      context,
      params: {},
    } as never);
    expect(result).toEqual({ done: "a@example.com is yours and confirmed already." });
  });

  it.each([
    [429, { detail: "Too many confirmation emails: try again in 60 seconds." }],
    [422, { code: "email_undeliverable", detail: "The email provider suppresses this mailbox." }],
    [503, { code: "email_unavailable", detail: "This deployment sends no email." }],
  ])("says why the API refused (%i)", async (status, body) => {
    const { context } = api(() => json(body, status));
    const result = await action({
      request: post("/settings/notifications", { intent: "add", email: "a@example.com" }),
      context,
      params: {},
    } as never);
    expect(result).toEqual({ error: body.detail });
  });

  it("asks for an address before adding one, and refuses an unknown intent", async () => {
    const { context, calls } = api(() => json({}));
    const ask = (fields: Record<string, string>) =>
      action({
        request: post("/settings/notifications", fields),
        context,
        params: {},
      } as never);
    expect(await ask({ intent: "add", email: "  " })).toEqual({ error: "Enter an email address." });
    expect(await ask({ intent: "drop" })).toEqual({
      error: "That is not something this page does.",
    });
    expect(apiCalls(calls)).toEqual([]);
  });

  it("refuses a form drawn for another account, changing nothing", async () => {
    const { context, calls } = api(() => json({}, 201));
    const result = await action({
      request: formPost("/settings/notifications", {
        viewer: "usr_other",
        intent: "add",
        email: "a@example.com",
      }),
      context,
      params: {},
    } as never);
    expect(result).toEqual({ error: expect.stringMatching(/another account/) });
    expect(apiCalls(calls)).toEqual([]);
  });
});
