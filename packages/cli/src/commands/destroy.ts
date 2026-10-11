import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { assertConfigAccount, pinAccount, resolveAccount } from "../account.ts";
import { parseJsonc } from "../jsonc.ts";
import { readApiConfig, resourcePlan } from "../resources.ts";
import { type RunResult, WranglerError, type WranglerRunner, wrangler } from "../wrangler.ts";
import { kvNamespaceIds } from "./provision.ts";

export interface DestroyDeps {
  repoRoot: string;
  runner: WranglerRunner;
  /** True with `--yes`: delete. Otherwise only list what would be deleted. */
  confirmed: boolean;
  log: (line: string) => void;
  /** CLOUDFLARE_ACCOUNT_ID, if set: the account wrangler acts on. */
  envAccountId?: string | undefined;
}

export interface DestroyResult {
  dryRun: boolean;
  /** Resources deleted, e.g. "r2:fyrden-git". Empty on a dry run. */
  deleted: string[];
  /** What a dry run found and `--yes` would delete. */
  wouldDelete: string[];
  /** Resources that do not exist. */
  skipped: string[];
  /** Resources destroy cannot delete (a bucket that is not empty, Analytics Engine datasets). */
  left: string[];
  /** False when something destroy should delete is still there; rerun once it can be. */
  complete: boolean;
}

// Wrangler's wording for a resource that is not there: R2 10006, Workers 10007,
// KV 10013, Queues 11000, D1 "Couldn't find", a missing queue consumer.
const MISSING =
  /does not exist|not found|couldn't find|no worker consumer|code: (10006|10007|10013|11000)\b/i;
// R2's BucketNotEmpty (developers.cloudflare.com/r2/api/error-codes/).
const BUCKET_NOT_EMPTY = /code: 10008\b|not empty/i;

/**
 * Runs one wrangler command. A resource that is not there gives `null`; any
 * other failure (auth, network) is an error, never "missing".
 */
async function call(runner: WranglerRunner, args: string[]): Promise<RunResult | null> {
  const result = await runner.run(args);
  if (result.code === 0) return result;
  if (MISSING.test(result.stderr + result.stdout)) return null;
  throw new WranglerError(args, result);
}

/** The lifecycle rule destroy adds to a bucket it cannot delete. */
export const ABORT_UPLOADS_RULE = "fyrden-destroy-abort";

/**
 * Asks R2 to abort the bucket's incomplete multipart uploads (left by
 * interrupted pushes and imports). R2 refuses to delete a bucket that still
 * has them, even when it holds no objects, and wrangler can neither list nor
 * abort them; a lifecycle rule can (`--abort-multipart-days`, wrangler
 * 4.149). R2 applies rules in the background, typically within a day
 * (developers.cloudflare.com/r2/buckets/object-lifecycles/). Never fails
 * the run: the help says what to do instead.
 */
async function abortIncompleteUploads(runner: WranglerRunner, bucket: string): Promise<string> {
  const args = [
    "r2",
    "bucket",
    "lifecycle",
    "add",
    bucket,
    ABORT_UPLOADS_RULE,
    "--abort-multipart-days",
    "1",
    "--force",
  ];
  const added = await runner.run(args);
  if (added.code === 0)
    return `  added lifecycle rule ${ABORT_UPLOADS_RULE}: R2 aborts the bucket's incomplete multipart uploads (left by interrupted pushes or imports; they keep a bucket from being deleted even with no objects in it) in the background, typically within a day.`;
  const reason = (added.stderr || added.stdout).trim().split("\n")[0]?.slice(0, 200) ?? "";
  return `  could not add lifecycle rule ${ABORT_UPLOADS_RULE} (${reason}); if the rule is not there yet, add it: wrangler ${args.join(" ")}`;
}

/**
 * Emptying a bucket through wrangler means one call per object, far too slow
 * for git data, so destroy leaves a non-empty bucket and says how to empty it.
 */
