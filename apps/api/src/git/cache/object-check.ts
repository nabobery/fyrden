import { createWorkersZlib } from "@fyrden/adapters-cloudflare";
import type { RepoGitStorage } from "@fyrden/adapters-cloudflare/git";
import {
  type BlockCache,
  FILE_MODES,
  GitObjectError,
  isTreeMode,
  ObjectReader,
  type Oid,
  oidFromHex,
  oidToHex,
  parseTree,
} from "@fyrden/git-core";
import { liveView } from "../pack-view.js";
import {
  DENIED,
  HEX_OID,
  MAX_PATH_BYTES,
  type ObjectAccessAnswer,
  type ObjectAccessRequest,
} from "./object-access.js";
import { openRequestBlockCache } from "./pack-blocks.js";

/** Delta-base cache of one path check: a few trees. Proposed; tuned under load. */
const CHECK_DELTA_CACHE_BYTES = 4 * 1024 * 1024;
/** Cache API calls one check may make for pack blocks (Free allows 50 per request). Proposed. */
const CHECK_CACHE_API_CALLS = 40;

export interface ObjectCheckDeps {
  readonly git: RepoGitStorage;
  /** The object's long-lived in-memory block tier. */
  readonly memoryBlocks: BlockCache;
}

const encoder = new TextEncoder();

/**
 * The object check, inside the repository object, from its own verified
 * commits (design: object authorization). Commits and diffs are answered
 * from the commit graph alone. A path is walked from the commit's tree
 * only after the commit has passed, so no pack block (cached or not) is
 * read for a commit the repository does not hold. Objects shared with a
 * sibling in the network stay out of reach unless one of this
 * repository's commits leads to them.
 */
export async function checkObjectAccess(
  deps: ObjectCheckDeps,
  request: ObjectAccessRequest,
): Promise<ObjectAccessAnswer> {
  switch (request?.kind) {
    case "commit": {
      const commit = verifiedTree(deps.git, request.commit);
      return commit ? { ok: true, kind: "commit", oid: request.commit } : DENIED;
    }
    case "diff": {
      const base = verifiedTree(deps.git, request.base);
      const head = verifiedTree(deps.git, request.head);
      return base && head
        ? { ok: true, kind: "diff", base: request.base, head: request.head }
        : DENIED;
    }
    case "path": {
      if (request.expect !== undefined && !HEX_OID.test(request.expect)) return DENIED;
      const segments = pathSegments(request.path);
      if (!segments) return DENIED;
      const tree = verifiedTree(deps.git, request.commit);
      if (!tree) return DENIED;
      const found = await walkPath(deps, tree, segments);
      if (!found || (request.expect !== undefined && found.oid !== request.expect)) return DENIED;
      return { ok: true, kind: found.kind, oid: found.oid };
    }
    default:
      return DENIED;
  }
}

/** The commit's tree when the commit is in this repository's verified commits. */
function verifiedTree(git: RepoGitStorage, hex: unknown): Oid | undefined {
  if (typeof hex !== "string" || !HEX_OID.test(hex)) return undefined;
  const [row] = git.commitGraph.readSync([oidFromHex(hex)], "verified");
  return row?.state === "verified" ? row.tree : undefined;
}

/** `a/b/c` as UTF-8 names; `[]` for the root; undefined for a path that names nothing. */
function pathSegments(path: unknown): Uint8Array[] | undefined {
  if (typeof path !== "string") return undefined;
  if (path === "") return [];
  if (encoder.encode(path).length > MAX_PATH_BYTES) return undefined;
  const parts = path.split("/");
  if (parts.some((p) => p === "" || p === "." || p === ".." || p.includes("\0"))) return undefined;
  return parts.map((p) => encoder.encode(p));
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

async function walkPath(
  deps: ObjectCheckDeps,
  root: Oid,
  segments: readonly Uint8Array[],
): Promise<{ kind: "tree" | "blob"; oid: string } | undefined> {
  const { git } = deps;
  const view = liveView(git, () =>
    git.context.metrics.count("r2.class_b", { bucket: "fyrden-git", op: "get_idx" }),
  );
  if (view.packs.length === 0) return undefined;
  const blocks = await openRequestBlockCache(deps.memoryBlocks, {
    scope: view.scope,
    maxCalls: CHECK_CACHE_API_CALLS,
  });
  const reader = await ObjectReader.open({
    view,
    packStore: git.packStore,
    zlib: createWorkersZlib(),
    memory: git.memory,
    blockCache: blocks.cache,
    limits: { deltaBaseCacheBytes: CHECK_DELTA_CACHE_BYTES },
  });
  try {
    let current = root;
    let kind: "tree" | "blob" = "tree";
    for (const name of segments) {
      if (kind !== "tree") return undefined;
      const tree = await reader.readObject(current);
      if (tree?.type !== "tree") return undefined;
      const entry = parseTree(tree.bytes).value.find((e) => sameBytes(e.name, name));
      // A submodule (gitlink) names a commit of another repository.
      if (!entry || entry.mode === FILE_MODES.gitlink) return undefined;
      current = entry.oid;
      kind = isTreeMode(entry.mode) ? "tree" : "blob";
    }
    const header = await reader.readHeader(current);
    if (header?.type !== kind) return undefined;
    return { kind, oid: oidToHex(current) };
  } catch (error) {
    // A tree that does not parse leads nowhere.
    if (error instanceof GitObjectError) return undefined;
    throw error;
  } finally {
    reader.release();
  }
}
