import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { oidFromHex } from "../../src/object/oid.js";
import { createGitSandbox, type GitSandbox } from "../../testing/git-cli.js";
import {
  commitBody,
  type MemoryServer,
  memoryServer,
  packOf,
  request,
  treeBody,
  writeObject,
} from "./support.js";

/*
 * Quarantine of unverified commits (engine half): a refused push's pending
 * commit rows are never visible (not to the verified view, not to later
 * uploads), and a later push that builds on one of its commits is refused.
 */

let sandbox: GitSandbox;
let server: MemoryServer;
let tree: string;
let base: string;
const missing = "9".repeat(40);

beforeAll(async () => {
  sandbox = await createGitSandbox();
  await sandbox.git(["init", "-q", "-b", "main"]);
  server = memoryServer();
  const blob = await writeObject(sandbox, "blob", "x\n");
  tree = await writeObject(sandbox, "tree", treeBody([["100644", "x", blob]]));
  base = await writeObject(sandbox, "commit", commitBody(tree));
  const pushed = await server.push(
    request([{ new: base, ref: "refs/heads/main" }], await packOf(sandbox, [blob, tree, base])),
  );
  expect(pushed.lines).toEqual(["unpack ok", "ok refs/heads/main"]);
});
afterAll(() => sandbox.dispose());

describe("push.pending-commits-quarantine", () => {
  it("refuses a child of a commit from a refused push (missing tree)", async () => {
    const c = await writeObject(sandbox, "commit", commitBody(missing, [base], "C"));
    const a = await server.push(
      request([{ old: base, new: c, ref: "refs/heads/main" }], await packOf(sandbox, [c])),
      { uploadId: "push-a" },
    );
    expect(a.lines).toEqual([
      "unpack index-pack abnormal exit",
      "ng refs/heads/main unpacker error",
    ]);
    expect(await server.graph.read([oidFromHex(c)], { uploadId: "push-a" })).toEqual([undefined]);

    const d = await writeObject(sandbox, "commit", commitBody(tree, [c], "D"));
    const b = await server.push(
      request([{ old: base, new: d, ref: "refs/heads/main" }], await packOf(sandbox, [d])),
      { uploadId: "push-b" },
    );
    expect(b.lines).toEqual([
      "unpack index-pack abnormal exit",
      "ng refs/heads/main unpacker error",
    ]);
    expect(b.result?.messages).toContain(`fatal: did not receive expected object ${c}`);
  });

  it("discards the pending rows of a valid push refused at the commit point", async () => {
    const c = await writeObject(sandbox, "commit", commitBody(tree, [base], "valid"));
    let seenDuringCommit: unknown[] = [];
    const a = await server.push(
      request([{ old: base, new: c, ref: "refs/heads/main" }], await packOf(sandbox, [c])),
      {
        uploadId: "push-c",
        finalize: {
          reauthorize: async () => {
            // Indexed: the row is pending for this upload only.
            seenDuringCommit = [
              (await server.graph.read([oidFromHex(c)], { uploadId: "push-c" }))[0]?.state,
              (await server.graph.read([oidFromHex(c)], "verified"))[0],
              (await server.graph.read([oidFromHex(c)], { uploadId: "other" }))[0],
            ];
            return "token revoked";
          },
        },
      },
    );
    expect(seenDuringCommit).toEqual(["pending", undefined, undefined]);
    expect(a.lines).toEqual(["unpack ok", "ng refs/heads/main token revoked"]);
    expect(await server.graph.read([oidFromHex(c)], { uploadId: "push-c" })).toEqual([undefined]);

    // A later push of a child, without the refused commit, is refused.
    const d = await writeObject(sandbox, "commit", commitBody(tree, [c], "child"));
    const b = await server.push(
      request([{ old: base, new: d, ref: "refs/heads/main" }], await packOf(sandbox, [d])),
    );
    expect(b.lines).toEqual([
      "unpack index-pack abnormal exit",
      "ng refs/heads/main unpacker error",
    ]);
    const refs = await server.refStore.readRefs();
    expect(Buffer.from(refs.refs.get("refs/heads/main") as Uint8Array).toString("hex")).toBe(base);
  });
});
