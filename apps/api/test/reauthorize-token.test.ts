// The commit-point check for writes a repository object makes itself (an
// import, a file write): a token stops with any token it was minted from,
// two steps back included (an agent's own token, the delegated token
// exchanged for it, a git token minted from that).
import { env } from "cloudflare:workers";
import { D1TokenStore } from "@fyrden/adapters-cloudflare/auth";
import { createIdFactory, secureRandomBytes } from "@fyrden/domain";
import { uniqueId } from "@fyrden/testing";
import { describe, expect, it } from "vitest";
import { TOKEN_REVOKED } from "../src/git/push/reauthorize.js";
import { reauthorizeByToken } from "../src/git/push/reauthorize-token.js";
import { api, json, user } from "./helpers/api.js";

const store = new D1TokenStore(env.DIRECTORY, {
  clock: () => Date.now(),
  newId: createIdFactory(() => Date.now(), secureRandomBytes),
  randomBytes: secureRandomBytes,
});

describe("reauthorizeByToken", () => {
  it("refuses a token whose source's source was revoked", async () => {
    const owner = await user();
    const repo = await json<{ id: string }>(
      api("POST", "/user/repos", owner.token, { name: uniqueId("r") }),
    );
    expect(repo.status).toBe(201);
    const mint = (sourceId?: string) =>
      store.mint({
        principalId: owner.principalId,
        type: sourceId ? "git" : "pat",
        scopes: [],
        ttlMs: 60 * 60 * 1000,
        ...(sourceId && { sourceId }),
        audit: { actorId: owner.principalId },
      });
    const first = await mint();
    const second = await mint(first.id);
    const third = await mint(second.id);
    const decide = () =>
      reauthorizeByToken(
        env.DIRECTORY,
        { tokenId: third.id, principal: owner.principalId, repoId: repo.body.id },
        async () => "admin",
      );
    expect((await decide()).refusal).toBeUndefined();
    await store.revoke(first.id, { actorId: owner.principalId });
    expect((await decide()).refusal).toBe(TOKEN_REVOKED);
  });
});
