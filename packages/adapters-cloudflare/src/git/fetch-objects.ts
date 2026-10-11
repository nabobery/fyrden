import type { MaterialisedPackStore, PackId, PackInfo, PackWriter } from "@fyrden/git-core";
import { fetchObjectKey, fetchObjectPrefix } from "./keys.js";
import type { R2PackStore } from "./r2-pack-store.js";
import { first, type GitStorageContext } from "./sql.js";

/**
 * Objects a fetch plan writes before it returns: regenerated
 * packs and side-band framed copies of stored packs, under
 * `net/<network_id>/fetch/<cache_key>/<pack_id>.pack`, each with a registry
 * row of kind `fetch`, so it is read through the pack store and leased like
 * any pack. A row reaches `indexing` when its bytes are complete; `find`
 * returns only such rows, newest first.
 *
 * The pack retire job deletes an object (bytes, then row) some time after
 * its last lease (leases touch it), condemning it first so no plan finds or
 * leases it again; `onBegin` schedules that job.
 */
export class FetchObjectStore implements MaterialisedPackStore {
  constructor(
    private readonly context: GitStorageContext,
    private readonly packStore: R2PackStore,
    private readonly networkId: () => string,
    /** Called when an object is begun (schedules its expiry). */
    private readonly onBegin: () => void = () => {},
  ) {}

  async find(key: string): Promise<PackInfo | undefined> {
    const prefix = fetchObjectPrefix(this.networkId(), key);
    const row = first<{ pack_id: string; bytes: number }>(
      this.context.storage,
      `SELECT pack_id, bytes FROM packs
       WHERE kind = 'fetch' AND state = 'indexing' AND bytes IS NOT NULL
         AND substr(r2_key, 1, ?) = ?
       ORDER BY created_at DESC, pack_id DESC LIMIT 1`,
      prefix.length,
      prefix,
    );
    return row && { packId: row.pack_id as PackId, bytes: row.bytes };
  }

  begin(key: string): PackWriter {
    fetchObjectPrefix(this.networkId(), key);
    const writer = this.packStore.beginObject("fetch", (networkId, packId) =>
      fetchObjectKey(networkId, key, packId),
    );
    this.onBegin();
    return writer;
  }
}
