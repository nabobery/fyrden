import {
  type JobHandler,
  type SliceResult,
  sweepPackPrefix,
} from "@fyrden/adapters-cloudflare/git";
import { type NetworkRuntime, scheduleDeletions } from "./runtime.js";
import type { MemberPack } from "./types.js";

/*
 * The network collection, as the network object's job.
 * One epoch:
 *
 * 1. Mark, behind the fence: no fork is created and no detach starts while
 *    it runs (they wait, then get a retryable refusal), and it does not
 *    start while a fork is joining. Each member reports its view (the
 *    registry rows of packs under the network's prefix). A member's claims
 *    become exactly the shared packs its view holds; claims recorded after
 *    the epoch began are kept as they are. Shared packs no member claims
 *    are condemned (two-phase deletion, deletion.ts). The fence lifts.
 * 2. Sweep: objects under `net/<nid>/p/` that no member's registry and not
 *    the network names, older than the sweep TTL, are deleted (the orphan
 *    sweep a lone repository runs for itself).
 *
 * Which objects of a shared pack each member reaches is each member's own
 * collection's question: it marks borrowed packs too, never rewrites them,
 * and drops from its view a borrowed pack it no longer reaches (its claim
 * is then released). So a shared pack is condemned once no member reaches
 * anything in it. Rewriting partly reachable shared packs (network repack)
 * is not done yet.
 */

interface GcCursor {
  readonly v: 1;
  readonly epoch: number;
  readonly phase: "mark" | "sweep";
  readonly startedAt: number;
  readonly members: readonly string[];
  readonly next: number;
  /** Per member snapshotted so far, the network's packs its view holds. */
  readonly holds: Readonly<Record<string, readonly string[]>>;
  readonly list?: string;
}

/** Registry states of a member's row that count as holding the pack. */
const HOLDING = new Set(["indexing", "indexed", "live", "garbage", "superseded", "condemned"]);

const encode = (cursor: GcCursor) => new TextEncoder().encode(JSON.stringify(cursor));
function decode(bytes: Uint8Array | null): GcCursor | undefined {
  if (!bytes) return undefined;
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes)) as GcCursor;
    return value.v === 1 ? value : undefined;
  } catch {
    return undefined;
  }
}

export function networkGcHandler(runtime: NetworkRuntime): JobHandler {
  return { runSlice: (job) => gcSlice(runtime, decode(job.cursor)) };
}

async function gcSlice(runtime: NetworkRuntime, saved: GcCursor | undefined): Promise<SliceResult> {
  const { registry, context, policy } = runtime;
  const networkId = registry.networkId();
  if (!networkId) return { done: true };
  const deadline = context.now() + policy.sliceMs;
  let cursor = saved ?? start(runtime);
  if (!cursor) return { done: false, cursor: null, runAfterMs: 1_000 };
  if (cursor.epoch !== registry.gcState().epoch) {
    // The saved run is not the current epoch's (a state lost with a reset): start again.
    registry.setGcState({ phase: "idle", fence: false });
    return { done: false, cursor: null, runAfterMs: 0 };
  }
  if (cursor.phase === "mark") {
    while (cursor.next < cursor.members.length) {
      if (context.now() >= deadline) return { done: false, cursor: encode(cursor), runAfterMs: 0 };
      const repoId = cursor.members[cursor.next] as string;
      await runtime.hooks.onMarkMember?.(cursor.epoch, repoId);
      // A member deleted since the snapshot holds nothing (its storage may be gone).
      const view = registry.member(repoId)
        ? await runtime.env.REPO.getByName(repoId)
            .networkSnapshot(networkId)
            .catch(async (error: unknown) => {
              if (await forgetIfDeleted(runtime, repoId)) return [];
              throw error;
            })
        : [];
      cursor = {
        ...cursor,
        next: cursor.next + 1,
        holds: { ...cursor.holds, [repoId]: holdings(runtime, repoId, view) },
      };
    }
    decide(runtime, cursor);
    cursor = { ...cursor, phase: "sweep" };
  }
  for (;;) {
    if (context.now() >= deadline) return { done: false, cursor: encode(cursor), runAfterMs: 0 };
    const page = await sweep(runtime, networkId, cursor.list);
    if (!page) break;
    cursor = { ...cursor, list: page };
  }
  registry.setGcState({ phase: "idle", fence: false });
  context.metrics.count("git.maintenance", { job: "network-gc", what: "epochs" }, 1);
  // Collect again later while the network is shared.
  if (registry.members(["joining", "active", "detaching", "detached"]).length > 1)
    return { done: false, cursor: null, runAfterMs: policy.gcIntervalMs };
  return { done: true };
}

/**
 * Opens an epoch and raises the fence, unless a fork is joining (the
 * epoch then waits for it). A fork abandoned while joining is removed.
 */
