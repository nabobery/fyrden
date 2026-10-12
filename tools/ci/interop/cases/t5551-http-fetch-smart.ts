// Ported from git.git t/t5551-http-fetch-smart.sh (v2.53.0): smart HTTP
// specifics (services, content types, authentication, chunked requests).
import { expect } from "vitest";
import { cloneBoth, expectSameRepository, loggedRequests, pushBoth, seeded } from "./support.ts";
import type { CaseFile } from "./types.ts";

const from = "t5551-http-fetch-smart.sh";

export const t5551: CaseFile = {
  cases: [
    {
      from,
      test: "clone http repository",
      fast: true,
      async run(t) {
        const { remotes } = await seeded(t, "http-clone");
        await expectSameRepository(t, await cloneBoth(t, remotes, "http-clone"));
      },
    },
    {
      from,
      test: "fetch changes via http",
      fast: true,
      async run(t) {
        const { work, remotes } = await seeded(t, "http-fetch");
        const dirs = await cloneBoth(t, remotes, "http-fetch");
        await t.commit(work, { "n.txt": "n\n" }, "new");
        await pushBoth(t, work, remotes, ["main"]);
        await t.ok(["fetch", "-q"], dirs.fyrden);
        await t.ok(["fetch", "-q"], dirs.oracle);
        await expectSameRepository(t, dirs);
      },
    },
    {
      from,
      test: "used upload-pack service",
      async run(t) {
        const { remotes } = await seeded(t, "http-service");
        const mark = t.server.output().length;
        await t.ok(["clone", "-q", remotes.fyrden, "http-service"]);
        // A v2 clone posts at least twice (ls-refs, then fetch).
        const seen = await loggedRequests(
          t,
          "http-service",
          mark,
          (r) => r.filter((line) => line.startsWith("POST ")).length >= 2,
        );
        // The first request is answered 401; git asks its credential helper and repeats it.
        expect(seen.slice(0, 2)).toEqual(["GET /info/refs 401", "GET /info/refs 200"]);
        expect(seen.slice(2).length).toBeGreaterThan(0);
        expect(seen.slice(2).every((r) => r === "POST /git-upload-pack 200")).toBe(true);
      },
    },
    {
      from,
      test: "clone from password-protected repository",
      fast: true,
      note: "every Fyrden repository needs a token; a wrong one fails without revealing the repository",
      async run(t) {
        const { remotes } = await seeded(t, "http-auth");
        const res = await t.git(["clone", remotes.fyrden, "http-auth"], {
          env: { FYRDEN_INTEROP_TOKEN: "fyrden_git_not-a-real-token" },
        });
        expect(res.code).not.toBe(0);
        expect(res.stderr).toMatch(/Authentication failed|401/);
        await t.ok(["clone", "-q", remotes.fyrden, "http-auth"]);
      },
    },
    {
      from,
      test: "invalid Content-Type rejected",
      note: "the inverse: Fyrden's responses carry the content types git requires",
      async run(t) {
        await t.remotes("http-ctype");
        const basic = Buffer.from(`x-access-token:${t.token}`).toString("base64");
        const base = t.server.repoUrl(t.repoName("http-ctype"));
        for (const service of ["git-upload-pack", "git-receive-pack"]) {
          const res = await fetch(`${base}/info/refs?service=${service}`, {
            headers: { Authorization: `Basic ${basic}`, "Git-Protocol": "version=2" },
          });
          await res.arrayBuffer();
          expect(res.status).toBe(200);
          expect(res.headers.get("content-type")).toBe(`application/x-${service}-advertisement`);
        }
      },
    },
    {
      from,
      test: "large fetch-pack requests can be sent using chunked encoding",
      note: "2,000 tags on distinct commits make the want list larger than http.postBuffer",
      async run(t) {
        const remotes = await t.remotes("http-chunked");
        const work = await t.work("http-chunked-work");
        const stream = Array.from(
          { length: 2000 },
          (_, i) =>
            `commit refs/tags/${"bla".repeat(30)}-${i}\ncommitter C <c@fyrden.invalid> ${1_767_225_600 + i} +0000\ndata <<EOF\n${i}\nEOF\n\n`,
        ).join("");
        const imported = await t.git(["fast-import", "--quiet"], { cwd: work, input: stream });
        expect(imported.code, imported.stderr).toBe(0);
        await pushBoth(t, work, remotes, ["main", "refs/tags/*"]);
        const dirs = { fyrden: "http-chunked", oracle: "http-chunked-oracle" };
        const cloned = await t.git(
          ["-c", "http.postBuffer=65536", "clone", "--bare", remotes.fyrden, dirs.fyrden],
          { env: { GIT_TRACE_CURL: "1", GIT_TRACE_CURL_NO_DATA: "1" } },
        );
        expect(cloned.code, cloned.stderr.slice(-2000)).toBe(0);
        expect(cloned.stderr).toMatch(/=> Send header: Transfer-Encoding: chunked/);
        await t.ok(["clone", "-q", "--bare", remotes.oracle, dirs.oracle]);
        await expectSameRepository(t, dirs);
        expect(
          Object.keys(await t.refs(dirs.fyrden)).filter((r) => r.startsWith("refs/tags/")),
        ).toHaveLength(2000);
      },
    },
    {
      from,
      test: "fetch by SHA-1 without tag following",
      async run(t) {
        const { work, remotes } = await seeded(t, "http-by-sha");
        const oid = (await t.ok(["rev-parse", "main"], work)).trim();
        await t.ok(["init", "-q", "http-by-sha"]);
        await t.ok(["fetch", "-q", "--no-tags", remotes.fyrden, oid], "http-by-sha");
        expect((await t.ok(["rev-parse", "FETCH_HEAD"], "http-by-sha")).trim()).toBe(oid);
        expect(Object.keys(await t.refs("http-by-sha"))).toEqual([]);
      },
    },
    {
      from,
      test: "server-side error detected",
      note: "a repository that does not exist: git reports it and exits non-zero",
      async run(t) {
        const res = await t.git([
          "clone",
          t.server.repoUrl(t.repoName("does-not-exist")),
          "missing",
        ]);
        expect(res.code).not.toBe(0);
        expect(res.stderr).toMatch(/not found|404/);
      },
    },
    {
      from,
      test: "client falls back from v2 to v0 to match server",
      note: "the reverse case: a v0 client is refused by Fyrden's v2-only upload-pack, with a message naming v2",
      async run(t) {
        const { remotes } = await seeded(t, "http-v0");
        const res = await t.git(["-c", "protocol.version=0", "clone", remotes.fyrden, "http-v0"]);
        expect(res.code).not.toBe(0);
        expect(res.stderr).toMatch(/protocol version 2/);
      },
    },
  ],
  notPorted: [
    {
      from,
      tests: [
        "enable client-side http/2",
        "setup repository",
        "create http-accessible bare repository",
        "create namespaced refs",
        "create 2,000 tags in the repo",
        "create empty http-accessible SHA-256 repository",
      ],
      reason: "fixture setup; each ported case builds its own repository",
    },
    {
      from,
      tests: [
        "follow redirects (301)",
        "follow redirects (302)",
        "redirects re-root further requests",
        "re-rooting dies on insane schemes",
        "redirects send auth to new location",
        "clone from auth-only-for-push repository",
        "clone from auth-only-for-objects repository",
        "no-op half-auth fetch does not require a password",
        "disable dumb http on server",
        "GIT_SMART_HTTP can disable smart http",
        "smart clone respects namespace",
        "dumb clone via http-backend respects namespace",
        "transfer.hiderefs works over smart-http",
        "test allowreachablesha1inwant",
        "test allowreachablesha1inwant with unreachable",
        "test allowanysha1inwant with unreachable",
        "clone the 2,000 tag repo to check OS command line overflow",
        "http can handle enormous ref negotiation",
      ],
      reason:
        "need web-server or git server configuration Fyrden does not have (redirects, partial authentication, dumb HTTP, namespaces, hiderefs, uploadpack.allow*); reachable wants are covered by t5500 cases",
    },
    {
      from,
      tests: [
        "credential.interactive=false skips askpass",
        "GIT_TRACE_CURL redacts auth details",
        "GIT_CURL_VERBOSE redacts auth details",
        "GIT_TRACE_CURL does not redact auth details if GIT_TRACE_REDACT=0",
        "cookies stored in http.cookiefile when http.savecookies set",
        "custom http headers",
        "using fetch command in remote-curl updates refs",
        "cookies are redacted by default",
        "empty values of cookies are also redacted",
        "GIT_TRACE_REDACT=0 disables cookie redaction",
        "GIT_TRACE_CURL_NO_DATA prevents data from being traced",
        "http auth remembers successful credentials",
        "http auth forgets bogus credentials",
        "passing hostname resolution information works",
        "clone warns or fails when using username:password",
        "clone does not detect username:password when it is https://username@domain:port/",
        "fetch warns or fails when using username:password",
        "push warns or fails when using username:password",
        "no empty path components",
      ],
      reason: "client-side HTTP, tracing and credential handling",
    },
    {
      from,
      tests: [
        "clone empty SHA-256 repository with protocol v2",
        "clone empty SHA-256 repository with protocol v0",
        "tag following always works over v0 http",
      ],
      reason: "SHA-256 repositories and protocol v0 upload-pack are not offered",
    },
  ],
};
