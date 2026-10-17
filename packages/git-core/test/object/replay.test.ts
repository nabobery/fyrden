import { describe, expect, it } from "vitest";
import { parseCommit } from "../../src/object/commit.js";
import { oidFromHex } from "../../src/object/oid.js";
import { replayCommit } from "../../src/object/replay.js";
import { splitSignedCommit, verifyCommitSignature } from "../../src/sign/commit-signature.js";
import { ed25519FromSeed, sshCommitSigner } from "../../src/sign/sshsig.js";

const utf8 = new TextEncoder();
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const OLD_PARENT = "1".repeat(40);
const NEW_PARENT = "2".repeat(40);
const NEW_TREE = "3".repeat(40);

const committer = {
  name: utf8.encode("Fyrden"),
  email: utf8.encode("noreply@fyrden.test"),
  timestamp: 1_800_000_000,
  timezone: "+0000",
};
const replay = { tree: oidFromHex(NEW_TREE), parent: oidFromHex(NEW_PARENT), committer };

const original = (headers: string, message = "\nSubject\n\nBody line\n") =>
  utf8.encode(`tree ${TREE}\nparent ${OLD_PARENT}\n${headers.replace(/^\n/, "")}${message}`);

describe("replayCommit", () => {
  it("keeps the author line, encoding header and message byte for byte, and drops other headers", async () => {
    // Spacing git accepts but would not write, and a timestamp no JS number holds exactly.
    const author = "author A  Person   <a@example.com>   9007199254740993 -0130\n";
    const body = original(
      `${author}committer C <c@example.com> 1700000000 +0000\n` +
        "encoding ISO-8859-1\n" +
        "gpgsig -----BEGIN SSH SIGNATURE-----\n abc\n -----END SSH SIGNATURE-----\n" +
        "x-unknown value\n continued\n",
    );
    parseCommit(body);
    const made = await replayCommit(body, replay);
    expect(text(made)).toBe(
      `tree ${NEW_TREE}\nparent ${NEW_PARENT}\n${author}` +
        "committer Fyrden <noreply@fyrden.test> 1800000000 +0000\n" +
        "encoding ISO-8859-1\n\nSubject\n\nBody line\n",
    );
    expect(parseCommit(made).value.parents).toHaveLength(1);
  });

  it("keeps an encoding header's continuation lines and a message without a final newline", async () => {
    const body = original(
      "author A <a@example.com> 1 +0000\ncommitter A <a@example.com> 1 +0000\n" +
        "encoding one\n two\n",
      "\nno newline",
    );
    const made = text(await replayCommit(body, replay));
    expect(made).toContain("encoding one\n two\n\nno newline");
    expect(made.endsWith("\nno newline")).toBe(true);
  });

  it("keeps a commit with no message as it is: no blank line added", async () => {
    const body = original(
      "author A <a@example.com> 1 +0000\ncommitter A <a@example.com> 1 +0000\n",
      "",
    );
    const made = text(await replayCommit(body, replay));
    expect(made.endsWith("committer Fyrden <noreply@fyrden.test> 1800000000 +0000\n")).toBe(true);
  });

  it("signs the replayed commit over its unsigned bytes, the same way each time", async () => {
    const signer = sshCommitSigner(await ed25519FromSeed(new Uint8Array(32).fill(7)));
    const body = original(
      "author A <a@example.com> 1 +0000\ncommitter A <a@example.com> 1 +0000\n",
    );
    const unsigned = await replayCommit(body, replay);
    const signed = await replayCommit(body, { ...replay, signer });
    const split = splitSignedCommit(signed);
    expect(split.kind).toBe("signed");
    if (split.kind === "signed") expect(text(split.payload)).toBe(text(unsigned));
    expect((await verifyCommitSignature(signed)).ok).toBe(true);
    expect(text(await replayCommit(body, { ...replay, signer }))).toBe(text(signed));
    expect(signer.keyId).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  it("refuses a body that is not a commit", async () => {
    await expect(replayCommit(utf8.encode("not a commit\n"), replay)).rejects.toThrow();
  });
});
