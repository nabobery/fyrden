// Thin packs through the Worker: a client that has a commit and sends
// `thin-pack` gets a stored delta against a blob it holds instead of the
// object rebuilt whole; without `thin-pack` the pack is self-contained.
import { createWorkersZlib } from "@fyrden/adapters-cloudflare";
import { type ObjectType, oidToHex, parsePack } from "@fyrden/git-core";
import { beforeAll, describe, expect, inject, it } from "vitest";
import {
  fetchBody,
  loadFixture,
  type Plan,
  packObjects,
  parseFetchResponse,
  throughWorker,
} from "./helpers/fetch-repo.js";
import { basic, createRepo, ORIGIN } from "./helpers/git-http.js";
import { fromHex } from "./helpers/git-oracle.js";
import { principalWithToken } from "./helpers/principals.js";

const fixtures = inject("fetchFixtures");

let owner: { principalId: string; token: string };
let handle: string;
/** Every object of the fixture, to resolve a thin pack's external bases. */
const objects = new Map<string, { type: ObjectType; data: Uint8Array }>();

beforeAll(async () => {
  owner = await principalWithToken("user", "git");
  handle = owner.principalId.toLowerCase().replace("_", "-");
  const pack = fromHex(fixtures.thin.packs[0] as string);
  const parsed = await parsePack(
    (async function* () {
      yield pack;
    })(),
    {
      zlib: createWorkersZlib(),
      memory: {
        reserve: async (bytes) => ({ bytes, release() {} }),
        tryReserve: (bytes) => ({ bytes, release() {} }),
      },
      readRange: async (offset, length) => pack.subarray(offset, offset + length),
      onObject: (object) => {
        objects.set(oidToHex(object.oid), { type: object.type, data: object.data });
      },
    },
  );
  parsed.release();
});

async function fetchThin(plan: Plan, thin: boolean) {
  const repo = await createRepo(owner.principalId);
  await loadFixture(repo.stub, fixtures.thin);
  const main = fixtures.thin.refs.find((r) => r.name === "refs/heads/main")?.oid as string;
  let bytes = new Uint8Array(0);
  await throughWorker(
    new Request(`${ORIGIN}/${handle}/${repo.name}.git/git-upload-pack`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-git-upload-pack-request",
        "Git-Protocol": "version=2",
        Authorization: basic(owner.token),
      },
      body: fetchBody([
        `want ${main}`,
        `have ${fixtures.thinHave}`,
        "ofs-delta",
        ...(thin ? ["thin-pack"] : []),
        "no-progress",
        "done",
      ]),
    }),
    { plan },
    async (response) => {
      bytes = new Uint8Array(await response.arrayBuffer());
    },
  );
  const pack = parseFetchResponse(bytes).pack as Uint8Array;
  return {
    size: pack.length,
    ...(await packObjects(pack, async (oid) => objects.get(oidToHex(oid)))),
  };
}

describe.each(["free", "paid"] as const)("thin packs (plan %s)", (plan) => {
  it("sends a delta against a blob the client holds when it asks for thin-pack", async () => {
    const thin = await fetchThin(plan, true);
    const whole = await fetchThin(plan, false);
    expect(thin.oids).toEqual(fixtures.thinSince);
    expect(whole.oids).toEqual(fixtures.thinSince);
    expect(thin.thinBases).toHaveLength(1);
    expect(fixtures.thin.objects).toContain(thin.thinBases[0]);
    expect(fixtures.thinSince).not.toContain(thin.thinBases[0]);
    expect(whole.thinBases).toEqual([]);
    expect(thin.size).toBeLessThan(whole.size);
  });
});