function emptyBucketHelp(bucket: string, uploads: string): string[] {
  return [
    `left r2:${bucket}: the bucket is not empty (objects, or incomplete multipart uploads), and R2 deletes only empty buckets.`,
    uploads,
    "  Delete its objects, if it has any:",
    // Dashboard action: developers.cloudflare.com/changelog/post/2026-04-30-r2-empty-bucket-folder-delete/
    // [U] whether "Empty Bucket" also aborts incomplete multipart uploads.
    `  - dashboard: R2 object storage > ${bucket} > Settings > Empty Bucket, or`,
    // Lifecycle rules delete in the background, not at once
    // (developers.cloudflare.com/r2/buckets/object-lifecycles/).
    `  - a lifecycle rule that expires every object (takes effect in the background, typically within a day or two): wrangler r2 bucket lifecycle add ${bucket} fyrden-destroy --expire-days 1 --force`,
    "  Then, once the objects and uploads are gone, rerun `fyrden destroy --yes`.",
  ];
}

/**
 * `fyrden destroy`: deletes what `fyrden deploy` created, by the names in the
 * committed configs. A dry run unless `confirmed`. The order is one Cloudflare
 * accepts: a Worker that consumes a queue cannot be deleted (error 10064, seen
 * live), so queue consumers go first, then fyrden-web, fyrden-api, the queues,
 * the R2 buckets, D1 and KV. Missing resources are skipped, so a second run
 * deletes nothing. Any unexpected failure stops the run before later steps.
 */
