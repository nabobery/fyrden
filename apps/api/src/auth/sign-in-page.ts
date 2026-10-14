import type { Context } from "hono";
import type { AuthVariables } from "../middleware/auth.js";

/**
 * `GET /auth/sign-in`: a small page on this origin that signs a user in
 * (with a passkey, or a personal access token), offers to add a passkey,
 * and goes back to `return_to` (a path on this origin, such as the
 * authorization request that sent the user here). Its script runs under a
 * per-response nonce and talks only to this origin.
 */

/** A path on this origin, or `/` (never another origin: no scheme, no `//`, no backslash). */
export function safeReturnTo(raw: string | undefined): string {
  if (!raw?.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return "/";
  return raw.length > 4096 ? "/" : raw;
}

const escapeHtml = (text: string): string =>
  text.replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch,
  );

const SCRIPT = `
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
const unb64 = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const back = document.body.dataset.returnTo;
const say = (text) => { document.getElementById("status").textContent = text; };
const post = (path, body) => fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
document.getElementById("passkey").addEventListener("click", async () => {
  try {
    const opts = await (await post("/auth/passkeys/sign-in-options")).json();
    const cred = await navigator.credentials.get({ publicKey: { ...opts.publicKey, challenge: unb64(opts.publicKey.challenge) } });
    const res = await post("/auth/passkeys/sign-in", { challenge_id: opts.challenge_id, credential: {
      id: cred.id, rawId: b64(cred.rawId), type: cred.type, response: {
        clientDataJSON: b64(cred.response.clientDataJSON), authenticatorData: b64(cred.response.authenticatorData),
        signature: b64(cred.response.signature), userHandle: cred.response.userHandle ? b64(cred.response.userHandle) : "" } } });
    if (res.ok) location.assign(back); else say("That passkey could not sign you in.");
  } catch { say("Signing in with a passkey was cancelled or failed."); }
});
document.getElementById("token-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const res = await post("/auth/token", { token: document.getElementById("token").value });
  if (!res.ok) { say((await res.json()).detail); return; }
  document.getElementById("signed-in").hidden = false;
  document.getElementById("sign-in").hidden = true;
});
document.getElementById("add").addEventListener("click", async () => {
  try {
    const opts = await (await post("/auth/passkeys/registration-options")).json();
    const pk = opts.publicKey;
    const cred = await navigator.credentials.create({ publicKey: { ...pk, challenge: unb64(pk.challenge),
      user: { ...pk.user, id: unb64(pk.user.id) }, excludeCredentials: pk.excludeCredentials.map((c) => ({ ...c, id: unb64(c.id) })) } });
    const res = await post("/auth/passkeys/registration", { challenge_id: opts.challenge_id, name: navigator.platform || null, credential: {
      id: cred.id, rawId: b64(cred.rawId), type: cred.type, response: {
        clientDataJSON: b64(cred.response.clientDataJSON), attestationObject: b64(cred.response.attestationObject) } } });
    if (res.ok) location.assign(back); else say((await res.json()).detail);
  } catch { say("Adding a passkey was cancelled or failed."); }
});
document.getElementById("continue").addEventListener("click", () => location.assign(back));
`;

export function signInPage(c: Context<{ Bindings: Env; Variables: AuthVariables }>): Response {
  const returnTo = safeReturnTo(c.req.query("return_to"));
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  return c.html(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer"><title>Sign in · Fyrden</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:28rem;margin:3rem auto;padding:0 1rem;color:#111}
h1{font-size:1.4rem}label{display:block;margin:.5rem 0 .25rem}input{width:100%;box-sizing:border-box;font:inherit;padding:.45rem}
button{font:inherit;padding:.5rem 1rem;border-radius:.4rem;border:1px solid #888;background:#fff;cursor:pointer;margin-top:.75rem}
button.primary{background:#1f6feb;border-color:#1f6feb;color:#fff}#status{color:#b42318;min-height:1.5em}
@media (prefers-color-scheme:dark){body{background:#0d1117;color:#e6edf3}button,input{background:#21262d;color:#e6edf3}}</style>
</head><body data-return-to="${escapeHtml(returnTo)}">
<h1>Sign in to Fyrden</h1>
<section id="sign-in"><button class="primary" id="passkey" type="button">Sign in with a passkey</button>
<form id="token-form"><label for="token">Or a personal access token (full rights)</label>
<input id="token" type="password" autocomplete="off" required><button type="submit">Sign in with the token</button></form></section>
<section id="signed-in" hidden><p>Signed in. Add a passkey so you can sign in without a token next time?</p>
<button class="primary" id="add" type="button">Add a passkey</button> <button id="continue" type="button">Not now</button></section>
<p id="status" role="status"></p>
<script nonce="${nonce}">${SCRIPT}</script></body></html>`,
    200,
    {
      "Cache-Control": "no-store",
      "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
      "X-Frame-Options": "DENY",
    },
  );
}
