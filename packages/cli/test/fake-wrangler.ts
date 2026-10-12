import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunResult, WranglerRunner } from "../src/wrangler.ts";

/**
 * An in-memory Cloudflare account that answers the wrangler commands the CLI
 * uses, including wrangler's refusal to deploy a Worker whose required secret
 * is not set (secrets.required in wrangler.jsonc), Cloudflare's refusal to
 * delete a Worker that still consumes a queue (code 10064, seen live) and R2's
 * refusal to delete a bucket that holds objects or incomplete multipart
 * uploads (code 10008).
 */
export function fakeWrangler() {
  const state = {
    d1: new Map<string, string>(),
    r2: new Set<string>(),
    /** Object counts of buckets that are not empty. */
    r2Objects: new Map<string, number>(),
    /** Incomplete multipart uploads per bucket: invisible to listings, but they keep it from being deleted. */
    r2Uploads: new Map<string, number>(),
    /** Lifecycle rules per bucket: name to its flags. */
    r2Lifecycle: new Map<string, Map<string, string[]>>(),
    queues: new Set<string>(),
    /** Queue name to the Workers consuming it. */
    consumers: new Map<string, Set<string>>(),
    /**
     * KV namespace id to title. Keyed by id so a test can give two namespaces
     * one title, which `kv namespace create` itself refuses (code 10014).
     */
    kv: new Map<string, string>(),
    secrets: new Map<string, string>(),
    deployed: [] as string[],
    migrated: [] as string[],
    tailAttached: false,
    loggedIn: true,
    accounts: [{ id: "acct-1", name: "Test account" }] as { id: string; name: string }[],
  };
  const calls: { args: string[]; cwd?: string; account?: string }[] = [];
  let next = 1;
  const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });
  const fail = (stderr: string): RunResult => ({ code: 1, stdout: "", stderr });

  const runner: WranglerRunner = {
    async run(args, options = {}) {
      const account = options.env?.CLOUDFLARE_ACCOUNT_ID;
      calls.push({ args, ...(options.cwd && { cwd: options.cwd }), ...(account && { account }) });
      // Like a real account: anything but whoami needs an account this login reaches.
      if (args[0] !== "whoami" && !state.accounts.some((a) => a.id === account))
        return fail("A request to the Cloudflare API failed. Authentication error [code: 10000]");
      const cmd = args.slice(0, 3).join(" ");
      const name = args[3] ?? args[2] ?? "";
      if (args[0] === "whoami")
        return state.loggedIn
          ? ok(JSON.stringify({ loggedIn: true, accounts: state.accounts }))
          : fail("You are not authenticated. Please run `wrangler login`.");
      if (cmd === "d1 list --json")
        return ok(JSON.stringify([...state.d1].map(([n, uuid]) => ({ name: n, uuid }))));
      if (args[0] === "d1" && args[1] === "create") {
        state.d1.set(args[2] as string, `d1-${next++}`);
        return ok();
      }
      if (cmd === "r2 bucket info") {
        if (!state.r2.has(name)) return fail("The specified bucket does not exist. [code: 10006]");
        const objects = (state.r2Objects.get(name) ?? 0).toLocaleString("en-US");
        return ok(args.includes("--json") ? JSON.stringify({ name, object_count: objects }) : name);
      }
      if (cmd === "r2 bucket delete") {
        if (!state.r2.has(name)) return fail("The specified bucket does not exist. [code: 10006]");
        if (state.r2Objects.get(name) || state.r2Uploads.get(name))
          return fail("The bucket you tried to delete is not empty. [code: 10008]");
        state.r2.delete(name);
        return ok();
      }
      if (cmd === "r2 bucket lifecycle" && args[3] === "add") {
        const bucket = args[4] as string;
        const rule = args[5] as string;
        if (!state.r2.has(bucket))
          return fail("The specified bucket does not exist. [code: 10006]");
        const rules = state.r2Lifecycle.get(bucket) ?? new Map<string, string[]>();
        // [U] wrangler's wording for a rule name already in use is not known.
        if (rules.has(rule)) return fail(`Lifecycle rule with ID '${rule}' already exists.`);
        rules.set(rule, args.slice(6));
        state.r2Lifecycle.set(bucket, rules);
        return ok();
      }
      if (cmd === "r2 bucket create") {
        state.r2.add(name);
        return ok();
      }
      if (args[0] === "queues" && args[1] === "info") {
        return state.queues.has(args[2] as string)
          ? ok()
          : fail(`Queue "${args[2]}" does not exist. [code: 11000]`);
      }
      if (args[0] === "queues" && args[1] === "create") {
        state.queues.add(args[2] as string);
        return ok();
      }
      if (args[0] === "queues" && args[1] === "delete") {
        if (!state.queues.delete(args[2] as string))
          return fail(`Queue "${args[2]}" does not exist. [code: 11000]`);
        state.consumers.delete(args[2] as string);
        return ok();
      }
      if (cmd === "queues consumer list") {
        if (!state.queues.has(name)) return fail(`Queue "${name}" does not exist. [code: 11000]`);
        const workers = [...(state.consumers.get(name) ?? [])];
        return ok(JSON.stringify(workers.map((script) => ({ type: "worker", script }))));
      }
      if (cmd === "queues consumer remove") {
        const worker = args[4] as string;
        if (!state.consumers.get(name)?.delete(worker))
          return fail(`No worker consumer '${worker}' exists for queue ${name}`);
        return ok();
      }
      if (cmd === "kv namespace list")
        return ok(JSON.stringify([...state.kv].map(([id, title]) => ({ id, title }))));
      if (cmd === "kv namespace create") {
        if ([...state.kv.values()].includes(name))
          return fail("a namespace with this account ID and title already exists [code: 10014]");
        state.kv.set(`kv-${next++}`, name);
        return ok();
      }
      if (cmd === "kv namespace delete") {
        const id = args[args.indexOf("--namespace-id") + 1] as string;
        if (!state.kv.delete(id)) return fail("namespace not found [code: 10013]");
        return ok();
      }
      if (args[0] === "d1" && args[1] === "delete") {
        if (!state.d1.delete(args[2] as string))
          return fail(`Couldn't find DB with name '${args[2]}'`);
        return ok();
      }
      if (args[0] === "delete") {
        const worker = args[args.indexOf("--name") + 1] as string;
        if (!state.deployed.includes(worker))
          return fail("This Worker does not exist on your account. [code: 10007]");
        if ([...state.consumers.values()].some((workers) => workers.has(worker)))
          return fail(
            `Cannot delete ${worker}: it is the consumer of a queue. Remove the consumer first. [code: 10064]`,
          );
        state.deployed = state.deployed.filter((w) => w !== worker);
        if (worker === "fyrden-api") {
          state.secrets.clear();
          state.tailAttached = false;
        }
        return ok();
      }
      if (cmd === "d1 migrations apply") {
        state.migrated.push(name);
        return ok();
      }
      if (args[0] === "secret" && args[1] === "list") {
        if (!state.deployed.includes(args[3] as string))
          return fail("Worker not found [code: 10007]");
        return ok(
          JSON.stringify([...state.secrets.keys()].map((n) => ({ name: n, type: "secret_text" }))),
        );
      }
      if (args[0] === "deploy") {
        const worker = options.cwd?.endsWith("web") ? "fyrden-web" : "fyrden-api";
        const fileIndex = args.indexOf("--secrets-file");
        if (fileIndex >= 0) {
          const secrets = JSON.parse(readFileSync(args[fileIndex + 1] as string, "utf8")) as Record<
            string,
            string
          >;
          for (const [k, v] of Object.entries(secrets)) state.secrets.set(k, v);
        }
        if (worker === "fyrden-api" && !state.secrets.has("BOOTSTRAP_SECRET")) {
          return fail("The following required secrets have not been set: BOOTSTRAP_SECRET");
        }
        const configIndex = args.indexOf("-c");
        if (configIndex >= 0 && options.cwd) {
          const config = JSON.parse(
            readFileSync(join(options.cwd, args[configIndex + 1] as string), "utf8"),
          ) as {
            tail_consumers?: { service: string }[];
            queues?: { consumers?: { queue: string }[] };
          };
          const missingTail = (config.tail_consumers ?? []).find(
            (t) => !state.deployed.includes(t.service),
          );
          if (missingTail)
            return fail(`Tail consumer ${missingTail.service} does not exist [code: 10007]`);
          state.tailAttached = (config.tail_consumers ?? []).length > 0;
          for (const { queue } of config.queues?.consumers ?? [])
            state.consumers.set(queue, new Set([...(state.consumers.get(queue) ?? []), worker]));
        }
        state.deployed.push(worker);
        return ok(`Deployed ${worker}\n  https://${worker}.acct.workers.dev`);
      }
      return fail(`fake wrangler: unexpected ${args.join(" ")}`);
    },
  };
  return { runner, state, calls };
}
