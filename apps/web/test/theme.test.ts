// The theme a visitor picked: read from a cookie, set by a same-origin post,
// and sent back only to a page on this origin.

import { describe, expect, it } from "vitest";
import { safeReturnPath, THEME_COOKIE, themePreference } from "../app/lib/theme.js";
import { action } from "../app/routes/appearance.js";
import { fakeApi, ORIGIN } from "./helpers/context.js";

const withCookie = (cookie?: string) =>
  new Request(`${ORIGIN}/`, cookie === undefined ? {} : { headers: { Cookie: cookie } });

describe("the theme preference", () => {
  it.each([
    [undefined, "system"],
    ["", "system"],
    [`${THEME_COOKIE}=dark`, "dark"],
    [`${THEME_COOKIE}=light`, "light"],
    [`other=1; ${THEME_COOKIE}=dark; more=2`, "dark"],
    [`${THEME_COOKIE}=system`, "system"],
    [`${THEME_COOKIE}=<script>`, "system"],
    [`${THEME_COOKIE}=DARK`, "system"],
    [`x${THEME_COOKIE}=dark`, "system"],
  ])("reads %s as %s", (cookie, mode) => {
    expect(themePreference(withCookie(cookie))).toBe(mode);
  });
});

describe("the page a theme post returns to", () => {
  it.each([
    ["/", "/"],
    ["/ada/repo/blob/main/a.ts?line=3", "/ada/repo/blob/main/a.ts?line=3"],
    ["/a%2Fb", "/a%2Fb"],
    ["", "/"],
    ["relative", "/"],
    ["https://evil.test/", "/"],
    ["//evil.test/", "/"],
    ["/\\evil.test/", "/"],
    ["/.//evil.test/path", "/"],
    ["/a/..//evil.test", "/"],
    ["/\t/evil.test", "/"],
    ["\n//evil.test", "/"],
    [`/${"a".repeat(4096)}`, "/"],
  ])("sends %j to %j", (raw, expected) => {
    expect(safeReturnPath(raw, ORIGIN)).toBe(expected);
  });
});

describe("POST /appearance", () => {
  const post = (fields: Record<string, string>, origin = ORIGIN) =>
    new Request(`${ORIGIN}/appearance`, {
      method: "POST",
      headers: { Origin: origin },
      body: new URLSearchParams(fields),
    });
  const run = async (request: Request) => {
    const { context, calls } = fakeApi(() => new Response(null, { status: 500 }));
    const response = (await action({ request, context, params: {} } as never)) as Response;
    return { response, calls };
  };

  it.each(["light", "dark"])("keeps %s in a cookie and returns to the page", async (mode) => {
    const { response, calls } = await run(post({ mode, return: "/ada/repo?tab=1" }));
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/ada/repo?tab=1");
    expect(response.headers.get("Set-Cookie")).toBe(
      `${THEME_COOKIE}=${mode}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax`,
    );
    expect(calls).toEqual([]);
  });

  it("clears the cookie for System", async () => {
    const { response } = await run(post({ mode: "system", return: "/" }));
    expect(response.headers.get("Set-Cookie")).toBe(
      `${THEME_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
    );
  });

  it("sends a hostile return target home", async () => {
    const { response } = await run(post({ mode: "dark", return: "/.//evil.test/" }));
    expect(response.headers.get("Location")).toBe("/");
  });

  it("refuses a mode it does not know, setting nothing", async () => {
    await expect(run(post({ mode: "neon\r\nSet-Cookie: x=1", return: "/" }))).rejects.toMatchObject(
      { init: { status: 400 } },
    );
  });

  it("refuses a post from another site", async () => {
    const request = post({ mode: "dark", return: "/" }, "https://evil.test");
    const { context } = fakeApi(() => new Response(null, { status: 500 }));
    await expect(
      Promise.resolve().then(() => action({ request, context, params: {} } as never)),
    ).rejects.toMatchObject({ init: { status: 403 } });
  });
});
