// Ported from git.git t/t5543-atomic-push.sh (v2.53.0): `git push --atomic`.
import { expect } from "vitest";
import { expectSameRefs, onBoth, porcelain, pushBoth, seeded } from "./support.ts";
import type { CaseFile } from "./types.ts";

const from = "t5543-atomic-push.sh";

export const t5543: CaseFile = {
  cases: [
    {
      from,
      test: "atomic push works for a single branch",
      fast: true,
      async run(t) {
        const remotes = await t.remotes("atomic-one");
        const work = await t.work("atomic-one-work");
        await pushBoth(t, work, remotes, ["main"], ["--atomic"]);
        await expectSameRefs(t, remotes);
      },
    },
    {
      from,
      test: "atomic push works for two branches",
      async run(t) {
        const remotes = await t.remotes("atomic-two");
        const work = await t.work("atomic-two-work");
        await t.ok(["branch", "second"], work);
        await pushBoth(t, work, remotes, ["main", "second"], ["--atomic"]);
        await expectSameRefs(t, remotes);
      },
    },
    {
      from,
      test: "atomic push works in combination with --mirror",
      async run(t) {
        const { work, remotes } = await seeded(t, "atomic-mirror");
        await t.ok(["branch", "-D", "feature"], work);
        await t.ok(["branch", "mirrored"], work);
        await pushBoth(t, work, remotes, [], ["--atomic", "--mirror"]);
        await expectSameRefs(t, remotes);
      },
    },
    {
      from,
      test: "atomic push works in combination with --force",
      async run(t) {
        const { work, remotes } = await seeded(t, "atomic-force");
        await t.ok(["reset", "-q", "--hard", "main~1"], work);
        await t.commit(work, { "r.txt": "r\n" }, "rewritten");
        await pushBoth(t, work, remotes, ["main", "feature"], ["--atomic", "--force"]);
        await expectSameRefs(t, remotes);
      },
    },
    {
      from,
      test: "atomic push fails if one branch fails",
      fast: true,
      async run(t) {
        const { work, remotes } = await seeded(t, "atomic-fail");
        await t.commit(work, { "ok.txt": "ok\n" }, "fast-forward");
        await t.ok(["checkout", "-q", "feature"], work);
        await t.ok(["reset", "-q", "--hard", "feature~1"], work);
        await t.commit(work, { "nff.txt": "nff\n" }, "non-fast-forward");
        const { fyrden, oracle } = await onBoth(
          t,
          remotes,
          (url) => ["push", "--atomic", url, "main", "feature"],
          () => work,
        );
        expect(oracle.code).not.toBe(0);
        expect(fyrden.code).not.toBe(0);
        await expectSameRefs(t, remotes);
      },
    },
    {
      from,
      test: "atomic push fails if one tag fails remotely",
      async run(t) {
        const { work, remotes } = await seeded(t, "atomic-tag");
        await t.ok(["tag", "clash", "feature"], work);
        await pushBoth(t, work, remotes, ["clash"]);
        await t.ok(["tag", "-f", "clash", "main"], work);
        await t.commit(work, { "t.txt": "t\n" }, "three");
        const { fyrden, oracle } = await onBoth(
          t,
          remotes,
          (url) => ["push", "--tags", "--atomic", url, "main"],
          () => work,
        );
        expect(oracle.code).not.toBe(0);
        expect(fyrden.code).not.toBe(0);
        await expectSameRefs(t, remotes);
      },
    },
    {
      from,
      test: "atomic push reports (reject by non-ff)",
      async run(t) {
        const { work, remotes } = await seeded(t, "atomic-report");
        await t.ok(["branch", "-f", "extra", "main"], work);
        await t.ok(["reset", "-q", "--hard", "main~1"], work);
        await t.commit(work, { "nff.txt": "nff\n" }, "non-fast-forward");
        const { fyrden, oracle } = await onBoth(
          t,
          remotes,
          (url) => ["push", "--porcelain", "--atomic", url, "main", "extra:refs/heads/extra"],
          () => work,
        );
        expect(fyrden.code).not.toBe(0);
        expect(porcelain(fyrden.stdout)).toEqual(porcelain(oracle.stdout));
      },
    },
    {
      from,
      test: "atomic push reports exit code failure",
      async run(t) {
        const { work, remotes } = await seeded(t, "atomic-exit");
        await t.commit(work, { "ok.txt": "ok\n" }, "fast-forward");
        // A ref the server refuses (hidden), next to one it would accept.
        const res = await t.git(
          ["push", "--atomic", remotes.fyrden, "main", "HEAD:refs/pull/1/head"],
          { cwd: work },
        );
        expect(res.code).toBe(1);
        expect(res.stderr).toMatch(/atomic push failure/);
        expect(res.stderr).toMatch(/\[remote rejected\]\s+main -> main \(atomic push failure\)/);
        await expectSameRefs(t, remotes);
      },
    },
  ],
  notPorted: [
    {
      from,
      tests: [
        "atomic push obeys update hook preventing a branch to be pushed",
        "atomic push is not advertised if configured",
        "atomic push reports (reject by update hook)",
        "atomic push reports (mirror, but reject by update hook)",
        "atomic push reports exit code failure with porcelain",
      ],
      reason:
        "need server-side hooks or receive.advertiseAtomic=false; the refusal path is covered with a hidden ref instead",
    },
  ],
};
