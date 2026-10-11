// Push indexing reads stored packs (a thin pack's external bases, link
// targets) through the object's pack block tier, scoped to the
// repository's network, like fetch planning does.
import { env } from "cloudflare:workers";
import { createLogger } from "@fyrden/adapters-cloudflare/obs";
import type { BlockCache } from "@fyrden/git-core";
import { describe, expect, inject, it } from "vitest";
import { PACK_CAP_DEFAULTS } from "../src/git/maintenance/tail-merge-plan.js";
import { RepoPush } from "../src/git/push/repo-push.js";
import { pushBody, reportLines, ZERO } from "./helpers/push-fixtures.js";
import { inRepo, newRepo } from "./helpers/repo-git.js";

const fx = inject("pushFixtures");
const MAIN = "refs/heads/main";

describe("push: pack block cache", () => {
  it("a thin push reads its external bases through the block tier of the repository's network", async () => {
    const { stub, networkId } = await newRepo();
    const result = await inRepo(stub, async (repo) => {
      const calls: { op: "get" | "put"; scope: string; packId: string; hit: boolean }[] = [];
      const blocks = new Map<string, Uint8Array>();
      const spy: BlockCache = {
        async get(scope, packId, index) {
          const block = blocks.get(`${scope}/${packId}/${index}`);
          calls.push({ op: "get", scope, packId, hit: block !== undefined });
          return block;
        },
        async put(scope, packId, index, block) {
          calls.push({ op: "put", scope, packId, hit: false });
          blocks.set(`${scope}/${packId}/${index}`, block.slice());
        },
      };
      const push = new RepoPush(
        repo.git,
        repo.git.context.metrics,
        createLogger({ test: "push-block-cache" }),
        () => PACK_CAP_DEFAULTS,
        () => spy,
      );
      const run = async (bytes: Uint8Array) => {
        const begun = push.begin({ principal: "usr_blocks", tokenId: "tok_blocks" });
        if (!begun.ok) throw new Error(begun.error);
        await env.GIT.put(begun.bodyKey, bytes);
        let progress = await push.run(begun.uploadId, bytes.length, 10_000);
        for (let i = 0; progress.state === "indexing" && i < 50; i++)
          progress = await push.status(begun.uploadId, 10_000);
        const response =
          progress.state === "done"
            ? progress.response
            : await push.finalize(begun.uploadId, {
                tokenId: "tok_blocks",
                decidedAt: Date.now(),
              });
        return reportLines(response).report;
      };
      const seeded = await run(
        pushBody([{ old: ZERO, new: fx.c2, ref: MAIN }], { pack: fx.packC2 }),
      );
      const base = repo.git.registry.liveOwn()[0]?.packId;
      const before = calls.length;
      const thin = await run(
        pushBody([{ old: fx.c2, new: fx.c3, ref: MAIN }], { pack: fx.packC3ThinOnC2 }),
      );
      return { seeded, thin, base, calls: calls.slice(before) };
    });
    expect(result.seeded).toEqual(["unpack ok\n", `ok ${MAIN}\n`, "0000"]);
    expect(result.thin).toEqual(["unpack ok\n", `ok ${MAIN}\n`, "0000"]);
    const onBase = result.calls.filter((c) => c.packId === result.base);
    // The external base was read from the stored pack through the tier...
    expect(onBase.some((c) => c.op === "get")).toBe(true);
    expect(onBase.some((c) => c.op === "put")).toBe(true);
    // ...and only under this repository's network.
    expect(new Set(result.calls.map((c) => c.scope))).toEqual(new Set([networkId]));
  });
});
