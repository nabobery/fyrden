import type { JobHandler, RepoGitStorage } from "@fyrden/adapters-cloudflare/git";
import type { Logger } from "@fyrden/adapters-cloudflare/obs";
import type { RepoPush } from "../../git/push/repo-push.js";
import {
  CONFIRMED_KEEP_MS,
  STORAGE_CHARGE_TTL_MS,
  STORAGE_QUOTA_EXCEEDED,
  STORAGE_QUOTA_UNAVAILABLE,
} from "../org/quotas.js";
import type { RepoAccount } from "./acl.js";

/*
 * The account's storage quota, as the repository's pushes use it: an
 * upload's bytes charged at its commit point (refused when they do not
 * fit), owed to the account in the commit's transaction and confirmed
 * right after; a confirmation that could not be made stays owed and the
 * `storage_confirm` job makes it later.
 */

/** The job that tells the account of committed uploads it was not told of at once. */
const STORAGE_CONFIRM_JOB = "storage-confirm";
/** How long before an owed confirmation is tried (again). Proposed. */
const STORAGE_CONFIRM_RETRY_MS = 60_000;
/** Owed confirmations one slice tells. Proposed. */
const STORAGE_CONFIRM_BATCH = 50;
/** How long a confirmation stays owed: within the account's memory of the ones it took. */
const STORAGE_OWED_MAX_AGE_MS = CONFIRMED_KEEP_MS - 24 * 60 * 60 * 1000;

export interface StorageChargeDeps {
  readonly git: RepoGitStorage;
  /** The Worker's bindings, read at each use (tests may replace them). */
  readonly env: () => Env;
  /** The account the repository belongs to; undefined for one from before identities. */
  readonly account: () => RepoAccount | undefined;
  readonly repoId: () => string;
  readonly log: () => Logger;
}

export class StorageCharges {
  constructor(private readonly deps: StorageChargeDeps) {}

  /** The push path's use of the account's quota (see `RepoPush.storage`). */
  quota(): NonNullable<RepoPush["storage"]> {
    const { git } = this.deps;
    const account = () => {
      // A repository from before identities were recorded has no account to charge.
      const owner = this.deps.account();
      return owner && this.deps.env().ORG.getByName(owner.accountId);
    };
    return {
      charge: async (uploadId, bytes) => {
        const stub = account();
        if (!stub) return undefined;
        try {
          const fits = await stub.chargeStorage({
            uploadId,
            repoId: this.deps.repoId(),
            bytes,
            ttlMs: STORAGE_CHARGE_TTL_MS,
          });
          return fits ? undefined : STORAGE_QUOTA_EXCEEDED;
        } catch (error) {
          // Fail closed: an account that cannot be asked takes no bytes.
          this.deps.log().warn("storage charge failed", { uploadId, error });
          return STORAGE_QUOTA_UNAVAILABLE;
        }
      },
      owe: (uploadId, bytes) => {
        if (!account()) return;
        git.context.storage.sql.exec(
          "INSERT OR IGNORE INTO storage_owed (upload_id, bytes, owed_at) VALUES (?, ?, ?)",
          uploadId,
          bytes,
          git.context.now(),
        );
        // Told right after the commit; this job tells the account should that fail.
        git.jobs.ensure("storage_confirm", STORAGE_CONFIRM_JOB, {
          runAt: git.context.now() + STORAGE_CONFIRM_RETRY_MS,
        });
      },
      confirm: async (uploadId, bytes) => {
        await this.#confirm(uploadId, bytes);
      },
      release: async (uploadId) => {
        // Not released, what the upload held lapses on its own.
        await account()
          ?.releaseStorage(uploadId)
          .catch((error: unknown) =>
            this.deps.log().warn("storage release failed", { uploadId, error }),
          );
      },
    };
  }

  /**
   * Tells the account a committed upload's bytes are the repository's (it
   * counts each upload once), then owes it nothing; false when it could
   * not be told (still owed: the `storage_confirm` job tries again).
   */
  async #confirm(uploadId: string, bytes: number): Promise<boolean> {
    const owner = this.deps.account();
    if (!owner) return true;
    try {
      // Not taken while the repository moves between accounts: owed to the next one.
      const taken = await this.deps.env().ORG.getByName(owner.accountId).confirmStorage({
        uploadId,
        repoId: this.deps.repoId(),
        bytes,
      });
      if (!taken) return false;
    } catch (error) {
      this.deps.log().warn("storage confirm failed", { uploadId, error });
      return false;
    }
    this.deps.git.context.storage.sql.exec(
      "DELETE FROM storage_owed WHERE upload_id = ?",
      uploadId,
    );
    return true;
  }

  /** Committed uploads the account has not been told of yet. */
  owed(): { uploadId: string; bytes: number }[] {
    return this.deps.git.context.storage.sql
      .exec<{ upload_id: string; bytes: number }>(
        "SELECT upload_id, bytes FROM storage_owed ORDER BY upload_id",
      )
      .toArray()
      .map((r) => ({ uploadId: r.upload_id, bytes: r.bytes }));
  }

  /** The `storage_confirm` job: tells the account of every upload still owed. */
  confirmHandler(): JobHandler {
    const { git } = this.deps;
    return {
      runSlice: async () => {
        const sql = git.context.storage.sql;
        // Owed past the account's memory of confirmations, one told again could count twice:
        // given up, uncounted.
        const stale = sql
          .exec<{ upload_id: string; bytes: number }>(
            "SELECT upload_id, bytes FROM storage_owed WHERE owed_at < ?",
            git.context.now() - STORAGE_OWED_MAX_AGE_MS,
          )
          .toArray();
        for (const row of stale) {
          this.deps.log().error("storage confirmation given up", {
            uploadId: row.upload_id,
            bytes: row.bytes,
          });
          sql.exec("DELETE FROM storage_owed WHERE upload_id = ?", row.upload_id);
        }
        const owed = sql
          .exec<{ upload_id: string; bytes: number }>(
            "SELECT upload_id, bytes FROM storage_owed ORDER BY owed_at LIMIT ?",
            STORAGE_CONFIRM_BATCH,
          )
          .toArray();
        for (const row of owed) {
          // The account cannot be told now: later, without spending an attempt.
          if (!(await this.#confirm(row.upload_id, row.bytes)))
            return { done: false, cursor: null, runAfterMs: STORAGE_CONFIRM_RETRY_MS };
        }
        // Done only with nothing owed, judged with no wait before the answer: a push that
        // owed more meanwhile found this job running and left it to this one.
        const left = sql.exec<{ n: number }>("SELECT count(*) AS n FROM storage_owed").one().n;
        return left === 0
          ? { done: true }
          : { done: false, cursor: null, runAfterMs: STORAGE_CONFIRM_RETRY_MS };
      },
    };
  }
}
