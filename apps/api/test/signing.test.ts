// Commit signing: commits the server makes are signed with the platform's
// key and show as verified; the public keys are published; a signature by a
// key Fyrden does not know is not verified.

import { env } from "cloudflare:workers";
import {
  ed25519FromSeed,
  ed25519PublicKeyBlob,
  sshCommitSigner,
  sshFingerprint,
} from "@fyrden/git-core";
import { uniqueId } from "@fyrden/testing";
import { beforeAll, describe, expect, it } from "vitest";
import type { CommitView } from "../src/do/repo/browse.js";
import { checkSignature } from "../src/do/repo/signature.js";
import { platformKeys, platformSigner } from "../src/signing/platform-key.js";
import { resolveVerification } from "../src/signing/verification.js";
import { api, json, user, type Who } from "./helpers/api.js";

type Verification = { verified: boolean; reason: string; signature: string | null };
type Commit = { sha: string; commit: { verification: Verification } };

let owner: Who;

beforeAll(async () => {
  owner = await user();
});

const seed = (n: number) => Uint8Array.from({ length: 32 }, (_, i) => (i * 13 + n) % 256);

/** A commit body (no object header) signed by `seed`'s key. */
async function signedBody(keySeed: Uint8Array): Promise<Uint8Array> {
  const unsigned = `tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904
author A <a@example.com> 1700000000 +0000
committer A <a@example.com> 1700000000 +0000

signed
`;
  const signer = sshCommitSigner(await ed25519FromSeed(keySeed));
  const signature = new TextDecoder().decode(await signer.sign(new TextEncoder().encode(unsigned)));
  const header = `gpgsig ${signature.split("\n").join("\n ")}\n`;
  const at = unsigned.indexOf("\n\n") + 1;
  return new TextEncoder().encode(unsigned.slice(0, at) + header + unsigned.slice(at));
}

const viewOf = async (body: Uint8Array): Promise<CommitView> => ({
  sha: "0".repeat(40),
  commit: {
    message: "signed\n",
    author: { name: "A", email: "a@example.com", date: "2023-11-14T22:13:20Z" },
    committer: { name: "A", email: "a@example.com", date: "2023-11-14T22:13:20Z" },
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
    const [unsigned] = await resolveVerification(broken, [
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
    const [byRetired, byStranger, unsigned] = await resolveVerification(rotated, [
      await viewOf(await signedBody(seed(1))),
      await viewOf(await signedBody(seed(3))),
      await viewOf(
        new TextEncoder().encode("tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\n\nx\n"),
      ),
    ]);
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

  it("reports a changed commit as invalid", async () => {
    const body = new TextDecoder().decode(await signedBody(seed(4)));
    const changed = new TextEncoder().encode(body.replace("signed\n", "changed\n"));
    expect((await checkSignature(changed)).reason).toBe("invalid");
  });
});
