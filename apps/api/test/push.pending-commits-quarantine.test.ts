// Quarantine of unverified commits through the whole push path: a commit
// that never became verified (its push was rejected, at indexing or at the
// commit point) is never a base for a later push, and its pending rows are
// gone with its upload.
import { oidFromHex } from "@fyrden/git-core";
import { describe, expect, inject, it } from "vitest";
import { type PushTarget, postPush, pushTarget } from "./helpers/push.js";
import { pushBody, reportLines, ZERO } from "./helpers/push-fixtures.js";
import { inRepo } from "./helpers/repo-git.js";

const fx = inject("pushFixtures");
const MAIN = "refs/heads/main";
const LONE = "refs/heads/lone";
const CHILD = "refs/heads/child";

async function seed(target: PushTarget) {
  const reply = await postPush(
    target,
    pushBody([{ old: ZERO, new: fx.c2, ref: MAIN }], { pack: fx.packC2 }),
  );
  expect(reply.report).toEqual(["unpack ok\n", `ok ${MAIN}\n`, "0000"]);
}

async function graphState(target: PushTarget) {
  return inRepo(target.repo.stub, async ({ git }) => ({
    refs: [...git.refStore.readRefsSync().refs.keys()],
    pending: git.context.storage.sql
      .exec<{ n: number }>("SELECT count(*) AS n FROM pending_commits")
      .one().n,
    lone: (await git.commitGraph.read([oidFromHex(fx.lone)], "verified"))[0] !== undefined,
    live: git.registry.inState("live").length,
  }));
}

const pushChild = (target: PushTarget) =>
  postPush(
    target,
    pushBody([{ old: ZERO, new: fx.child, ref: CHILD }], { pack: fx.packChildWithoutParent }),
  );

describe("push: quarantine of unverified commits", () => {
  it("rejects a commit whose tree is missing, then a child of it", async () => {
    const target = await pushTarget();
    await seed(target);
    const a = await postPush(
      target,
      pushBody([{ old: ZERO, new: fx.lone, ref: LONE }], { pack: fx.packLoneWithoutTree }),
    );
    expect(a.report).toEqual([
      "unpack index-pack abnormal exit\n",
      `ng ${LONE} unpacker error\n`,
      "0000",
    ]);
    expect(a.progress.join("")).toMatch(/did not receive expected object/);

    const b = await pushChild(target);
    expect(b.report).toEqual([
      "unpack index-pack abnormal exit\n",
      `ng ${CHILD} unpacker error\n`,
      "0000",
    ]);
    expect(b.progress.join("")).toContain(`did not receive expected object ${fx.lone}`);
    expect(await graphState(target)).toEqual({ refs: [MAIN], pending: 0, lone: false, live: 1 });
  });

  it("drops the pending rows of a push refused at the commit point; a child of it is rejected", async () => {
    const target = await pushTarget();
    await seed(target);
    const { stub } = target.repo;
    const begun = await stub.beginPush({
      principal: target.owner.principalId,
      tokenId: "tok_quarantine",
    });
    if (!begun.ok) throw new Error(begun.error);
    const body = pushBody([{ old: ZERO, new: fx.lone, ref: LONE }], {
      pack: fx.packLoneWithTree,
    });
    await inRepo(stub, ({ git }) => git.bucket.put(begun.bodyKey, body));
    let progress = await stub.runPush(begun.uploadId, body.length, 10_000);
    while (progress.state === "indexing") progress = await stub.pushStatus(begun.uploadId, 10_000);
    // Indexing proved the closure and wrote pending rows for this upload only.
    const pending = await inRepo(stub, async ({ git }) => ({
      own: (await git.commitGraph.read([oidFromHex(fx.lone)], { uploadId: begun.uploadId }))[0]
        ?.state,
      verified: (await git.commitGraph.read([oidFromHex(fx.lone)], "verified"))[0],
    }));
    expect(pending).toEqual({ own: "pending", verified: undefined });

    const refused = await stub.finalizePush(begun.uploadId, {
      refusal: "the token used for this push is no longer valid",
      tokenId: "tok_quarantine",
      decidedAt: Date.now(),
    });
    expect(reportLines(refused).report).toEqual([
      "unpack ok\n",
      `ng ${LONE} the token used for this push is no longer valid\n`,
      "0000",
    ]);
    expect(await graphState(target)).toEqual({ refs: [MAIN], pending: 0, lone: false, live: 1 });

    const child = await pushChild(target);
    expect(child.report).toEqual([
      "unpack index-pack abnormal exit\n",
      `ng ${CHILD} unpacker error\n`,
      "0000",
    ]);
    expect(child.progress.join("")).toContain(`did not receive expected object ${fx.lone}`);
    expect(await graphState(target)).toEqual({ refs: [MAIN], pending: 0, lone: false, live: 1 });
  });
});
