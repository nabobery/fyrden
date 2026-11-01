// The page a confirmation email links to: opening it calls nothing but the
// session check; a signed-out visitor is sent to sign in and back with the
// link intact; only a same-origin post confirms, and the page says what
// the API answered.

import { describe, expect, it } from "vitest";
import { action, loader } from "../app/routes/settings.emails.confirm.js";
import { fakeApi, formPost, json } from "./helpers/context.js";

const ORIGIN = "https://fyrden.test";

describe("the email confirmation page", () => {
  it("changes nothing when opened, only asking to confirm", async () => {
    const { context, calls } = fakeApi(() => json({ user: { id: "usr_1", handle: "ada" } }));
    const request = new Request(`${ORIGIN}/settings/emails/confirm?token=t1`, {
      headers: { Cookie: "fyrden_session=s" },
    });
    expect(await loader({ request, context, params: {} } as never)).toEqual({
      token: "t1",
      handle: "ada",
    });
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(["/auth/session"]);
  });

  it("sends a signed-out visitor to sign in and back, the link unspent", async () => {
    const { context, calls } = fakeApi(() => json({}, 401));
    const request = new Request(`${ORIGIN}/settings/emails/confirm?token=t1`);
    const thrown = await loader({ request, context, params: {} } as never).catch((e) => e);
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).headers.get("Location")).toBe(
      `/auth/sign-in?return_to=${encodeURIComponent("/settings/emails/confirm?token=t1")}`,
    );
    expect(calls).toEqual([]);
  });

  it("refuses a post from another origin", async () => {
    const { context, calls } = fakeApi(() => json({ email: "a@example.com" }));
    const request = new Request(`${ORIGIN}/settings/emails/confirm`, {
      method: "POST",
      headers: { Origin: "https://evil.test", Cookie: "fyrden_session=s" },
      body: new URLSearchParams({ token: "t1" }),
    });
    const thrown = await action({ request, context, params: {} } as never).catch((e) => e);
    expect((thrown as { init?: { status?: number } }).init?.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it.each([
    [200, { email: "a@example.com" }, { confirmed: "a@example.com" }],
    [409, { code: "email_taken" }, { error: expect.stringMatching(/Another account/) }],
    [404, { code: "confirmation_not_found" }, { error: expect.stringMatching(/does not work/) }],
    [503, { detail: "Down." }, { error: "Down." }],
  ])("says what the API answered (%i)", async (status, body, shown) => {
    const { context, calls } = fakeApi(() => json(body, status));
    const result = await action({
      request: formPost("/settings/emails/confirm", { token: "t1" }),
      context,
      params: {},
    } as never);
    expect(result).toEqual(shown);
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      "POST /api/user/emails/confirm",
    ]);
  });
});
