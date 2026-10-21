// Commit signing: commits the server makes are signed with the platform's
// key and show as verified; the public keys are published; a signature by a
// key Fyrden does not know is not verified.

import { env, exports } from "cloudflare:workers";
import {
  ed25519FromSeed,
  ed25519PublicKeyBlob,
  sshCommitSigner,
  sshFingerprint,
} from "@fyrden/git-core";
import { uniqueId } from "@fyrden/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { MAX_SIGNING_KEYS } from "../src/accounts/signing-keys.js";
import type { CommitView } from "../src/do/repo/browse.js";
import { checkSignature, factOf } from "../src/do/repo/signature.js";
import { ACCESS_TOKEN_TYPE, TOKEN_EXCHANGE } from "../src/oauth/exchange.js";
import { platformKeys, platformSigner } from "../src/signing/platform-key.js";
import { resolveVerification } from "../src/signing/verification.js";
import { api, json, user, type Who } from "./helpers/api.js";
import { principalWithToken, scopedToken } from "./helpers/principals.js";

type Verification = { verified: boolean; reason: string; signature: string | null };
type Commit = { sha: string; commit: { verification: Verification } };

let owner: Who;

beforeAll(async () => {
  owner = await user();
});

const seed = (n: number) => Uint8Array.from({ length: 32 }, (_, i) => (i * 13 + n) % 256);

/** A commit body (no object header) signed by `seed`'s key. */
async function signedBody(keySeed: Uint8Array, email = "a@example.com"): Promise<Uint8Array> {
  const unsigned = `tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904
author A <${email}> 1700000000 +0000
committer A <${email}> 1700000000 +0000

signed
`;
  const signer = sshCommitSigner(await ed25519FromSeed(keySeed));
  const signature = new TextDecoder().decode(await signer.sign(new TextEncoder().encode(unsigned)));
  const header = `gpgsig ${signature.split("\n").join("\n ")}\n`;
  const at = unsigned.indexOf("\n\n") + 1;
  return new TextEncoder().encode(unsigned.slice(0, at) + header + unsigned.slice(at));
}

const viewOf = async (body: Uint8Array, email = "a@example.com"): Promise<CommitView> => ({
  sha: "0".repeat(40),
  commit: {
    message: "signed\n",
    author: { name: "A", email, date: "2023-11-14T22:13:20Z" },
    committer: { name: "A", email, date: "2023-11-14T22:13:20Z" },
    tree: { sha: "4b825dc642cb6eb9a060e54bf8d69288fbee4904" },
    verification: await checkSignature(body),
  },
  parents: [],
});

