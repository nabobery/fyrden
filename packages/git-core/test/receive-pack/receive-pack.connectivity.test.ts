import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { oidToHex } from "../../src/object/oid.js";
import { createGitSandbox, type GitSandbox } from "../../testing/git-cli.js";
import {
  commitBody,
  gitReceivePack,
  type MemoryServer,
  memoryServer,
  oracleRepo,
  packOf,
  request,
  tagBody,
  treeBody,
  writeObject,
} from "./support.js";

/*
 * Connectivity: every link of every new object must resolve
 * to an object of the right type, in the pack or among the repository's
 * verified objects; ref tips must exist. Pushes are crafted with
 * `git hash-object --literally` and `git pack-objects` (which packs exactly
 * the objects named, broken ones included), and the same request goes to
 * `git receive-pack` with receive.fsckObjects on, whose report must match.
 */

let sandbox: GitSandbox;
let oracle: string;
let server: MemoryServer;
let blob: string;
let tree: string;
let base: string;
const missing = "1234567890123456789012345678901234567890";

beforeAll(async () => {
  sandbox = await createGitSandbox();
  await sandbox.git(["init", "-q", "-b", "main"]);
  oracle = await oracleRepo(sandbox);
  server = memoryServer();
  blob = await writeObject(sandbox, "blob", "base\n");
  const sub = await writeObject(sandbox, "tree", treeBody([["100644", "f", blob]]));
  tree = await writeObject(
    sandbox,
    "tree",
    treeBody([
      ["100644", "a", blob],
      ["40000", "sub", sub],
    ]),
  );
  base = await writeObject(sandbox, "commit", commitBody(tree));
  const body = request(
    [{ new: base, ref: "refs/heads/main" }],
    await packOf(sandbox, [blob, sub, tree, base]),
  );
  expect((await server.push(body)).lines).toEqual(await gitReceivePack(sandbox, oracle, body));
});
afterAll(() => sandbox.dispose());

/** Pushes `objects` with one command to both servers; returns both reports. */
async function pushBoth(ref: string, tip: string, objects: readonly string[], old?: string) {
  const body = request(
    [{ new: tip, ref, ...(old ? { old } : {}) }],
    await packOf(sandbox, objects),
  );
  const ours = await server.push(body);
  const git = await gitReceivePack(sandbox, oracle, body);
  return { ours, git };
}

