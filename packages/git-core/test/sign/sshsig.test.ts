import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { encodeCommit } from "../../src/object/commit.js";
import { oidFromHex } from "../../src/object/oid.js";
import { splitSignedCommit, verifyCommitSignature } from "../../src/sign/commit-signature.js";
import {
  armorSshSignature,
  ed25519FromSeed,
  ed25519PublicKeyBlob,
  GIT_NAMESPACE,
  parseSshPublicKey,
  parseSshSignature,
  sshCommitSigner,
  sshFingerprint,
  verifySshSignature,
} from "../../src/sign/sshsig.js";
import { createGitSandbox, type GitSandbox } from "../../testing/git-cli.js";

const utf8 = new TextEncoder();
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const seed = (n: number) => Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + n) % 256);

const keyLine = (publicKey: Uint8Array) =>
  `ssh-ed25519 ${Buffer.from(ed25519PublicKeyBlob(publicKey)).toString("base64")}`;

function ident(name: string, email: string) {
  return {
    name: utf8.encode(name),
    email: utf8.encode(email),
    timestamp: 1_700_000_000,
    timezone: "+0000",
  };
}

/** A root commit of the empty tree, signed by `signer` over its unsigned bytes. */
async function signedCommit(signer: ReturnType<typeof sshCommitSigner>, message = "signed\n") {
  const unsigned = {
    tree: oidFromHex(EMPTY_TREE),
    parents: [],
    author: ident("A", "a@example.com"),
    committer: ident("A", "a@example.com"),
    headers: [],
    message: utf8.encode(message),
  };
  const signature = await signer.sign(encodeCommit(unsigned));
  return encodeCommit({ ...unsigned, headers: [{ key: "gpgsig", value: signature }] });
}

