import { beforeEach, describe, expect, it } from "vitest";
import { oidFromHex, oidToHex } from "../../src/object/oid.js";
import type { CommitGraph } from "../../src/ports/commit-graph.js";
import type { RepoView } from "../../src/reader/view.js";
import { buildPack, gitOid, makeDelta, type PackEntrySpec, text } from "../pack/pack-builder.js";
import { commitBody, type MemoryServer, memoryServer, request, treeBody } from "./support.js";

/*
 * A pack shared in a fork network can hold another member's objects. A
 * push must not reach them: not as a thin base, a link target or a ref
 * tip. The fixture is one "mixed" pack, marked shared in the view, holding
 * this repository's history (main) and a sibling's private blob that no ref
 * or verified commit of this repository reaches.
 */

type Spec = { kind: "commit" | "tree" | "blob" | "tag"; data: Uint8Array };
const obj = (kind: Spec["kind"], data: Uint8Array | string) => {
  const bytes = typeof data === "string" ? text(data) : data;
  return { spec: { kind, data: bytes } as Spec, oid: gitOid(kind, bytes) };
};
const packOf = (entries: readonly PackEntrySpec[]) => buildPack(entries).bytes;

const publicBlob = obj("blob", "public file\n");
const tree = obj("tree", treeBody([["100644", "a", publicBlob.oid]]));
const main = obj("commit", commitBody(tree.oid, [], "main"));
const secret = obj("blob", "sibling secret\n");

let server: MemoryServer;
let shared: RepoView;

beforeEach(async () => {
  server = memoryServer();
  // The private blob rides along, unreferenced: nothing of this repository reaches it.
  const first = await server.push(
    request(
      [{ new: main.oid, ref: "refs/heads/main" }],
      packOf([publicBlob.spec, tree.spec, main.spec, secret.spec]),
    ),
  );
  expect(first.lines).toEqual(["unpack ok", "ok refs/heads/main"]);
  const view = await server.view();
  shared = { ...view, packs: view.packs.map((pack) => ({ ...pack, shared: true })) };
});

async function refNames(): Promise<string[]> {
  return [...(await server.refStore.readRefs()).refs.keys()].sort();
}

describe("push.shared-pack-closure", () => {
  it("does not resolve a thin base found only outside this repository's closure", async () => {
    // A REF_DELTA that copies the whole private blob, and a tag at the result.
    const thin = packOf([
      {
        kind: "ref",
        baseOid: secret.oid,
        delta: makeDelta(secret.spec.data, secret.spec.data),
      },
    ]);
    const stolen = await server.push(
      request([{ new: secret.oid, ref: "refs/tags/stolen" }], thin),
      { index: { view: shared } },
    );
    expect(stolen.lines).toEqual([
      "unpack index-pack abnormal exit",
      "ng refs/tags/stolen unpacker error",
    ]);
    // The same answer as for a base that is nowhere.
    const absent = "0123456789abcdef0123456789abcdef01234567";
    const nowhere = await server.push(
      request(
        [{ new: secret.oid, ref: "refs/tags/nowhere" }],
        packOf([{ kind: "ref", baseOid: absent, delta: makeDelta(text("x"), text("x")) }]),
      ),
      { index: { view: shared } },
    );
    expect(stolen.result?.messages.map((m) => m.replace(secret.oid, "<base>"))).toEqual(
      nowhere.result?.messages.map((m) => m.replace(absent, "<base>")),
    );
    expect(await refNames()).toEqual(["refs/heads/main"]);
  });

  it("does not accept a ref tip found only outside this repository's closure", async () => {
    const empty = packOf([]);
    const stolen = await server.push(
      request([{ new: secret.oid, ref: "refs/tags/stolen" }], empty),
      { index: { view: shared } },
    );
    expect(stolen.lines).toEqual(["unpack ok", "ng refs/tags/stolen missing necessary objects"]);
    expect(await refNames()).toEqual(["refs/heads/main"]);
  });

  it("does not satisfy a link with an object outside this repository's closure", async () => {
    const t = obj("tree", treeBody([["100644", "s", secret.oid]]));
    const c = obj("commit", commitBody(t.oid, [main.oid], "link"));
    const linked = await server.push(
      request([{ new: c.oid, ref: "refs/heads/link" }], packOf([t.spec, c.spec])),
      { index: { view: shared } },
    );
    expect(linked.lines[0]).toBe("unpack index-pack abnormal exit");
    expect(linked.result?.messages).toContain(
      `fatal: did not receive expected object ${secret.oid}`,
    );
  });

  it("uses objects of a shared pack that this repository's history reaches", async () => {
    const added = obj("blob", "added\n");
    const t = obj(
      "tree",
      treeBody([
        ["100644", "a", publicBlob.oid],
        ["100644", "b", added.oid],
      ]),
    );
    const c = obj("commit", commitBody(t.oid, [main.oid], "next"));
    // The new blob as a thin delta against the public one; the tree links it too.
    const changed = obj("blob", "public file, changed\n");
    const t2 = obj("tree", treeBody([["100644", "a", changed.oid]]));
    const c2 = obj("commit", commitBody(t2.oid, [c.oid], "thin"));
    const pushed = await server.push(
      request(
        [
          { new: c2.oid, ref: "refs/heads/next" },
          { new: tree.oid, ref: "refs/tags/tree" },
        ],
        packOf([
          added.spec,
          t.spec,
          c.spec,
          {
            kind: "ref",
            baseOid: publicBlob.oid,
            delta: makeDelta(publicBlob.spec.data, changed.spec.data),
          },
          t2.spec,
          c2.spec,
        ]),
      ),
      { index: { view: shared } },
    );
    expect(pushed.lines).toEqual(["unpack ok", "ok refs/heads/next", "ok refs/tags/tree"]);
  });
});

