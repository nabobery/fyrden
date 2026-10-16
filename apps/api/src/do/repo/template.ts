import type { RepoGitStorage } from "@fyrden/adapters-cloudflare/git";
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
import { REPO_DELETED } from "./events.js";
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
    "principal" | "tokenId" | "repoId" | "committer" | "author" | "message" | "requestId"
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
      author: input.author ? ident(input.author, now) : committer,
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

/** What a generation settled as abandoned answers its own late commit. */
const GENERATION_ABANDONED =
  "the generation from the template was abandoned; the repository is being deleted";

export interface GenerationDeps {
  readonly git: RepoGitStorage;
  /** The Worker's bindings, read at each use (tests may replace them). */
  readonly env: () => Env;
  /** No read: the repository is gone or going. */
  readonly refusesReads: () => boolean;
  /** Whether the repository's git storage exists (none after an erase). */
  readonly hasGitStorage: () => boolean;
  /** Takes the directory's epoch (a commit needs it first). */
  readonly checkEpoch: () => Promise<void>;
  /** The write deps of the current invocation. */
  readonly writeDeps: () => Promise<FileWriteDeps>;
  /** For tests: runs before the first commit is written. */
  readonly hooks: () => { readonly beforeWrite?: () => Promise<void> };
}

/**
 * A new repository's generation from a template, while it is pending: its
 * marker (the template), recorded before the storage exists so no write is
 * admitted ahead of it; its first commit; and its settling when its
 * request could not confirm it.
 */
export class TemplateGeneration {
  constructor(private readonly deps: GenerationDeps) {}

  /** Records that the repository is generated from `templateId` (before its storage exists). */
  record(templateId: string): void {
    this.deps.git.context.storage.sql.exec(
      `INSERT INTO generation (id, template_id, started_at) VALUES (1, ?, ?)
       ON CONFLICT (id) DO NOTHING`,
      templateId,
      this.deps.git.context.now(),
    );
  }

  /**
   * What the first commit is made of: the template's tree, once the
   * repository is still being generated (and not abandoned).
   */
  async template(): Promise<Browsed<TemplateTree>> {
    if (this.deps.refusesReads()) return fail(404, "repo_not_found", REPO_DELETED);
    const templateId = this.templateId();
    if (templateId === undefined)
      return fail(409, "not_generating", "The repository is not being generated from a template.");
    if (this.abandoned() !== undefined)
      return fail(409, "generation_abandoned", GENERATION_ABANDONED);
    const template = await this.deps.env().REPO.getByName(templateId).templateTree();
    if (!template.ok) return template;
    await this.deps.hooks().beforeWrite?.();
    return template;
  }

  /** Makes the first commit from `template` (see `writeTemplate`); the marker goes with it. */
  async write(
    input: TemplateWriteInput,
    template: TemplateTree,
  ): Promise<Browsed<{ branch: string; commit: string }>> {
    // Its commit needs the restore generation taken (a cold instance has not yet).
    await this.deps.checkEpoch();
    const made = await writeTemplate(await this.deps.writeDeps(), input, template);
    if (made.ok) this.deps.git.context.storage.sql.exec("DELETE FROM generation");
    return made;
  }

  /**
   * Settles a generation its request could not confirm: `committed` when
   * the repository has refs (its first commit was made: nothing else
   * writes while it is pending), whether or not its marker was cleared;
   * `abandoned` while it is pending without them, after which its commit
   * is refused at the commit point, so the repository can be deleted
   * without losing a late one; `none` otherwise (no repository here, as
   * after an erase, or no generation). One synchronous transaction, so it
   * cannot interleave with that commit.
   */
  abandon(): "committed" | "abandoned" | "none" {
    const { git } = this.deps;
    return git.context.storage.transactionSync(() => {
      const committed = this.deps.hasGitStorage() && git.refStore.readRefsSync().refs.size > 0;
      if (this.templateId() === undefined)
        return committed ? ("committed" as const) : ("none" as const);
      if (committed) {
        git.context.storage.sql.exec("DELETE FROM generation");
        return "committed" as const;
      }
      git.context.storage.sql.exec(
        "UPDATE generation SET abandoned_at = ? WHERE abandoned_at IS NULL",
        git.context.now(),
      );
      return "abandoned" as const;
    });
  }

  /** Why a commit is refused: the generation it would finish was abandoned. */
  abandoned(): string | undefined {
    return this.deps.git.context.storage.sql
      .exec<{ abandoned_at: number | null }>("SELECT abandoned_at FROM generation")
      .toArray()[0]?.abandoned_at != null
      ? GENERATION_ABANDONED
      : undefined;
  }

  /** The template this repository is still being generated from, if it is. */
  templateId(): string | undefined {
    return this.deps.git.context.storage.sql
      .exec<{ template_id: string }>("SELECT template_id FROM generation")
      .toArray()[0]?.template_id;
  }
}
