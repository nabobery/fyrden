// Ported from git.git t/t5500-fetch-pack.sh (v2.53.0): clones and fetches,
// full and shallow, compared with git's own upload-pack.
import { expect } from "vitest";
import { cloneBoth, expectSameRepository, onBoth, pushBoth, seeded } from "./support.ts";
import type { CaseFile } from "./types.ts";

const from = "t5500-fetch-pack.sh";

export const t5500: CaseFile = {
  cases: [
    {
      from,
      test: "single given branch clone",
      fast: true,
      async run(t) {
        const { remotes } = await seeded(t, "single");
        const dirs = await cloneBoth(t, remotes, "single", [
          "--single-branch",
          "--branch",
          "feature",
        ]);
        await expectSameRepository(t, dirs);
        expect(Object.keys(await t.refs(dirs.fyrden))).toContain("refs/remotes/origin/feature");
      },
    },
    {
      from,
      test: "clone shallow depth 1 with fsck",
      fast: true,
      async run(t) {
        const { remotes } = await seeded(t, "depth1");
        const dirs = await cloneBoth(t, remotes, "depth1", ["--depth", "1", "--no-single-branch"]);
        await expectSameRepository(t, dirs);
        expect(await t.shallow(dirs.fyrden)).not.toEqual([]);
      },
    },
    {
      from,
      test: "deepening fetch in shallow repo",
      async run(t) {
        const { remotes } = await seeded(t, "deepen");
        const dirs = await cloneBoth(t, remotes, "deepen", ["--depth", "1"]);
        await t.ok(["fetch", "-q", "--depth", "3"], dirs.fyrden);
        await t.ok(["fetch", "-q", "--depth", "3"], dirs.oracle);
        await expectSameRepository(t, dirs);
      },
    },
    {
      from,
      test: "simple fetch in shallow repo",
      async run(t) {
        const { work, remotes } = await seeded(t, "shallow-fetch");
        const dirs = await cloneBoth(t, remotes, "shallow-fetch", ["--depth", "2"]);
        await t.commit(work, { "new.txt": "new\n" }, "five");
        await t.commit(work, { "new.txt": "newer\n" }, "six");
        await pushBoth(t, work, remotes, ["main"]);
        await t.ok(["fetch", "-q"], dirs.fyrden);
        await t.ok(["fetch", "-q"], dirs.oracle);
        await expectSameRepository(t, dirs);
      },
    },
    {
      from,
      test: "fetching deepen",
      minGit: "2.18.0",
      async run(t) {
        const { remotes } = await seeded(t, "deepen-rel");
        const dirs = await cloneBoth(t, remotes, "deepen-rel", ["--depth", "1"]);
        await t.ok(["fetch", "-q", "--deepen=1"], dirs.fyrden);
        await t.ok(["fetch", "-q", "--deepen=1"], dirs.oracle);
        await expectSameRepository(t, dirs);
      },
    },
    {
      from,
      test: "turn shallow to complete repository",
      fast: true,
      async run(t) {
        const { work, remotes } = await seeded(t, "unshallow");
        const dirs = await cloneBoth(t, remotes, "unshallow", ["--depth", "1"]);
        await t.ok(["fetch", "-q", "--unshallow"], dirs.fyrden);
        await t.ok(["fetch", "-q", "--unshallow"], dirs.oracle);
        await expectSameRepository(t, dirs);
        expect(await t.shallow(dirs.fyrden)).toEqual([]);
        expect(await t.ok(["rev-list", "origin/main"], dirs.fyrden)).toBe(
          await t.ok(["rev-list", "main"], work),
        );
      },
    },
    {
      from,
      test: "clone shallow with --branch",
      async run(t) {
        const { remotes } = await seeded(t, "shallow-branch");
        const dirs = await cloneBoth(t, remotes, "shallow-branch", [
          "--depth",
          "1",
          "--branch",
          "feature",
        ]);
        await expectSameRepository(t, dirs);
      },
    },
    {
      from,
      test: "shallow cloning single tag",
      async run(t) {
        const { remotes } = await seeded(t, "shallow-tag");
        const dirs = await cloneBoth(t, remotes, "shallow-tag", [
          "--depth",
          "1",
          "--branch",
          "v1",
          "--single-branch",
        ]);
        await expectSameRepository(t, dirs);
      },
    },
    {
      from,
      test: "clone shallow since ...",
      async run(t) {
        const { work, remotes } = await seeded(t, "since");
        // main~1's date: the cut falls inside main's history.
        const date = (await t.ok(["log", "-1", "--format=%cI", "main~1"], work)).trim();
        const dirs = await cloneBoth(t, remotes, "since", [`--shallow-since=${date}`]);
        await expectSameRepository(t, dirs);
      },
    },
    {
      from,
      test: "fetch shallow since ...",
      async run(t) {
        const { work, remotes } = await seeded(t, "fetch-since");
        const late = (await t.ok(["log", "-1", "--format=%cI", "main"], work)).trim();
        const early = (await t.ok(["log", "-1", "--format=%cI", "main~2"], work)).trim();
        const dirs = await cloneBoth(t, remotes, "fetch-since", [`--shallow-since=${late}`]);
        await t.ok(["fetch", "-q", `--shallow-since=${early}`], dirs.fyrden);
        await t.ok(["fetch", "-q", `--shallow-since=${early}`], dirs.oracle);
        await expectSameRepository(t, dirs);
      },
    },
    {
      from,
      test: "shallow clone exclude tag two",
      async run(t) {
        const { remotes } = await seeded(t, "exclude");
        const dirs = await cloneBoth(t, remotes, "exclude", ["--shallow-exclude", "v1"]);
        await expectSameRepository(t, dirs);
      },
    },
    {
      from,
      test: "fetch exclude tag one",
      async run(t) {
        const { remotes } = await seeded(t, "fetch-exclude");
        const dirs = await cloneBoth(t, remotes, "fetch-exclude", ["--depth", "1"]);
        await t.ok(["fetch", "-q", "--shallow-exclude", "v1", "origin", "main"], dirs.fyrden);
        await t.ok(["fetch", "-q", "--shallow-exclude", "v1", "origin", "main"], dirs.oracle);
        await expectSameRepository(t, dirs);
      },
    },
    {
      from,
      test: "fetch-pack can fetch a raw sha1",
      note: "a reachable commit that is not a ref tip; protocol v2 allows it (as git does)",
      async run(t) {
        const { work, remotes } = await seeded(t, "raw-sha1");
        const oid = (await t.ok(["rev-parse", "main~1"], work)).trim();
        await t.ok(["init", "-q", "raw-sha1-client"]);
        await t.ok(["init", "-q", "raw-sha1-client-oracle"]);
        const { fyrden, oracle } = await onBoth(
          t,
          remotes,
          (url) => ["fetch", "-q", "--no-tags", url, oid],
          (side) => (side === "fyrden" ? "raw-sha1-client" : "raw-sha1-client-oracle"),
        );
        expect(fyrden.code, fyrden.stderr).toBe(0);
        expect(oracle.code, oracle.stderr).toBe(0);
        expect((await t.ok(["rev-parse", "FETCH_HEAD"], "raw-sha1-client")).trim()).toBe(oid);
        await t.fsck("raw-sha1-client");
      },
    },
    {
      from,
      test: "fetch-pack cannot fetch a raw sha1 that is not advertised as a ref",
      note: "a commit no ref reaches any more is refused; git's own v2 server sends it (deliberate difference)",
      async run(t) {
        const { work, remotes } = await seeded(t, "unreachable");
        await t.ok(["checkout", "-q", "-b", "gone"], work);
        const oid = await t.commit(work, { "gone.txt": "gone\n" }, "gone");
        await pushBoth(t, work, remotes, ["gone"]);
        await pushBoth(t, work, remotes, [":gone"]);
        await t.ok(["init", "-q", "unreachable-client"]);
        // git's own upload-pack (2.53, protocol v2) sends a commit it still has
        // even when no ref reaches it. Fyrden sends only objects reachable from
        // its refs: packs can be shared between repositories, so an unreachable
        // object may belong to another one.
        const fyrden = await t.git(["fetch", "--no-tags", remotes.fyrden, oid], {
          cwd: "unreachable-client",
        });
        expect(fyrden.code).not.toBe(0);
        expect(fyrden.stderr).toMatch(/not our ref/);
      },
    },
    {
      from,
      test: "test lonely missing ref",
      async run(t) {
        const { remotes } = await seeded(t, "missing-ref");
        await t.ok(["init", "-q", "missing-ref-client"]);
        const res = await t.git(["fetch", remotes.fyrden, "refs/heads/xyzzy"], {
          cwd: "missing-ref-client",
        });
        expect(res.code).not.toBe(0);
        expect(res.stderr).toMatch(/couldn't find remote ref refs\/heads\/xyzzy/);
      },
    },
    {
      from,
      test: "filtering by size has no effect if support for it is not advertised",
      note: "Fyrden does not advertise filter; git clones in full and warns",
      async run(t) {
        const { remotes } = await seeded(t, "filter");
        const res = await t.git(["clone", "--filter=blob:none", remotes.fyrden, "filter"]);
        expect(res.code, res.stderr).toBe(0);
        expect(res.stderr).toMatch(/filtering not recognized by server, ignoring/);
        await t.ok(["clone", "-q", remotes.oracle, "filter-oracle"]);
        await expectSameRepository(t, { fyrden: "filter", oracle: "filter-oracle" });
      },
    },
  ],
  notPorted: [
    {
      from,
      tests: [
        "setup",
        "post 1st pull setup",
        "add two more",
        "add two more (part 2)",
        "setup tests for the --stdin parameter",
        "setup fetch refs from cmdline v[12]",
        "set up tests of missing reference",
      ],
      reason: "fixture setup; each ported case builds its own history",
    },
    {
      from,
      tests: [
        "single branch object count",
        "clone shallow depth count",
        "clone shallow object count",
        "clone shallow object count (part 2)",
        "no changes expected",
      ],
      reason: "counts objects of git's own server; ported cases compare every object with it",
    },
    {
      from,
      tests: [
        "single branch clone",
        "clone shallow depth 1",
        "$number pull",
        "clone shallow",
        "fsck in shallow repo",
        "fetch same depth in shallow repo",
        "pull in shallow repo",
        "deepening pull in shallow repo",
        "additional simple shallow deepenings",
        "clone shallow without --no-single-branch",
        "clone shallow with packed refs",
        "clone shallow with detached HEAD",
        "shallow clone pulling tags",
        "pull in shallow repo with missing merge base",
      ],
      reason:
        "the same requests as a ported case (pull is fetch then a local merge; packed refs and a detached HEAD are client-side)",
    },
    {
      from,
      tests: [
        "fetch --no-shallow on full repo",
        "fetch --depth --no-shallow",
        "fetch refs from stdin",
        "fetch mixed refs from cmdline and stdin",
        "test duplicate refs from stdin",
        "test missing ref after existing",
        "test missing ref before existing",
        "test --all, --depth, and explicit head",
        "test --all, --depth, and explicit tag",
        "test --all with tag to non-tip",
        "test --all wrt tag to non-commits",
        "fetch-pack can fetch a raw sha1 that is advertised as a ref",
        "fetch-pack can fetch a raw sha1 overlapping a named ref",
        "protocol.version=$version fetch refs from cmdline",
        "fetch-pack --diag-url $p://$h$c/$r",
        "fetch-pack --diag-url $p://$h$c/~$r",
        "fetch-pack --diag-url $p://$h:22/$r",
        "fetch-pack --diag-url $p://$h/$r",
        "fetch-pack --diag-url $p:///$r",
        "fetch-pack --diag-url $p://$h/~$r",
        "fetch-pack --diag-url ./$h:$r",
        "fetch-pack --diag-url ./$p:$h/~$r",
        "fetch-pack --diag-url file://c:/repo",
        "fetch-pack --diag-url c:repo",
        "ensure bogus fetch.negotiationAlgorithm yields error",
        'use ref advertisement to prune "have" lines sent',
        "same as last but with config overrides",
        "fetch-pack with fsckObjects and keep-file does not segfault",
        "in_vain not triggered before first ACK",
        "in_vain reset upon ACK",
      ],
      reason:
        "git fetch-pack argument handling, negotiation heuristics or local checks; the requests they produce are covered by ported cases",
    },
    {
      from,
      tests: [
        "fetch in shallow repo unreachable shallow objects",
        "fetch creating new shallow root",
        "shallow fetch with tags does not break the repository",
        "fetch exclude tag one as revision",
        "clone shallow since selects no commits",
        "shallow since with commit graph and already-seen commit",
      ],
      reason:
        "depend on git's local repository state (reflogs, gc, commit-graph files) rather than on what the server sends",
    },
    {
      from,
      tests: [
        "filtering by size",
        "fetch with --filter=blob:limit=0",
        "fetch with --filter=blob:limit=0 and HTTP",
      ],
      reason: "partial clone: Fyrden does not offer filter (see the not-advertised case)",
    },
  ],
};
