import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseExpectedSchema, type SchemaObject } from "../src/d1-schema.ts";
import type { RunResult, WranglerRunner } from "../src/wrangler.ts";

/**
 * An in-memory Cloudflare account that answers the wrangler commands the CLI
 * uses, including wrangler's refusal to deploy a Worker whose required secret
 * is not set (secrets.required in wrangler.jsonc), Cloudflare's refusal to
 * delete a Worker that still consumes a queue (code 10064, seen live) and R2's
 * refusal to delete a bucket that holds objects or incomplete multipart
 * uploads (code 10008).
 *
 * D1 migrations are modelled by what they leave behind: applying them adds
 * the repository's expected objects a database lacks and leaves the ones it
 * has as they are, as D1 skips a migration it recorded by file name.
 */
export function fakeWrangler() {
  const state = {
    d1: new Map<string, string>(),
    /** Each D1 database's schema objects. */
    d1Schema: new Map<string, SchemaObject[]>(),
    /** The migration files each D1 database has applied, by name (its d1_migrations table). */
    d1Migrations: new Map<string, string[]>(),
    /** What fyrden-org answers to the effects summary, one row per state. */
    effects: [] as { state: string; count: number; oldest: number }[],
    /** Answers other queries of a database (a test's own SQLite), before the cases above. */
    d1Query: undefined as ((db: string, sql: string) => unknown[] | undefined) | undefined,
    /** fyrden-api's versions, latest last, with the vars each was deployed with. */
    apiVersions: [] as { id: string; vars: Record<string, string> }[],
    /** The read model protocol a deploy recorded as served (fyrden-directory). */
    executorVersion: 0,
    r2: new Set<string>(),
    /** Object counts of buckets that are not empty. */
    r2Objects: new Map<string, number>(),
    /** Incomplete multipart uploads per bucket: invisible to listings, but they keep it from being deleted. */
    r2Uploads: new Map<string, number>(),
    /** Lifecycle rules per bucket: name to its flags. */
    r2Lifecycle: new Map<string, Map<string, string[]>>(),
    queues: new Set<string>(),
    /** Queues whose delivery is paused. */
    paused: new Set<string>(),
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
    /** The next deploy of fyrden-api fails (once). */
    failApiDeploy: false,
    /** The next pause of a queue's delivery fails (once), before it applies or after. */
    failPause: false as false | "before" | "after",
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
      if (args[0] === "queues" && (args[1] === "pause-delivery" || args[1] === "resume-delivery")) {
        if (!state.queues.has(args[2] as string))
          return fail(`Queue "${args[2]}" does not exist. [code: 11000]`);
        if (args[1] === "pause-delivery" && state.failPause) {
          if (state.failPause === "after") state.paused.add(args[2] as string);
          state.failPause = false;
          return fail("A request to the Cloudflare API failed. [code: 10013]");
        }
        if (args[1] === "pause-delivery") state.paused.add(args[2] as string);
        else state.paused.delete(args[2] as string);
        return ok();
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
        const config = readConfig(args, options.cwd) as {
          d1_databases?: { database_name: string; migrations_dir: string }[];
        };
        const dir = config.d1_databases?.find((d) => d.database_name === name)?.migrations_dir;
        const expected = parseExpectedSchema(
          readFileSync(join(options.cwd as string, `${dir}.expected.sql`), "utf8"),
        );
        const schema = state.d1Schema.get(name) ?? [];
        const have = new Set(schema.map((o) => o.name));
        state.d1Schema.set(name, [...schema, ...expected.filter((o) => !have.has(o.name))]);
        const applied = state.d1Migrations.get(name) ?? [];
        const files = readdirSync(join(options.cwd as string, dir as string)).filter((f) =>
          f.endsWith(".sql"),
        );
        state.d1Migrations.set(name, [
          ...applied,
          ...files.sort().filter((f) => !applied.includes(f)),
        ]);
        return ok();
      }
      if (args[0] === "d1" && args[1] === "execute") {
        const db = args[2] as string;
        const sql = args[args.indexOf("--command") + 1] as string;
        if (!state.d1.has(db)) return fail(`Couldn't find DB with name '${db}'`);
        const schema = state.d1Schema.get(db) ?? [];
        const migrations = state.d1Migrations.get(db);
        let results: unknown[];
        const answered = state.d1Query?.(db, sql);
        if (answered) results = answered;
        else if (sql.includes("FROM d1_migrations")) {
          if (!migrations) return fail("no such table: d1_migrations: SQLITE_ERROR [code: 7500]");
          results = migrations.map((name) => ({ name }));
        } else if (sql.includes("FROM sqlite_schema")) results = schema;
        else if (sql.startsWith("UPDATE read_model_barriers SET executor_version")) {
          state.executorVersion = Number(/executor_version = (\d+)/.exec(sql)?.[1]);
          results = [{ shard: "default" }];
        } else if (sql.includes("FROM effects") && schema.some((o) => o.name === "effects"))
          results = state.effects;
        else return fail("no such table: effects: SQLITE_ERROR [code: 7500]");
        return ok(JSON.stringify([{ results, success: true, meta: {} }]));
      }
      if (cmd === "deployments status --name") {
        const latest = state.apiVersions.at(-1);
        if (args[3] !== "fyrden-api" || !latest)
          return fail(`The Worker ${args[3]} has no deployments.`);
        return ok(JSON.stringify({ versions: [{ version_id: latest.id, percentage: 100 }] }));
      }
      if (args[0] === "versions" && args[1] === "view") {
        const version = state.apiVersions.find((v) => v.id === args[2]);
        if (!version) return fail(`version ${args[2]} not found [code: 10007]`);
        const bindings = Object.entries(version.vars).map(([n, text]) => ({
          type: "plain_text",
          name: n,
          text,
        }));
        return ok(JSON.stringify({ id: version.id, resources: { bindings } }));
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
        if (worker === "fyrden-api" && state.failApiDeploy) {
          state.failApiDeploy = false;
          return fail("A request to the Cloudflare API failed. [code: 10013]");
        }
        if (worker === "fyrden-api" && !state.secrets.has("BOOTSTRAP_SECRET")) {
          return fail("The following required secrets have not been set: BOOTSTRAP_SECRET");
        }
        if (args.includes("-c") && options.cwd) {
          const config = readConfig(args, options.cwd) as {
            tail_consumers?: { service: string }[];
            queues?: { consumers?: { queue: string }[] };
            vars?: Record<string, string>;
          };
          const missingTail = (config.tail_consumers ?? []).find(
            (t) => !state.deployed.includes(t.service),
          );
          if (missingTail)
            return fail(`Tail consumer ${missingTail.service} does not exist [code: 10007]`);
          state.tailAttached = (config.tail_consumers ?? []).length > 0;
          for (const { queue } of config.queues?.consumers ?? [])
            state.consumers.set(queue, new Set([...(state.consumers.get(queue) ?? []), worker]));
          state.apiVersions.push({ id: `ver-${next++}`, vars: config.vars ?? {} });
        }
        state.deployed.push(worker);
        return ok(`Deployed ${worker}\n  https://${worker}.acct.workers.dev`);
      }
      return fail(`fake wrangler: unexpected ${args.join(" ")}`);
    },
  };
  return { runner, state, calls };
}

/** The generated (plain JSON) config a command names with `-c`. */
function readConfig(args: string[], cwd: string | undefined): Record<string, unknown> {
  const file = args[args.indexOf("-c") + 1] as string;
  return JSON.parse(readFileSync(join(cwd as string, file), "utf8")) as Record<string, unknown>;
}
