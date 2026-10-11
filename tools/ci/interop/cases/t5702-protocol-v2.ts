// Ported from git.git t/t5702-protocol-v2.sh (v2.53.0), the cases that
// apply to a smart HTTP server: ls-refs, fetch, include-tag, unborn HEAD,
// and the features Fyrden does not advertise.
import { expect } from "vitest";
import {
  cloneBoth,
  DELIM,
  expectSameRefs,
  expectSameRepository,
  FLUSH,
  loggedRequests,
  onBoth,
  pkt,
  postUploadPack,
  pushBoth,
  seeded,
} from "./support.ts";
import type { CaseFile } from "./types.ts";

const from = "t5702-protocol-v2.sh";

export const t5702: CaseFile = {
  cases: [
    {
      from,
      test: "ref advertisement is filtered with ls-remote using protocol v2",
      fast: true,
      async run(t) {
        const { remotes } = await seeded(t, "v2-ls");
        const { fyrden, oracle } = await onBoth(t, remotes, (url) => [
          "ls-remote",
          "--symref",
          url,
          "main",
          "refs/tags/v*",
        ]);
        expect(fyrden.code, fyrden.stderr).toBe(0);
        expect(fyrden.stdout).toBe(oracle.stdout);
        await expectSameRefs(t, remotes);
      },
    },
    {
      from,
      test: "ls-remote with v2 http sends only one POST",
      async run(t) {
        const { remotes } = await seeded(t, "v2-one-post");
        const mark = t.server.output().length;
        await t.ok(["ls-remote", remotes.fyrden]);
        // Until the POST is logged: any second POST was sent before it, so is logged by then too.
        const seen = await loggedRequests(t, "v2-one-post", mark, (r) =>
          r.some((line) => line.startsWith("POST ")),
        );
        // The first request is answered 401; git asks its credential helper and repeats it.
        expect(seen).toEqual([
          "GET /info/refs 401",
          "GET /info/refs 200",
          "POST /git-upload-pack 200",
        ]);
      },
    },
    {
      from,
      test: "clone of empty repo propagates name of default branch",
      fast: true,
      minGit: "2.31.0",
      async run(t) {
        const remotes = await t.remotes("v2-empty");
        const dirs = await cloneBoth(t, remotes, "v2-empty");
        expect((await t.ok(["symbolic-ref", "HEAD"], dirs.fyrden)).trim()).toBe(
          (await t.ok(["symbolic-ref", "HEAD"], dirs.oracle)).trim(),
        );
      },
    },
    {
      from,
      test: "bare clone propagates empty default branch",
      minGit: "2.31.0",
      async run(t) {
        const remotes = await t.remotes("v2-empty-bare");
        const dirs = await cloneBoth(t, remotes, "v2-empty-bare", ["--bare"]);
        expect((await t.ok(["symbolic-ref", "HEAD"], dirs.fyrden)).trim()).toBe(
          (await t.ok(["symbolic-ref", "HEAD"], dirs.oracle)).trim(),
        );
      },
    },
    {
      from,
      test: "fetch with http:// using protocol v2",
      async run(t) {
        const { work, remotes } = await seeded(t, "v2-fetch");
        const dirs = await cloneBoth(t, remotes, "v2-fetch");
        await t.commit(work, { "two.txt": "two\n" }, "two more");
        await pushBoth(t, work, remotes, ["main"]);
        await t.ok(["fetch", "-q"], dirs.fyrden);
        await t.ok(["fetch", "-q"], dirs.oracle);
        await expectSameRepository(t, dirs);
      },
    },
    {
      from,
      test: "fetch supports include-tag and tag following",
      fast: true,
      async run(t) {
        const { work, remotes } = await seeded(t, "v2-include-tag");
        const dirs = await cloneBoth(t, remotes, "v2-include-tag", [
          "--no-tags",
          "--single-branch",
        ]);
        await t.commit(work, { "t.txt": "t\n" }, "tagged");
        await t.ok(["tag", "-a", "-m", "two", "v2"], work);
        await pushBoth(t, work, remotes, ["main", "v2"]);
        for (const dir of [dirs.fyrden, dirs.oracle]) {
          await t.ok(["config", "--unset", "remote.origin.tagOpt"], dir);
          await t.ok(["fetch", "-q", "origin", "main:refs/remotes/origin/main"], dir);
        }
        await expectSameRepository(t, dirs);
        expect(Object.keys(await t.refs(dirs.fyrden))).toContain("refs/tags/v2");
      },
    },
    {
      from,
      test: "exact oid fetch with tag following",
      async run(t) {
        const { work, remotes } = await seeded(t, "v2-oid-tags");
        const oid = (await t.ok(["rev-parse", "main~1"], work)).trim();
        for (const dir of ["v2-oid-tags", "v2-oid-tags-oracle"]) await t.ok(["init", "-q", dir]);
        await onBoth(
          t,
          remotes,
          (url) => ["fetch", "-q", url, `${oid}:refs/heads/fetched`],
          (side) => (side === "fyrden" ? "v2-oid-tags" : "v2-oid-tags-oracle"),
        );
        await expectSameRepository(t, { fyrden: "v2-oid-tags", oracle: "v2-oid-tags-oracle" });
      },
    },
    {
      from,
      test: "fetch supports various ways of have lines",
      async run(t) {
        const { work, remotes } = await seeded(t, "v2-haves");
        const dirs = await cloneBoth(t, remotes, "v2-haves");
        // The clones gain local work, so they send haves the server lacks.
        for (const dir of [dirs.fyrden, dirs.oracle]) {
          await t.commit(dir, { "local.txt": "local\n" }, "local");
        }
        await t.ok(["checkout", "-q", "feature"], work);
        await t.commit(work, { "f2.txt": "f2\n" }, "feature two");
        await t.ok(["checkout", "-q", "-b", "third", "main~2"], work);
        await t.commit(work, { "t3.txt": "t3\n" }, "third");
        await pushBoth(t, work, remotes, ["feature", "third"]);
        await t.ok(["fetch", "-q"], dirs.fyrden);
        await t.ok(["fetch", "-q"], dirs.oracle);
        await t.fsck(dirs.fyrden);
        // Local branches differ (each clone committed on its own); what was fetched must not.
        const fetched = async (dir: string) =>
          Object.entries(await t.refs(dir)).filter(([ref]) => !ref.startsWith("refs/heads/"));
        expect(await fetched(dirs.fyrden)).toEqual(await fetched(dirs.oracle));
      },
    },
    {
      from,
      test: "upload-pack respects client shallows",
      async run(t) {
        const { work, remotes } = await seeded(t, "v2-client-shallow");
        const dirs = await cloneBoth(t, remotes, "v2-client-shallow", [
          "--depth",
          "1",
          "--no-single-branch",
        ]);
        await t.ok(["checkout", "-q", "feature"], work);
        await t.commit(work, { "f3.txt": "f3\n" }, "on feature");
        await pushBoth(t, work, remotes, ["feature"]);
        await t.ok(["fetch", "-q"], dirs.fyrden);
        await t.ok(["fetch", "-q"], dirs.oracle);
        await expectSameRepository(t, dirs);
      },
    },
    {
      from,
      test: "partial clone warns if filter is not advertised",
      async run(t) {
        const { remotes } = await seeded(t, "v2-partial");
        const res = await t.git(["clone", "--filter=blob:limit=0", remotes.fyrden, "v2-partial"]);
        expect(res.code, res.stderr).toBe(0);
        expect(res.stderr).toMatch(/filtering not recognized by server, ignoring/);
      },
    },
    {
      from,
      test: "even with handcrafted request, filter does not work if not advertised",
      fast: true,
      async run(t) {
        const { work } = await seeded(t, "v2-handmade-filter");
        const main = (await t.ok(["rev-parse", "main"], work)).trim();
        const reply = await postUploadPack(
          t,
          "v2-handmade-filter",
          pkt("command=fetch\n") +
            pkt("object-format=sha1\n") +
            DELIM +
            pkt(`want ${main}\n`) +
            pkt("filter blob:none\n") +
            FLUSH,
        );
        expect(reply).toMatch(/^200 /);
        expect(reply).toMatch(/ERR /);
        expect(reply).not.toMatch(/packfile/);
      },
    },
    {
      from,
      test: "reject client packfile-uris if not advertised",
      async run(t) {
        await seeded(t, "v2-handmade-uris");
        const reply = await postUploadPack(
          t,
          "v2-handmade-uris",
          pkt("command=fetch\n") +
            pkt("object-format=sha1\n") +
            DELIM +
            pkt("packfile-uris https\n") +
            pkt("done\n") +
            FLUSH,
        );
        expect(reply).toMatch(/ERR /);
      },
    },
    {
      from,
      test: "http:// --negotiate-only without wait-for-done support",
      minGit: "2.32.0",
      async run(t) {
        const { remotes } = await seeded(t, "v2-negotiate");
        await t.ok(["clone", "-q", remotes.fyrden, "v2-negotiate"]);
        const head = (await t.ok(["rev-parse", "HEAD"], "v2-negotiate")).trim();
        const res = await t.git(
          ["fetch", "--no-tags", "--negotiate-only", `--negotiation-tip=${head}`, "origin"],
          { cwd: "v2-negotiate" },
        );
        expect(res.code).not.toBe(0);
        expect(res.stderr).toMatch(/server does not support wait-for-done/);
      },
    },
    {
      from,
      test: "push with http:// and a config of v2 does not request v2",
      fast: true,
      async run(t) {
        const { work, remotes } = await seeded(t, "v2-push");
        await t.commit(work, { "p.txt": "p\n" }, "pushed with v2 configured");
        await pushBoth(t, work, remotes, ["main"], []);
        await expectSameRefs(t, remotes);
      },
    },
    {
      from,
      test: "clone big repository with http:// using protocol v2",
      note: "1,000 commits, one file each",
      async run(t) {
        const remotes = await t.remotes("v2-big");
        const work = await t.work("v2-big-work");
        const parent = (await t.ok(["rev-parse", "main"], work)).trim();
        const stream = [`reset refs/heads/main\nfrom ${parent}\n\n`]
          .concat(
            Array.from(
              { length: 1000 },
              (_, i) =>
                `commit refs/heads/main\ncommitter C <c@fyrden.invalid> ${1_767_225_600 + i} +0000\ndata <<EOF\n${i}\nEOF\nM 644 inline file-${i}.txt\ndata <<EOF\ncontent ${i}\nEOF\n\n`,
            ),
          )
          .join("");
        const imported = await t.git(["fast-import", "--quiet"], { cwd: work, input: stream });
        expect(imported.code, imported.stderr).toBe(0);
        await pushBoth(t, work, remotes, ["main"]);
        await expectSameRepository(t, await cloneBoth(t, remotes, "v2-big"));
      },
    },
    {
      from,
      test: "server-options are sent when using ls-remote",
      note: "Fyrden does not advertise server-option; git refuses to send one rather than drop it",
      minGit: "2.20.0",
      async run(t) {
        const { remotes } = await seeded(t, "v2-server-option");
        const res = await t.git(["ls-remote", "-o", "hello", remotes.fyrden]);
        expect(res.code).not.toBe(0);
        expect(res.stderr).toMatch(/server-option|server options/);
      },
    },
  ],
  notPorted: [
    {
      from,
      tests: [
        "create repo to be served by git-daemon",
        "list refs with git:// using protocol v2",
        "clone with git:// using protocol v2",
        "fetch with git:// using protocol v2",
        "fetch by hash without tag following with protocol v2 does not list refs",
        "pull with git:// using protocol v2",
        "push with git:// and a config of v2 does not request v2",
        "create repo to be served by file:// transport",
        "list refs with file:// using protocol v2",
        "clone with file:// using protocol v2",
        "fetch with file:// using protocol v2",
        "file:// --negotiate-only",
        "file:// --negotiate-only with protocol v0",
        "push with custom path does not request v2",
        "fetch with custom path does request v2",
        "archive with custom path does not request v2",
        "create repo to be served by http:// transport",
        "clone with http:// using protocol v2",
      ],
      reason: "git:// and file:// transports, or the same request as a ported http:// case",
    },
    {
      from,
      tests: [
        "server-options from configuration are used by ls-remote",
        "warn if using server-option with ls-remote with legacy protocol",
        "server-options are sent when fetching",
        "server-options are sent when fetch multiple remotes",
        "server-options from configuration are used by git-fetch",
        "warn if using server-option with fetch with legacy protocol",
        "server-options are sent when cloning",
        "server-options from configuration are used by git-clone",
        "warn if using server-option with clone with legacy protocol",
        "server-option configuration with legacy protocol is ok",
        "invalid server-option configuration",
      ],
      reason: "server-option is not advertised (the refusal is the ls-remote case)",
    },
    {
      from,
      tests: [
        "clone propagates unborn HEAD from non-empty repo",
        "bare clone propagates unborn HEAD from non-empty repo",
        "...but not if explicitly forbidden by config",
        "defaulted HEAD uses remote branch if available",
        "clone propagates object-format from empty repo",
        "upload-pack respects config using protocol v2",
        "fetch from namespaced repo respects namespaces",
        "ensure that multiple fetches in same process from a shallow repo works",
        "deepen-relative",
        "default refspec is used to filter ref when fetching",
        "empty refspec filters refs when fetching",
        "set up parent for prefix tests",
        "ref advertisement is filtered during fetch using protocol v2",
        "exact oid fetch avoids pointless HEAD request",
        "fetch with http:// by hash without tag following with protocol v2 does not list refs",
      ],
      reason:
        "need a server HEAD on an unborn branch beside other branches, server configuration or namespaces, or check client tracing; deepen-relative is ported as t5500 'fetching deepen'",
    },
    {
      from,
      tests: [
        "setup filter tests",
        "partial clone",
        "dynamically fetch missing object",
        "when dynamically fetching missing object, do not list refs",
        "partial fetch",
        "do not advertise filter if not configured to do so",
        "usage: --negotiate-only without --negotiation-tip",
        "usage: --negotiate-only with --recurse-submodules",
        "http:// --negotiate-only",
        "http:// --negotiate-only with protocol v0",
        "part of packfile response provided as URI",
        "packfile URIs with fetch instead of clone",
        "fetching with valid packfile URI but invalid hash fails",
        "packfile-uri with transfer.fsckobjects",
        "packfile-uri with transfer.fsckobjects fails on bad object",
        "packfile-uri with transfer.fsckobjects succeeds when .gitmodules is separate from tree",
        "packfile-uri with transfer.fsckobjects fails when .gitmodules separate from tree is invalid",
        "packfile-uri path redacted in trace",
        "packfile-uri path not redacted in trace when GIT_TRACE_REDACT=0",
      ],
      reason:
        "partial clone, wait-for-done and packfile URIs are not offered (the refusals are ported cases)",
    },
    {
      from,
      tests: [
        "clone repository with http:// using protocol v2 with incomplete pktline length",
        "clone repository with http:// using protocol v2 with incomplete pktline body",
        "clone with http:// using protocol v2 and invalid parameters",
        'when server sends "ready", expect DELIM',
        'when server does not send "ready", expect FLUSH',
      ],
      reason: "a deliberately broken server checks the client; not applicable to a server",
    },
  ],
};
