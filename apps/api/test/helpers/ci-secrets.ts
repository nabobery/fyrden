// Actions secrets as a client makes them: a libsodium sealed box for a public
// key, made with noble and WebCrypto only (independently of the server's code),
// and the accounts and repositories the tests set them on.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { registerSecretValue } from "@fyrden/testing/log-capture";
import { hsalsa, xsalsa20poly1305 } from "@noble/ciphers/salsa.js";
import { blake2b } from "@noble/hashes/blake2.js";
import { expect } from "vitest";
import { x25519Algorithm } from "../../src/ci/sealed-box.js";
import type { OrgDO } from "../../src/do/OrgDO.js";
import { api, json, type Who } from "./api.js";
import { createRepo } from "./git-http.js";

const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

/** `value` (text as UTF-8, or bytes) sealed for the base64 X25519 public key `publicKey`, in base64. */
export async function sealFor(publicKey: string, value: string | Uint8Array): Promise<string> {
  const recipientKey = fromBase64(publicKey);
  const message = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const ephemeral = (await crypto.subtle.generateKey({ name: "X25519" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const epk = new Uint8Array(
    (await crypto.subtle.exportKey("raw", ephemeral.publicKey)) as ArrayBuffer,
  );
  const recipient = await crypto.subtle.importKey(
    "raw",
    recipientKey,
    { name: "X25519" },
    false,
    [],
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits(x25519Algorithm(recipient), ephemeral.privateKey, 256),
  );
  const words = (bytes: Uint8Array) => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return Uint32Array.from({ length: bytes.length / 4 }, (_, i) => view.getUint32(i * 4, true));
  };
  const out = new Uint32Array(8);
  hsalsa(
    words(new TextEncoder().encode("expand 32-byte k")),
    words(shared),
    new Uint32Array(4),
    out,
  );
  const key = new Uint8Array(32);
  const keyView = new DataView(key.buffer);
  for (const [i, w] of out.entries()) keyView.setUint32(i * 4, w, true);
  const nonceInput = new Uint8Array(64);
  nonceInput.set(epk);
  nonceInput.set(recipientKey, 32);
  const box = xsalsa20poly1305(key, blake2b(nonceInput, { dkLen: 24 })).encrypt(message);
  const sealed = new Uint8Array(32 + box.length);
  sealed.set(epk);
  sealed.set(box, 32);
  return toBase64(sealed);
}

/**
 * A value no log line or stored row may hold, `length` characters long when
 * given; registered, so a log line holding it fails the test.
 */
export const secretValue = (length?: number) => {
  const unit = `sv-${crypto.randomUUID()}-${crypto.randomUUID()}`;
  return registerSecretValue(
    length === undefined ? unit : unit.repeat(Math.ceil(length / unit.length)).slice(0, length),
  );
};

/** A new organization owned by `owner`, made by the instance administrator `admin`. */
export async function newOrg(admin: Who, owner: Who): Promise<{ login: string; id: string }> {
  const login = uniqueId("org").slice(0, 39);
  const made = await json<{ id: string }>(
    api("POST", "/admin/organizations", admin.token, { login, admin: owner.handle }),
  );
  expect(made.status).toBe(201);
  return { login, id: made.body.id };
}

export async function repoOf(
  ownerId: string,
  visibility: "public" | "internal" | "private" = "private",
): Promise<{ id: string; name: string }> {
  const repo = await createRepo(ownerId);
  if (visibility !== "private")
    await env.DIRECTORY.prepare("UPDATE repos SET visibility = ? WHERE id = ?")
      .bind(visibility, repo.id)
      .run();
  return { id: repo.id, name: repo.name };
}

/** A repository of organization `login` with `visibility`, made by its owner `owner`. */
export async function orgRepoOf(
  owner: Who,
  login: string,
  visibility: "public" | "internal" | "private" = "private",
): Promise<{ id: string; name: string }> {
  const made = await json<{ id: string; name: string }>(
    api("POST", `/orgs/${login}/repos`, owner.token, { name: uniqueId("r") }),
  );
  expect(made.status).toBe(201);
  if (visibility !== "private")
    await env.DIRECTORY.prepare("UPDATE repos SET visibility = ? WHERE id = ?")
      .bind(visibility, made.body.id)
      .run();
  return { id: made.body.id, name: made.body.name };
}

/** Sets a secret through REST as `who` (`path`: `/repos/o/r` or `/orgs/o`), sealed for the scope's key. */
export async function putSecret(
  who: Who,
  path: string,
  name: string,
  value: string | Uint8Array,
  extra: Record<string, unknown> = {},
): Promise<Response> {
  const key = await json<{ key_id: string; key: string }>(
    api("GET", `${path}/actions/secrets/public-key`, who.token),
  );
  expect(key.status).toBe(200);
  return api("PUT", `${path}/actions/secrets/${name}`, who.token, {
    encrypted_value: await sealFor(key.body.key, value),
    key_id: key.body.key_id,
    ...extra,
  });
}

/** Every row of every table of an account object, as text. */
export function everyRow(stub: DurableObjectStub<OrgDO>): Promise<string> {
  return runInDurableObject(stub, (_: OrgDO, state) => {
    const tables = state.storage.sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%'",
      )
      .toArray();
    return JSON.stringify(
      tables.map((t) => [t.name, state.storage.sql.exec(`SELECT * FROM "${t.name}"`).toArray()]),
    );
  });
}

export function inAccount<T>(
  stub: DurableObjectStub<OrgDO>,
  fn: (sql: SqlStorage, instance: OrgDO) => T,
): Promise<T> {
  return runInDurableObject(stub, (instance: OrgDO, state) => fn(state.storage.sql, instance));
}