describe("commit signing", () => {
  it("signs file writes with the platform key, and shows them verified", async () => {
    const repo = await json<{ name: string }>(
      api("POST", "/user/repos", owner.token, { name: uniqueId("s") }),
    );
    const path = `/repos/${owner.handle}/${repo.body.name}`;
    const written = await json<{ commit: Commit }>(
      api("PUT", `${path}/contents/a.txt`, owner.token, { message: "add", content: btoa("a") }),
    );
    expect(written.body.commit.commit.verification).toMatchObject({
      verified: true,
      reason: "valid",
      signature: expect.stringContaining("-----BEGIN SSH SIGNATURE-----"),
    });
    const read = await json<Commit>(api("GET", `${path}/commits/main`, owner.token));
    expect(read.body.sha).toBe(written.body.commit.sha);
    expect(read.body.commit.verification).toMatchObject({ verified: true, reason: "valid" });
  });

  it("publishes the platform's public keys to any caller", async () => {
    const res = await api("GET", "/meta/signing-keys", owner.token);
    expect(res.status).toBe(200);
    const { keys } = await res.json<{
      keys: { key_id: string; key: string; current: boolean }[];
    }>();
    const pair = await ed25519FromSeed(
      Uint8Array.from(atob((env as unknown as { SIGNING_KEY: string }).SIGNING_KEY), (c) =>
        c.charCodeAt(0),
      ),
    );
    expect(keys).toEqual([
      {
        key_id: await sshFingerprint(ed25519PublicKeyBlob(pair.publicKey)),
        key: expect.stringMatching(/^ssh-ed25519 AAAA/),
        current: true,
      },
    ]);
  });

  it("leaves unreadable keys out of verification, and reads go on", async () => {
    const rsa = `ssh-rsa ${btoa(String.fromCharCode(0, 0, 0, 7, ...new TextEncoder().encode("ssh-rsa")))}`;
    const broken = { SIGNING_KEY: "bad", SIGNING_KEYS_RETIRED: `not a key\n${rsa}` };
    expect(await platformKeys(broken)).toEqual([]);
    const [unsigned] = await resolveVerification({ env: { ...env, ...broken } as Env }, [
      await viewOf(
        new TextEncoder().encode("tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\n\nx\n"),
      ),
    ]);
    expect(unsigned?.commit.verification.reason).toBe("unsigned");
    await expect(platformSigner(broken)).rejects.toThrow();
  });

  it("classifies an empty signature as malformed and an OpenPGP one as another type", async () => {
    const commit = (sig: string) =>
      new TextEncoder().encode(
        `tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\ngpgsig ${sig}\n\nx\n`,
      );
    expect((await checkSignature(commit(""))).reason).toBe("malformed_signature");
    expect(
      (
        await checkSignature(
          commit("-----BEGIN PGP SIGNATURE-----\n abc\n -----END PGP SIGNATURE-----"),
        )
      ).reason,
    ).toBe("unknown_signature_type");
  });

  it("verifies a retired key's commits, and not a stranger's", async () => {
    const retired = await ed25519FromSeed(seed(1));
    const retiredLine = `ssh-ed25519 ${btoa(String.fromCharCode(...ed25519PublicKeyBlob(retired.publicKey)))}`;
    const rotated = {
      SIGNING_KEY: btoa(String.fromCharCode(...seed(2))),
      SIGNING_KEYS_RETIRED: retiredLine,
    };
    const [byRetired, byStranger, unsigned] = await resolveVerification(
      { env: { ...env, ...rotated } as Env },
      [
        await viewOf(await signedBody(seed(1))),
        await viewOf(await signedBody(seed(3))),
        await viewOf(
          new TextEncoder().encode("tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\n\nx\n"),
        ),
      ],
    );
    expect(byRetired?.commit.verification).toMatchObject({ verified: true, reason: "valid" });
    expect(byStranger?.commit.verification).toMatchObject({
      verified: false,
      reason: "unknown_key",
    });
    expect(unsigned?.commit.verification).toEqual({
      verified: false,
      reason: "unsigned",
      signature: null,
      payload: null,
      verified_at: null,
    });
    expect((await platformKeys(rotated)).map((k) => k.current)).toEqual([true, false]);
  });

  it("gives the rulesets the same verdict from bytes alone, a large message's included", async () => {
    const pgp = new TextEncoder().encode(
      "tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\nauthor A <a@example.com> 1700000000 +0000\ncommitter A <a@example.com> 1700000000 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n abc\n -----END PGP SIGNATURE-----\n\nx\n",
    );
    const signed = await signedBody(seed(5), "b@example.com");
    const changed = new TextEncoder().encode(
      new TextDecoder().decode(signed).replace("signed\n", "changed\n"),
    );
    for (const body of [signed, changed, pgp])
      expect(await factOf(body)).toEqual({
        ...(({ reason, key }) => ({ reason, key }))(await checkSignature(body)),
        committerEmail: expect.any(String),
      });
    expect(await factOf(signed)).toMatchObject({
      reason: "signed",
      committerEmail: "b@example.com",
    });
    // A signed commit whose 8 MiB message is not UTF-8 at all.
    const head = `tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904
author A <c@example.com> 1700000000 +0000
committer A <c@example.com> 1700000000 +0000

`;
    const unsigned = new Uint8Array(head.length + 8 * 1024 * 1024).fill(0xff);
    unsigned.set(new TextEncoder().encode(head));
    const signer = sshCommitSigner(await ed25519FromSeed(seed(6)));
    const armored = new TextDecoder().decode(await signer.sign(unsigned));
    const header = new TextEncoder().encode(`gpgsig ${armored.split("\n").join("\n ")}\n`);
    const at = head.indexOf("\n\n") + 1;
    const large = new Uint8Array(unsigned.length + header.length);
    large.set(unsigned.subarray(0, at));
    large.set(header, at);
    large.set(unsigned.subarray(at), at + header.length);
    expect(await factOf(large)).toMatchObject({
      reason: "signed",
      committerEmail: "c@example.com",
    });
  });

  it("reports a changed commit as invalid", async () => {
    const body = new TextDecoder().decode(await signedBody(seed(4)));
    const changed = new TextEncoder().encode(body.replace("signed\n", "changed\n"));
    expect((await checkSignature(changed)).reason).toBe("invalid");
  });

  it("verifies a user's key for commits by that user, and only while the key is theirs", async () => {
    const signer = await user();
    const pair = await ed25519FromSeed(seed(9));
    const line = `ssh-ed25519 ${btoa(String.fromCharCode(...ed25519PublicKeyBlob(pair.publicKey)))}`;
    const added = await json<{ id: string; fingerprint: string; key: string }>(
      api("POST", "/user/ssh_signing_keys", signer.token, {
        title: "laptop",
        key: `${line} me@laptop`,
      }),
    );
    expect(added).toMatchObject({
      status: 201,
      body: { key: line, fingerprint: await sshFingerprint(ed25519PublicKeyBlob(pair.publicKey)) },
    });
    const own = `${signer.principalId.toLowerCase()}@users.noreply.fyrden.test`;
    const resolve = async (email: string) =>
      (
        await resolveVerification({ env }, [await viewOf(await signedBody(seed(9), email), email)])
      )[0]?.commit.verification;
    expect(await resolve(own)).toMatchObject({ verified: true, reason: "valid" });
    expect(await resolve("someone@example.com")).toMatchObject({
      verified: false,
      reason: "bad_email",
    });
    expect(
      (await api("DELETE", `/user/ssh_signing_keys/${added.body.id}`, signer.token)).status,
    ).toBe(200);
    expect(await resolve(own)).toMatchObject({ verified: false, reason: "unknown_key" });
  });
});

