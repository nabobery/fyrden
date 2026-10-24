import type { RepoGitStorage } from "@fyrden/adapters-cloudflare/git";
import type { Metrics } from "@fyrden/adapters-cloudflare/obs";
import type { Blob } from "../../webhooks/capture.js";

/*
 * The repository's store of webhook capture blobs (`webhook_blobs`): the
 * long text values webhook captures name by hash (see
 * `webhooks/capture.ts`), each kept once and until a day after the latest
 * deadline of an event naming it, so an event's delivery can still read it.
 * Nothing counts references: a blob goes when its time is up, whatever
 * named it.
 */

/** How long a blob outlives the latest deadline naming it. */
export const WEBHOOK_BLOB_GRACE_MS = 24 * 60 * 60 * 1000;

/** What asking for an event's blobs answers: their texts, or why they cannot be read. */
export type WebhookBlobsRead =
  | { readonly texts: Readonly<Record<string, string>> }
  | { readonly missing: "deleted" | "restored" | "transferred" | "absent" };

export interface WebhookBlobsAsk {
  readonly hashes: readonly string[];
  /** The restore and ownership generations the event was made in. */
  readonly epochGen: number;
  readonly ownerGen: number;
}

export interface WebhookBlobsDeps {
  readonly git: RepoGitStorage;
  readonly metrics: Metrics;
  /** Queues the store's pruning for `at` (or keeps it sooner). */
  readonly pruneAt: (at: number) => void;
}

export class RepoWebhookBlobs {
  constructor(private readonly deps: WebhookBlobsDeps) {}

  get #sql() {
    return this.deps.git.context.storage.sql;
  }

  #written(op: string, rows: number): void {
    if (rows > 0)
      this.deps.metrics.count(
        "do.rows_written",
        { class: this.deps.git.context.doClass, op },
        rows,
      );
  }

  /**
   * In the caller's transaction: keeps `blobs` for an event whose delivery
   * deadline is `deadline`, each until a day after the latest such deadline
   * (a blob kept long enough already is not written). Rows written.
   */
  store(blobs: ReadonlyMap<string, Blob>, deadline: number): number {
    const until = deadline + WEBHOOK_BLOB_GRACE_MS;
    let written = 0;
    for (const blob of blobs.values())
      written += this.#sql.exec(
        `INSERT INTO webhook_blobs (hash, text_json, bytes, retain_until) VALUES (?, ?, ?, ?)
         ON CONFLICT (hash) DO UPDATE SET retain_until = excluded.retain_until
         WHERE excluded.retain_until > webhook_blobs.retain_until`,
        blob.hash,
        blob.json,
        blob.bytes,
        until,
      ).rowsWritten;
    this.#written("webhooks.blobs", written);
    if (blobs.size > 0) this.deps.pruneAt(until);
    return written;
  }

  /**
   * The texts of `ask.hashes`, while the event is still the repository's:
   * made in its current restore generation and under its current owner
   * (`current`); `missing` with why otherwise, or `absent` when any is gone.
   */
  read(
    ask: WebhookBlobsAsk,
    current: { readonly epochGen: number; readonly ownerGen: number },
  ): WebhookBlobsRead {
    if (ask.epochGen !== current.epochGen) return { missing: "restored" };
    if (ask.ownerGen !== current.ownerGen) return { missing: "transferred" };
    const wanted = [...new Set(ask.hashes)];
    const rows = this.#sql
      .exec<{ hash: string; text_json: string }>(
        "SELECT hash, text_json FROM webhook_blobs WHERE hash IN (SELECT value FROM json_each(?))",
        JSON.stringify(wanted),
      )
      .toArray();
    if (rows.length !== wanted.length) return { missing: "absent" };
    return { texts: Object.fromEntries(rows.map((row) => [row.hash, row.text_json])) };
  }

  /** Deletes up to `limit` blobs whose time is up at `now`; how many, and when the next goes. */
  prune(now: number, limit: number): { pruned: number; nextAt: number | null } {
    const cursor = this.#sql.exec(
      `DELETE FROM webhook_blobs WHERE hash IN (
         SELECT hash FROM webhook_blobs WHERE retain_until <= ? ORDER BY retain_until LIMIT ?)
       RETURNING hash`,
      now,
      limit,
    );
    const pruned = cursor.toArray().length;
    this.#written("webhooks.blobs_prune", cursor.rowsWritten);
    const [next] = this.#sql
      .exec<{ at: number | null }>("SELECT min(retain_until) AS at FROM webhook_blobs")
      .toArray();
    return { pruned, nextAt: next?.at ?? null };
  }
}
