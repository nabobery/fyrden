// Test-only Durable Object hosting the git storage adapters. Tests reach the
// adapters through `runInDurableObject`, because SQLite storage can only be
// used from inside its own object.
import { DurableObject } from "cloudflare:workers";
import type { PackId, PackWriter } from "@fyrden/git-core";
import { GIT_STORAGE_TABLES_V1, RepoGitStorage } from "../../src/git/index.js";
import { MIN_PART_BYTES, R2PackStore } from "../../src/git/r2-pack-store.js";
import { applyDoMigrations } from "../../src/migrations/index.js";
import type { Metrics } from "../../src/obs/metrics.js";

export interface RecordedMetric {
  name: string;
  dimensions: Record<string, string>;
  value: number;
}

export class GitStoreProbeDO extends DurableObject<Env> {
  readonly metrics: RecordedMetric[] = [];
  readonly alarms: number[] = [];
  /** Open writers, for tests that drive one pack across several calls. */
  readonly writers = new Map<PackId, PackWriter>();
  readonly git: RepoGitStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      applyDoMigrations(ctx.storage, [
        { version: 1, name: "git_storage", sql: GIT_STORAGE_TABLES_V1 },
      ]);
    });
    const recorder: Metrics = {
      count: (name, dimensions, value = 1) => {
        this.metrics.push({ name, dimensions: dimensions as Record<string, string>, value });
      },
    };
    this.git = new RepoGitStorage({
      storage: ctx.storage,
      bucket: env.GIT,
      bucketName: "fyrden-git-test",
      metrics: recorder,
      partBytes: MIN_PART_BYTES,
      setAlarm: (at) => {
        this.alarms.push(at);
      },
    });
  }

  /** Starts a pack whose id the test chose, so a test-side proxy can name it synchronously. */
  beginPackWithId(packId: PackId): void {
    const store = new R2PackStore(this.git.context, {
      bucket: this.env.GIT,
      bucketName: "fyrden-git-test",
      registry: this.git.registry,
      networkId: () => this.git.networkId(),
      partBytes: MIN_PART_BYTES,
      newPackId: () => packId,
    });
    this.writers.set(packId, store.beginPack());
  }

  writer(packId: PackId): PackWriter {
    const writer = this.writers.get(packId);
    if (!writer) throw new Error(`no open writer for ${packId}`);
    return writer;
  }
}
