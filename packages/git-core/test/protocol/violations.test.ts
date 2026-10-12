import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGitSandbox, type GitSandbox } from "../../testing/git-cli.js";
import { CORPUS, caseBytes } from "./corpus.js";
import { bin, pkt, protocolError } from "./helpers.js";
import { runTarget } from "./targets.js";

/*
 * The protocol-violation corpus: inputs every parser must refuse with a
 * typed error, from a buffer and from a stream cut anywhere. Where git
 * refuses the same input, git is run on it too, so the corpus cannot drift
 * into rejecting what git accepts without a note saying so.
 */

describe("protocol-violation corpus", () => {
  it("has cases for every kind of violation the plan names", () => {
    const codes = new Set(CORPUS.map((c) => c.code));
    for (const code of [
      "invalid-length",
      "line-too-long",
      "truncated",
      "bad-capability",
      "too-many-wants",
    ] as const) {
      expect(codes).toContain(code);
    }
    expect(new Set(CORPUS.map((c) => c.name)).size).toBe(CORPUS.length);
  });

  it.each(CORPUS.map((c) => [c.name, c] as const))("refuses %s", async (_name, c) => {
    const bytes = caseBytes(c);
    expect((await protocolError(() => runTarget(c.target, bytes, c.limits))).code).toBe(c.code);
    // The same verdict from a stream, whether bytes arrive one at a time or in uneven chunks.
    const cuts =
      bytes.length <= 4096
        ? Array.from({ length: bytes.length }, (_, i) => i)
        : [1, 3, 4, 5, 4099, bytes.length >> 1];
    expect((await protocolError(() => runTarget(c.target, bytes, c.limits, cuts))).code).toBe(
      c.code,
    );
  });
});

describe("git refuses the corpus inputs marked for it", () => {
  let sandbox: GitSandbox;
  beforeAll(async () => {
    sandbox = await createGitSandbox();
    await sandbox.git(["init", "-q", "--bare", "repo.git"]);
  });
  afterAll(() => sandbox.dispose());

  const service = (name: "upload-pack" | "receive-pack", input: Uint8Array) =>
    sandbox.gitBytes([name, "--stateless-rpc", "repo.git"], {
      input,
      env: { GIT_PROTOCOL: "version=2" },
    });

  it("accepts well-formed requests (the control)", async () => {
    const ls = bin(
      `${pkt("command=ls-refs\n")}${pkt("object-format=sha1")}0001${pkt("peel\n")}0000`,
    );
    expect(Buffer.from(await service("upload-pack", ls)).toString("latin1")).toBe("0000");
    const del = bin(
      `${pkt(`${"1".repeat(40)} ${"0".repeat(40)} refs/heads/gone\0 report-status`)}0000`,
    );
    expect(Buffer.from(await service("receive-pack", del)).toString("latin1")).toContain(
      "ok refs/heads/gone",
    );
  });

  const marked = CORPUS.filter((c) => c.git !== undefined);
  it.each(marked.map((c) => [c.name, c] as const))("git %s too", async (_name, c) => {
    await expect(service(c.git as "upload-pack", caseBytes(c))).rejects.toThrow(/failed/);
  });
});
