import type { ResourcePlan } from "../resources.ts";
import type { WranglerRunner } from "../wrangler.ts";
import { WranglerError, wrangler } from "../wrangler.ts";

export interface ProvisionResult {
  /** Resources this run created, e.g. "r2:fyrden-git". Empty when everything existed. */
  created: string[];
  /** Resources that are missing (only when `create` is false). */
  missing: string[];
  d1Ids: Record<string, string>;
  kvIds: Record<string, string>;
}

// Wrangler's wording for a resource that does not exist (R2 code 10006, Queues code 11000).
const NOT_FOUND = /does not exist|not found|code: 10006|code: 11000/i;
const ALREADY_EXISTS = /already exists|already taken|code: 10004|code: 11009/i;

/**
 * Asks for one named resource. Missing resources are reported as false; any
 * other failure (R2 not enabled, auth, network) is an error, never "missing".
 */
async function exists(runner: WranglerRunner, args: string[]): Promise<boolean> {
  const result = await runner.run(args);
  if (result.code === 0) return true;
  if (NOT_FOUND.test(result.stderr + result.stdout)) return false;
  throw new WranglerError(args, result);
}

/** Creates a resource; one created concurrently by someone else counts as success. */
async function create(runner: WranglerRunner, args: string[]): Promise<void> {
  const result = await runner.run(args);
  if (result.code !== 0 && !ALREADY_EXISTS.test(result.stderr + result.stdout))
    throw new WranglerError(args, result);
}

async function d1Ids(runner: WranglerRunner): Promise<Record<string, string>> {
  const list = JSON.parse(await wrangler(runner, ["d1", "list", "--json"])) as {
    uuid: string;
    name: string;
  }[];
  return Object.fromEntries(list.map((d) => [d.name, d.uuid]));
}

/**
 * The id of each KV namespace titled one of `titles`, the one lookup deploy
 * (to bind) and destroy (to delete) share. Creating a second namespace with a
 * title the account already has is refused (verified:
 * developers.cloudflare.com/api/resources/kv/subresources/namespaces/methods/create/),
 * but renames and jurisdictions are not documented to keep titles unique
 * [U]. So a title more than one namespace holds is an error, never a guess:
 * a guess could bind one namespace and later delete another.
 */
export async function kvNamespaceIds(
  runner: WranglerRunner,
  titles: readonly string[],
): Promise<Map<string, string>> {
  const list = JSON.parse(await wrangler(runner, ["kv", "namespace", "list"])) as {
    id: string;
    title: string;
  }[];
  const ids = new Map<string, string>();
  for (const title of titles) {
    const matches = list.filter((k) => k.title === title).map((k) => k.id);
    if (matches.length > 1)
      throw new Error(
        `${matches.length} KV namespaces in this account are titled ${title} (ids ${matches.join(", ")}); Fyrden cannot tell which one is its own and will not guess. Rename or delete the ones that are not Fyrden's, then rerun.`,
      );
    if (matches[0] !== undefined) ids.set(title, matches[0]);
  }
  return ids;
}

/**
 * Makes sure every resource in the plan exists. Checks first and creates only
 * what is missing, so a second run creates nothing. R2 buckets and queues are
 * checked one by one (`info`), which avoids parsing paginated list output.
 */
export async function provision(
  runner: WranglerRunner,
  plan: ResourcePlan,
  shouldCreate = true,
): Promise<ProvisionResult> {
  const created: string[] = [];
  const missing: string[] = [];
  const ensure = async (key: string, present: boolean, args: string[]) => {
    if (present) return;
    if (!shouldCreate) {
      missing.push(key);
      return;
    }
    await create(runner, args);
    created.push(key);
  };

  let d1 = await d1Ids(runner);
  for (const db of plan.d1) await ensure(`d1:${db.name}`, db.name in d1, ["d1", "create", db.name]);
  if (created.some((c) => c.startsWith("d1:"))) d1 = await d1Ids(runner);

  for (const name of plan.r2) {
    await ensure(`r2:${name}`, await exists(runner, ["r2", "bucket", "info", name]), [
      "r2",
      "bucket",
      "create",
      name,
    ]);
  }
  for (const name of plan.queues) {
    await ensure(`queue:${name}`, await exists(runner, ["queues", "info", name]), [
      "queues",
      "create",
      name,
    ]);
  }

  const titles = plan.kv.map((ns) => ns.title);
  let kv = await kvNamespaceIds(runner, titles);
  for (const ns of plan.kv)
    await ensure(`kv:${ns.title}`, kv.has(ns.title), ["kv", "namespace", "create", ns.title]);
  if (created.some((c) => c.startsWith("kv:"))) kv = await kvNamespaceIds(runner, titles);

  return {
    created,
    missing,
    d1Ids: Object.fromEntries(
      plan.d1.filter((db) => d1[db.name]).map((db) => [db.binding, d1[db.name] as string]),
    ),
    kvIds: Object.fromEntries(
      plan.kv.flatMap((ns) => {
        const id = kv.get(ns.title);
        return id === undefined ? [] : [[ns.binding, id]];
      }),
    ),
  };
}
