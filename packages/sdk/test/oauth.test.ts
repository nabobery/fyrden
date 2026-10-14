import { describe, expect, it, vi } from "vitest";
import {
  authorizationUrl,
  createDpopKey,
  createPkce,
  exchangeToken,
  FyrdenError,
  refreshToken,
} from "../src/index.js";

const decode = (part: string) =>
  JSON.parse(atob(part.replaceAll("-", "+").replaceAll("_", "/"))) as Record<string, unknown>;

const b64 = (bytes: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

describe("DPoP proofs", () => {
  it("come from a private key that cannot leave WebCrypto", async () => {
    const generate = vi.spyOn(crypto.subtle, "generateKey");
    try {
      await createDpopKey();
      expect(generate.mock.calls[0]?.[1]).toBe(false);
    } finally {
      generate.mockRestore();
    }
  });

  it("name the method, the URL without its query, and the token, signed by the key", async () => {
    const key = await createDpopKey();
    const proof = await key.proof("get", "https://fyrden.test/api/user?x=1#y", "tok");
    const [header, payload, signature] = proof.split(".") as [string, string, string];
    const head = decode(header) as { typ: string; alg: string; jwk: { x: string; y: string } };
    expect(head).toMatchObject({ typ: "dpop+jwt", alg: "ES256", jwk: { kty: "EC", crv: "P-256" } });
    const claims = decode(payload);
    expect(claims).toMatchObject({ htm: "GET", htu: "https://fyrden.test/api/user" });
    expect(claims.ath).toBe(
      b64(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("tok"))),
    );
    expect(Math.abs((claims.iat as number) - Date.now() / 1000)).toBeLessThan(5);
    // A new jti each time; none bound to a token at the token endpoint.
    const again = decode(
      (await key.proof("POST", "https://fyrden.test/oauth/token")).split(".")[1] ?? "",
    );
    expect(again.jti).not.toBe(claims.jti);
    expect(again).not.toHaveProperty("ath");
    // The signature verifies with the public key in the header; the thumbprint is its RFC 7638 one.
    const publicKey = await crypto.subtle.importKey(
      "jwk",
      head.jwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const raw = Uint8Array.from(atob(signature.replaceAll("-", "+").replaceAll("_", "/")), (c) =>
      c.charCodeAt(0),
    );
    expect(
      await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        publicKey,
        raw,
        new TextEncoder().encode(`${header}.${payload}`),
      ),
    ).toBe(true);
    const canonical = JSON.stringify({ crv: "P-256", kty: "EC", x: head.jwk.x, y: head.jwk.y });
    expect(key.jkt).toBe(
      b64(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical))),
    );
  });
});

describe("the code flow's request", () => {
  it("carries an S256 challenge of the verifier, the resource and the key's thumbprint", async () => {
    const { verifier, challenge } = await createPkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toBe(
      b64(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
    );
    const url = new URL(
      authorizationUrl("https://fyrden.test", {
        clientId: "c",
        redirectUri: "http://127.0.0.1/cb",
        codeChallenge: challenge,
        resource: "https://fyrden.test/mcp",
        state: "s",
        dpopJkt: "j",
      }),
    );
    expect(url.pathname).toBe("/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: "c",
      redirect_uri: "http://127.0.0.1/cb",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: "https://fyrden.test/mcp",
      state: "s",
      dpop_jkt: "j",
    });
  });
});

describe("token requests", () => {
  const answering = (status: number, body: string, seen: RequestInit[] = []) =>
    (async (_url: string | URL | Request, init?: RequestInit) => {
      if (init) seen.push(init);
      return new Response(body, { status, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;

  it("never follow a redirect with the code or a token", async () => {
    const seen: RequestInit[] = [];
    await refreshToken(
      "https://fyrden.test",
      { clientId: "c", refreshToken: "r" },
      { fetch: answering(200, '{"access_token":"a","token_type":"Bearer","expires_in":1}', seen) },
    );
    expect(seen[0]?.redirect).toBe("manual");
    await expect(
      refreshToken(
        "https://fyrden.test",
        { clientId: "c", refreshToken: "r" },
        { fetch: answering(307, "") },
      ),
    ).rejects.toMatchObject({ status: 307, code: "redirected" });
  });

  it("refuse an OAuth error, or anything else, as a typed error with its status", async () => {
    const refused = refreshToken(
      "https://fyrden.test",
      { clientId: "c", refreshToken: "r" },
      {
        fetch: answering(
          400,
          '{"error":"invalid_grant","error_description":"The refresh token was already used."}',
        ),
      },
    );
    await expect(refused).rejects.toMatchObject({
      status: 400,
      code: "invalid_grant",
      detail: "The refresh token was already used.",
    });
    await expect(
      refreshToken(
        "https://fyrden.test",
        { clientId: "c", refreshToken: "r" },
        { fetch: answering(502, "null") },
      ),
    ).rejects.toMatchObject({ status: 502, code: "http_error" });
  });

  it("refuse an exchange that does not say what it issued", async () => {
    await expect(
      exchangeToken(
        "https://fyrden.test",
        { subjectToken: "s", grantId: "g" },
        { fetch: answering(200, '{"access_token":"a","token_type":"Bearer","expires_in":1}') },
      ),
    ).rejects.toMatchObject({ code: "invalid_token_response" });
  });

  it("refuse a success that carries no token", async () => {
    for (const body of [
      "<html>sign in</html>",
      "{}",
      "null",
      '{"access_token":"a"}',
      '{"access_token":"","token_type":"Bearer"}',
    ])
      await expect(
        refreshToken(
          "https://fyrden.test",
          { clientId: "c", refreshToken: "r" },
          { fetch: answering(200, body) },
        ),
      ).rejects.toBeInstanceOf(FyrdenError);
  });
});
