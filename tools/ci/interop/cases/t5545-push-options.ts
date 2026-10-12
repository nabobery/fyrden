// Ported from git.git t/t5545-push-options.sh (v2.53.0): `git push -o`.
// Fyrden accepts push options and keeps them with the push event; it has no
// hooks, so the cases check that the push is accepted, not what a hook saw.
import { expect } from "vitest";
import { expectSameRefs, pushBoth } from "./support.ts";
import type { CaseFile } from "./types.ts";

const from = "t5545-push-options.sh";

export const t5545: CaseFile = {
  cases: [
    {
      from,
      test: "push options work properly across http",
      fast: true,
      async run(t) {
        const remotes = await t.remotes("options");
        const work = await t.work("options-work");
        await pushBoth(t, work, remotes, ["main"], ["--push-option=asdf"]);
        await expectSameRefs(t, remotes);
      },
    },
    {
      from,
      test: "two push options work",
      async run(t) {
        const remotes = await t.remotes("options-two");
        const work = await t.work("options-two-work");
        await pushBoth(
          t,
          work,
          remotes,
          ["main"],
          ["--push-option=asdf", "--push-option=more structured text"],
        );
        await expectSameRefs(t, remotes);
      },
    },
    {
      from,
      test: "push options keep quoted characters intact (http)",
      async run(t) {
        const remotes = await t.remotes("options-quoted");
        const work = await t.work("options-quoted-work");
        await pushBoth(t, work, remotes, ["main"], ['--push-option="embedded quotes"']);
        await expectSameRefs(t, remotes);
      },
    },
    {
      from,
      test: "default push option",
      async run(t) {
        const remotes = await t.remotes("options-default");
        const work = await t.work("options-default-work");
        const res = await t.git(["-c", "push.pushOption=default", "push", remotes.fyrden, "main"], {
          cwd: work,
        });
        expect(res.code, res.stderr).toBe(0);
      },
    },
  ],
  notPorted: [
    {
      from,
      tests: [
        "one push option works for a single branch",
        "push option denied by remote",
        "push options and submodules",
        "two default push options",
        "push option from command line overrides from-config push option",
        "empty value of push.pushOption in config clears the list",
        "invalid push option in config",
        "push options keep quoted characters intact (direct)",
        "push option denied properly by http server",
      ],
      reason:
        "check what a server-side hook received, need a server that does not advertise push options, or exercise client config handling (same request as a ported case)",
    },
  ],
};
