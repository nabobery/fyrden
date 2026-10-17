import {
  type JobHandler,
  listPackPrefix,
  type PackPrefixPage,
  type SliceResult,
} from "@fyrden/adapters-cloudflare/git";
import type { RepoDO } from "../do/RepoDO.js";
import type { NetworkRegistry } from "./registry.js";
import {
  NETWORK_GC_JOB_ID,
  type NetworkRuntime,
  SliceCalls,
  scheduleDeletions,
  scheduleNetworkGc,
} from "./runtime.js";
import type { MemberPack } from "./types.js";

/*
 * The network collection, as the network object's job.
 * One epoch:
 *
 * 1. Mark, behind the fence: no fork is created and no detach starts while
 *    it runs (they wait, then get a retryable refusal), and it does not
 *    start while a fork is joining (it waits until that fork is published
 *    or abandoned). Each member in turn reports its view (the registry rows
 *    of packs under the network's prefix), and claims the shared packs its
 *    view holds as of the epoch. Once all have, the claims from before the
 *    epoch no member renewed are released, so a member's claims become
 *    exactly the shared packs its view holds (claims recorded after the
 *    epoch began are kept as they are). Shared packs no member claims are
 *    condemned (two-phase deletion, deletion.ts). The fence lifts.
 * 2. Sweep: objects under `net/<nid>/p/` that no member's registry and not
 *    the network names, older than the sweep TTL, are deleted (the orphan
 *    sweep a lone repository runs for itself). Page by page: the members
 *    are asked in turn which of a page's packs their registries name, until
 *    every pack is named or every member has answered; only then is the
 *    rest deleted.
 *
 * A slice makes at most the policy's `sliceCalls` calls and saves its place
 * (the member it reached, the page and what is known of it), so a network
 * with many members is collected over several slices and alarms. What the
 * members answered is recorded as it comes (claims, and what of the page is
 * still unnamed), so the place saved stays small however large the network.
 *
 * Which objects of a shared pack each member reaches is each member's own
 * collection's question: it marks borrowed packs too, never rewrites them,
 * and drops from its view a borrowed pack it no longer reaches (its claim
 * is then released). So a shared pack is condemned once no member reaches
 * anything in it. Rewriting partly reachable shared packs (network repack)
 * is not done yet.
 */

/** A member's place in the order members joined: `[joinedAt, repoId]`. */
type MemberPlace = readonly [number, string];

interface GcCursor {
  readonly v: 2;
  readonly epoch: number;
  readonly phase: "mark" | "sweep";
  readonly startedAt: number;
  /** The last member the mark has asked: members are asked in the order they joined. */
  readonly marked?: MemberPlace;
  /** The R2 list cursor of the sweep's next page. */
  readonly list?: string;
  /** The sweep's page whose members are being asked. */
  readonly page?: SweepPage;
}

/** A listed page of the sweep, while the members are asked about it. */
interface SweepPage extends PackPrefixPage {
  /** Its packs the network does not hold and no member asked so far names. */
  readonly unnamed: readonly string[];
  /** The last member asked: members are asked in the order they joined. */
  readonly asked?: MemberPlace;
}

/** The collection is due, and waits for a fork that is joining (`wakeGc`). */
interface GcWait {
  readonly v: 2;
  readonly phase: "wait";
}

/** Registry states of a member's row that count as holding the pack. */
const HOLDING = new Set(["indexing", "indexed", "live", "garbage", "superseded", "condemned"]);

/** The members a mark asks (a fork still joining is waited for before the epoch opens). */
const MARKED = ["active", "detaching", "detached"] as const;

/** Calls one question to a member may take: the call, and the directory check if it fails. */
const MEMBER_CALLS = 2;

const encode = (cursor: GcCursor | GcWait) => new TextEncoder().encode(JSON.stringify(cursor));
/** A saved cursor; one of an earlier shape is not resumed (the collection opens a new epoch). */
function decode(bytes: Uint8Array | null): GcCursor | GcWait | undefined {
  if (!bytes) return undefined;
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes)) as GcCursor | GcWait;
    return value.v === 2 ? value : undefined;
  } catch {
    return undefined;
  }
}

export function networkGcHandler(runtime: NetworkRuntime): JobHandler {
  return { runSlice: (job) => gcSlice(runtime, decode(job.cursor)) };
}

/**
 * Runs a collection that waits for a joining fork now, once no fork is
 * joining any more (the last one was published, abandoned or deleted).
 */
