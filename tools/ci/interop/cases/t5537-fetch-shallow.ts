// Ported from git.git t/t5537-fetch-shallow.sh (v2.53.0): fetches into
// shallow repositories, where the client's shallow lines shape the pack.
import { expect } from "vitest";
import { cloneBoth, expectSameRepository, pushBoth, seeded } from "./support.ts";
import type { CaseFile } from "./types.ts";

const from = "t5537-fetch-shallow.sh";

export const t5537: CaseFile = {
  cases: [
    {
      from,
      test: "fetch --depth from shallow clone",
      async run(t) {
        const { work, remotes } = await seeded(t, "fs-depth");
        const dirs = await cloneBoth(t, remotes, "fs-depth", ["--depth", "2"]);
        await t.commit(work, { "n.txt": "n\n" }, "five");
        await pushBoth(t, work, remotes, ["main"]);
        await t.ok(["fetch", "-q", "--depth", "2"], dirs.fyrden);
        await t.ok(["fetch", "-q", "--depth", "2"], dirs.oracle);
        await expectSameRepository(t, dirs);
      },
    },
    {
      from,
      test: "fetch something upstream has but hidden by clients shallow boundaries",
      fast: true,
      async run(t) {
        const { work, remotes } = await seeded(t, "fs-hidden");
        const dirs = await cloneBoth(t, remotes, "fs-hidden", [
          "--depth",
          "1",
          "--no-single-branch",
        ]);
        // A new branch from main~2, below the client's shallow boundary.
        await t.ok(["checkout", "-q", "-b", "old", "main~2"], work);
        await t.commit(work, { "old.txt": "old\n" }, "old");
        await pushBoth(t, work, remotes, ["old"]);
        await t.ok(
          ["fetch", "-q", "--depth", "1", "origin", "old:refs/remotes/origin/old"],
          dirs.fyrden,
        );
        await t.ok(
          ["fetch", "-q", "--depth", "1", "origin", "old:refs/remotes/origin/old"],
          dirs.oracle,
        );
        await expectSameRepository(t, dirs);
        expect(await t.shallow(dirs.fyrden)).toHaveLength((await t.shallow(dirs.oracle)).length);
      },
    },
    {
      from,
      test: "fetch that requires changes in .git/shallow is filtered",
      async run(t) {
        const { work, remotes } = await seeded(t, "fs-filtered");
        const dirs = await cloneBoth(t, remotes, "fs-filtered", ["--depth", "1"]);
        await t.ok(["checkout", "-q", "--orphan", "orphan"], work);
        await t.commit(work, { "orphan.txt": "orphan\n" }, "orphan");
        await pushBoth(t, work, remotes, ["orphan"]);
        await t.ok(["fetch", "-q", "origin", "orphan:refs/remotes/origin/orphan"], dirs.fyrden);
        await t.ok(["fetch", "-q", "origin", "orphan:refs/remotes/origin/orphan"], dirs.oracle);
        await expectSameRepository(t, dirs);
      },
    },
  ],
  notPorted: [
    {
      from,
      tests: ["setup", "setup shallow clone"],
      reason: "fixture setup; each ported case builds its own history",
    },
    {
      from,
      tests: [
        "clone from shallow clone",
        "fetch from shallow clone",
        "fetch --unshallow from shallow clone",
        "fetch --update-shallow",
        "fetch --update-shallow into a repo with submodules",
        "fetch --update-shallow a commit that is also a shallow point into a repo with submodules",
        "fetch --update-shallow (with fetch.writeCommitGraph)",
        "shallow fetch from a read-only repo",
      ],
      reason:
        "the server is itself a shallow repository; Fyrden repositories are never shallow (shallow pushes are refused)",
    },
    {
      from,
      tests: [
        "fetch --unshallow from a full clone",
        ".git/shallow is edited by repack",
        "shallow fetches check connectivity before writing shallow file",
      ],
      reason: "client-side checks and local repository maintenance",
    },
  ],
};
