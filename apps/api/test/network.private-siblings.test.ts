// Private siblings with real borrowed packs: G, a private fork, opened a
// pull request into P, so G's commits are in P's pack (under
// `refs/pull/1/head`). F, a fork of P made by `repos.fork`'s engine path,
// borrows that pack: every block of G's objects is readable by F's reader,
// yet nothing only G's work reaches is served through F, by fetch want, by
// negotiation, or by the object check (commit, path, diff). The engine-level
// version of these checks (simulated borrowing) is authz.private-siblings
// and git-core's upload-pack.wants-reachable.

import { beforeAll, describe, expect, inject, it } from "vitest";
import { loadFixture } from "./helpers/fetch-repo.js";
import { createRepo, type TestRepo } from "./helpers/git-http.js";
import { cloneObjects, fork, type Owner } from "./helpers/network.js";
import { principalWithToken } from "./helpers/principals.js";
import { inRepo } from "./helpers/repo-git.js";

const fx = inject("gcFixtures");
const tipOf = (name: string) => fx.repo.refs.find((r) => r.name === name)?.oid as string;

let pOwner: Owner;
let fOwner: Owner;
let p: TestRepo;
let f: TestRepo;

beforeAll(async () => {
  pOwner = await principalWithToken("user", "git");
  fOwner = await principalWithToken("user", "git");
  p = await createRepo(pOwner.principalId);
  await loadFixture(
    p.stub,
    {
      ...fx.repo,
      refs: fx.repo.refs.map((r) =>
        r.name === "refs/heads/side" ? { ...r, name: "refs/pull/1/head" } : r,
      ),
    },
    { allReachable: false },
  );
  f = (await fork(pOwner, p, fOwner)).repo;
});

describe("a fork never serves a private sibling's objects from a borrowed pack", () => {
  it("the borrowed pack holds G's objects", async () => {
    const borrowed = await inRepo(f.stub, ({ git }) =>
      git.context.storage.sql
        .exec<{ origin: string }>("SELECT origin FROM packs WHERE state = 'live'")
        .toArray()
        .map((r) => r.origin),
    );
    expect(borrowed).toEqual(["borrowed"]);
    expect(fx.all).toContain(fx.side);
  });

  it("refuses wants of G's commit, and of G's trees and blobs by SHA", async () => {
    const sideCommit = await p.stub.objectAccess({ kind: "commit", commit: fx.side });
    expect(sideCommit.ok).toBe(true);
    const sideBlob = await p.stub.objectAccess({
      kind: "path",
      commit: fx.side,
      path: "only-side.txt",
    });
    const sideTree = await p.stub.objectAccess({ kind: "path", commit: fx.side, path: "" });
    if (!sideBlob.ok || sideBlob.kind === "diff" || !sideTree.ok || sideTree.kind === "diff")
      throw new Error("P should show G's objects through its pull request ref");
    for (const want of [fx.side, sideBlob.oid, sideTree.oid]) {
      const answer = await cloneObjects(fOwner, f, [want], ["done"]);
      expect(answer.error).toMatch(/not our ref/);
    }
  });

  it("never acknowledges G's commit as common", async () => {
    const answer = await cloneObjects(fOwner, f, [tipOf("refs/heads/main")], [`have ${fx.side}`]);
    expect(answer.acks ?? []).not.toContain(`ACK ${fx.side}`);
  });

  it("the object check denies G's commit, its paths and diffs through F", async () => {
    const main = tipOf("refs/heads/main");
    expect(await f.stub.objectAccess({ kind: "commit", commit: fx.side })).toEqual({ ok: false });
    expect(
      await f.stub.objectAccess({ kind: "path", commit: fx.side, path: "only-side.txt" }),
    ).toEqual({ ok: false });
    expect(await f.stub.objectAccess({ kind: "diff", base: main, head: fx.side })).toEqual({
      ok: false,
    });
    // F's own history is served.
    expect((await f.stub.objectAccess({ kind: "commit", commit: main })).ok).toBe(true);
  });
});
