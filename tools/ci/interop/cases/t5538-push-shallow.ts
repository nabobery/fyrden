// Ported from git.git t/t5538-push-shallow.sh (v2.53.0): pushes from a
// shallow clone, which send shallow lines with the commands.
import { expect } from "vitest";
import { expectSameRefs, onBoth, seeded } from "./support.ts";
import type { CaseFile } from "./types.ts";

const from = "t5538-push-shallow.sh";

export const t5538: CaseFile = {
  cases: [
    {
      from,
      test: "push from shallow clone",
      fast: true,
      async run(t) {
        const { remotes } = await seeded(t, "push-shallow");
        await t.ok(["clone", "-q", "--depth", "2", remotes.fyrden, "push-shallow-clone"]);
        const tip = await t.commit("push-shallow-clone", { "five.txt": "5\n" }, "5");
        // git's own receive-pack accepts this: the server has the full history.
        await t.ok(
          ["push", "-q", remotes.oracle, "+main:refs/remotes/shallow/main"],
          "push-shallow-clone",
        );
        const res = await t.git(["push", "origin", "+main:refs/remotes/shallow/main"], {
          cwd: "push-shallow-clone",
        });
        expect(res.code, res.stderr).toBe(0);
        expect((await t.lsRemote(remotes.fyrden))["refs/remotes/shallow/main"]).toBe(tip);
      },
    },
    {
      from,
      test: "push from shallow clone, with grafted roots",
      async run(t) {
        const { remotes } = await seeded(t, "push-grafted");
        const other = await t.remotes("push-grafted-other");
        const source = await t.work("push-grafted-source");
        await t.commit(source, { "a.txt": "a\n" }, "a");
        await t.commit(source, { "b.txt": "b\n" }, "b");
        await t.ok(["push", "-q", other.fyrden, "main"], source);
        await t.ok(["clone", "-q", "--depth", "2", other.fyrden, "grafted"]);
        const { fyrden, oracle } = await onBoth(
          t,
          remotes,
          (url) => ["push", url, "+main:refs/remotes/grafted/main"],
          () => "grafted",
        );
        expect(oracle.code).not.toBe(0);
        expect(fyrden.code).not.toBe(0);
        await expectSameRefs(t, remotes);
      },
    },
  ],
  notPorted: [
    {
      from,
      tests: [
        "setup",
        "add new shallow root with receive.updateshallow on",
        "push from shallow to shallow",
        "push from full to shallow",
        "push new commit from shallow clone has correct object count",
        "push new commit from shallow clone has good deltas",
      ],
      reason:
        "need receive.shallowUpdate or a shallow server repository; Fyrden never stores shallow history",
    },
  ],
};