export async function destroy(deps: DestroyDeps): Promise<DestroyResult> {
  const { log, confirmed } = deps;
  const apiDir = join(deps.repoRoot, "apps", "api");
  const webDir = join(deps.repoRoot, "apps", "web");

  const account = await resolveAccount(deps.runner, deps.envAccountId);
  log(
    `destroying Fyrden in account ${account.name} (${account.id})${confirmed ? "" : " (dry run)"}`,
  );
  const runner = pinAccount(deps.runner, account.id);

  const config = await readApiConfig(join(apiDir, "wrangler.jsonc"));
  assertConfigAccount("apps/api/wrangler.jsonc", config, account.id);
  const webConfig = parseJsonc<Record<string, unknown> & { name: string }>(
    await readFile(join(webDir, "wrangler.jsonc"), "utf8"),
  );
  assertConfigAccount("apps/web/wrangler.jsonc", webConfig, account.id);
  const plan = resourcePlan(config);
  // KV namespaces are found the way deploy binds them, and before anything is
  // deleted: an ambiguous title stops the run here.
  const kv = await kvNamespaceIds(
    runner,
    plan.kv.map((ns) => ns.title),
  );
  // fyrden-web first: it is fyrden-api's Tail Worker, and fyrden-api has no
  // other dependants once its queue consumers are gone.
  const workers = [webConfig.name, config.name];

  if (confirmed) {
    // [M] Unverified whether Durable Object data outlives its Worker's
    // deletion; the warning assumes it does not, erring towards data loss.
    log(
      `WARNING: this permanently deletes Fyrden in account ${account.name} (${account.id}): both Workers and their Durable Object data, every repository's git data (R2), the D1 databases, the queues and the KV cache. It cannot be undone.`,
    );
  }

  const result: DestroyResult = {
    dryRun: !confirmed,
    deleted: [],
    wouldDelete: [],
    skipped: [],
    left: [],
    complete: true,
  };
  const missing = (key: string) => {
    result.skipped.push(key);
    log(`skipped ${key} (not found)`);
  };
  /** Deletes a resource that exists, or on a dry run lists it. */
  const remove = async (key: string, args: string[], note = "") => {
    if (!confirmed) {
      result.wouldDelete.push(key);
      log(`would delete ${key}${note}`);
    } else if (await call(runner, args)) {
      result.deleted.push(key);
      log(`deleted ${key}`);
    } else {
      missing(key);
    }
  };

  // 1. Queue consumers held by Fyrden's Workers. A missing queue has none;
  //    it is reported with the queues below.
  for (const queue of plan.queues) {
    const list = await call(runner, ["queues", "consumer", "list", queue, "--json"]);
    if (!list) continue;
    const consumers = JSON.parse(list.stdout) as {
      type: string;
      script?: string;
      service?: string;
    }[];
    for (const consumer of consumers) {
      const worker = consumer.script ?? consumer.service;
      if (consumer.type === "worker" && worker && workers.includes(worker))
        await remove(`consumer:${queue}/${worker}`, [
          "queues",
          "consumer",
          "remove",
          queue,
          worker,
        ]);
    }
  }

  // 2. Workers. `--force` because each is a dependant of the other (Tail
  //    Worker, service binding): without it wrangler asks, and outside a
  //    terminal answers yes itself. The operator already confirmed with --yes.
  for (const worker of workers) {
    const key = `worker:${worker}`;
    if (await call(runner, ["secret", "list", "--name", worker, "--format", "json"]))
      await remove(key, ["delete", "--name", worker, "--force"]);
    else missing(key);
  }

  // 3. Queues, now without consumers.
  for (const queue of plan.queues) {
    if (await call(runner, ["queues", "info", queue]))
      await remove(`queue:${queue}`, ["queues", "delete", queue]);
    else missing(`queue:${queue}`);
  }

  // 4. R2 buckets. R2 refuses to delete one that holds objects.
  for (const bucket of plan.r2) {
    const key = `r2:${bucket}`;
    const args = ["r2", "bucket", "delete", bucket];
    const info = await call(runner, ["r2", "bucket", "info", bucket, "--json"]);
    if (!info) {
      missing(key);
    } else if (!confirmed) {
      // R2's object count comes from metrics and may lag, so it only informs.
      const { object_count: count = "0" } = JSON.parse(info.stdout) as { object_count?: string };
      const note = count === "0" ? "" : ` (about ${count} objects; it must be emptied first)`;
      await remove(key, args, note);
    } else {
      const deleted = await runner.run(args);
      const output = deleted.stderr + deleted.stdout;
      if (deleted.code === 0) {
        result.deleted.push(key);
        log(`deleted ${key}`);
      } else if (BUCKET_NOT_EMPTY.test(output)) {
        result.left.push(key);
        result.complete = false;
        const uploads = await abortIncompleteUploads(runner, bucket);
        for (const line of emptyBucketHelp(bucket, uploads)) log(line);
      } else if (MISSING.test(output)) {
        missing(key);
      } else {
        throw new WranglerError(args, deleted);
      }
    }
  }

  // 5. D1 databases.
  const d1 = new Set(
    (JSON.parse(await wrangler(runner, ["d1", "list", "--json"])) as { name: string }[]).map(
      (d) => d.name,
    ),
  );
  for (const db of plan.d1) {
    if (d1.has(db.name)) await remove(`d1:${db.name}`, ["d1", "delete", db.name, "-y"]);
    else missing(`d1:${db.name}`);
  }

  // 6. KV namespaces, by the ids found above.
  for (const ns of plan.kv) {
    const id = kv.get(ns.title);
    if (id)
      await remove(`kv:${ns.title}`, ["kv", "namespace", "delete", "--namespace-id", id, "-y"]);
    else missing(`kv:${ns.title}`);
  }

  // 7. Analytics Engine datasets: wrangler (4.149) has no command for them.
  const datasets = (config.analytics_engine_datasets ?? []) as { dataset: string }[];
  for (const { dataset } of datasets) {
    result.left.push(`analytics-engine:${dataset}`);
    log(
      `left analytics-engine:${dataset}: wrangler cannot delete Analytics Engine datasets; it stops receiving data once fyrden-api is gone`,
    );
  }

  if (confirmed) {
    log(
      `\ndeleted ${result.deleted.length}, skipped ${result.skipped.length} (not found), left ${result.left.length}`,
    );
  } else {
    log(
      `\ndry run: nothing was deleted; rerun with --yes to delete the ${result.wouldDelete.length} resources above permanently`,
    );
  }
  if (result.left.length > 0) log(`left in place: ${result.left.join(", ")}`);
  return result;
}
