// Ported from git.git t/t5516-fetch-push.sh (v2.53.0): pushes and fetches
// over smart HTTP, compared with git's own receive-pack and upload-pack.
import { expect } from "vitest";
import {
  cloneBoth,
  expectSameRefs,
  expectSameRepository,
  onBoth,
  porcelain,
  pushBoth,
  seeded,
} from "./support.ts";
import type { CaseFile } from "./types.ts";

const from = "t5516-fetch-push.sh";

export const t5516: CaseFile = {
  cases: [
    {
      from,
      test: "push without wildcard",
      fast: true,
      async run(t) {
        const remotes = await t.remotes("plain");
        const work = await t.work("plain-work");
        await pushBoth(t, work, remotes, ["refs/heads/main:refs/remotes/origin/main"]);
        await expectSameRefs(t, remotes);
      },
    },
    {
      from,
      test: "push with wildcard",
      async run(t) {
        const remotes = await t.remotes("wild");
        const work = await t.work("wild-work");
        await t.ok(["branch", "one"], work);
        await t.ok(["branch", "two"], work);
        await pushBoth(t, work, remotes, ["refs/heads/*:refs/remotes/origin/*"]);
        await expectSameRefs(t, remotes);
      },
    },
    {
      from,
      test: "failed (non-fast-forward) push with matching heads",
      fast: true,
      async run(t) {
        const { work, remotes } = await seeded(t, "non-ff");
        await t.ok(["reset", "-q", "--hard", "main~1"], work);
        await t.commit(work, { "other.txt": "other\n" }, "diverged");
        const { fyrden, oracle } = await onBoth(
          t,
          remotes,
          (url) => ["push", url, "main"],
          () => work,
        );
        expect(oracle.code).not.toBe(0);
        expect(fyrden.code).not.toBe(0);
        expect(fyrden.stderr).toMatch(/\[rejected\]\s+main -> main \(non-fast-forward\)/);
        await expectSameRefs(t, remotes);
      },
    },
    {
      from,
      test: "push --force with matching heads",
      async run(t) {
        const { work, remotes } = await seeded(t, "force");
        await t.ok(["reset", "-q", "--hard", "main~1"], work);
        await t.commit(work, { "other.txt": "other\n" }, "diverged");
        await pushBoth(t, work, remotes, ["main"], ["--force"]);
        await expectSameRefs(t, remotes);
      },
    },
    {
      from,
      test: "push with dry-run",
      async run(t) {
        const { work, remotes } = await seeded(t, "dry-run");
        const before = await t.lsRemote(remotes.fyrden);
        await t.commit(work, { "dry.txt": "dry\n" }, "dry");
        await t.ok(["push", "--dry-run", remotes.fyrden, "main"], work);
        expect(await t.lsRemote(remotes.fyrden)).toEqual(before);
      },
    },
    {
      from,
      test: "push updates local refs",
      fast: true,
      async run(t) {
        const { remotes } = await seeded(t, "local-refs");
        const dirs = await cloneBoth(t, remotes, "local-refs");
        await t.commit(dirs.fyrden, { "next.txt": "next\n" }, "next");
        await t.ok(["push", "-q", "origin", "main"], dirs.fyrden);
        expect((await t.ok(["rev-parse", "origin/main"], dirs.fyrden)).trim()).toBe(
          (await t.ok(["rev-parse", "main"], dirs.fyrden)).trim(),
        );
      },
    },
    {
      from,
      test: "push does not update local refs on failure",
      note: "the failure is Fyrden refusing a pull request ref, where git's test uses a hook",
      async run(t) {
        const { remotes } = await seeded(t, "no-local-update");
        const dirs = await cloneBoth(t, remotes, "no-local-update");
        const before = (await t.ok(["rev-parse", "origin/main"], dirs.fyrden)).trim();
        await t.commit(dirs.fyrden, { "next.txt": "next\n" }, "next");
        const res = await t.git(["push", "--atomic", "origin", "main", "HEAD:refs/pull/1/head"], {
          cwd: dirs.fyrden,
        });
        expect(res.code).not.toBe(0);
        expect((await t.ok(["rev-parse", "origin/main"], dirs.fyrden)).trim()).toBe(before);
      },
    },
    {
      from,
      test: "allow deleting a ref using --delete",
      fast: true,
      async run(t) {
        const { work, remotes } = await seeded(t, "delete-ref");
        await pushBoth(t, work, remotes, ["feature"], ["--delete"]);
        await expectSameRefs(t, remotes);
        expect(Object.keys(await t.lsRemote(remotes.fyrden))).not.toContain("refs/heads/feature");
      },
    },
    {
      from,
      test: "allow deleting a tag using --delete",
      async run(t) {
        const { work, remotes } = await seeded(t, "delete-tag");
        await pushBoth(t, work, remotes, ["tag", "v1"], ["--delete"]);
        await expectSameRefs(t, remotes);
      },
    },
    {
      from,
      test: "push --porcelain",
      fast: true,
      async run(t) {
        const remotes = await t.remotes("porcelain");
        const work = await t.work("porcelain-work");
        const { fyrden, oracle } = await onBoth(
          t,
          remotes,
          (url) => ["push", "--porcelain", url, "main:refs/remotes/origin/main"],
          () => work,
        );
        expect(fyrden.code, fyrden.stderr).toBe(0);
        expect(porcelain(fyrden.stdout)).toEqual(porcelain(oracle.stdout));
      },
    },
    {
      from,
      test: "push --porcelain rejected",
      async run(t) {
        const { work, remotes } = await seeded(t, "porcelain-rejected");
        await t.ok(["reset", "-q", "--hard", "main~1"], work);
        await t.commit(work, { "other.txt": "other\n" }, "diverged");
        const { fyrden, oracle } = await onBoth(
          t,
          remotes,
          (url) => ["push", "--porcelain", url, "main"],
          () => work,
        );
        expect(fyrden.code).not.toBe(0);
        expect(porcelain(fyrden.stdout)).toEqual(porcelain(oracle.stdout));
      },
    },
    {
      from,
      test: "push --prune",
      async run(t) {
        const { work, remotes } = await seeded(t, "prune");
        await t.ok(["branch", "-D", "feature"], work);
        await pushBoth(t, work, remotes, ["refs/heads/*:refs/heads/*"], ["--prune"]);
        await expectSameRefs(t, remotes);
      },
    },
    {
      from,
      test: "fetch exact oid in protocol v2",
      async run(t) {
        const { work, remotes } = await seeded(t, "exact-oid");
        const oid = (await t.ok(["rev-parse", "feature"], work)).trim();
        await t.ok(["init", "-q", "exact-oid-client"]);
        await t.ok(
          ["fetch", "-q", remotes.fyrden, `${oid}:refs/heads/copy`, "main:refs/heads/extra"],
          "exact-oid-client",
        );
        expect((await t.ok(["rev-parse", "copy"], "exact-oid-client")).trim()).toBe(oid);
        await t.fsck("exact-oid-client");
      },
    },
    {
      from,
      test: "fetch follows tags by default",
      fast: true,
      async run(t) {
        const { remotes } = await seeded(t, "follow-tags");
        for (const dir of ["follow-tags", "follow-tags-oracle"]) await t.ok(["init", "-q", dir]);
        await onBoth(
          t,
          remotes,
          (url) => ["fetch", "-q", url, "main:refs/remotes/origin/main"],
          (side) => (side === "fyrden" ? "follow-tags" : "follow-tags-oracle"),
        );
        await expectSameRepository(t, { fyrden: "follow-tags", oracle: "follow-tags-oracle" });
        expect(Object.keys(await t.refs("follow-tags"))).toContain("refs/tags/v1");
      },
    },
    {
      from,
      test: "push --follow-tags only pushes relevant tags",
      async run(t) {
        const remotes = await t.remotes("push-follow");
        const work = await t.work("push-follow-work");
        await t.ok(["tag", "-a", "-m", "on main", "reachable"], work);
        await t.ok(["checkout", "-q", "-b", "side"], work);
        await t.commit(work, { "side.txt": "side\n" }, "side");
        await t.ok(["tag", "-a", "-m", "on side", "unreachable"], work);
        await t.ok(["checkout", "-q", "main"], work);
        await pushBoth(t, work, remotes, ["main"], ["--follow-tags"]);
        await expectSameRefs(t, remotes);
        expect(Object.keys(await t.lsRemote(remotes.fyrden))).not.toContain(
          "refs/tags/unreachable",
        );
      },
    },
    {
      from,
      test: "push --no-thin must produce non-thin pack",
      async run(t) {
        const { work, remotes } = await seeded(t, "no-thin");
        await t.commit(work, { "big.txt": `${"x".repeat(50_000)}y\n` }, "delta against big");
        await pushBoth(t, work, remotes, ["main"], ["--no-thin"]);
        await t.commit(work, { "big.txt": `${"x".repeat(50_000)}z\n` }, "thin delta");
        await pushBoth(t, work, remotes, ["main"], ["--thin"]);
        await expectSameRefs(t, remotes);
        await t.ok(["clone", "-q", remotes.fyrden, "no-thin-clone"]);
        await t.fsck("no-thin-clone");
      },
    },
    {
      from,
      test: "pushing a tag pushes the tagged object",
      async run(t) {
        const remotes = await t.remotes("tag-blob");
        const work = await t.work("tag-blob-work");
        const blob = (
          await t.git(["hash-object", "-w", "--stdin"], { cwd: work, input: "tagged blob\n" })
        ).stdout.trim();
        await t.ok(["tag", "-m", "a blob", "blob-tag", blob], work);
        await pushBoth(t, work, remotes, ["main", "blob-tag"]);
        await expectSameRefs(t, remotes);
        await t.ok(["init", "-q", "tag-blob-client"]);
        await t.ok(
          ["fetch", "-q", remotes.fyrden, "refs/tags/blob-tag:refs/tags/blob-tag"],
          "tag-blob-client",
        );
        expect((await t.git(["cat-file", "blob", blob], { cwd: "tag-blob-client" })).stdout).toBe(
          "tagged blob\n",
        );
      },
    },
    {
      from,
      test: "refuse to push a hidden ref, and make sure do not pollute the repository",
      fast: true,
      note: "refs/pull/ is hidden on Fyrden; the oracle hides it with receive.hideRefs",
      async run(t) {
        const { work, remotes } = await seeded(t, "hidden");
        const { fyrden, oracle } = await onBoth(
          t,
          remotes,
          (url) => ["push", url, "HEAD:refs/pull/1/head"],
          () => work,
        );
        expect(oracle.code).not.toBe(0);
        expect(fyrden.code).not.toBe(0);
        expect(fyrden.stderr).toMatch(/deny updating a hidden ref/);
        await expectSameRefs(t, remotes);
      },
    },
    {
      from,
      test: "push with F/D conflict with deletion and creation",
      async run(t) {
        const remotes = await t.remotes("fd");
        const work = await t.work("fd-work");
        await t.ok(["branch", "branch"], work);
        await pushBoth(t, work, remotes, ["main", "branch"]);
        await t.ok(["branch", "-D", "branch"], work);
        await t.ok(["branch", "branch/conflict"], work);
        const { fyrden, oracle } = await onBoth(
          t,
          remotes,
          (url) => ["push", url, ":refs/heads/branch", "refs/heads/branch/conflict"],
          () => work,
        );
        expect(oracle.code, oracle.stderr).toBe(0);
        expect(fyrden.code, fyrden.stderr).toBe(0);
        await expectSameRefs(t, remotes);
      },
    },
    {
      from,
      test: "push with negotiation proceeds anyway even if negotiation fails",
      minGit: "2.29.0",
      note: "Fyrden does not offer wait-for-done, so negotiation always fails over to a plain push",
      async run(t) {
        const { work, remotes } = await seeded(t, "negotiate");
        await t.commit(work, { "n.txt": "n\n" }, "negotiated");
        const res = await t.git(["-c", "push.negotiate=1", "push", remotes.fyrden, "main"], {
          cwd: work,
        });
        expect(res.code, res.stderr).toBe(0);
        expect((await t.lsRemote(remotes.fyrden))["refs/heads/main"]).toBe(
          (await t.ok(["rev-parse", "main"], work)).trim(),
        );
      },
    },
  ],
  notPorted: [
    {
      from,
      tests: [
        "fetch without wildcard",
        "fetch with wildcard",
        "fetch with insteadOf",
        "fetch with pushInsteadOf (should not rewrite)",
        "push with insteadOf",
        "push with pushInsteadOf",
        "push with pushInsteadOf and explicit pushurl (pushInsteadOf should not rewrite)",
        "push with matching heads",
        "push with matching heads on the command line",
        "push with matching heads and forced update",
        "push with no ambiguity (1)",
        "push with no ambiguity (2)",
        "push with colon-less refspec, no ambiguity",
        "push with weak ambiguity (1)",
        "push with weak ambiguity (2)",
        "push with ambiguity",
        "push with onelevel ref",
        "push with colon-less refspec (1)",
        "push with colon-less refspec (2)",
        "push with colon-less refspec (3)",
        "push with colon-less refspec (4)",
        "push head with non-existent, incomplete dest",
        "push tag with non-existent, incomplete dest",
        "push oid with non-existent, incomplete dest",
        "push ref expression with non-existent, incomplete dest",
        "push ref expression with non-existent oid src",
        "push to remote with no explicit refspec and config remote.*.push = src:dest",
        "push with remote.pushdefault",
        "push with config remote.*.pushurl",
        "push with config branch.*.pushremote",
        "branch.*.pushremote config order is irrelevant",
        "push rejects empty branch name entries",
        'push ignores "branch." config without subsection',
        "push updates up-to-date local refs",
        "push preserves up-to-date packed refs",
        "push --delete without args aborts",
        "push --delete refuses src:dest refspecs",
        "push --delete refuses empty string",
        "push --delete onelevel refspecs",
        "push --porcelain bad url",
        "push --porcelain --dry-run rejected",
        "push --prune refspec",
        "pushing a specific ref applies remote.$name.push as refmap",
        "with no remote.$name.push, it is not used as refmap",
        "with no remote.$name.push, upstream mapping is used",
        "push does not follow tags by default",
        "fetch with branches",
        "fetch with branches containing #",
        "push with branches",
        "push with branches containing #",
        "push with config push.useBitmaps",
        "push with config pack.usePathWalk=true",
        "push into bare respects core.logallrefupdates",
        "fetch into bare respects core.logallrefupdates",
      ],
      reason:
        "client-side refspec, remote and config handling: the requests the server sees are those of a ported case",
    },
    {
      from,
      tests: [
        "setup",
        "reject 'git $cmd --no-$opt'",
        "push with $head",
        "push with $head nonexisting at remote",
        "push with +$head",
        "push $head with non-existent, incomplete dest",
        "push with config remote.*.push = $head",
        "force pushing required to update $tag_type_description",
        "fetch will not clobber an existing $tag_type_description without --force",
      ],
      reason:
        "loops over client options and local ref kinds; tag replacement without --force is refused by the client before anything is sent",
    },
    {
      from,
      tests: [
        "push to update a ref hidden by $configsection.hiderefs",
        "shallow fetch reachable SHA1 (but not a ref), allowtipsha1inwant=$configallowtipsha1inwant",
        "deny fetch unreachable SHA1, allowtipsha1inwant=$configallowtipsha1inwant",
      ],
      reason:
        "loops over server configuration (hiderefs sections, uploadpack.allowTipSHA1InWant); the hidden-ref push and the reachable and unreachable wants are ported cases",
    },
    {
      from,
      tests: [
        "push without negotiation",
        "push with negotiation",
        "push deletion with negotiation",
        "push with negotiation does not attempt to fetch submodules",
      ],
      reason:
        "need the server to offer wait-for-done (push.negotiate), which Fyrden does not; the fall-back is ported",
    },
    {
      from,
      tests: [
        "allow deleting an invalid remote ref",
        "pushing valid refs triggers post-receive and post-update hooks",
        "deleting dangling ref triggers hooks with correct args",
        "deletion of a non-existent ref is not fed to post-receive and post-update hooks",
        "deletion of a non-existent ref alone does trigger post-receive and post-update hooks",
        "mixed ref updates, deletes, invalid deletes trigger hooks with correct input",
        "warn on push to HEAD of non-bare repository",
        "deny push to HEAD of non-bare repository",
        "allow push to HEAD of bare repository (bare)",
        "allow push to HEAD of non-bare repository (config)",
        "push into aliased refs (consistent)",
        "push into aliased refs (inconsistent)",
        "receive.denyCurrentBranch = updateInstead",
        "updateInstead with push-to-checkout hook",
        "denyCurrentBranch and worktrees",
        "denyCurrentBranch and bare repository worktrees",
        "refuse fetch to current branch of worktree",
        "refuse fetch to current branch of bare repository worktree",
        "peeled advertisements are not considered ref tips",
        "fetch exact oid",
      ],
      reason:
        "need server-side hooks, a working tree, symbolic refs or a corrupt ref on the server, or the v0 ref advertisement for fetch; Fyrden has none of these",
    },
  ],
};