export function wakeGc(runtime: NetworkRuntime): void {
  const { registry, jobs, context } = runtime;
  if (registry.members(["joining"]).length > 0) return;
  const job = jobs.get(NETWORK_GC_JOB_ID);
  if (job?.state === "queued" && decode(job.cursor)?.phase === "wait")
    scheduleNetworkGc(runtime, context.now());
}

/**
 * Whether a collection holds the fence. One whose job ended without
 * lifting it (it failed for good, or is gone) no longer does: the fence is
 * lifted here and the collection is due again after the interval, so forks
 * and detaches wait only while a mark can still finish.
 */
export function fenced(runtime: NetworkRuntime): boolean {
  const { registry, jobs, context, policy, log } = runtime;
  if (!registry.gcState().fence) return false;
  const job = jobs.get(NETWORK_GC_JOB_ID)?.state;
  if (job === "queued" || job === "running") return true;
  context.storage.transactionSync(() => {
    registry.setGcState({ phase: "idle", fence: false });
    scheduleNetworkGc(runtime, context.now() + policy.gcIntervalMs);
  });
  log.warn("network collection ended with its fence up; lifted", { job: job ?? "missing" });
  return false;
}

async function gcSlice(
  runtime: NetworkRuntime,
  saved: GcCursor | GcWait | undefined,
): Promise<SliceResult> {
  const { env, registry, context, policy } = runtime;
  const networkId = registry.networkId();
  if (!networkId) return { done: true };
  const deadline = context.now() + policy.sliceMs;
  const calls = new SliceCalls(policy.sliceCalls, context.metrics);
  let cursor: GcCursor;
  if (saved === undefined || saved.phase === "wait") {
    const started = start(runtime);
    // Nothing awaited between this check and the job recording the wait,
    // so a fork that finishes joining always finds it to wake.
    if ("waitUntil" in started)
      return {
        done: false,
        cursor: encode({ v: 2, phase: "wait" }),
        runAfterMs: started.waitUntil - context.now(),
      };
    cursor = started;
  } else cursor = saved;
  if (cursor.epoch !== registry.gcState().epoch) {
    // The saved run is not the current epoch's (a state lost with a reset): start again.
    registry.setGcState({ phase: "idle", fence: false });
    return { done: false, cursor: null, runAfterMs: 0 };
  }
  const paused = (): SliceResult => ({ done: false, cursor: encode(cursor), runAfterMs: 0 });
  if (cursor.phase === "mark") {
    for (;;) {
      const member = registry.memberAfter(cursor.marked, MARKED);
      if (!member) break;
      if (context.now() >= deadline || !calls.fits(MEMBER_CALLS)) return paused();
      const { repoId } = member;
      await runtime.hooks.onMarkMember?.(cursor.epoch, repoId);
      // A member deleted meanwhile holds nothing (its storage may be gone).
      const view: MemberPack[] = registry.member(repoId)
        ? await askMember<MemberPack[]>(runtime, calls, repoId, "networkSnapshot", [], (stub) =>
            stub.networkSnapshot(networkId),
          )
        : [];
      const { startedAt } = cursor;
      context.storage.transactionSync(() => {
        if (registry.member(repoId))
          registry.hold(repoId, holdings(runtime, repoId, view), startedAt);
      });
      cursor = { ...cursor, marked: [member.joinedAt, repoId] };
    }
    decide(runtime, cursor.startedAt);
    cursor = { v: 2, epoch: cursor.epoch, phase: "sweep", startedAt: cursor.startedAt };
  }
  for (;;) {
    if (context.now() >= deadline) return paused();
    const { page } = cursor;
    if (!page) {
      if (!calls.fits(1)) return paused();
      const listed = await listPackPrefix({
        bucket: env.GIT,
        networkId,
        ...(cursor.list ? { cursor: cursor.list } : {}),
        limit: policy.sweepListLimit,
        cutoff: context.now() - policy.sweepTtlMs,
        onList: () => calls.count("r2.class_a", { bucket: "fyrden-git", op: "list" }),
      });
      cursor = { ...cursor, page: { ...listed, unnamed: notHeld(registry, listed) } };
      continue;
    }
    // Members are asked only while a pack of the page is still unnamed.
    // In the order they joined: one that joins meanwhile comes last, so it is
    // asked too; one deleted meanwhile registers nothing any more.
    const member = page.unnamed.length > 0 ? registry.memberAfter(page.asked) : undefined;
    if (member) {
      if (!calls.fits(MEMBER_CALLS)) return paused();
      const named = new Set<string>(
        await askMember<string[]>(runtime, calls, member.repoId, "registeredPacks", [], (stub) =>
          stub.registeredPacks(page.unnamed),
        ),
      );
      cursor = {
        ...cursor,
        page: {
          ...page,
          unnamed: page.unnamed.filter((id) => !named.has(id)),
          asked: [member.joinedAt, member.repoId],
        },
      };
      continue;
    }
    // Every member has answered: what none names, and the network still does not hold, goes.
    const stillNotHeld = new Set(notHeld(registry, page));
    const doomed = page.unnamed.filter((id) => stillNotHeld.has(id));
    const keys = page.old
      .filter((o) => o.packId === undefined || doomed.includes(o.packId))
      .map((o) => o.key);
    if (keys.length > 0) {
      if (!calls.fits(1)) return paused();
      calls.count("r2.class_a", { bucket: "fyrden-git", op: "delete" });
      await env.GIT.delete(keys);
      context.metrics.count("git.maintenance", { job: "network-gc", what: "swept" }, keys.length);
    }
    if (page.next === undefined) break;
    const { page: _swept, ...rest } = cursor;
    cursor = { ...rest, list: page.next };
  }
  registry.setGcState({ phase: "idle", fence: false });
  context.metrics.count("git.maintenance", { job: "network-gc", what: "epochs" }, 1);
  // Collect again later while the network is shared.
  if (registry.members(undefined, 2).length > 1)
    return { done: false, cursor: null, runAfterMs: policy.gcIntervalMs };
  return { done: true };
}

