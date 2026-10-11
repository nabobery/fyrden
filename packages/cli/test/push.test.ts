import { describe, expect, it } from "vitest";
import { type PushArgs, parsePushArgs, push } from "../src/commands/push.ts";
import { deps, fakeFiles, fakeGit, fakeServer, OID, withoutConfig } from "./fake-push.ts";

/*
 * `fyrden push --chunked`: the pack is made with the user's git, uploaded
 * in parts through the upload session API with retries, and completed;
 * the outcome is printed per ref, as git prints it.
 */

const REMOTE = "https://fyrden.example/alice/proj.git";

const args = (over: Partial<PushArgs> = {}): PushArgs => ({
  remote: "origin",
  refspecs: ["main"],
  chunked: true,
  force: false,
  bodyLimit: 104_857_600,
  ...over,
});

function setup(
  script: Parameters<typeof fakeGit>[0] = {},
  server: Parameters<typeof fakeServer>[0] = { partSize: 40 },
  env: Record<string, string | undefined> = {},
) {
  const files = fakeFiles();
  const git = fakeGit(
    {
      remotes: { origin: REMOTE },
      remoteRefs: { "refs/heads/main": OID.a, "refs/tags/v1": OID.tag },
      revs: { main: OID.b, v2: OID.c },
      fullNames: { main: "refs/heads/main", v2: "refs/tags/v2" },
      local: [OID.a],
      ancestors: [`${OID.a} ${OID.b}`],
      packBytes: 100,
      ...script,
    },
    files,
  );
  const srv = fakeServer(server);
  return { git, files, srv, d: deps(git, files, srv, env) };
}

describe("parsePushArgs", () => {
  it("reads flags, the remote and refspecs", () => {
    expect(parsePushArgs(["--chunked", "-f", "origin", "main", "+x:y"], {})).toEqual({
      remote: "origin",
      refspecs: ["main", "+x:y"],
      chunked: true,
      force: true,
      bodyLimit: 104_857_600,
    });
    expect(parsePushArgs(["origin"], {})).toEqual({ error: expect.any(String) });
    expect(parsePushArgs(["--body-limit", "x", "origin", "main"], {})).toEqual({
      error: expect.any(String),
    });
    expect(parsePushArgs(["--nope", "origin", "main"], {})).toEqual({ error: expect.any(String) });
  });
});

