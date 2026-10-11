// Ported from git.git t/t5533-push-cas.sh (v2.53.0): --force-with-lease,
// which relies on the server reporting the ref values it holds.
import { expect } from "vitest";
import type { Interop } from "../harness.ts";
import { expectSameRefs, onBoth, seeded } from "./support.ts";
import type { CaseFile } from "./types.ts";

const from = "t5533-push-cas.sh";

/** A history on both remotes, and a work tree whose main has been rewritten. */
async function rewritten(t: Interop, name: string) {
  const { work, remotes } = await seeded(t, name);
  const remoteMain = (await t.ok(["rev-parse", "main"], work)).trim();
  await t.ok(["reset", "-q", "--hard", "main~1"], work);
  await t.commit(work, { "rewritten.txt": "rewritten\n" }, "rewritten");
  return { work, remotes, remoteMain };
}

export const t5533: CaseFile = {
  cases: [
    {
      from,
      test: "push to update (protected)",
      fast: true,
      async run(t) {
        const { work, remotes, remoteMain } = await rewritten(t, "cas-protected");
        const stale = (await t.ok(["rev-parse", "main~1"], work)).trim();
        const { fyrden, oracle } = await onBoth(
          t,
          remotes,
          (url) => ["push", `--force-with-lease=main:${stale}`, url, "main"],
          () => work,
        );
        expect(oracle.code).not.toBe(0);
        expect(fyrden.code).not.toBe(0);
        expect(fyrden.stderr).toMatch(/stale info/);
        expect((await t.lsRemote(remotes.fyrden))["refs/heads/main"]).toBe(remoteMain);
      },
    },
    {
      from,
      test: "push to update (allowed)",
      async run(t) {
        const { work, remotes, remoteMain } = await rewritten(t, "cas-allowed");
        const { fyrden } = await onBoth(
          t,
          remotes,
          (url) => ["push", `--force-with-lease=main:${remoteMain}`, url, "main"],
          () => work,
        );
        expect(fyrden.code, fyrden.stderr).toBe(0);
        await expectSameRefs(t, remotes);
      },
    },
    {
      from,
      test: "push to delete (protected)",
      async run(t) {
        const { work, remotes } = await seeded(t, "cas-delete-protected");
        const stale = (await t.ok(["rev-parse", "feature~1"], work)).trim();
        const { fyrden, oracle } = await onBoth(
          t,
          remotes,
          (url) => ["push", `--force-with-lease=feature:${stale}`, url, ":feature"],
          () => work,
        );
        expect(oracle.code).not.toBe(0);
        expect(fyrden.code).not.toBe(0);
        await expectSameRefs(t, remotes);
      },
    },
    {
      from,
      test: "push to delete (allowed)",
      async run(t) {
        const { work, remotes } = await seeded(t, "cas-delete-allowed");
        const current = (await t.ok(["rev-parse", "feature"], work)).trim();
        const { fyrden } = await onBoth(
          t,
          remotes,
          (url) => ["push", `--force-with-lease=feature:${current}`, url, ":feature"],
          () => work,
        );
        expect(fyrden.code, fyrden.stderr).toBe(0);
        await expectSameRefs(t, remotes);
      },
    },
    {
      from,
      test: "new branch covered by force-with-lease (explicit)",
      async run(t) {
        const { work, remotes } = await seeded(t, "cas-new");
        await t.ok(["branch", "branch", "main"], work);
        const { fyrden } = await onBoth(
          t,
          remotes,
          (url) => ["push", "--force-with-lease=branch:", url, "branch"],
          () => work,
        );
        expect(fyrden.code, fyrden.stderr).toBe(0);
        await expectSameRefs(t, remotes);
      },
    },
    {
      from,
      test: "new branch already exists",
      async run(t) {
        const { work, remotes } = await seeded(t, "cas-exists");
        await t.ok(["push", "-q", remotes.fyrden, "main:refs/heads/branch"], work);
        await t.ok(["push", "-q", remotes.oracle, "main:refs/heads/branch"], work);
        await t.ok(["checkout", "-q", "-b", "branch", "main"], work);
        await t.commit(work, { "f.txt": "f\n" }, "F");
        const { fyrden, oracle } = await onBoth(
          t,
          remotes,
          (url) => ["push", "--force-with-lease=branch:", url, "branch"],
          () => work,
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
        "push to update (protected, forced)",
        "push to update (protected, tracking)",
        "push to update (protected, tracking, forced)",
        "push to update (allowed, tracking)",
        "push to update (allowed even though no-ff)",
        "push to delete (protected, forced)",
        "cover everything with default force-with-lease (protected)",
        "cover everything with default force-with-lease (allowed)",
        "new branch covered by force-with-lease",
        "background updates of REMOTE can be mitigated with a non-updated REMOTE-push",
        'background updates to remote can be mitigated with "--force-if-includes"',
        'background updates to remote can be mitigated with "push.useForceIfIncludes"',
        '"--force-if-includes" should be disabled for --force-with-lease="<refname>:<expect>"',
        '"--force-if-includes" should allow forced update after a rebase ("pull --rebase")',
        '"--force-if-includes" should allow forced update after a rebase ("pull --rebase", local rebase)',
        '"--force-if-includes" should allow deletes',
      ],
      reason:
        "the lease is computed by the client from remote-tracking refs and reflogs; the server sees the same old-value check as a ported case",
    },
  ],
};
