import { env, exports } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import type { RepoDO } from "../../src/do/RepoDO.js";
import { api, json, user, type Who } from "./api.js";
import type { FetchFixtureRepo } from "./fetch-fixtures.js";
import { loadFixture } from "./fetch-repo.js";
import { ORIGIN } from "./git-http.js";
import { setPolicy } from "./maintenance.js";

export type ReleaseOut = {
  id: number;
  tag_name: string;
  name: string | null;
  body: string | null;
  draft: boolean;
  prerelease: boolean;
  author: { id: string };
  tag_sha: string | null;
  commit_sha: string | null;
  current_tag_sha: string | null;
  tag_state: "current" | "moved" | "deleted" | null;
  published_at: number | null;
  created_at: number;
  updated_at: number;
  version: number;
  assets: unknown[];
  code?: string;
};

export type ReleaseRepo = {
  owner: Who;
  id: string;
  name: string;
  path: string;
  stub: DurableObjectStub<RepoDO>;
};

/** A repository made through the API, holding a fixture git built, with nothing scheduled on its own. */
export async function releaseRepo(fixture: FetchFixtureRepo): Promise<ReleaseRepo> {
  const owner = await user();
  const made = await json<{ id: string; name: string }>(
    api("POST", "/user/repos", owner.token, { name: uniqueId("r") }),
  );
  if (made.status !== 201) throw new Error(`repository not made: ${JSON.stringify(made)}`);
  const stub = env.REPO.getByName(made.body.id);
  await setPolicy(stub);
  await loadFixture(stub, fixture, { allReachable: false });
  return {
    owner,
    id: made.body.id,
    name: made.body.name,
    path: `/repos/${owner.handle}/${made.body.name}`,
    stub,
  };
}

/** A request with its idempotency key given, so a test can send the same one twice. */
export function withKey(method: string, path: string, token: string, key: string, body: unknown) {
  return exports.default.fetch(`${ORIGIN}/api${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Idempotency-Key": key,
    },
    body: JSON.stringify(body),
  });
}
