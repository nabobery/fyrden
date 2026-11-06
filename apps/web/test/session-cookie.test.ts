import { SESSION_COOKIE } from "@fyrden/api-contract/session";
import { describe, expect, it } from "vitest";
import { checkSession, signedInUser } from "../app/lib/api.server.js";
import { fakeApi, json, ORIGIN } from "./helpers/context.js";

const USER = { id: "u1", handle: "ada" };
const page = (cookie?: string) =>
  new Request(`${ORIGIN}/`, cookie === undefined ? {} : { headers: { Cookie: cookie } });

describe("the session check", () => {
  it.each([
    ["no cookie", undefined],
    ["only a theme cookie", "fyrden_theme=dark"],
    ["a cookie whose name only contains the session's", `x${SESSION_COOKIE}=s; y=1`],
    ["a cookie named without the prefix", "fyrden_session=s"],
  ])("makes no API call with %s", async (_name, cookie) => {
    const { context, calls } = fakeApi(() => json({ user: USER }));
    await expect(signedInUser(context, page(cookie))).resolves.toBeNull();
    await expect(checkSession(context, page(cookie))).resolves.toEqual({ state: "signed-out" });
    expect(calls).toEqual([]);
  });

  it("asks the API when the session cookie is one of several", async () => {
    const { context, calls } = fakeApi(() => json({ user: USER }));
    const cookie = `fyrden_theme=dark; ${SESSION_COOKIE}=s`;
    await expect(signedInUser(context, page(cookie))).resolves.toEqual(USER);
    await expect(checkSession(context, page(cookie))).resolves.toEqual({
      state: "signed-in",
      user: USER,
    });
    expect(calls).toHaveLength(2);
    expect(new URL((calls[0] as Request).url).pathname).toBe("/auth/session");
    expect((calls[0] as Request).headers.get("Cookie")).toBe(cookie);
  });

  it("reads an expired session as signed out, as the API says", async () => {
    const { context } = fakeApi(() => json({ detail: "expired" }, 401));
    const cookie = `${SESSION_COOKIE}=old`;
    await expect(signedInUser(context, page(cookie))).resolves.toBeNull();
    await expect(checkSession(context, page(cookie))).resolves.toEqual({ state: "signed-out" });
  });

  it("reads a failed binding as not known, not as signed out", async () => {
    const { context } = fakeApi(() => {
      throw new TypeError("The service binding refused the call.");
    });
    await expect(checkSession(context, page(`${SESSION_COOKIE}=s`))).resolves.toEqual({
      state: "unknown",
    });
  });
});
