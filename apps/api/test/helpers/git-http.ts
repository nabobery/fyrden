import { env, exports } from "cloudflare:workers";
import { createWorkersZlib } from "@fyrden/adapters-cloudflare";
import { packObjectKey } from "@fyrden/adapters-cloudflare/git";
import { createIdFactory, secureRandomBytes } from "@fyrden/domain";
import {
  createSha1Hasher,
  oidFromHex,
  parsePack,
  type RefUpdate,
  writeIdx,
} from "@fyrden/git-core";
import { uniqueId } from "@fyrden/testing";
import { expect } from "vitest";
import type { RepoDO } from "../../src/do/RepoDO.js";
import { fromHex, type OracleRepo } from "./git-oracle.js";
import { inRepo } from "./repo-git.js";

const newId = createIdFactory(Date.now, secureRandomBytes);
export const ORIGIN = "https://fyrden.test";

export interface TestRepo {
  readonly id: string;
  readonly name: string;
  readonly stub: DurableObjectStub<RepoDO>;
}

/** A repository row owned by `ownerId`, with initialized git storage. */
export async function createRepo(ownerId: string, name = uniqueId("repo")): Promise<TestRepo> {
  const id = newId("rep");
  const networkId = newId("net");
  const stub = env.REPO.getByName(id);
  expect(await stub.initGitStorage(networkId)).toEqual({ ok: true });
  const now = Date.now();
  await env.DIRECTORY.prepare(
    `INSERT INTO repos (id, owner_id, name, network_id, org_shard, visibility, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'default', 'private', ?, ?)`,
  )
    .bind(id, ownerId, name, networkId, now, now)
    .run();
  return { id, name, stub };
}

/**
 * Stores the oracle repository's pack (with an `.idx` our writer makes) as
 * a live pack, its root commits as verified commit rows, and its refs, the
 * way a completed push leaves them.
 */
export async function loadOracleRepo(stub: DurableObjectStub<RepoDO>, repo: OracleRepo) {
  await inRepo(stub, async ({ git }) => {
    const bytes = fromHex(repo.packHex);
    const parsed = await parsePack(
      (async function* () {
        yield bytes;
      })(),
      {
        zlib: createWorkersZlib(),
        memory: git.memory,
        readRange: async (offset, length) => bytes.subarray(offset, offset + length),
      },
    );
    const idx = await writeIdx(parsed.entries, parsed.checksum, {
      createHasher: () => createSha1Hasher({ detectCollisions: false }),
    });
    parsed.release();

    const upload = git.uploads.begin({
      networkId: git.networkId(),
      principal: "usr_oracle",
      commands: [],
      atomic: true,
      withPack: true,
      ttlMs: 60 * 60 * 1000,
      leaseTtlMs: 10 * 60 * 1000,
    });
    if (!upload.packId || !upload.r2Key) throw new Error("upload has no pack");
    await git.bucket.put(upload.r2Key, bytes);
    await git.bucket.put(packObjectKey(git.networkId(), upload.packId, "idx"), idx.bytes);
    idx.release();
    git.uploads.markUploaded(upload.uploadId, { bytes: bytes.length });
    await git.commitGraph.insertPending(
      upload.uploadId,
      repo.rootCommits.map((c) => ({
        oid: oidFromHex(c.oid),
        tree: oidFromHex(c.tree),
        parents: [],
        commitTime: c.time,
        generation: c.time,
        level: 1,
      })),
    );
    git.uploads.markIndexed(upload.uploadId, { deps: [] });
    const refUpdates: RefUpdate[] = repo.refs.map((ref) => ({
      name: ref.name,
      oldOid: null,
      newOid: oidFromHex(ref.oid),
    }));
    const result = git.refStore.commitSync({
      addPacks: [],
      removePacks: [],
      refUpdates,
      expectedVersion: git.refStore.readRefsSync().version,
      uploadId: upload.uploadId,
    });
    if (!result.ok) throw new Error(`commit failed: ${JSON.stringify(result)}`);
  });
}

export const basic = (token: string, user = "x-access-token") =>
  `Basic ${btoa(`${user}:${token}`)}`;

/** A request to the Worker, as a git client would send it. */
export function gitFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return exports.default.fetch(`${ORIGIN}${path}`, init);
}