describe("SSH commit signatures", () => {
  const sandboxes: GitSandbox[] = [];
  afterEach(async () => {
    await Promise.all(sandboxes.splice(0).map((s) => s.dispose()));
  });

  it("are verified by git verify-commit, and the same bytes give the same signature", async () => {
    const key = await ed25519FromSeed(seed(1));
    const signer = sshCommitSigner(key);
    const commit = await signedCommit(signer);
    expect(await signedCommit(signer)).toEqual(commit);

    const sandbox = await createGitSandbox();
    sandboxes.push(sandbox);
    await sandbox.git(["init", "-q"]);
    const id = (
      await sandbox.git(["hash-object", "-t", "commit", "-w", "--stdin"], { input: commit })
    ).stdout.trim();
    const allowed = join(sandbox.dir, "allowed_signers");
    writeFileSync(allowed, `* namespaces="git" ${keyLine(key.publicKey)}\n`);
    const verified = await sandbox.git([
      "-c",
      "gpg.format=ssh",
      "-c",
      `gpg.ssh.allowedSignersFile=${allowed}`,
      "verify-commit",
      "--raw",
      id,
    ]);
    expect(verified.stderr).toContain("Good");
    expect(await verifyCommitSignature(commit)).toMatchObject({ ok: true });
  });

  it("verify what git signs with ssh-keygen, with the fingerprint ssh-keygen shows", async () => {
    const sandbox = await createGitSandbox();
    sandboxes.push(sandbox);
    const keyFile = join(sandbox.dir, "key");
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "", "-f", keyFile]);
    await sandbox.git(["init", "-q", "-b", "main"]);
    await sandbox.git([
      "-c",
      "gpg.format=ssh",
      "-c",
      `user.signingkey=${keyFile}.pub`,
      "commit",
      "-q",
      "-S",
      "--allow-empty",
      "-m",
      "by git",
    ]);
    const body = await sandbox.gitBytes(["cat-file", "commit", "HEAD"]);
    const result = await verifyCommitSignature(body);
    const shown = execFileSync("ssh-keygen", ["-l", "-f", `${keyFile}.pub`])
      .toString()
      .split(" ")[1];
    expect(result).toEqual({
      ok: true,
      publicKey: parseSshPublicKey(readFileSync(`${keyFile}.pub`, "utf8")).blob,
      fingerprint: shown,
    });
    // The signed payload is the commit without its signature header.
    const split = splitSignedCommit(body);
    if (split.kind !== "signed") throw new Error(split.kind);
    expect(new TextDecoder().decode(split.payload)).not.toContain("gpgsig");
    expect(new TextDecoder().decode(split.payload)).toContain("\n\nby git\n");
  });

  it("report a changed commit, another namespace, a broken signature and no signature", async () => {
    const key = await ed25519FromSeed(seed(2));
    const commit = await signedCommit(sshCommitSigner(key));
    const text = new TextDecoder().decode(commit);
    const tampered = utf8.encode(text.replace("signed\n", "changed\n"));
    expect(await verifyCommitSignature(tampered)).toMatchObject({ ok: false, reason: "invalid" });
    const split = splitSignedCommit(commit);
    if (split.kind !== "signed") throw new Error(split.kind);
    expect(await verifySshSignature(split.payload, split.signature, "file")).toMatchObject({
      ok: false,
      reason: "wrong_namespace",
    });
    const broken = utf8.encode(text.replace(/\n (\S)/, "\n X$1"));
    expect(await verifyCommitSignature(broken)).toMatchObject({ ok: false });
    const unsigned = utf8.encode(
      text.slice(0, text.indexOf("gpgsig")) + text.slice(text.indexOf("\n\n") + 1),
    );
    expect(await verifyCommitSignature(unsigned)).toEqual({ ok: false, reason: "unsigned" });
  });

  it("split signatures as git does: repeated headers, the other algorithm's header", async () => {
    const sandbox = await createGitSandbox();
    sandboxes.push(sandbox);
    const keyFile = join(sandbox.dir, "key");
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "", "-f", keyFile]);
    await sandbox.git(["init", "-q", "-b", "main"]);
    await sandbox.git([
      "-c",
      "gpg.format=ssh",
      "-c",
      `user.signingkey=${keyFile}.pub`,
      "commit",
      "-q",
      "-S",
      "--allow-empty",
      "-m",
      "x",
    ]);
    const allowed = join(sandbox.dir, "allowed_signers");
    writeFileSync(allowed, `* namespaces="git" ${readFileSync(`${keyFile}.pub`, "utf8")}`);
    const signed = new TextDecoder().decode(await sandbox.gitBytes(["cat-file", "commit", "HEAD"]));
    const at = signed.indexOf("gpgsig ");
    const variants = [
      // Another algorithm's signature header, before and after ours.
      `${signed.slice(0, at)}gpgsig-sha256 other\n more\n${signed.slice(at)}`,
      signed.replace("\n\nx\n", "\ngpgsig-sha256 other\n more\n\nx\n"),
      // A second signature header: git appends it to the signature.
      signed.replace("\n\nx\n", "\ngpgsig extra\n\nx\n"),
      // Leading junk before the armor.
      signed.replace("gpgsig -----BEGIN", "gpgsig junk\n -----BEGIN"),
      // Other `gpgsig*` headers, with and without a value.
      signed.replace("\n\nx\n", "\ngpgsig-extra opaque\n more\n\nx\n"),
      signed.replace("\n\nx\n", "\ngpgsig-sha256\n\nx\n"),
      // The footer without a line break before it.
      signed.replace(/\n -----END SSH SIGNATURE-----/, "-----END SSH SIGNATURE-----"),
      // Base64 without its padding.
      signed.replace(/=+\n -----END/, "\n -----END"),
      // Whitespace inside the base64, which OpenSSH skips.
      signed.replace(/\n (\S{10})(\S)/, "\n $1 \t$2"),
    ];
    for (const variant of variants) {
      const id = (
        await sandbox.git(["hash-object", "-t", "commit", "-w", "--stdin", "--literally"], {
          input: variant,
        })
      ).stdout.trim();
      const git = await sandbox
        .git([
          "-c",
          "gpg.format=ssh",
          "-c",
          `gpg.ssh.allowedSignersFile=${allowed}`,
          "verify-commit",
          id,
        ])
        .then(
          () => true,
          () => false,
        );
      const ours = (await verifyCommitSignature(utf8.encode(variant))).ok;
      expect([variant.slice(0, 120), ours]).toEqual([variant.slice(0, 120), git]);
    }
  });

  it("split exactly as git: signature headers joined, other gpgsig headers dropped", () => {
    const body = utf8.encode(
      [
        `tree ${EMPTY_TREE}`,
        "gpgsig A",
        " B",
        "gpgsig-extra junk",
        " more junk",
        "gpgsig C",
        "author A <a@b> 1 +0000",
        "",
        "gpgsig in the message",
        "",
      ].join("\n"),
    );
    const split = splitSignedCommit(body);
    expect(split.kind).toBe("signed");
    if (split.kind !== "signed") return;
    expect(new TextDecoder().decode(split.signature)).toBe("A\nB\nC\n");
    expect(new TextDecoder().decode(split.payload)).toBe(
      `tree ${EMPTY_TREE}\nauthor A <a@b> 1 +0000\n\ngpgsig in the message\n`,
    );
  });

  it("refuse armor with junk before it, a truncated or padded key, and an oversized signature", async () => {
    const key = await ed25519FromSeed(seed(5));
    const message = utf8.encode("m");
    const armored = new TextDecoder().decode(await sshCommitSigner(key).sign(message));
    expect(await verifySshSignature(message, utf8.encode(`junk\n${armored}`))).toMatchObject({
      ok: false,
      reason: "malformed_signature",
    });
    const sig = parseSshSignature(utf8.encode(armored));
    const withKey = (publicKey: Uint8Array) => armorSshSignature({ ...sig, publicKey });
    const truncated = sig.publicKey.subarray(0, 4 + "ssh-ed25519".length);
    const padded = Uint8Array.from([...sig.publicKey, 0]);
    for (const bad of [truncated, padded])
      expect(await verifySshSignature(message, withKey(bad))).toMatchObject({
        ok: false,
        reason: "malformed_signature",
      });
    const huge = utf8.encode(`tree ${EMPTY_TREE}\ngpgsig ${"A".repeat(70_000)}\n\nm\n`);
    expect(splitSignedCommit(huge)).toEqual({ kind: "oversized" });
  });

  it("round-trip any message and key", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uint8Array({ minLength: 32, maxLength: 32 }),
        fc.uint8Array({ maxLength: 512 }),
        async (keySeed, message) => {
          const key = await ed25519FromSeed(keySeed);
          const armored = await sshCommitSigner(key).sign(message);
          const parsed = parseSshSignature(armored);
          expect(parsed.namespace).toBe(GIT_NAMESPACE);
          const verified = await verifySshSignature(message, armored);
          expect(verified).toMatchObject({
            ok: true,
            fingerprint: await sshFingerprint(ed25519PublicKeyBlob(key.publicKey)),
          });
        },
      ),
      { numRuns: 50 },
    );
  });

  it("parse public key lines and refuse mismatched ones", () => {
    const blob = ed25519PublicKeyBlob(new Uint8Array(32));
    const line = `ssh-ed25519 ${Buffer.from(blob).toString("base64")} me@host`;
    expect(parseSshPublicKey(line)).toEqual({ keyType: "ssh-ed25519", blob });
    expect(() => parseSshPublicKey(line.replace("ssh-ed25519", "ssh-rsa"))).toThrow();
    expect(() => parseSshPublicKey("nonsense")).toThrow();
  });
});
