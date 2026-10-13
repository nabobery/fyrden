// Re-authorization at the commit point: the Worker checks the pusher's token
// on the D1 primary just before the commit, and the commit transaction
// accepts only a fresh decision for the upload's own token. A revoked token
// (during upload or indexing) or one that lost its write scope aborts the push
// with refs unchanged; a token that merely expired after the upload was
// accepted does not.
import { env } from "cloudflare:workers";
import { hashToken } from "@fyrden/domain";
import { oidToHex } from "@fyrden/git-core";
import { afterEach, beforeEach, describe, expect, inject, it, vi } from "vitest";
import { ACCESS_LOST, TOKEN_REVOKED } from "../src/git/push/reauthorize.js";
import { principalWithToken } from "./helpers/principals.js";
import { holdAfterRunPush, type PushTarget, postPush, pushTarget } from "./helpers/push.js";
import { pushBody, reportLines, ZERO } from "./helpers/push-fixtures.js";
import { inRepo } from "./helpers/repo-git.js";

const fx = inject("pushFixtures");
const MAIN = "refs/heads/main";
const DAY = 24 * 60 * 60 * 1000;

// Every clock in this isolate runs a day ahead, so the alarm the index job
// arms never fires on its own: one firing by itself would finish indexing
// while the Worker is held, and the push would no longer be indexing there.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
  vi.setSystemTime(Date.now() + DAY);
});

afterEach(() => {
  vi.useRealTimers();
});

/** Indexing one phase per call: the push is still indexing when the Worker is held. */
const onePhase = {
  GIT_PUSH_INDEX_BUDGET_MS: "0",
  GIT_PUSH_POLL_MS: "20",
  GIT_PUSH_MAX_POLL_MS: "20",
};

/**
 * Starts a push and holds it after the upload is accepted and indexing has
 * started; `during` runs there, then the push continues to its commit.
 */
async function pushWith(target: PushTarget, during: () => Promise<unknown>) {
  const hold = holdAfterRunPush();
  const reply = postPush(target, firstPush(), { vars: onePhase, bindings: { REPO: hold.REPO } });
  await hold.accepted();
  expect((await state(target)).uploads).toEqual(["indexing"]);
  try {
    await during();
  } finally {
    hold.resume();
  }
  return reply;
}

async function state(target: PushTarget) {
  return inRepo(target.repo.stub, ({ git }) => ({
    refs: [...git.refStore.readRefsSync().refs].map(([n, o]) => `${n} ${oidToHex(o)}`),
    uploads: git.context.storage.sql
      .exec<{ state: string }>("SELECT state FROM uploads")
      .toArray()
      .map((r) => r.state),
    pending: git.context.storage.sql
      .exec<{ n: number }>("SELECT count(*) AS n FROM pending_commits")
      .one().n,
    live: git.registry.inState("live").length,
  }));
}

async function setToken(token: string, column: "revoked_at" | "expires_at", at: number) {
  const hex = await hashToken(token);
  const result = await env.DIRECTORY.prepare(`UPDATE tokens SET ${column} = ? WHERE token_hash = ?`)
    .bind(at, hex)
    .run();
  if (result.meta.changes !== 1) throw new Error("token row not found");
}

const firstPush = () => pushBody([{ old: ZERO, new: fx.c2, ref: MAIN }], { pack: fx.packC2 });

describe("push: re-authorization at the commit point", () => {
  it("aborts the push when the token is revoked during indexing", async () => {
    const target = await pushTarget();
    const { report, progress } = await pushWith(target, () =>
      setToken(target.owner.token, "revoked_at", Date.now()),
    );
    expect(report).toEqual(["unpack ok\n", `ng ${MAIN} ${TOKEN_REVOKED}\n`, "0000"]);
    expect(progress).toContain(`error: ${TOKEN_REVOKED}\n`);
    expect(await state(target)).toEqual({ refs: [], uploads: ["rejected"], pending: 0, live: 0 });
  });

  it("aborts the push when write access is lost before the commit", async () => {
    const target = await pushTarget();
    const { report } = await pushWith(target, async () => {
      // The repository changes hands: the pusher no longer owns it.
      const someoneElse = await principalWithToken("user");
      await env.DIRECTORY.prepare("UPDATE repos SET owner_id = ? WHERE id = ?")
        .bind(someoneElse.principalId, target.repo.id)
        .run();
    });
    expect(report).toEqual(["unpack ok\n", `ng ${MAIN} ${ACCESS_LOST}\n`, "0000"]);
    expect((await state(target)).refs).toEqual([]);
  });

  it.each([
    ["while the token stays valid", false],
    ["and the token then expires", true],
  ])(
    "aborts the push when the token loses its write scope during indexing %s",
    async (_, expire) => {
      const target = await pushTarget();
      const { report } = await pushWith(target, async () => {
        await env.DIRECTORY.prepare(
          `UPDATE tokens SET scopes = '["contents:read"]' WHERE token_hash = ?`,
        )
          .bind(await hashToken(target.owner.token))
          .run();
        if (expire) await setToken(target.owner.token, "expires_at", Date.now() - 1);
      });
      expect(report).toEqual(["unpack ok\n", `ng ${MAIN} ${ACCESS_LOST}\n`, "0000"]);
      expect((await state(target)).refs).toEqual([]);
    },
  );

  it("completes a push whose token expired after the upload was accepted", async () => {
    const target = await pushTarget();
    const { report } = await pushWith(target, () =>
      setToken(target.owner.token, "expires_at", Date.now() - 1),
    );
    expect(report).toEqual(["unpack ok\n", `ok ${MAIN}\n`, "0000"]);
    expect(await state(target)).toMatchObject({
      refs: [`${MAIN} ${fx.c2}`],
      uploads: ["committed"],
      pending: 0,
      live: 1,
    });
  });

  it("refuses the commit for a stale decision or another token's decision", async () => {
    const target = await pushTarget();
    const { stub } = target.repo;
    const run = async (decision: { tokenId?: string; decidedAt: number }) => {
      const begun = await stub.beginPush({ principal: target.owner.principalId, tokenId: "tok_a" });
      if (!begun.ok) throw new Error(begun.error);
      const body = firstPush();
      await env.GIT.put(begun.bodyKey, body);
      let progress = await stub.runPush(begun.uploadId, body.length, 10_000);
      while (progress.state === "indexing")
        progress = await stub.pushStatus(begun.uploadId, 10_000);
      const response = await stub.finalizePush(begun.uploadId, {
        tokenId: decision.tokenId ?? "tok_a",
        decidedAt: decision.decidedAt,
      });
      return reportLines(response).report;
    };
    expect(await run({ decidedAt: Date.now() - 120_000 })).toEqual([
      "unpack ok\n",
      `ng ${MAIN} the push's authorization is too old; try the push again\n`,
      "0000",
    ]);
    expect(await run({ tokenId: "tok_b", decidedAt: Date.now() })).toEqual([
      "unpack ok\n",
      `ng ${MAIN} the push was authorized for another token\n`,
      "0000",
    ]);
    expect(await state(target)).toMatchObject({ refs: [], pending: 0, live: 0 });
    expect(await run({ decidedAt: Date.now() })).toEqual(["unpack ok\n", `ok ${MAIN}\n`, "0000"]);
  });
});
