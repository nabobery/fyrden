import { env } from "cloudflare:workers";
import type { RepoGitStorage } from "@fyrden/adapters-cloudflare/git";
import { oidFromHex, type PackId } from "@fyrden/git-core";
import { expect, inject } from "vitest";
import type { RepoDO } from "../../src/do/RepoDO.js";
import { loadFixture, packObjects } from "./fetch-repo.js";
import { setPolicy } from "./maintenance.js";
import { inRepo, newRepo } from "./repo-git.js";

type Stub = DurableObjectStub<RepoDO>;

export const DAY = 24 * 60 * 60 * 1000;
export const HOUR = 60 * 60 * 1000;

const fx = inject("gcFixtures");

/** A repository holding the garbage-collection fixture, as packs git wrote (one pack by default). */
export async function gcRepo(packs: readonly string[] = fx.repo.packs) {
  const { stub } = await newRepo();
  await setPolicy(stub);
  const packIds = await loadFixture(stub, { ...fx.repo, packs }, { allReachable: false });
  return { stub, packIds };
}

/** Moves (or creates, or deletes) one ref directly, as any commit would. */
export function moveRef(stub: Stub, name: string, from: string | null, to: string | null) {
  return inRepo(stub, ({ git }) => {
    const result = git.refStore.commitSync({
      addPacks: [],
      removePacks: [],
      refUpdates: [
        {
          name,
          oldOid: from === null ? null : oidFromHex(from),
          newOid: to === null ? null : oidFromHex(to),
        },
      ],
      expectedVersion: git.refStore.state().version,
    });
    if (!result.ok) throw new Error(`ref update failed: ${JSON.stringify(result)}`);
  });
}

/** The objects of a stored pack, sorted hex (parsed whole: every pack maintenance writes is self-contained). */
export async function objectsOf(git: RepoGitStorage, packId: string): Promise<string[]> {
  const row = git.registry.get(packId);
  if (!row) throw new Error(`no pack ${packId}`);
  const object = await git.bucket.get(row.r2Key);
  if (!object) throw new Error(`pack ${packId} has no bytes`);
  return (await packObjects(new Uint8Array(await object.arrayBuffer()))).oids;
}

/** Pack ids by state. */
export const inState = (git: RepoGitStorage, state: string): PackId[] =>
  git.context.storage.sql
    .exec<{ pack_id: string }>(
      "SELECT pack_id FROM packs WHERE state = ? ORDER BY created_at, pack_id",
      state,
    )
    .toArray()
    .map((r) => r.pack_id as PackId);

/** Every object in packs of `state`, sorted, each once. */
export const objectsIn = (stub: Stub, state: string) =>
  inRepo(stub, async ({ git }) => {
    const out = new Set<string>();
    for (const id of inState(git, state)) for (const o of await objectsOf(git, id)) out.add(o);
    return [...out].sort();
  });

/** Whether the pack's R2 objects (pack and index) exist. */
export async function stored(git: RepoGitStorage, packId: string): Promise<boolean> {
  const net = git.networkId();
  const [pack, idx] = await Promise.all([
    env.GIT.head(`net/${net}/p/${packId}.pack`),
    env.GIT.head(`net/${net}/p/${packId}.idx`),
  ]);
  return pack !== null && idx !== null;
}

export const minus = (a: readonly string[], b: readonly string[]) => {
  const drop = new Set(b);
  return a.filter((x) => !drop.has(x));
};

export function expectSorted(actual: readonly string[], expected: readonly string[]): void {
  expect([...actual].sort()).toEqual([...expected].sort());
}