/**
 * Opens an epoch and raises the fence. While a fork is joining it does
 * not, and answers when the first joining fork counts as abandoned. A
 * fork abandoned while joining is removed.
 */
function start(runtime: NetworkRuntime): GcCursor | { readonly waitUntil: number } {
  const { registry, context, policy } = runtime;
  const now = context.now();
  return context.storage.transactionSync(() => {
    // In the order they joined: the first one still joining is the first to expire.
    for (const member of registry.members(["joining"])) {
      const abandonedAt = member.joinedAt + policy.joiningTtlMs;
      if (abandonedAt > now) return { waitUntil: abandonedAt };
      const unclaimed = registry.removeJoining(member.repoId);
      if (unclaimed.length > 0) registry.condemn(unclaimed, policy.retentionMs);
    }
    const epoch = registry.gcState().epoch + 1;
    registry.setGcState({ epoch, phase: "mark", fence: true });
    return { v: 2 as const, epoch, phase: "mark" as const, startedAt: now };
  });
}

/**
 * Of a page's packs, those the network does not hold (unknown to it, or
 * their bytes deleted): only a member's registry can keep them.
 */
function notHeld(registry: NetworkRegistry, page: PackPrefixPage): string[] {
  const ids = [...new Set(page.old.flatMap((o) => (o.packId === undefined ? [] : [o.packId])))];
  const known = registry.known(ids);
  return ids.filter((id) => !known.has(id) || registry.packState(id) === "deleted");
}

/**
 * Asks member `repoId` (its `method`), counting the call first. A member
 * deleted meanwhile answers `gone`; any other failure is thrown.
 */
async function askMember<R>(
  runtime: NetworkRuntime,
  calls: SliceCalls,
  repoId: string,
  method: "networkSnapshot" | "registeredPacks",
  gone: R,
  ask: (member: DurableObjectStub<RepoDO>) => Promise<R>,
): Promise<R> {
  calls.count("do.request", { class: "RepoDO", method });
  try {
    return await ask(runtime.env.REPO.getByName(repoId));
  } catch (error) {
    if (await forgetIfDeleted(runtime, calls, repoId)) return gone;
    throw error;
  }
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

/**
 * Every member has claimed what its view holds: releases the claims they
 * did not renew in the epoch begun at `startedAt`; condemns what nobody
 * claims; lifts the fence.
 */
function decide(runtime: NetworkRuntime, startedAt: number): void {
  const { registry, context, policy } = runtime;
  context.storage.transactionSync(() => {
    registry.releaseUnrenewed(startedAt);
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

/**
 * After a call to member `repoId` failed: true when it is no longer a member
 * (deleted meanwhile), or the directory says it is deleted. Such a member is
 * removed here with its claims: its deletion left it behind (a network it
 * was in before it recorded its networks), and its storage is gone.
 */
async function forgetIfDeleted(
  runtime: NetworkRuntime,
  calls: SliceCalls,
  repoId: string,
): Promise<boolean> {
  const { registry, env, context, policy } = runtime;
  if (!registry.member(repoId)) return true;
  calls.count("d1.query", { db: "directory", op: "member_state" });
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
