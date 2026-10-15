import {
  createSha1Hasher,
  encodeCommit,
  FILE_MODES,
  hashObject,
  isTreeMode,
  type Oid,
  oidToHex,
  treeEntries,
} from "@fyrden/git-core";
import { BUSY as BROWSE_BUSY, type Browsed, fail, guarded, type RepoBrowse } from "./browse.js";
import {
  BUSY,
  FILE_WRITE_POLICY,
  type FileWriteDeps,
  type FileWriteInput,
  finishUpload,
  ident,
  packOf,
  storeUpload,
} from "./file-writes.js";

/*
 * Generating a repository from a template: the template's object hands
 * over the trees and files of its default branch's tree, as they are
 * stored; the new repository's object commits that tree as its first
 * commit, through the push path as a file write is (fsck, connectivity,
 * the writer's token checked again at the commit point). Modes, symlinks
 * and submodule links are kept; the history is not.
 */

/** Limits of one generation. Proposed. */
export const TEMPLATE_POLICY = {
  /** Trees and files copied at most. */
  maxObjects: 2_000,
  /** Their bytes at most: they cross from one object to the other, and are packed there. */
  maxBytes: 8 * 1024 * 1024,
} as const;

/** Objects one prefetch locates together. */
const PREFETCH_BATCH = 100;

export interface TemplateObject {
  readonly type: "tree" | "blob";
  readonly data: Uint8Array;
}

export interface TemplateTree {
  /** The root tree's id. */
  readonly tree: string;
  /** Every tree and file below it, each once. */
  readonly objects: TemplateObject[];
}

const tooLarge = (limits: typeof TEMPLATE_POLICY) =>
  fail(
    422,
    "template_too_large",
    `The template has more than ${limits.maxObjects} files and directories, or ${limits.maxBytes} bytes, on its default branch.`,
  );

/**
 * The trees and files of the default branch's tree, in the template's
 * object. The memory they take is reserved while they are read.
 */
export function templateTree(
  browse: RepoBrowse,
  limits: typeof TEMPLATE_POLICY = TEMPLATE_POLICY,
): Promise<Browsed<TemplateTree>> {
  return guarded(async () => {
    const at = await browse.resolveTree(undefined);
    if (!at.ok) return at;
    return browse.reading(async (reader) => {
      const objects: TemplateObject[] = [];
      const holds: { release(): void }[] = [];
      const seen = new Set<string>([oidToHex(at.value.tree)]);
      let bytes = 0;
      let level: { oid: Oid; type: "tree" | "blob" }[] = [{ oid: at.value.tree, type: "tree" }];
      try {
        while (level.length > 0) {
          const next: typeof level = [];
          for (let i = 0; i < level.length; i += PREFETCH_BATCH) {
            const batch = level.slice(i, i + PREFETCH_BATCH);
            await reader.prefetch(batch.map((o) => o.oid));
            for (const { oid, type } of batch) {
              const header = await reader.readHeader(oid);
              if (header?.type !== type)
                throw new Error(`template object ${oidToHex(oid)} is missing or not a ${type}`);
              bytes += header.size;
              if (bytes > limits.maxBytes) return tooLarge(limits);
              const hold = browse.hold(header.size);
              if (!hold) return BROWSE_BUSY;
              holds.push(hold);
              const object = await reader.readObject(oid);
              if (object?.type !== type)
                throw new Error(`template object ${oidToHex(oid)} is missing or not a ${type}`);
              objects.push({ type, data: object.bytes });
              if (type !== "tree") continue;
              for (const entry of treeEntries(object.bytes)) {
                // A submodule names a commit of another repository: nothing to copy.
                if ((entry.mode & 0o170000) === FILE_MODES.gitlink) continue;
                const hex = oidToHex(entry.oid);
                if (seen.has(hex)) continue;
                seen.add(hex);
                if (seen.size > limits.maxObjects) return tooLarge(limits);
                next.push({ oid: entry.oid, type: isTreeMode(entry.mode) ? "tree" : "blob" });
              }
            }
          }
          level = next;
        }
        return { ok: true, value: { tree: oidToHex(at.value.tree), objects } };
      } finally {
        for (const hold of holds) hold.release();
      }
    });
  });
}

export interface TemplateWriteInput
  extends Pick<
    FileWriteInput,
    "principal" | "tokenId" | "repoId" | "committer" | "message" | "requestId"
  > {}

/**
 * Commits `template` as the first commit on the default branch of this
 * (empty) repository.
 */
export async function writeTemplate(
  deps: FileWriteDeps,
  input: TemplateWriteInput,
  template: TemplateTree,
): Promise<Browsed<{ branch: string; commit: string }>> {
  const { git } = deps;
  const snapshot = git.refStore.readRefsSync();
  const ref = snapshot.head;
  // Nothing else writes while the generation is pending: refs here mean a commit already made.
  if (snapshot.refs.size > 0 || !ref?.startsWith("refs/heads/"))
    return fail(409, "repo_not_empty", "The new repository already has commits.");
  const bytes = template.objects.reduce((n, o) => n + o.data.length, 0);
  // The objects, the pack builder's chunks and the pack they are joined into.
  const memory = await git.memory.reserveWithin(
    3 * bytes + 2 * 1024 * 1024,
    FILE_WRITE_POLICY.memoryWaitMs,
  );
  if (!memory) return BUSY;
  let upload: Awaited<ReturnType<typeof storeUpload>>;
  let commit: Oid;
  try {
    const objects = [];
    for (const object of template.objects)
      objects.push({
        ...object,
        // Hashed with collision detection, as a push is.
        oid: await hashObject(() => createSha1Hasher(), object.type, object.data),
      });
    const tree = objects[0];
    if (tree?.type !== "tree" || oidToHex(tree.oid) !== template.tree)
      throw new Error("the template's objects do not start with its tree");
    const now = Math.floor((deps.now ?? Date.now)() / 1000);
    const committer = ident(input.committer, now);
    const unsigned = {
      tree: tree.oid,
      parents: [],
      author: committer,
      committer,
      headers: [],
      message: new TextEncoder().encode(input.message),
    };
    const data = encodeCommit(
      deps.signer
        ? {
            ...unsigned,
            headers: [{ key: "gpgsig", value: await deps.signer.sign(encodeCommit(unsigned)) }],
          }
        : unsigned,
    );
    commit = await hashObject(() => createSha1Hasher(), "commit", data);
    const pack = await packOf(git, [...objects, { type: "commit", oid: commit, data }]);
    upload = await storeUpload(deps, input, { ref, head: undefined, commit, pack });
  } finally {
    memory.release();
  }
  if (!upload.ok) return upload;
  const committed = await finishUpload(deps, input, upload.value);
  if (!committed.ok) return committed;
  return {
    ok: true,
    value: { branch: ref.slice("refs/heads/".length), commit: oidToHex(commit) },
  };
}