describe("fyrden push --chunked", () => {
  it("packs against the remote's refs, uploads every part and completes", async () => {
    const { git, srv, d } = setup();
    expect(await push(args(), d)).toBe(0);

    // The pack: the new tip, minus every remote ref the local repository has.
    expect(git.packInputs).toEqual([`${OID.b}\n^${OID.a}\n`]);
    const packCall = git.calls.find((c) => c[0] === "pack-objects") as string[];
    expect(packCall).toEqual(expect.arrayContaining(["--revs", "--thin", "--delta-base-offset"]));

    const create = srv.requests[0];
    expect(create).toMatchObject({
      method: "POST",
      path: "/api/repos/alice/proj/uploads",
      auth: "Bearer tok",
      body: { size: 100, ref_updates: [{ ref: "refs/heads/main", old: OID.a, new: OID.b }] },
    });
    // 100 bytes in parts of 40: 40, 40, 20, with git credentials.
    const puts = srv.requests.filter((r) => r.method === "PUT");
    expect(puts.map((r) => [r.path.split("/").at(-1), r.bytes])).toEqual([
      ["1", 40],
      ["2", 40],
      ["3", 20],
    ]);
    expect(puts[0]?.auth).toBe(`Basic ${btoa("fyrden:tok")}`);
    const pack = new Uint8Array(100).map((_, i) => i % 251);
    expect([...srv.stored.keys()].sort()).toEqual([1, 2, 3]);
    expect(srv.stored.get(2)).toEqual(pack.slice(40, 80));
    expect(d.out.join("\n")).toContain(
      "   " + OID.a.slice(0, 7) + ".." + OID.b.slice(0, 7) + "  main -> main",
    );
  });

  it("takes the token from FYRDEN_TOKEN, the remote URL, or git's credential helper", async () => {
    const helper = setup({ password: "from-helper" });
    await push(args(), helper.d);
    expect(helper.git.calls).toContainEqual(["credential", "fill"]);
    expect(helper.srv.requests[0]?.auth).toBe("Bearer from-helper");

    const inUrl = setup({
      remotes: { origin: "https://u:url%2Btoken@fyrden.example/alice/proj.git" },
    });
    await push(args(), inUrl.d);
    expect(inUrl.srv.requests[0]?.auth).toBe("Bearer url+token");
    expect(inUrl.d.out.join("\n")).not.toContain("token");

    const fromEnv = setup({}, { partSize: 40 }, { FYRDEN_TOKEN: "env-token" });
    await push(args(), fromEnv.d);
    expect(fromEnv.git.calls).not.toContainEqual(["credential", "fill"]);
    expect(fromEnv.srv.requests[0]?.auth).toBe("Bearer env-token");
  });

  it("discovers, packs and uploads against the push URL, as git push would", async () => {
    // origin fetches from one repository and pushes to another.
    const { git, srv, d } = setup({
      remotes: { origin: "https://fyrden.example/alice/mirror.git" },
      pushUrls: { origin: [REMOTE] },
    });
    expect(await push(args(), d)).toBe(0);
    expect(git.calls).toContainEqual(["remote", "get-url", "--push", "--all", "origin"]);
    const lsRemote = git.calls.map(withoutConfig).filter((c) => c[0] === "ls-remote");
    expect(lsRemote).toEqual([["ls-remote", REMOTE]]);
    expect(srv.requests.map((r) => r.path)).toContain("/api/repos/alice/proj/uploads");
    expect(srv.requests.every((r) => !r.path.includes("mirror"))).toBe(true);
    expect(d.out[0]).toBe(`To ${REMOTE}`);
  });

  it("refuses a remote with several push URLs before contacting any", async () => {
    const { git, srv, d } = setup({
      pushUrls: { origin: [REMOTE, "https://fyrden.example/alice/other.git"] },
    });
    expect(await push(args(), d)).toBe(1);
    expect(d.err.join("\n")).toContain("remote origin has 2 push URLs");
    expect(git.calls.map(withoutConfig).some((c) => c[0] === "ls-remote")).toBe(false);
    expect(srv.requests).toEqual([]);
  });

  it("authenticates discovery with FYRDEN_TOKEN through a per-call credential helper, never argv", async () => {
    const { git, srv, d } = setup({}, { partSize: 40 }, { FYRDEN_TOKEN: "env-token" });
    expect(await push(args(), d)).toBe(0);
    const index = git.calls.findIndex((c) => withoutConfig(c)[0] === "ls-remote");
    const call = git.calls[index] as string[];
    // Other helpers are reset for the call; ours answers only for the push URL's origin.
    expect(call.slice(0, 4)).toEqual([
      "-c",
      "credential.helper=",
      "-c",
      expect.stringMatching(/^credential\.https:\/\/fyrden\.example\.helper=!/),
    ]);
    expect(git.envs[index]).toEqual({ FYRDEN_GIT_CREDENTIAL: "env-token" });
    expect(git.calls.flat().join(" ")).not.toContain("env-token");
    expect(srv.requests[0]?.auth).toBe("Bearer env-token");
  });

  it("moves a token in the remote URL out of argv and into the helper", async () => {
    const url = "https://u:url%2Btoken@fyrden.example/alice/proj.git";
    const { git, d } = setup({ remotes: {} });
    expect(await push(args({ remote: url }), d)).toBe(0);
    const index = git.calls.findIndex((c) => withoutConfig(c)[0] === "ls-remote");
    expect(withoutConfig(git.calls[index] as string[])).toEqual(["ls-remote", REMOTE]);
    expect(git.envs[index]).toEqual({ FYRDEN_GIT_CREDENTIAL: "url+token" });
    expect(git.calls.flat().join(" ")).not.toContain("token");
  });

  it("leaves discovery to git's own credential helpers when there is no token", async () => {
    const { git, d } = setup();
    expect(await push(args(), d)).toBe(0);
    const index = git.calls.findIndex((c) => withoutConfig(c)[0] === "ls-remote");
    expect(git.calls[index]).toEqual(["ls-remote", REMOTE]);
    expect(git.envs[index]).toBeUndefined();
  });

  it("uploads a failed part again and resumes from what the server holds", async () => {
    const { srv, d } = setup({}, { partSize: 40, failOnce: { 2: 503, 3: "network" } });
    expect(await push(args(), d)).toBe(0);
    const puts = srv.requests
      .filter((r) => r.method === "PUT")
      .map((r) => r.path.split("/").at(-1));
    expect(puts).toEqual(["1", "2", "2", "3", "3"]);
    // After a failure the client asks the session what is stored before sending more.
    expect(srv.requests.some((r) => r.method === "GET")).toBe(true);
    expect([...srv.stored.keys()].sort()).toEqual([1, 2, 3]);
  });

  it("sends a part again that another request was uploading, or that was replaced meanwhile", async () => {
    const { srv, d } = setup(
      {},
      { partSize: 40, failOnce: { 1: "part_in_progress", 2: "part_superseded" } },
    );
    expect(await push(args(), d)).toBe(0);
    const puts = srv.requests
      .filter((r) => r.method === "PUT")
      .map((r) => r.path.split("/").at(-1));
    expect(puts).toEqual(["1", "1", "2", "2", "3"]);
  });

  it("calls complete again while the server is still indexing", async () => {
    const { srv, d } = setup({}, { partSize: 40, indexingRounds: 2 });
    expect(await push(args(), d)).toBe(0);
    expect(srv.requests.filter((r) => r.path.endsWith("/complete"))).toHaveLength(3);
  });

  it("reports refs the server rejected and exits 1", async () => {
    const { d } = setup({}, { partSize: 40, rejected: { "refs/heads/main": "stale info" } });
    expect(await push(args(), d)).toBe(1);
    expect(d.out.join("\n")).toContain(" ! [rejected]        main -> main (stale info)");
  });

  it("refuses a non-fast-forward locally unless forced", async () => {
    const refused = setup({ ancestors: [] });
    expect(await push(args(), refused.d)).toBe(1);
    expect(refused.d.out.join("\n")).toContain(
      "! [rejected]        main -> main (non-fast-forward)",
    );
    expect(refused.srv.requests).toEqual([]);

    const forced = setup({ ancestors: [] });
    expect(await push(args({ refspecs: ["+main"] }), forced.d)).toBe(0);
    expect(forced.srv.requests[0]?.body).toMatchObject({
      ref_updates: [{ ref: "refs/heads/main", old: OID.a, new: OID.b }],
    });
  });

  it("refuses to update a remote ref whose old value it does not have", async () => {
    const { d, srv } = setup({ local: [] });
    expect(await push(args(), d)).toBe(1);
    expect(d.out.join("\n")).toContain("(fetch first)");
    expect(srv.requests).toEqual([]);
  });

  it("creates a new tag and names destinations as git does", async () => {
    const { srv, d } = setup();
    expect(await push(args({ refspecs: ["v2", "main:refs/heads/other"] }), d)).toBe(0);
    expect(srv.requests[0]?.body).toMatchObject({
      ref_updates: [
        { ref: "refs/tags/v2", old: null, new: OID.c },
        { ref: "refs/heads/other", old: null, new: OID.b },
      ],
    });
    const out = d.out.join("\n");
    expect(out).toContain(" * [new tag]         v2 -> v2");
    expect(out).toContain(" * [new branch]      main -> other");
  });

  it("says everything is up to date without packing or calling the server", async () => {
    const { git, srv, d } = setup({ revs: { main: OID.a } });
    expect(await push(args(), d)).toBe(0);
    expect(d.err.join("\n")).toContain("Everything up-to-date");
    expect(git.packInputs).toEqual([]);
    expect(srv.requests).toEqual([]);
  });

  it("refuses a remote that is not an http(s) URL", async () => {
    const { d } = setup({ remotes: { origin: "git@example.com:a/b.git" } });
    expect(await push(args(), d)).toBe(1);
    expect(d.err.join("\n")).toMatch(/https/);
  });

  it("removes the pack file whatever happens", async () => {
    const { files, d } = setup({}, { partSize: 40, failOnce: { 1: 422 } });
    expect(await push(args(), d)).toBe(1);
    expect(files.data.size).toBe(0);
    expect(files.removed).toHaveLength(1);
  });
});