describe("receive-pack.connectivity", () => {
  it("refuses a new commit whose tree is missing", async () => {
    const c = await writeObject(sandbox, "commit", commitBody(missing, [base]));
    const { ours, git } = await pushBoth("refs/heads/a", c, [c]);
    expect(ours.lines).toEqual(git);
    expect(ours.lines[0]).toBe("unpack index-pack abnormal exit");
    expect(ours.result?.messages).toContain(`fatal: did not receive expected object ${missing}`);
  });

  it("refuses a new commit whose parent is missing", async () => {
    const c = await writeObject(sandbox, "commit", commitBody(tree, [missing]));
    const { ours, git } = await pushBoth("refs/heads/b", c, [c]);
    expect(ours.lines).toEqual(git);
    expect(ours.lines[1]).toBe("ng refs/heads/b unpacker error");
  });

  it("refuses a new tree with an entry that is missing", async () => {
    const t = await writeObject(sandbox, "tree", treeBody([["100644", "gone", missing]]));
    const c = await writeObject(sandbox, "commit", commitBody(t, [base]));
    const { ours, git } = await pushBoth("refs/heads/c", c, [t, c]);
    expect(ours.lines).toEqual(git);
    expect(ours.lines[0]).toBe("unpack index-pack abnormal exit");
  });

  it("refuses an annotated tag of a tree with a missing blob", async () => {
    const t = await writeObject(sandbox, "tree", treeBody([["100644", "x", missing]]));
    const tag = await writeObject(sandbox, "tag", tagBody(t, "tree", "tree-tag"));
    const { ours, git } = await pushBoth("refs/tags/tree-tag", tag, [t, tag]);
    expect(ours.lines).toEqual(git);
    expect(ours.lines[0]).toBe("unpack index-pack abnormal exit");
  });

  it("follows tag -> tag -> commit and accepts a complete chain", async () => {
    const inner = await writeObject(sandbox, "tag", tagBody(base, "commit", "inner"));
    const outer = await writeObject(sandbox, "tag", tagBody(inner, "tag", "outer"));
    const { ours, git } = await pushBoth("refs/tags/outer", outer, [inner, outer]);
    expect(ours.lines).toEqual(git);
    expect(ours.lines).toEqual(["unpack ok", "ok refs/tags/outer"]);
  });

  it("validates tag -> blob by type", async () => {
    const b = await writeObject(sandbox, "blob", "tagged\n");
    const good = await writeObject(sandbox, "tag", tagBody(b, "blob", "blob-tag"));
    const ok = await pushBoth("refs/tags/blob-tag", good, [b, good]);
    expect(ok.ours.lines).toEqual(ok.git);
    expect(ok.ours.lines).toEqual(["unpack ok", "ok refs/tags/blob-tag"]);
    // A tag that says "commit" about a blob.
    const lying = await writeObject(sandbox, "tag", tagBody(b, "commit", "liar"));
    const bad = await pushBoth("refs/tags/liar", lying, [lying]);
    expect(bad.ours.lines).toEqual(bad.git);
    expect(bad.ours.result?.messages.join("\n")).toContain(
      `object ${b}: expected type commit, found blob`,
    );
  });

  it("skips gitlinks", async () => {
    const t = await writeObject(sandbox, "tree", treeBody([["160000", "module", missing]]));
    const c = await writeObject(sandbox, "commit", commitBody(t, [base]));
    const { ours, git } = await pushBoth("refs/heads/sub", c, [t, c]);
    expect(ours.lines).toEqual(git);
    expect(ours.lines).toEqual(["unpack ok", "ok refs/heads/sub"]);
  });

  it("reports a ref tip that is nowhere as missing necessary objects", async () => {
    const { ours, git } = await pushBoth("refs/heads/ghost", missing, []);
    expect(ours.lines).toEqual(git);
    expect(ours.lines).toEqual(["unpack ok", "ng refs/heads/ghost missing necessary objects"]);
  });

  it("stops at objects the repository already has (verified closures are boundaries)", async () => {
    // A new commit whose tree keeps the existing subtree and adds one blob.
    const b = await writeObject(sandbox, "blob", "new\n");
    const { stdout: sub } = await sandbox.git(["rev-parse", `${tree}:sub`]);
    const t = await writeObject(
      sandbox,
      "tree",
      treeBody([
        ["100644", "a", blob],
        ["100644", "n", b],
        ["40000", "sub", sub.trim()],
      ]),
    );
    const c = await writeObject(sandbox, "commit", commitBody(t, [base]));
    const looked: string[] = [];
    const view = await server.view((_, oid) => looked.push(Buffer.from(oid).toString("hex")));
    const body = request(
      [{ new: c, ref: "refs/heads/boundary" }],
      await packOf(sandbox, [b, t, c]),
    );
    const ours = await server.push(body, { index: { view } });
    expect(ours.lines).toEqual(await gitReceivePack(sandbox, oracle, body));
    expect(ours.lines).toEqual(["unpack ok", "ok refs/heads/boundary"]);
    // The existing subtree, blob and parent are looked up; nothing inside the subtree is.
    expect(new Set(looked)).toEqual(new Set([blob, sub.trim(), base]));
  });

  it("fails closed beyond its lookup budget", async () => {
    const c = await writeObject(sandbox, "commit", commitBody(tree, [base], "budget"));
    const body = request([{ new: c, ref: "refs/heads/budget" }], await packOf(sandbox, [c]));
    const ours = await server.push(body, { index: { limits: { maxExternalLookups: 1 } } });
    expect(ours.lines).toEqual([
      "unpack index-pack abnormal exit",
      "ng refs/heads/budget unpacker error",
    ]);
    expect(ours.result?.messages.join("\n")).toContain("exceeded its limit of 1 lookups");
  });

  it("refuses to point a branch at something other than a commit (git allows it)", async () => {
    const ours = await server.push(
      request([{ new: tree, ref: "refs/heads/tree" }], await packOf(sandbox, [])),
    );
    expect(ours.lines).toEqual(["unpack ok", "ng refs/heads/tree branch must point to a commit"]);
    // Under refs/tags/ any object is fine.
    const tagged = await server.push(
      request([{ new: tree, ref: "refs/tags/tree" }], await packOf(sandbox, [])),
    );
    expect(tagged.lines).toEqual(["unpack ok", "ok refs/tags/tree"]);
  });

  it("never left a refused push's objects or rows behind", async () => {
    const refs = await server.refStore.readRefs();
    expect([...refs.refs.keys()].sort()).toEqual(
      [
        "refs/heads/boundary",
        "refs/heads/main",
        "refs/heads/sub",
        "refs/tags/blob-tag",
        "refs/tags/outer",
        "refs/tags/tree",
      ].sort(),
    );
    expect(oidToHex(refs.refs.get("refs/heads/main") as never)).toBe(base);
  });
});
