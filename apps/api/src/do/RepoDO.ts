import { createLogger, createMetrics, type RequestMeta } from "@fyrden/adapters-cloudflare/obs";
import { MigratingDO } from "./base/MigratingDO.js";
import { repoSchema } from "./schema/repo.js";

/** One repository: refs, packs, issues, pull requests and the outbox. Keyed by the immutable repo id. */
export class RepoDO extends MigratingDO {
  static readonly schema = repoSchema;

  /** Writes and reads back one value in this object's SQLite storage (used by /healthz). */
  async healthProbe(nonce: string, meta: RequestMeta = {}): Promise<boolean> {
    await this.ctx.storage.put("healthz", nonce);
    createMetrics(this.env.METRICS).count("do.rows_written", {
      class: "RepoDO",
      op: "healthProbe",
    });
    const ok = (await this.ctx.storage.get<string>("healthz")) === nonce;
    createLogger({ ...meta, do: "RepoDO" }).debug("healthz probe", { ok });
    return ok;
  }
}
