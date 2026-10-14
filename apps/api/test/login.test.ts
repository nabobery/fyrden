// Human sign-in: a session from a full-rights personal access token, then
// passkeys (WebAuthn) added and used; nothing from another origin.

import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { decodeCbor, WebAuthnError } from "../src/auth/webauthn.js";
import { user } from "./helpers/api.js";
import { authenticator } from "./helpers/authenticator.js";
import { ORIGIN } from "./helpers/git-http.js";
import { scopedToken } from "./helpers/principals.js";

const call = (path: string, init: RequestInit = {}) =>
  exports.default.fetch(`${ORIGIN}${path}`, { redirect: "manual", ...init });

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  call(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN, ...headers },
    body: JSON.stringify(body),
  });

/** The session cookie a response sets, as a request header. */
function sessionOf(res: Response): string {
  const set = res.headers.get("Set-Cookie") ?? "";
  expect(set).toMatch(/^__Host-fyrden_session=fyrden_ses_\w+;/);
  expect(set).toContain("HttpOnly");
  expect(set).toContain("Secure");
  expect(set).toContain("SameSite=Lax");
  return set.split(";")[0] as string;
}

describe("signing in", () => {
  it("takes a full-rights personal access token, and signs out", async () => {
    const who = await user();
    const res = await post("/auth/token", { token: who.token });
    expect(res.status).toBe(200);
    const cookie = sessionOf(res);
    expect(
      await (await call("/auth/session", { headers: { Cookie: cookie } })).json(),
    ).toMatchObject({
      user: { id: who.principalId },
    });
    expect((await post("/auth/logout", {}, { Cookie: cookie })).status).toBe(204);
    expect((await call("/auth/session", { headers: { Cookie: cookie } })).status).toBe(401);
  });

  it("refuses a narrowed token, a wrong one, and any request from another origin", async () => {
    const who = await user();
    const narrow = await scopedToken(who.principalId, ["contents:read"]);
    expect((await post("/auth/token", { token: narrow })).status).toBe(401);
    expect((await post("/auth/token", { token: "fyrden_pat_nope" })).status).toBe(401);
    expect(
      (await post("/auth/token", { token: who.token }, { Origin: "https://evil.example" })).status,
    ).toBe(403);
  });

  it("adds a passkey for a signed-in user, then signs in with it alone", async () => {
    const who = await user();
    const cookie = sessionOf(await post("/auth/token", { token: who.token }));
    const key = await authenticator();
    const options = await (
      await post("/auth/passkeys/registration-options", {}, { Cookie: cookie })
    ).json<{
      challenge_id: string;
      publicKey: { challenge: string; rp: { id: string }; user: { id: string } };
    }>();
    expect(options.publicKey.rp.id).toBe(new URL(ORIGIN).hostname);
    const added = await post(
      "/auth/passkeys/registration",
      {
        challenge_id: options.challenge_id,
        credential: await key.register(options.publicKey, ORIGIN),
        name: "laptop",
      },
      { Cookie: cookie },
    );
    expect(added.status).toBe(201);
    // Signed out, the passkey alone signs in.
    const signIn = async (
      tweak?: { counter?: number; userVerified?: boolean; flags?: number; userHandle?: string },
      origin = ORIGIN,
    ) => {
      const opts = await (await post("/auth/passkeys/sign-in-options", {})).json<{
        challenge_id: string;
        publicKey: { challenge: string; rpId: string };
      }>();
      return post("/auth/passkeys/sign-in", {
        challenge_id: opts.challenge_id,
        credential: await key.signIn(opts.publicKey, origin, tweak),
      });
    };
    const res = await signIn();
    expect(res.status).toBe(200);
    const fresh = sessionOf(res);
    expect(
      await (await call("/auth/session", { headers: { Cookie: fresh } })).json(),
    ).toMatchObject({
      user: { id: who.principalId },
    });
    // A counter that does not move, no user verification, or a ceremony on another origin: refused.
    expect((await signIn({ counter: 1 })).status).toBe(401);
    expect((await signIn({ userVerified: false })).status).toBe(401);
    expect((await signIn(undefined, "https://evil.example")).status).toBe(401);
    // Attested data on a sign-in, a backup state without eligibility, a reserved bit, or no
    // (or another user's) handle: refused.
    for (const flags of [0x45, 0x15, 0x07])
      expect((await signIn({ flags })).status, `flags ${flags}`).toBe(401);
    expect((await signIn({ userHandle: "" })).status).toBe(401);
    expect((await signIn({ userHandle: "dXNyX290aGVy" })).status).toBe(401);
    // Listed, then removed: it signs in no more.
    const listed = await (await call("/auth/passkeys", { headers: { Cookie: fresh } })).json<{
      passkeys: { id: string; name: string }[];
    }>();
    expect(listed.passkeys).toEqual([
      expect.objectContaining({ id: key.credentialId, name: "laptop" }),
    ]);
    expect(
      (
        await call(`/auth/passkeys/${key.credentialId}`, {
          method: "DELETE",
          headers: { Cookie: fresh, Origin: ORIGIN },
        })
      ).status,
    ).toBe(204);
    expect((await signIn()).status).toBe(401);
  });

  it("takes each challenge once", async () => {
    const who = await user();
    const cookie = sessionOf(await post("/auth/token", { token: who.token }));
    const key = await authenticator();
    const options = await (
      await post("/auth/passkeys/registration-options", {}, { Cookie: cookie })
    ).json<{
      challenge_id: string;
      publicKey: { challenge: string; rp: { id: string }; user: { id: string } };
    }>();
    const body = {
      challenge_id: options.challenge_id,
      credential: await key.register(options.publicKey, ORIGIN),
    };
    expect((await post("/auth/passkeys/registration", body, { Cookie: cookie })).status).toBe(201);
    expect((await post("/auth/passkeys/registration", body, { Cookie: cookie })).status).toBe(400);
  });

  it("serves a sign-in page that goes back only to a path on this origin", async () => {
    const page = async (returnTo: string) =>
      (await call(`/auth/sign-in?return_to=${encodeURIComponent(returnTo)}`)).text();
    expect(await page("/oauth/authorize?client_id=x")).toContain(
      'data-return-to="/oauth/authorize?client_id=x"',
    );
    for (const bad of ["//evil.example/x", "https://evil.example/", "/\\evil.example"])
      expect(await page(bad)).toContain('data-return-to="/"');
    const res = await call("/auth/sign-in");
    expect(res.headers.get("Content-Security-Policy")).toMatch(/script-src 'nonce-[^']+'/);
  });

  it("refuses malformed CBOR as such, never with an unexpected error", () => {
    for (const bytes of [
      Uint8Array.of(0x1a, 0x00), // a 32-bit length cut short
      Uint8Array.of(0x19, 0x01), // a 16-bit length cut short
      Uint8Array.of(0x62, 0xff, 0xfe), // text that is not UTF-8
      Uint8Array.of(0x5a, 0xff, 0xff, 0xff, 0xff), // a byte string longer than the input
      Uint8Array.of(0x9f), // an indefinite-length array
    ])
      expect(() => decodeCbor(bytes)).toThrow(WebAuthnError);
  });
});
