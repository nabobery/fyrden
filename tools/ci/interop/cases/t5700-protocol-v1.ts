// Ported from git.git t/t5700-protocol-v1.sh (v2.53.0), http:// cases.
// Fyrden's receive-pack speaks v0 and v1; its upload-pack speaks v2 only.
import { expect } from "vitest";
import { expectSameRefs, onBoth, seeded } from "./support.ts";
import type { CaseFile } from "./types.ts";

const from = "t5700-protocol-v1.sh";

export const t5700: CaseFile = {
  cases: [
    {
      from,
      test: "push with http:// using protocol v1",
      fast: true,
      async run(t) {
        const { work, remotes } = await seeded(t, "v1-push");
        await t.commit(work, { "v1.txt": "v1\n" }, "v1");
        const { fyrden, oracle } = await onBoth(
          t,
          remotes,
          (url) => ["-c", "protocol.version=1", "push", url, "main"],
          () => work,
        );
        expect(oracle.code, oracle.stderr).toBe(0);
        expect(fyrden.code, fyrden.stderr).toBe(0);
        await expectSameRefs(t, remotes);
      },
    },
    {
      from,
      test: "clone with http:// using protocol v1",
      note: "refused: upload-pack is v2 only, and the message says so",
      async run(t) {
        const { remotes } = await seeded(t, "v1-clone");
        const res = await t.git(["-c", "protocol.version=1", "clone", remotes.fyrden, "v1-clone"]);
        expect(res.code).not.toBe(0);
        expect(res.stderr).toMatch(/protocol version 2/);
      },
    },
  ],
  notPorted: [
    {
      from,
      tests: [
        "create repo to be served by git-daemon",
        "clone with git:// using protocol v1",
        "fetch with git:// using protocol v1",
        "pull with git:// using protocol v1",
        "push with git:// using protocol v1",
        "create repo to be served by file:// transport",
        "clone with file:// using protocol v1",
        "fetch with file:// using protocol v1",
        "pull with file:// using protocol v1",
        "push with file:// using protocol v1",
        "setup ssh wrapper",
        "create repo to be served by ssh:// transport",
        "clone with ssh:// using protocol v1",
        "fetch with ssh:// using protocol v1",
        "pull with ssh:// using protocol v1",
        "push with ssh:// using protocol v1",
        "create repos to be served by http:// transport",
        "cloning branchless tagless but not refless remote",
      ],
      reason: "git://, file:// and ssh:// transports; Fyrden serves smart HTTP only",
    },
    {
      from,
      tests: [
        "fetch with http:// using protocol v1",
        "pull with http:// using protocol v1",
        "clone propagates object-format from empty repo",
        "clone with http:// using protocol v1 with empty SHA-256 repo",
      ],
      reason:
        "v1 upload-pack is not offered (the refusal is the clone case); SHA-256 repositories are not offered",
    },
  ],
};
