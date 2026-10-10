import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunResult, WranglerRunner } from "../src/wrangler.ts";

/**
 * An in-memory Cloudflare account that answers the wrangler commands the CLI
 * uses, including wrangler's refusal to deploy a Worker whose required secret
 * is not set (secrets.required in wrangler.jsonc).
 */
export function fakeWrangler() {
  const state = {
    d1: new Map<string, string>(),
    r2: new Set<string>(),
    queues: new Set<string>(),
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
      if (cmd === "r2 bucket info")
        return state.r2.has(name)
          ? ok(name)
          : fail("The specified bucket does not exist. [code: 10006]");
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
      if (cmd === "kv namespace list")
        return ok(JSON.stringify([...state.kv].map(([title, id]) => ({ title, id }))));
      if (cmd === "kv namespace create") {
        state.kv.set(name, `kv-${next++}`);
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
          };
          const missingTail = (config.tail_consumers ?? []).find(
            (t) => !state.deployed.includes(t.service),
          );
          if (missingTail)
            return fail(`Tail consumer ${missingTail.service} does not exist [code: 10007]`);
          state.tailAttached = (config.tail_consumers ?? []).length > 0;
        }
        state.deployed.push(worker);
        return ok(`Deployed ${worker}\n  https://${worker}.acct.workers.dev`);
      }
      return fail(`fake wrangler: unexpected ${args.join(" ")}`);
    },
  };
  return { runner, state, calls };
}
