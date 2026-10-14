import type { RepoEntry } from "../../repos/directory.js";

/**
 * Storage reserved for an upload in its repository's account, before the
 * upload is stored: the declared size, or, when the size is not known
 * (gzip, no `Content-Length`), as much of `maxBytes` as is free. The
 * upload is then stored up to the reservation and charged at its commit.
 */
export async function reserveUpload(
  env: Env,
  repo: Pick<RepoEntry, "id" | "ownerId">,
  uploadId: string,
  size: {
    readonly declared: number | undefined;
    readonly maxBytes: number;
    readonly ttlMs: number;
  },
): Promise<{ ok: true; bytes: number } | { ok: false; message: string }> {
  const partial = size.declared === undefined;
  const wanted = size.declared ?? size.maxBytes;
  const { reserved, freeBytes } = await env.ORG.getByName(repo.ownerId).reserveStorage({
    uploadId,
    repoId: repo.id,
    bytes: wanted,
    ttlMs: size.ttlMs,
    partial,
  });
  if (reserved > 0 && (partial || reserved === wanted)) return { ok: true, bytes: reserved };
  return {
    ok: false,
    message: partial
      ? "the account's storage quota is used up"
      : `the account's storage quota has ${freeBytes} bytes free; this push needs ${wanted}`,
  };
}

/** Drops an upload's reservation (and any charge) once it will not commit. */
export function releaseUpload(env: Env, repo: Pick<RepoEntry, "ownerId">, uploadId: string) {
  return env.ORG.getByName(repo.ownerId).releaseStorage(uploadId);
}
