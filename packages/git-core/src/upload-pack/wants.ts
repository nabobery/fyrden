import type { ObjectType } from "../object/object.js";
import { type Oid, oidToHex } from "../object/oid.js";
import type { CommitGraph } from "../ports/commit-graph.js";
import type { RefSnapshot } from "../ports/ref-store.js";
import { notOurRef } from "./errors.js";
import { type PeeledTip, type PeelReader, peelRefTips, tagChain } from "./peel.js";
import { reachedFrom } from "./reach.js";

/** The objects a validated request asks for. */
export interface WantedObjects {
  /** Commits whose history is sent: wanted commits, and those wanted tags peel to. */
  readonly commits: readonly Oid[];
  /** Wanted objects that are not commits: annotated tags (with their chains), and trees and blobs at ref tips. */
  readonly objects: readonly { readonly oid: Oid; readonly type: ObjectType }[];
}

/**
 * The ref tips of a snapshot, peeled lazily: commits come from one read of
 * the commit graph, and tag objects are read only when a caller needs
 * their targets.
 */
export class RefTips {
  readonly oids: readonly Oid[];
  readonly #graph: CommitGraph;
  readonly #reader: PeelReader;
  #commits: Promise<Oid[]> | undefined;
  #peeled: Promise<Map<string, PeeledTip>> | undefined;

  constructor(refs: RefSnapshot, graph: CommitGraph, reader: PeelReader) {
    this.oids = [...new Map([...refs.refs.values()].map((oid) => [oidToHex(oid), oid])).values()];
    this.#graph = graph;
    this.#reader = reader;
  }

  /** Tips that are commits. */
  commits(): Promise<Oid[]> {
    this.#commits ??= this.#graph
      .read(this.oids, "verified")
      .then((rows) => this.oids.filter((_, i) => rows[i] !== undefined));
    return this.#commits;
  }

  /** Every tip with its type and peeled target, keyed by hex. Reads each tag object once. */
  peeled(): Promise<Map<string, PeeledTip>> {
    this.#peeled ??= peelRefTips(this.oids, this.#graph, this.#reader);
    return this.#peeled;
  }

  /** Commit tips plus the commits that tag tips peel to: every commit a ref names. */
  async commitTargets(): Promise<Oid[]> {
    const out = new Map((await this.commits()).map((oid) => [oidToHex(oid), oid]));
    for (const tip of (await this.peeled()).values()) {
      if (tip.targetType === "commit") out.set(oidToHex(tip.target), tip.target);
    }
    return [...out.values()];
  }
}

/**
 * Checks that every want is reachable from the current refs: a want equal to a ref tip or to a tag tip's peeled target is
 * accepted; any other want must be a commit reachable from a commit some
 * ref names, found by a bounded walk over verified commit rows. Throws
 * `not our ref` for the first want, in request order, that is not; a walk
 * that runs out of budget fails closed. Trees and blobs are accepted only
 * as ref tips or peeled tag targets (no partial clone).
 *
 * Returns how to classify the wants, which reads the wanted tag objects:
 * a full clone served from stored packs never needs it.
 */
export async function validateWants(
  wants: readonly Oid[],
  tips: RefTips,
  graph: CommitGraph,
  reader: PeelReader,
  maxWalkCommits: number,
): Promise<() => Promise<WantedObjects>> {
  const tipSet = new Set(tips.oids.map(oidToHex));
  const rows = await graph.read(wants, "verified");
  const isCommit = (i: number) => rows[i] !== undefined;
  const accepted = wants.map((oid) => tipSet.has(oidToHex(oid)));

  if (accepted.some((ok, i) => !ok && !isCommit(i))) {
    // Trees, blobs and tags are accepted only as tips or as what a tag tip peels to.
    const targets = new Set<string>();
    for (const tip of (await tips.peeled()).values()) {
      if (tip.type === "tag") targets.add(oidToHex(tip.target));
    }
    wants.forEach((oid, i) => {
      if (targets.has(oidToHex(oid))) accepted[i] = true;
    });
  }
  const pending = wants.map((_, i) => i).filter((i) => !accepted[i] && isCommit(i));
  const reached = await reachableFromRefs(
    graph,
    tips,
    pending.map((i) => wants[i] as Oid),
    maxWalkCommits,
  );
  reached.forEach((ok, k) => {
    if (ok) accepted[pending[k] as number] = true;
  });
  const refused = accepted.indexOf(false);
  if (refused >= 0) throw notOurRef(wants[refused] as Oid);
  let classified: Promise<WantedObjects> | undefined;
  return () => {
    classified ??= classify(wants, isCommit, tips, reader);
    return classified;
  };
}

/**
 * Which of `targets` (commits with verified rows) are reachable from a
 * commit some ref names. Branch-like tips are tried first; tag objects are
 * read only when that leaves a target unreached. Each walk loads at most
 * `maxCommits` rows and fails closed.
 */
export async function reachableFromRefs(
  graph: CommitGraph,
  tips: RefTips,
  targets: readonly Oid[],
  maxCommits: number,
): Promise<boolean[]> {
  const result = targets.map(() => false);
  const walkFrom = async (starts: readonly Oid[]) => {
    const open = result.flatMap((ok, i) => (ok ? [] : [i]));
    if (open.length === 0 || starts.length === 0) return;
    const reached = await reachedFrom(
      graph,
      starts,
      open.map((i) => targets[i] as Oid),
      maxCommits,
    );
    reached.forEach((ok, k) => {
      if (ok) result[open[k] as number] = true;
    });
  };
  const commitTips = await tips.commits();
  await walkFrom(commitTips);
  if (result.includes(false)) {
    // A tag can name a commit no other ref reaches: walk again from tag targets too.
    const known = new Set(commitTips.map(oidToHex));
    const all = await tips.commitTargets();
    if (all.some((oid) => !known.has(oidToHex(oid)))) await walkFrom(all);
  }
  return result;
}

async function classify(
  wants: readonly Oid[],
  isCommit: (i: number) => boolean,
  tips: RefTips,
  reader: PeelReader,
): Promise<WantedObjects> {
  const commits: Oid[] = [];
  const objects: { oid: Oid; type: ObjectType }[] = [];
  const nonCommits = wants.filter((_, i) => !isCommit(i));
  if (nonCommits.length === 0) return { commits: [...wants], objects };
  const peeled = await tips.peeled();
  const targets = new Map<string, ObjectType>();
  for (const tip of peeled.values()) targets.set(oidToHex(tip.target), tip.targetType);
  for (const [i, oid] of wants.entries()) {
    if (isCommit(i)) {
      commits.push(oid);
      continue;
    }
    const hex = oidToHex(oid);
    const tip = peeled.get(hex);
    if (tip?.type === "tag") {
      const chain = await tagChain(reader, oid);
      for (const tag of chain.tags) objects.push({ oid: tag, type: "tag" });
      if (tip.targetType === "commit") commits.push(tip.target);
      else objects.push({ oid: tip.target, type: tip.targetType });
      continue;
    }
    const type = tip?.type ?? targets.get(hex);
    if (type === undefined) throw notOurRef(oid);
    if (type === "commit") commits.push(oid);
    else objects.push({ oid, type });
  }
  return { commits, objects };
}