describe("agents' signing keys", () => {
  it("verify an agent's commits by a key of its own, never one it adds acting for a user", async () => {
    const owner = await user();
    const agent = await json<{ id: string; handle: string }>(
      api("POST", "/agents", owner.token, { handle: uniqueId("signer").slice(0, 39) }),
    );
    const own = await json<{ token: string }>(
      api("POST", `/agents/${agent.body.handle}/tokens`, owner.token, {}),
    );
    const pair = await ed25519FromSeed(seed(41));
    const line = `ssh-ed25519 ${btoa(String.fromCharCode(...ed25519PublicKeyBlob(pair.publicKey)))}`;
    const added = await json<{ id: string }>(
      api("POST", "/user/ssh_signing_keys", own.body.token, { title: "ci", key: line }),
    );
    expect(added.status).toBe(201);
    expect((await api("GET", "/user/ssh_signing_keys", own.body.token)).status).toBe(200);
    // A key belongs to one principal: its user cannot add the agent's.
    expect(
      (
        await json<{ code: string }>(
          api("POST", "/user/ssh_signing_keys", owner.token, { title: "mine", key: line }),
        )
      ).body,
    ).toMatchObject({ code: "key_in_use" });
    const email = `${agent.body.id.toLowerCase()}@users.noreply.fyrden.test`;
    const [view] = await resolveVerification({ env }, [
      await viewOf(await signedBody(seed(41), email), email),
    ]);
    expect(view?.commit.verification).toMatchObject({ verified: true, reason: "valid" });
    const verifyAgain = async () =>
      (
        await resolveVerification({ env }, [await viewOf(await signedBody(seed(41), email), email)])
      )[0]?.commit.verification;
    // Acting for its user under a grant, it is the user's keys it would touch: none.
    const granted = await json<{ id: string }>(
      api("POST", "/grants", owner.token, {
        agent: agent.body.handle,
        scopes: ["ssh_signing_keys:write"],
      }),
    );
    expect(granted.status).toBe(201);
    const exchanged = await exports.default.fetch("https://fyrden.test/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: TOKEN_EXCHANGE,
        subject_token: own.body.token,
        subject_token_type: ACCESS_TOKEN_TYPE,
        grant_id: granted.body.id,
      }).toString(),
    });
    const { access_token } = await exchanged.json<{ access_token: string }>();
    expect((await api("GET", "/user/ssh_signing_keys", access_token)).status).toBe(403);
    // Nor reads or deletes the user's, though the grant would allow it.
    const users = await json<{ id: string }>(
      api("POST", "/user/ssh_signing_keys", owner.token, {
        title: "u",
        key: `ssh-ed25519 ${btoa(String.fromCharCode(...ed25519PublicKeyBlob((await ed25519FromSeed(seed(43))).publicKey)))}`,
      }),
    );
    expect(users.status).toBe(201);
    for (const method of ["GET", "DELETE"])
      expect(
        (await api(method, `/user/ssh_signing_keys/${users.body.id}`, access_token)).status,
      ).toBe(403);
    expect((await api("GET", `/user/ssh_signing_keys/${users.body.id}`, owner.token)).status).toBe(
      200,
    );
    const other = await ed25519FromSeed(seed(42));
    const otherLine = `ssh-ed25519 ${btoa(String.fromCharCode(...ed25519PublicKeyBlob(other.publicKey)))}`;
    expect(
      (await api("POST", "/user/ssh_signing_keys", access_token, { title: "x", key: otherLine }))
        .status,
    ).toBe(403);
    // Its keys hold while its owner does: disabling the owner stops them.
    await env.DIRECTORY.prepare(
      "UPDATE principals SET disabled_at = ?, lifecycle = CASE WHEN type = 'user' THEN 'suspended' ELSE lifecycle END WHERE id = ?",
    )
      .bind(Date.now(), owner.principalId)
      .run();
    expect(await verifyAgain()).toMatchObject({ verified: false, reason: "unknown_key" });
  });
});

