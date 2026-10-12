import { oidEquals } from "../object/oid.js";
import type { RefStore } from "../ports/ref-store.js";
import type { PushCommitRequest, PushCommitResult } from "./finalize.js";

export interface RefStoreCommitOptions {
  /**
   * Called after the transaction that made the upload live, to promote its
   * pending commit rows. The port's `commit` cannot do it in the same
   * transaction; the Durable Object's `commitSync` does, so it does not use
   * this adapter.
   */
  readonly onUploadCommitted?: (uploadId: string) => Promise<void>;
  /** Retries after the ref-state version moved under an unrelated commit. Default 8. */
  readonly maxRetries?: number;
}

/**
 * A push commit point over the `RefStore` port, for the in-memory fakes and
 * any store without the Durable Object's extras. A version conflict caused
 * by another ref is retried with a fresh snapshot; the compare-and-set on
 * the pushed refs is the store's own. Dependencies are not checked.
 */
export function refStoreCommitter(
  refStore: RefStore,
  options: RefStoreCommitOptions = {},
): (request: PushCommitRequest) => Promise<PushCommitResult> {
  const maxRetries = options.maxRetries ?? 8;
  return async (request) => {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const snapshot = await refStore.readRefs();
      for (const update of request.updates) {
        const current = snapshot.refs.get(update.name) ?? null;
        const same =
          current === null || update.oldOid === null
            ? current === update.oldOid
            : oidEquals(current, update.oldOid);
        if (!same) return { ok: false, reason: "ref-conflict", ref: update.name };
      }
      const result = await refStore.commit({
        addPacks: request.withUpload ? request.packs : [],
        removePacks: [],
        refUpdates: request.updates,
        expectedVersion: snapshot.version,
      });
      if (result.ok) {
        if (request.withUpload) await options.onUploadCommitted?.(request.uploadId);
        return { ok: true };
      }
      if (result.reason === "ref-conflict")
        return { ok: false, reason: "ref-conflict", ref: result.ref };
      if (result.reason === "refname-conflict") {
        const { ref, conflictsWith } = result;
        return { ok: false, reason: "refname-conflict", ref, conflictsWith };
      }
      if (result.reason === "unknown-pack") {
        return { ok: false, reason: "failed", message: `pack ${result.packId} cannot be added` };
      }
    }
    return { ok: false, reason: "failed", message: "the repository is busy; try the push again" };
  };
}