function start(runtime: NetworkRuntime): GcCursor | undefined {
  const { registry, context, policy } = runtime;
  const now = context.now();
  return context.storage.transactionSync(() => {
    for (const member of registry.members(["joining"])) {
      if (member.joinedAt + policy.joiningTtlMs > now) return undefined;
      const unclaimed = registry.removeJoining(member.repoId);
      if (unclaimed.length > 0) registry.condemn(unclaimed, policy.retentionMs);
    }
    const epoch = registry.gcState().epoch + 1;
    registry.setGcState({ epoch, phase: "mark", fence: true });
    return {
      v: 1 as const,
      epoch,
      phase: "mark" as const,
      startedAt: now,
      members: registry.members(["active", "detaching", "detached"]).map((m) => m.repoId),
      next: 0,
      holds: {},
    };
  });
}

/** The network's packs a member's view holds; a borrowed pack the network did not know is recorded as shared. */
function holdings(runtime: NetworkRuntime, repoId: string, view: readonly MemberPack[]): string[] {
  const { registry } = runtime;
  const held = view.filter((p) => HOLDING.has(p.state));
  const known = registry.known(held.map((p) => p.packId));
  const unknownBorrowed = held.filter((p) => p.origin === "borrowed" && !known.has(p.packId));
  for (const pack of unknownBorrowed)
    registry.share(
      [
        {
          packId: pack.packId,
          networkId: pack.networkId,
          r2Key: "",
          kind: "",
          origin: "borrowed",
          bytes: 0,
          objectCount: null,
          unitId: null,
          createdAt: 0,
        },
      ],
      () => repoId,
      [],
    );
  return held.filter((p) => known.has(p.packId) || p.origin === "borrowed").map((p) => p.packId);
}

/** Replaces each snapshotted member's claims with what its view holds; condemns what nobody claims; lifts the fence. */
function decide(runtime: NetworkRuntime, cursor: GcCursor): void {
  const { registry, context, policy } = runtime;
  context.storage.transactionSync(() => {
    for (const repoId of cursor.members) {
      // Deleted since the snapshot: its claims went with it.
      if (!registry.member(repoId)) continue;
      const holds = new Set(cursor.holds[repoId] ?? []);
      const before = context.storage.sql
        .exec<{ pack_id: string }>(
          "SELECT pack_id FROM pack_claims WHERE repo_id = ? AND claimed_at < ?",
          repoId,
          cursor.startedAt,
        )
        .toArray()
        .map((r) => r.pack_id);
      registry.release(
        repoId,
        before.filter((id) => !holds.has(id)),
      );
      registry.claim([repoId], [...holds]);
    }
    const unclaimed = registry.allUnclaimed();
    registry.condemn(unclaimed, policy.retentionMs);
    if (unclaimed.length > 0) {
      scheduleDeletions(runtime);
      context.metrics.count(
        "git.maintenance",
        { job: "network-gc", what: "condemned" },
        unclaimed.length,
      );
    }
    registry.setGcState({ phase: "sweep", fence: false });
  });
}

/** One page of the sweep of the network's pack prefix; the next page's cursor, or undefined at the end. */
async function sweep(
  runtime: NetworkRuntime,
  networkId: string,
  list: string | undefined,
): Promise<string | undefined> {
  const { env, registry, context, policy } = runtime;
  const members = registry.members(["joining", "active", "detaching", "detached"]);
  const { deleted, cursor } = await sweepPackPrefix({
    bucket: env.GIT,
    networkId,
    ...(list ? { cursor: list } : {}),
    limit: policy.sweepListLimit,
    cutoff: context.now() - policy.sweepTtlMs,
    registered: async (ids) => {
      const out = new Set<string>();
      for (const id of registry.known(ids)) if (registry.packState(id) !== "deleted") out.add(id);
      for (const member of members) {
        let registered: string[];
        try {
          registered = await env.REPO.getByName(member.repoId).registeredPacks([...ids]);
        } catch (error) {
          // Deleted meanwhile: it registers nothing any more.
          if (await forgetIfDeleted(runtime, member.repoId)) continue;
          throw error;
        }
        for (const id of registered) out.add(id);
      }
      return out;
    },
    onList: () => context.metrics.count("r2.class_a", { bucket: "fyrden-git", op: "list" }),
  });
  if (deleted.length > 0)
    context.metrics.count("git.maintenance", { job: "network-gc", what: "swept" }, deleted.length);
  return cursor;
}

/**
 * After a call to member `repoId` failed: true when it is no longer a member
 * (deleted meanwhile), or the directory says it is deleted. Such a member is
 * removed here with its claims: its deletion left it behind (a network it
 * was in before it recorded its networks), and its storage is gone.
 */
async function forgetIfDeleted(runtime: NetworkRuntime, repoId: string): Promise<boolean> {
  const { registry, env, context, policy } = runtime;
  if (!registry.member(repoId)) return true;
  context.metrics.count("d1.query", { db: "directory", op: "member_state" });
  const row = await env.DIRECTORY.prepare("SELECT state FROM repos WHERE id = ?")
    .bind(repoId)
    .first<{ state: string }>();
  if (row?.state !== "deleted") return false;
  const unclaimed = context.storage.transactionSync(() => {
    const left = registry.removeMember(repoId);
    registry.condemn(left, policy.retentionMs);
    return left;
  });
  if (unclaimed.length > 0) scheduleDeletions(runtime);
  return true;
}