/** One key short of the limit, written directly. */
async function seed99(who: Who) {
  await env.DIRECTORY.batch(
    Array.from({ length: MAX_SIGNING_KEYS - 1 }, (_, i) =>
      env.DIRECTORY.prepare(
        "INSERT INTO ssh_signing_keys (id, principal_id, title, key, fingerprint, created_at) VALUES (?, ?, 't', 'k', ?, 1)",
      ).bind(`key_seed${i}_${who.principalId}`, who.principalId, `fp-${who.principalId}-${i}`),
    ),
  );
}

async function keyCount(who: Who): Promise<number> {
  return (
    (
      await env.DIRECTORY.prepare(
        "SELECT count(*) AS n FROM ssh_signing_keys WHERE principal_id = ?",
      )
        .bind(who.principalId)
        .first<{ n: number }>()
    )?.n ?? 0
  );
}

describe("SSH signing keys", () => {
  const add = (who: Who, key: string, title = "k") =>
    json<{ id: string; code?: string }>(
      api("POST", "/user/ssh_signing_keys", who.token, { title, key }),
    );
  const lineOf = async (n: number) =>
    `ssh-ed25519 ${btoa(String.fromCharCode(...ed25519PublicKeyBlob((await ed25519FromSeed(seed(n))).publicKey)))}`;

  it("are listed, read and deleted by their user only", async () => {
    const me = await user();
    const first = (await add(me, await lineOf(20), "one")).body;
    const second = (await add(me, await lineOf(21), "two")).body;
    const page = await json<{ keys: { id: string }[]; next_cursor: string | null }>(
      api("GET", "/user/ssh_signing_keys?per_page=1", me.token),
    );
    expect(page.body.keys.map((k) => k.id)).toEqual([first.id]);
    const rest = await json<{ keys: { id: string }[]; next_cursor: string | null }>(
      api("GET", `/user/ssh_signing_keys?per_page=1&cursor=${page.body.next_cursor}`, me.token),
    );
    expect(rest.body).toEqual({
      keys: [expect.objectContaining({ id: second.id })],
      next_cursor: null,
    });
    const other = await user();
    expect((await api("GET", `/user/ssh_signing_keys/${first.id}`, other.token)).status).toBe(404);
    expect((await api("DELETE", `/user/ssh_signing_keys/${first.id}`, other.token)).status).toBe(
      404,
    );
    expect((await api("GET", `/user/ssh_signing_keys/${first.id}`, me.token)).status).toBe(200);
  });

  it("refuse a malformed key, another type, and a key another user added", async () => {
    const me = await user();
    expect(await add(me, "not a key")).toMatchObject({
      status: 422,
      body: { code: "invalid_key" },
    });
    const rsa = `ssh-rsa ${btoa(String.fromCharCode(0, 0, 0, 7, ...new TextEncoder().encode("ssh-rsa")))}`;
    expect(await add(me, rsa)).toMatchObject({ status: 422, body: { code: "unsupported_key" } });
    const line = await lineOf(22);
    expect((await add(me, line)).status).toBe(201);
    const other = await user();
    expect(await add(other, `${line} copied`)).toMatchObject({
      status: 422,
      body: { code: "key_in_use" },
    });
  });

  it("need their scopes: read to see them, write (which implies read) to change them", async () => {
    const me = await user();
    const agent = await principalWithToken("agent", "pat");
    const callers = {
      read: await scopedToken(me.principalId, ["ssh_signing_keys:read"]),
      write: await scopedToken(me.principalId, ["ssh_signing_keys:write"]),
      other: await scopedToken(me.principalId, ["metadata:read"]),
      all: await scopedToken(me.principalId, []),
      agent: agent.token,
    };
    // What each caller gets from list, get, create and delete.
    const expected: Record<keyof typeof callers, [number, number, number, number]> = {
      read: [200, 200, 403, 403],
      write: [200, 200, 201, 200],
      other: [403, 403, 403, 403],
      all: [200, 200, 201, 200],
      // Its own keys: none of the user's.
      agent: [200, 404, 201, 404],
    };
    let n = 60;
    for (const [caller, token] of Object.entries(callers) as [keyof typeof callers, string][]) {
      // A key of the user's own for each caller to read and delete.
      const key = (await add(me, await lineOf(n++))).body.id;
      const got = [
        (await api("GET", "/user/ssh_signing_keys", token)).status,
        (await api("GET", `/user/ssh_signing_keys/${key}`, token)).status,
        (
          await api("POST", "/user/ssh_signing_keys", token, {
            title: "t",
            key: await lineOf(n++),
          })
        ).status,
        (await api("DELETE", `/user/ssh_signing_keys/${key}`, token)).status,
      ];
      expect([caller, got]).toEqual([caller, expected[caller]]);
      // A refused delete leaves the key.
      const still = (await api("GET", `/user/ssh_signing_keys/${key}`, me.token)).status;
      expect([caller, still]).toEqual([caller, expected[caller][3] === 200 ? 404 : 200]);
    }
    const audits = await env.DIRECTORY.prepare(
      `SELECT action, count(*) AS n FROM audit_log WHERE actor_id = ?
       AND action LIKE 'ssh_signing_key.%' GROUP BY action ORDER BY action`,
    )
      .bind(me.principalId)
      .all<{ action: string; n: number }>();
    // One create per caller's key, plus the two allowed creates; two allowed deletes.
    expect(audits.results).toEqual([
      { action: "ssh_signing_key.create", n: 5 + 2 },
      { action: "ssh_signing_key.delete", n: 2 },
    ]);
  });

  it("are added once, concurrently, up to the limit, with one audit row per change", async () => {
    const me = await user();
    await seed99(me);
    const results = await Promise.all(
      [40, 41, 42, 43].map(async (n) => (await add(me, await lineOf(n))).status),
    );
    expect(results.filter((s) => s === 201)).toHaveLength(1);
    expect(await keyCount(me)).toBe(MAX_SIGNING_KEYS);
    // At the limit, a key already added (by anyone) is `key_in_use`, not `too_many_keys`.
    const other = await user();
    const theirs = await lineOf(44);
    expect((await add(other, theirs)).status).toBe(201);
    expect(await add(me, theirs)).toMatchObject({ status: 422, body: { code: "key_in_use" } });
    const added = await env.DIRECTORY.prepare(
      "SELECT count(*) AS n FROM audit_log WHERE actor_id = ? AND action = 'ssh_signing_key.create'",
    )
      .bind(me.principalId)
      .first<{ n: number }>();
    expect(added?.n).toBe(1);
    // Deleting twice: one change, one audit row.
    const mine = await json<{ keys: { id: string }[] }>(
      api("GET", "/user/ssh_signing_keys?per_page=100", me.token),
    );
    const last = mine.body.keys.at(-1)?.id as string;
    const deletes = await Promise.all(
      [1, 2].map(
        async () => (await api("DELETE", `/user/ssh_signing_keys/${last}`, me.token)).status,
      ),
    );
    expect(deletes.sort()).toEqual([200, 404]);
    const removed = await env.DIRECTORY.prepare(
      "SELECT count(*) AS n FROM audit_log WHERE target_id = ? AND action = 'ssh_signing_key.delete'",
    )
      .bind(last)
      .first<{ n: number }>();
    expect(removed?.n).toBe(1);
  });

  it("are limited per user", async () => {
    const me = await user();
    await seed99(me);
    expect((await add(me, await lineOf(50))).status).toBe(201);
    expect(await add(me, await lineOf(51))).toMatchObject({
      status: 422,
      body: { code: "too_many_keys" },
    });
  });
});
