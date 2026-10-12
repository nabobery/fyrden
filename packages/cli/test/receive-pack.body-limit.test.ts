// Push body limits, the CLI side: Cloudflare refuses a request body above
// the plan's limit with its own 413 before the Worker runs (104,857,600
// bytes on Free and Pro, measured 2026-10-10), so `fyrden push` checks the
// pack size first and, above the limit, names it and `fyrden push --chunked`.
import { describe, expect, it } from "vitest";
import { DEFAULT_BODY_LIMIT, parsePushArgs, push } from "../src/commands/push.ts";
import { deps, fakeFiles, fakeGit, OID } from "./fake-push.ts";

const REMOTE = "https://fyrden.example/alice/proj.git";

function setup(packBytes: number, env: Record<string, string | undefined> = {}) {
  const files = fakeFiles();
  const git = fakeGit(
    {
      remotes: { origin: REMOTE },
      remoteRefs: {},
      revs: { main: OID.a },
      fullNames: { main: "refs/heads/main" },
      packBytes,
    },
    files,
  );
  return { git, files, d: deps(git, files, undefined, env) };
}

describe("fyrden push preflight (receive-pack.body-limit)", () => {
  it("defaults to the Free and Pro request body limit", () => {
    expect(DEFAULT_BODY_LIMIT).toBe(104_857_600);
    expect(parsePushArgs(["origin", "main"], {})).toMatchObject({ bodyLimit: 104_857_600 });
    expect(
      parsePushArgs(["origin", "main"], { FYRDEN_PUSH_BODY_LIMIT: "209715200" }),
    ).toMatchObject({ bodyLimit: 209_715_200 });
    expect(parsePushArgs(["--body-limit", "5000", "origin", "main"], {})).toMatchObject({
      bodyLimit: 5000,
    });
  });

  it("refuses a pack above the limit, naming the limit and fyrden push --chunked, before any upload", async () => {
    const { git, files, d } = setup(2_000);
    const code = await push(
      { remote: "origin", refspecs: ["main"], chunked: false, force: false, bodyLimit: 1_000 },
      d,
    );
    expect(code).toBe(1);
    const message = d.err.join("\n");
    expect(message).toContain("1000 bytes");
    expect(message).toContain("fyrden push --chunked origin main");
    // Stock git push is never run, and the pack is removed.
    expect(git.passthroughs).toEqual([]);
    expect(files.data.size).toBe(0);
  });

  it("counts the command section too: a pack just under the limit can still be over it", async () => {
    const { git, d } = setup(990);
    expect(
      await push(
        { remote: "origin", refspecs: ["main"], chunked: false, force: false, bodyLimit: 1_000 },
        d,
      ),
    ).toBe(1);
    expect(git.passthroughs).toEqual([]);
  });

  it("hands a push under the limit to git push", async () => {
    const { git, files, d } = setup(500);
    const code = await push(
      { remote: "origin", refspecs: ["main"], chunked: false, force: false, bodyLimit: 1_000 },
      d,
    );
    expect(code).toBe(0);
    expect(git.passthroughs).toEqual([["push", "origin", "main"]]);
    expect(files.data.size).toBe(0);
  });

  it("hands FYRDEN_TOKEN to git push through the per-call credential helper, not argv", async () => {
    const { git, d } = setup(500, { FYRDEN_TOKEN: "env-token" });
    const code = await push(
      { remote: "origin", refspecs: ["main"], chunked: false, force: false, bodyLimit: 1_000 },
      d,
    );
    expect(code).toBe(0);
    const [call] = git.passthroughs as [string[]];
    expect(call.slice(0, 2)).toEqual(["-c", "credential.helper="]);
    expect(call.slice(4)).toEqual(["push", "origin", "main"]);
    expect(git.envs.at(-1)).toEqual({ FYRDEN_GIT_CREDENTIAL: "env-token" });
    expect(git.calls.flat().join(" ")).not.toContain("env-token");
  });

  it("pushes to a URL remote without the token it carries in argv", async () => {
    const { git, d } = setup(500);
    const code = await push(
      {
        remote: "https://fyrden:s3cret@fyrden.example/alice/proj.git",
        refspecs: ["main"],
        chunked: false,
        force: false,
        bodyLimit: 1_000,
      },
      d,
    );
    expect(code).toBe(0);
    expect((git.passthroughs[0] as string[]).slice(4)).toEqual(["push", REMOTE, "main"]);
    expect(git.envs.at(-1)).toEqual({ FYRDEN_GIT_CREDENTIAL: "s3cret" });
    expect(git.calls.flat().join(" ")).not.toContain("s3cret");
  });
});