describe("push.shared-pack-closure through history", () => {
  // main moves to a commit whose tree drops the public blob; only its parent's tree has it.
  const other = obj("blob", "other file\n");
  const laterTree = obj("tree", treeBody([["100644", "b", other.oid]]));
  const later = obj("commit", commitBody(laterTree.oid, [main.oid], "drop a"));

  beforeEach(async () => {
    const moved = await server.push(
      request(
        [{ old: main.oid, new: later.oid, ref: "refs/heads/main" }],
        packOf([other.spec, laterTree.spec, later.spec]),
      ),
    );
    expect(moved.lines).toEqual(["unpack ok", "ok refs/heads/main"]);
    const view = await server.view();
    shared = { ...view, packs: view.packs.map((pack) => ({ ...pack, shared: true })) };
  });

  it("accepts a ref tip reachable only through an ancestor commit's tree", async () => {
    const pushed = await server.push(
      request([{ new: publicBlob.oid, ref: "refs/tags/old-a" }], packOf([])),
      { index: { view: shared } },
    );
    expect(pushed.lines).toEqual(["unpack ok", "ok refs/tags/old-a"]);
  });

  it("lets a new commit link an object that only an ancestor's tree reaches", async () => {
    const t = obj(
      "tree",
      treeBody([
        ["100644", "a", publicBlob.oid],
        ["100644", "b", other.oid],
      ]),
    );
    const c = obj("commit", commitBody(t.oid, [later.oid], "restore a"));
    const pushed = await server.push(
      request([{ old: later.oid, new: c.oid, ref: "refs/heads/main" }], packOf([t.spec, c.spec])),
      { index: { view: shared } },
    );
    expect(pushed.lines).toEqual(["unpack ok", "ok refs/heads/main"]);
  });

  it("fails closed when the proof's reads run out before the ancestor's tree", async () => {
    const pushed = await server.push(
      request([{ new: publicBlob.oid, ref: "refs/tags/old-a" }], packOf([])),
      { index: { view: shared, limits: { closureReads: 1 } } },
    );
    expect(pushed.lines).toEqual(["unpack ok", "ng refs/tags/old-a missing necessary objects"]);
  });

  it("still refuses an object no commit of the history reaches", async () => {
    const stolen = await server.push(
      request([{ new: secret.oid, ref: "refs/tags/stolen" }], packOf([])),
      { index: { view: shared } },
    );
    expect(stolen.lines).toEqual(["unpack ok", "ng refs/tags/stolen missing necessary objects"]);
  });
});

describe("push.shallow-and-unverified-tips", () => {
  it("refuses a whole upload whose shallow history ends at a commit this repository lacks", async () => {
    await server.push(request([{ new: main.oid, ref: "refs/heads/old" }], packOf([])));
    const lacking = "fedcba9876543210fedcba9876543210fedcba98";
    const t = obj("tree", treeBody([["100644", "c", publicBlob.oid]]));
    const c = obj("commit", commitBody(t.oid, [lacking], "shallow"));
    const mixed = await server.push(
      request(
        [
          { old: main.oid, ref: "refs/heads/old" },
          { new: c.oid, ref: "refs/heads/c" },
        ],
        packOf([t.spec, c.spec]),
        { shallow: [lacking] },
      ),
    );
    expect(mixed.lines).toEqual([
      "unpack index-pack abnormal exit",
      "ng refs/heads/old unpacker error",
      "ng refs/heads/c unpacker error",
    ]);
    expect(mixed.result?.messages.join("\n")).toContain("shallow update not allowed");
    expect(mixed.result?.uploadCommitted).toBe(false);
    expect(await refNames()).toEqual(["refs/heads/main", "refs/heads/old"]);
    // Nothing of the upload became live: its commit cannot be named later.
    const later = await server.push(request([{ new: c.oid, ref: "refs/heads/c2" }], packOf([])));
    expect(later.lines).toEqual(["unpack ok", "ng refs/heads/c2 missing necessary objects"]);
  });

  it("refuses an existing commit as a ref tip without a verified row", async () => {
    // The commit is in a live pack, but its closure was never proven.
    const hidden = oidToHex(oidFromHex(main.oid));
    const graph: CommitGraph = {
      ...server.graph,
      read: async (oids, view) =>
        (await server.graph.read(oids, view)).map((row, i) =>
          oidToHex(oids[i] as never) === hidden ? undefined : row,
        ),
    };
    const pushed = await server.push(
      request([{ new: main.oid, ref: "refs/heads/x" }], packOf([])),
      {
        index: { commitGraph: graph },
      },
    );
    expect(pushed.lines).toEqual(["unpack ok", "ng refs/heads/x missing necessary objects"]);
  });
});
