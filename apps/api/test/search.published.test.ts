// A repository published long after its storage was made (a fork's copy
// taking minutes): the events it made meanwhile may have been dropped as a
// repository's never listed, so while search indexing is on its publication
// asks for its reconciliation. A quick one asks nothing.
import { env } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { afterEach, describe, expect, inject, it, vi } from "vitest";
import { forkRepository } from "../src/network/fork.js";
import { UNLISTED_GRACE_MS } from "../src/queues/events-consumer.js";
import { publishHooks } from "../src/repos/directory.js";
import { api, json, user } from "./helpers/api.js";
import { loadFixture } from "./helpers/fetch-repo.js";
import { entryOf } from "./helpers/network.js";
import { principalWithToken } from "./helpers/principals.js";

const fetched = inject("fetchFixtures").single;

const indexing = (on: boolean) =>
  on
    ? env.DIRECTORY.prepare(
        `INSERT INTO deployment_settings (name, value, updated_at) VALUES ('search_indexing', 'on', 0)
         ON CONFLICT (name) DO UPDATE SET value = 'on'`,
      ).run()
    : env.DIRECTORY.prepare("DELETE FROM deployment_settings WHERE name = 'search_indexing'").run();

const request = (repoId: string) =>
  env.ORG_READ.prepare("SELECT reason FROM search_repairs WHERE repo_id = ? AND dirty > covered")
    .bind(repoId)
    .first<{ reason: string }>();

/** Publication `ms` after the request began (the clock moved on meanwhile). */
const publishedAfter = (ms: number) => {
  publishHooks.before = async () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + ms);
  };
};

afterEach(async () => {
  delete publishHooks.before;
  vi.restoreAllMocks();
  await indexing(false);
});

async function created(): Promise<string> {
  const owner = await user();
  const made = await json<{ id: string }>(
    api("POST", "/user/repos", owner.token, { name: uniqueId("published") }),
  );
  expect(made.status).toBe(201);
  return made.body.id;
}

describe("a repository's publication", () => {
  it("asks for its reconciliation when it came late, with search indexing on", async () => {
    await indexing(true);
    publishedAfter(UNLISTED_GRACE_MS);
    expect(await request(await created())).toEqual({ reason: "published_late" });
  });

  it("asks nothing when it came quickly, or with search indexing off", async () => {
    await indexing(true);
    expect(await request(await created())).toBeNull();
    await indexing(false);
    publishedAfter(UNLISTED_GRACE_MS);
    expect(await request(await created())).toBeNull();
  });

  it("asks for a fork's reconciliation when its copy took long", async () => {
    await indexing(true);
    const parentOwner = await principalWithToken("user", "git");
    const name = uniqueId("parent");
    const made = await json<{ id: string }>(
      api("POST", "/user/repos", parentOwner.token, { name }),
    );
    const stub = env.REPO.getByName(made.body.id);
    await stub.checkEpoch();
    await loadFixture(stub, fetched);
    const forker = await user();
    publishedAfter(UNLISTED_GRACE_MS);
    const forked = await forkRepository(env, {
      parent: await entryOf(parentOwner, { id: made.body.id, name, stub }),
      ownerId: forker.principalId,
      ownerHandle: forker.handle,
      name: uniqueId("fork"),
      maxRepos: Number.MAX_SAFE_INTEGER,
    });
    expect(forked.ok).toBe(true);
    if (!forked.ok) return;
    expect(await request(forked.repo.id)).toEqual({ reason: "published_late" });
  });
});
