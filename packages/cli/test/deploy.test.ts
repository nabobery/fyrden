import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { API_DEPLOY_CONFIG, type DeployDeps, deploy } from "../src/commands/deploy.ts";
import { doctor } from "../src/commands/doctor.ts";
import { parseJsonc } from "../src/jsonc.ts";
import type { WranglerRunner } from "../src/wrangler.ts";
import { fakeWrangler } from "./fake-wrangler.ts";

const realRoot = resolve(import.meta.dirname, "../../..");
let repoRoot = "";

beforeEach(async () => {
  // A copy of the real API config and migrations, so the plan is the real one.
  repoRoot = await mkdtemp(join(tmpdir(), "fyrden-cli-"));
  await mkdir(join(repoRoot, "apps", "web"), { recursive: true });
  await cp(join(realRoot, "apps/api/wrangler.jsonc"), join(repoRoot, "apps/api/wrangler.jsonc"));
  await cp(join(realRoot, "apps/web/wrangler.jsonc"), join(repoRoot, "apps/web/wrangler.jsonc"));
  await cp(join(realRoot, "apps/api/migrations"), join(repoRoot, "apps/api/migrations"), {
    recursive: true,
  });
});
afterEach(() => rm(repoRoot, { recursive: true, force: true }));

function deps(runner: WranglerRunner, overrides: Partial<DeployDeps> = {}) {
  const generated: string[] = [];
  const lines: string[] = [];
  const d: DeployDeps = {
    repoRoot,
    plan: "paid",
    runner,
    buildWeb: async () => {},
    source: { commit: "0123abc", dirty: false },
    randomSecret: () => "s3cret-value",
    onSecretGenerated: (s) => generated.push(s),
    log: (l) => lines.push(l),
    // The deployed API, asked which read model protocol it serves.
    fetch: async () => Response.json({ readModel: { protocol: 1 } }),
    ...overrides,
  };
  return { d, generated, lines };
}

const generatedConfig = async () =>
  parseJsonc<
    Record<string, unknown> & {
      d1_databases: { database_id: string }[];
      kv_namespaces: { id: string }[];
    }
  >(await readFile(join(repoRoot, "apps/api", API_DEPLOY_CONFIG), "utf8"));

describe("fyrden deploy", () => {
  it("creates every resource, including all four buckets and fyrden-assets", async () => {
    const fake = fakeWrangler();
    const result = await deploy(deps(fake.runner).d);
    expect([...fake.state.r2].sort()).toEqual([
      "fyrden-assets",
      "fyrden-ci",
      "fyrden-git",
      "fyrden-search",
    ]);
    expect([...fake.state.queues].sort()).toEqual([
      "fyrden-ci-dispatch",
      "fyrden-effects-feed",
      "fyrden-effects-references",
      "fyrden-effects-webhooks",
      "fyrden-events",
      "fyrden-events-dlq",
      "fyrden-indexing",
      "fyrden-webhooks",
    ]);
    expect([...fake.state.d1.keys()].sort()).toEqual(["fyrden-directory", "fyrden-org"]);
    expect([...fake.state.kv.values()]).toEqual(["fyrden-api-cache"]);
    expect(result.created).toHaveLength(15);
  });

  it("uploads the required secret with the first API deploy and reports a generated one", async () => {
    const fake = fakeWrangler();
    const { d, generated } = deps(fake.runner);
    await deploy(d);
    expect(fake.state.secrets.get("BOOTSTRAP_SECRET")).toBe("s3cret-value");
    expect(generated).toEqual(["s3cret-value"]);
    // Never in a command line; the file is gone after the deploy.
    expect(fake.calls.some((c) => c.args.join(" ").includes("s3cret-value"))).toBe(false);
    const file = fake.calls.find((c) => c.args.includes("--secrets-file"))?.args.at(-1) as string;
    await expect(stat(file)).rejects.toThrow();
  });

  it("makes the webhook secrets' key once, never shown, and keeps it", async () => {
    const fake = fakeWrangler();
    const { d, lines } = deps(fake.runner);
    await deploy(d);
    const key = fake.state.secrets.get("WEBHOOKS_KEY") as string;
    expect(Buffer.from(key, "base64")).toHaveLength(32);
    expect(key).not.toBe(fake.state.secrets.get("SIGNING_KEY"));
    expect(lines.join("\n")).not.toContain(key);
    await deploy(deps(fake.runner).d);
    expect(fake.state.secrets.get("WEBHOOKS_KEY")).toBe(key);
  });

  it("makes the unsubscribe links' key once (base64url), never shown, and keeps it", async () => {
    const fake = fakeWrangler();
    const { d, lines } = deps(fake.runner);
    await deploy(d);
    const key = fake.state.secrets.get("EMAIL_KEY") as string;
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(key, "base64url")).toHaveLength(32);
    expect(lines.join("\n")).not.toContain(key);
    await deploy(deps(fake.runner).d);
    expect(fake.state.secrets.get("EMAIL_KEY")).toBe(key);
  });

  it("adds the unsubscribe links' key to a deployment made without it", async () => {
    const fake = fakeWrangler();
    await deploy(deps(fake.runner).d);
    fake.state.secrets.delete("EMAIL_KEY");
    const webhooks = fake.state.secrets.get("WEBHOOKS_KEY");
    await deploy(deps(fake.runner).d);
    expect(fake.state.secrets.get("EMAIL_KEY")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(fake.state.secrets.get("WEBHOOKS_KEY")).toBe(webhooks);
  });

  it("makes a commit signing key once, never shown, and keeps it", async () => {
    const fake = fakeWrangler();
    const { d, lines } = deps(fake.runner);
    await deploy(d);
    const key = fake.state.secrets.get("SIGNING_KEY") as string;
    expect(Buffer.from(key, "base64")).toHaveLength(32);
    expect(lines.join("\n")).not.toContain(key);
    expect(fake.calls.some((c) => c.args.join(" ").includes(key))).toBe(false);
    await deploy(deps(fake.runner).d);
    expect(fake.state.secrets.get("SIGNING_KEY")).toBe(key);
    // A deployment from before signing gets one with its next deploy.
    fake.state.secrets.delete("SIGNING_KEY");
    await deploy(deps(fake.runner).d);
    expect(fake.state.secrets.get("SIGNING_KEY")).not.toBe(key);
    expect(fake.state.secrets.get("BOOTSTRAP_SECRET")).toBe("s3cret-value");
  });

  it("is idempotent: a second run creates nothing and keeps the secret", async () => {
    const fake = fakeWrangler();
    await deploy(deps(fake.runner).d);
    const before = fake.calls.length;
    const second = deps(fake.runner, { randomSecret: () => "other" });
    const result = await deploy(second.d);
    expect(result.created).toEqual([]);
    expect(second.generated).toEqual([]);
    expect(fake.state.secrets.get("BOOTSTRAP_SECRET")).toBe("s3cret-value");
    const later = fake.calls.slice(before);
    expect(
      later.filter((c) => c.args.includes("create") || c.args.includes("--secrets-file")),
    ).toEqual([]);
  });

  it("reports a generated secret before a later step fails", async () => {
    const fake = fakeWrangler();
    const { d, generated } = deps(fake.runner, {
      buildWeb: async () => {
        throw new Error("web build failed");
      },
    });
    await expect(deploy(d)).rejects.toThrow(/web build failed/);
    expect(generated).toEqual(["s3cret-value"]);
  });

  it("uses a preset secret without reporting it", async () => {
    const fake = fakeWrangler();
    const { d, generated, lines } = deps(fake.runner, { presetBootstrapSecret: "from-ci" });
    await deploy(d);
    expect(fake.state.secrets.get("BOOTSTRAP_SECRET")).toBe("from-ci");
    expect(generated).toEqual([]);
    expect(lines.join("\n")).not.toContain("from-ci");
  });

  it("says so when a preset secret is not uploaded because one is already set", async () => {
    const fake = fakeWrangler();
    await deploy(deps(fake.runner).d);
    const { d, lines } = deps(fake.runner, { presetBootstrapSecret: "from-ci" });
    await deploy(d);
    expect(fake.state.secrets.get("BOOTSTRAP_SECRET")).toBe("s3cret-value");
    expect(lines.join("\n")).toContain("already has a BOOTSTRAP_SECRET");
    expect(lines.join("\n")).not.toContain("from-ci");
  });

  it("fails without deploying when no secret is preset and generating one is disabled (CI)", async () => {
    const fake = fakeWrangler();
    const { d, generated, lines } = deps(fake.runner, { randomSecret: undefined });
    await expect(deploy(d)).rejects.toThrow(/set FYRDEN_BOOTSTRAP_SECRET/);
    expect(fake.state.deployed).toEqual([]);
    expect(fake.state.secrets.size).toBe(0);
    expect(generated).toEqual([]);
    expect(lines.join("\n")).not.toContain("BOOTSTRAP_SECRET=");
  });

  it.each([
    ["is missing", (dir: string) => rm(dir, { recursive: true })],
    ["cannot be read", (dir: string) => chmod(dir, 0o000)],
  ])("stops before deploying when a migrations folder %s", async (_, breakDir) => {
    const dir = join(repoRoot, "apps/api/migrations/directory");
    await breakDir(dir);
    const fake = fakeWrangler();
    try {
      await expect(deploy(deps(fake.runner).d)).rejects.toThrow(/ENOENT|EACCES/);
      expect(fake.state.migrated).toEqual([]);
      expect(fake.state.deployed).toEqual([]);
    } finally {
      await chmod(dir, 0o755).catch(() => {});
    }
  });

  it("writes resource ids into a generated config and leaves the committed one alone", async () => {
    const fake = fakeWrangler();
    const original = await readFile(join(repoRoot, "apps/api/wrangler.jsonc"), "utf8");
    await deploy(deps(fake.runner).d);
    expect(await readFile(join(repoRoot, "apps/api/wrangler.jsonc"), "utf8")).toBe(original);
    const generated = await generatedConfig();
    expect(generated.d1_databases.every((db) => db.database_id?.startsWith("d1-"))).toBe(true);
    expect(generated.kv_namespaces[0]?.id).toMatch(/^kv-/);
    expect(generated.vars).toMatchObject({ FYRDEN_PLAN: "paid" });
    expect(generated.tail_consumers).toEqual([{ service: "fyrden-web" }]);
  });

  it("attaches the Tail Worker only after fyrden-web exists on a first Paid deploy", async () => {
    const fake = fakeWrangler();
    await deploy(deps(fake.runner).d);
    expect(fake.state.deployed).toEqual(["fyrden-api", "fyrden-web", "fyrden-api"]);
    expect(fake.state.tailAttached).toBe(true);
    // Later deploys find fyrden-web and deploy the API once, with the consumer.
    await deploy(deps(fake.runner).d);
    expect(fake.state.deployed.slice(3)).toEqual(["fyrden-api", "fyrden-web"]);
    expect(fake.state.tailAttached).toBe(true);
  });

  it("fails instead of replacing the secret when secrets cannot be listed", async () => {
    const fake = fakeWrangler();
    await deploy(deps(fake.runner).d);
    const flaky: WranglerRunner = {
      run: async (args, options) =>
        args[0] === "secret"
          ? { code: 1, stdout: "", stderr: "fetch failed: network timeout" }
          : fake.runner.run(args, options),
    };
    await expect(deploy(deps(flaky, { randomSecret: () => "replacement" }).d)).rejects.toThrow(
      /network timeout/,
    );
    expect(fake.state.secrets.get("BOOTSTRAP_SECRET")).toBe("s3cret-value");
  });

  it("sets a Paid deployment's internal calls, raising its subrequest limit past the default", async () => {
    const fake = fakeWrangler();
    await deploy(deps(fake.runner).d);
    let generated = await generatedConfig();
    expect(generated.vars).toMatchObject({ FYRDEN_INTERNAL_CALLS: "1000" });
    expect(generated).not.toHaveProperty("limits");
    await deploy(deps(fake.runner, { internalCalls: 5_000 }).d);
    generated = await generatedConfig();
    expect(generated.vars).toMatchObject({ FYRDEN_PLAN: "paid", FYRDEN_INTERNAL_CALLS: "5000" });
    expect(generated).not.toHaveProperty("limits");
    await deploy(deps(fake.runner, { internalCalls: 50_000 }).d);
    generated = await generatedConfig();
    expect(generated.vars).toMatchObject({ FYRDEN_INTERNAL_CALLS: "50000" });
    expect(generated.limits).toEqual({ subrequests: 50_000 });
    // Left out again: back to 1,000, not whatever the last deploy set.
    await deploy(deps(fake.runner).d);
    generated = await generatedConfig();
    expect(generated.vars).toMatchObject({ FYRDEN_INTERNAL_CALLS: "1000" });
    expect(generated).not.toHaveProperty("limits");
  });

  it("pauses the events queue's delivery around the API's deploy, resuming it after, failed or not", async () => {
    const fake = fakeWrangler();
    await deploy(deps(fake.runner).d);
    const steps = fake.calls
      .map((call) => call.args.slice(0, 3).join(" "))
      .filter((step) => /^(queues (pause|resume)-delivery|deploy -c)/.test(step));
    // (The first Paid deploy's second one, attaching the Tail Worker, is the same version.)
    expect(steps.slice(0, 3)).toEqual([
      "queues pause-delivery fyrden-events",
      `deploy -c ${steps[1]?.split(" ")[2]}`,
      "queues resume-delivery fyrden-events",
    ]);
    expect(fake.state.paused.size).toBe(0);
    // A failed deploy resumes it too.
    fake.state.failApiDeploy = true;
    await expect(deploy(deps(fake.runner).d)).rejects.toThrow();
    expect(fake.state.paused.size).toBe(0);
  });

  it("deletes the secrets it wrote and resumes delivery when pausing the queue fails, deploying nothing", async () => {
    const fake = fakeWrangler();
    // A temporary directory of its own, so no other test's secrets show.
    const own = await mkdtemp(join(tmpdir(), "fyrden-deploy-tmp-"));
    const previous = process.env.TMPDIR;
    process.env.TMPDIR = own;
    try {
      for (const when of ["before", "after"] as const) {
        fake.state.failPause = when;
        await expect(deploy(deps(fake.runner).d)).rejects.toThrow();
        expect(fake.state.deployed).toEqual([]);
        expect(await readdir(own)).toEqual([]);
        // A pause whose answer was lost is resumed too.
        expect(fake.state.paused.size, when).toBe(0);
      }
    } finally {
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
      await rm(own, { recursive: true, force: true });
    }
  });

  it("sets the discretionary allowance when given, and leaves it unset (the plan's default) when not", async () => {
    const fake = fakeWrangler();
    await deploy(deps(fake.runner, { discretionary: "do_rows_written=5000" }).d);
    let generated = await generatedConfig();
    expect(generated.vars).toMatchObject({ FYRDEN_DISCRETIONARY_DAILY: "do_rows_written=5000" });
    await deploy(deps(fake.runner).d);
    generated = await generatedConfig();
    expect(generated.vars).not.toHaveProperty("FYRDEN_DISCRETIONARY_DAILY");
  });

  it("configures the email provider when given, uploading its key each time, and leaves email off when not", async () => {
    const fake = fakeWrangler();
    const email = {
      provider: "resend" as const,
      from: "Fyrden <n@notify.example>",
      apiKey: "re_first0001",
    };
    await deploy(deps(fake.runner, { email }).d);
    let generated = await generatedConfig();
    expect(generated.vars).toMatchObject({
      FYRDEN_EMAIL_PROVIDER: "resend",
      FYRDEN_EMAIL_FROM: "Fyrden <n@notify.example>",
    });
    expect(generated.vars).not.toHaveProperty("FYRDEN_EMAIL_SENDING");
    expect(fake.state.secrets.get("RESEND_API_KEY")).toBe("re_first0001");
    // A new key rotates it.
    await deploy(deps(fake.runner, { email: { ...email, apiKey: "re_second002" } }).d);
    expect(fake.state.secrets.get("RESEND_API_KEY")).toBe("re_second002");
    // Left out: no provider (the key stays, unused).
    await deploy(deps(fake.runner).d);
    generated = await generatedConfig();
    expect(generated.vars).not.toHaveProperty("FYRDEN_EMAIL_PROVIDER");
    expect(generated.vars).not.toHaveProperty("FYRDEN_EMAIL_FROM");
    // Sending, with its webhook's secret and limits of its own; each deploy says so again.
    await deploy(
      deps(fake.runner, {
        email: {
          ...email,
          webhookSecret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
          sending: true,
          limits: { daily: 500, reserve: 20 },
        },
      }).d,
    );
    generated = await generatedConfig();
    expect(generated.vars).toMatchObject({
      FYRDEN_EMAIL_SENDING: "on",
      FYRDEN_EMAIL_DAILY_LIMIT: "500",
      FYRDEN_EMAIL_RESERVE: "20",
    });
    expect(generated.vars).not.toHaveProperty("FYRDEN_EMAIL_MONTHLY_LIMIT");
    expect(fake.state.secrets.get("RESEND_WEBHOOK_SECRET")).toBe(
      "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
    );
    await deploy(deps(fake.runner, { email }).d);
    generated = await generatedConfig();
    expect(generated.vars).not.toHaveProperty("FYRDEN_EMAIL_SENDING");
    expect(generated.vars).not.toHaveProperty("FYRDEN_EMAIL_DAILY_LIMIT");
  });

  it("points notification emails at the web Worker once it is deployed, or at the origin given", async () => {
    const email = {
      provider: "resend" as const,
      from: "Fyrden <n@notify.example>",
      apiKey: "re_first0001",
      webhookSecret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
      sending: true,
    };
    const fake = fakeWrangler();
    await deploy(deps(fake.runner, { email }).d);
    // The API first without it, then again with the web Worker's URL.
    const origins = () => fake.state.apiVersions.map((v) => v.vars.FYRDEN_PUBLIC_ORIGIN);
    expect(origins()).toEqual([undefined, "https://fyrden-web.acct.workers.dev"]);
    // Every deploy sending does so again (its configuration is rebuilt from the committed file).
    await deploy(deps(fake.runner, { email }).d);
    expect(origins().slice(2)).toEqual([undefined, "https://fyrden-web.acct.workers.dev"]);
    // A custom origin: set with the first API deploy, no second one.
    await deploy(deps(fake.runner, { email: { ...email, publicOrigin: "https://git.example" } }).d);
    expect(origins().slice(4)).toEqual(["https://git.example"]);
    // Not sending: none, and no second deploy.
    await deploy(deps(fake.runner, { email: { ...email, sending: false } }).d);
    expect(origins().slice(5)).toEqual([undefined]);
  });

  it("adds watchers to audiences when given, and stops when a later deploy leaves it out", async () => {
    const fake = fakeWrangler();
    await deploy(deps(fake.runner, { watchAudiences: true }).d);
    expect((await generatedConfig()).vars).toMatchObject({ FYRDEN_WATCH_AUDIENCES: "on" });
    await deploy(deps(fake.runner).d);
    expect((await generatedConfig()).vars).not.toHaveProperty("FYRDEN_WATCH_AUDIENCES");
  });

  it("records the read model protocol the deployed API serves, only when it says", async () => {
    const fake = fakeWrangler();
    const recorded: string[] = [];
    let barriers = [{ shard: "default" }];
    fake.state.d1Query = (db, sql) => {
      if (!sql.includes("read_model_barriers")) return undefined;
      recorded.push(`${db}: ${sql.replace(/\s+/g, " ")}`);
      return barriers;
    };
    const asked: string[] = [];
    const answered = deps(fake.runner, {
      fetch: async (url) => {
        asked.push(String(url));
        return Response.json(
          { ok: false, error: "rate_limited", readModel: { protocol: 1 } },
          {
            status: 429,
          },
        );
      },
    });
    await deploy(answered.d);
    expect(asked).toEqual(["https://fyrden-api.acct.workers.dev/healthz"]);
    // Its own shard's barrier only.
    expect(recorded).toEqual([
      "fyrden-directory: UPDATE read_model_barriers SET executor_version = 1 WHERE shard = 'default' RETURNING shard",
    ]);
    expect(answered.lines).toContain("ok   fyrden-api serves read model protocol 1 (recorded)");
    // No barrier row to record it in: not said to be recorded.
    barriers = [];
    const missing = deps(fake.runner, {
      fetch: async () => Response.json({ readModel: { protocol: 1 } }),
    });
    await deploy(missing.d);
    expect(missing.lines).not.toContain("ok   fyrden-api serves read model protocol 1 (recorded)");
    expect(missing.lines).toContain(
      "WARN the read model protocol the API serves is not verified: the directory has no barrier for its read model",
    );
    barriers = [{ shard: "default" }];
    // An API that does not answer, or names no protocol: nothing recorded, and said so.
    for (const fetch of [
      async () => {
        throw new TypeError("fetch failed");
      },
      async () => Response.json({ ok: true }),
    ]) {
      recorded.length = 0;
      const silent = deps(fake.runner, { fetch });
      await deploy(silent.d);
      expect(recorded).toEqual([]);
      expect(silent.lines.some((l) => l.startsWith("WARN the read model protocol"))).toBe(true);
    }
  });

  it("holds the read model's work back when given, and lets it go when a later deploy leaves it out", async () => {
    const fake = fakeWrangler();
    await deploy(deps(fake.runner, { readModelMaintenance: true }).d);
    expect((await generatedConfig()).vars).toMatchObject({ FYRDEN_READ_MODEL_MAINTENANCE: "on" });
    await deploy(deps(fake.runner).d);
    expect((await generatedConfig()).vars).not.toHaveProperty("FYRDEN_READ_MODEL_MAINTENANCE");
  });

  it("never keeps a switch it owns from the committed configuration's variables", async () => {
    const path = join(repoRoot, "apps/api/wrangler.jsonc");
    const committed = parseJsonc<Record<string, unknown>>(await readFile(path, "utf8"));
    const owned = {
      FYRDEN_WATCH_AUDIENCES: "on",
      FYRDEN_LIVE: "on",
      FYRDEN_LIVE_SOCKETS: "9",
      FYRDEN_EMAIL_SENDING: "on",
      FYRDEN_EMAIL_PROVIDER: "resend",
      FYRDEN_DISCRETIONARY_DAILY: "queue_ops=1",
    };
    await writeFile(
      path,
      JSON.stringify({
        ...committed,
        vars: { ...(committed.vars as object), ...owned, KEEP: "1" },
      }),
    );
    const fake = fakeWrangler();
    await deploy(deps(fake.runner).d);
    const vars = (await generatedConfig()).vars as Record<string, string>;
    for (const name of Object.keys(owned)) expect(vars, name).not.toHaveProperty(name);
    expect(vars.KEEP).toBe("1");
  });

  it("turns live hints on when given, and off again when a later deploy leaves them out", async () => {
    const fake = fakeWrangler();
    await deploy(deps(fake.runner).d);
    let generated = await generatedConfig();
    expect(generated.vars).not.toHaveProperty("FYRDEN_LIVE");
    await deploy(deps(fake.runner, { live: { sockets: 200 } }).d);
    generated = await generatedConfig();
    expect(generated.vars).toMatchObject({ FYRDEN_LIVE: "on", FYRDEN_LIVE_SOCKETS: "200" });
    await deploy(deps(fake.runner).d);
    generated = await generatedConfig();
    expect(generated.vars).not.toHaveProperty("FYRDEN_LIVE");
    expect(generated.vars).not.toHaveProperty("FYRDEN_LIVE_SOCKETS");
  });

  it("raises a committed subrequest limit below the internal calls asked, keeping its other limits", async () => {
    const path = join(repoRoot, "apps/api/wrangler.jsonc");
    const committed = parseJsonc<Record<string, unknown>>(await readFile(path, "utf8"));
    await writeFile(
      path,
      JSON.stringify({ ...committed, limits: { cpu_ms: 60_000, subrequests: 2_000 } }),
    );
    const fake = fakeWrangler();
    await deploy(deps(fake.runner, { internalCalls: 5_000 }).d);
    expect((await generatedConfig()).limits).toEqual({ cpu_ms: 60_000, subrequests: 5_000 });
    await deploy(deps(fake.runner, { internalCalls: 1_500 }).d);
    expect((await generatedConfig()).limits).toEqual({ cpu_ms: 60_000, subrequests: 2_000 });
  });

  it("raises a committed subrequest limit below the default 1,000 internal calls", async () => {
    const path = join(repoRoot, "apps/api/wrangler.jsonc");
    const committed = parseJsonc<Record<string, unknown>>(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...committed, limits: { subrequests: 500 } }));
    const fake = fakeWrangler();
    await deploy(deps(fake.runner).d);
    const generated = await generatedConfig();
    expect(generated.vars).toMatchObject({ FYRDEN_INTERNAL_CALLS: "1000" });
    expect(generated.limits).toEqual({ subrequests: 1_000 });
  });

  it("drops Paid-only features (Tail Workers) in Free mode", async () => {
    const fake = fakeWrangler();
    await deploy(deps(fake.runner, { plan: "free" }).d);
    expect(fake.state.deployed).toEqual(["fyrden-api", "fyrden-web"]);
    const generated = await generatedConfig();
    expect(generated.vars).toMatchObject({ FYRDEN_PLAN: "free" });
    expect(generated.vars).not.toHaveProperty("FYRDEN_INTERNAL_CALLS");
    expect(generated).not.toHaveProperty("tail_consumers");
  });

  it("migrates D1 before deploying, and deploys the API before the web Worker", async () => {
    const fake = fakeWrangler();
    const result = await deploy(deps(fake.runner).d);
    expect(fake.state.migrated).toEqual(["fyrden-directory", "fyrden-org"]);
    expect(fake.state.deployed.slice(0, 2)).toEqual(["fyrden-api", "fyrden-web"]);
    expect(result.apiUrl).toBe("https://fyrden-api.acct.workers.dev");
    const migrateIndex = fake.calls.findIndex((c) => c.args[1] === "migrations");
    const deployIndex = fake.calls.findIndex((c) => c.args[0] === "deploy");
    expect(migrateIndex).toBeLessThan(deployIndex);
  });

  it("checks each D1 schema against the repository once it is migrated", async () => {
    const fake = fakeWrangler();
    const { d, lines } = deps(fake.runner);
    await deploy(d);
    const applied = fake.calls.findIndex((c) => c.args.join(" ").includes("migrations apply"));
    const checks = fake.calls.filter(
      (c) => c.args[1] === "execute" && c.args.join(" ").includes("sqlite_schema"),
    );
    expect(checks.map((c) => [c.args[2], c.args.at(-1)])).toEqual([
      ["fyrden-directory", API_DEPLOY_CONFIG],
      ["fyrden-org", API_DEPLOY_CONFIG],
    ]);
    expect(fake.calls.indexOf(checks[0] as (typeof fake.calls)[number])).toBeGreaterThan(applied);
    expect(lines).toContain("ok   fyrden-org schema matches apps/api/migrations/org.expected.sql");
  });

  it("stops before deploying a Worker when a migrated D1 schema differs from the repository", async () => {
    const fake = fakeWrangler();
    // A database that once ran an earlier text of a migration: D1 recorded it
    // by name, so the migration's later text never ran there.
    fake.state.d1.set("fyrden-org", "d1-org");
    fake.state.d1Schema.set("fyrden-org", [
      { type: "table", name: "effects", sql: "CREATE TABLE effects (effect_id TEXT PRIMARY KEY)" },
    ]);
    await expect(deploy(deps(fake.runner).d)).rejects.toThrow(
      "fyrden-org schema differs from apps/api/migrations/org.expected.sql: effects (table) differs. " +
        "Repair it as docs/operations/d1-schema.md says before deploying.",
    );
    expect(fake.state.migrated).toEqual(["fyrden-directory", "fyrden-org"]);
    expect(fake.state.deployed).toEqual([]);
  });

  it("records the commit it deploys, and warns when the working tree has uncommitted changes", async () => {
    const fake = fakeWrangler();
    const clean = deps(fake.runner);
    await deploy(clean.d);
    expect((await generatedConfig()).vars).toMatchObject({ FYRDEN_COMMIT: "0123abc" });
    expect(clean.lines.join("\n")).not.toContain("WARN");

    const dirty = deps(fake.runner, { source: { commit: "0123abc", dirty: true } });
    await deploy(dirty.d);
    expect((await generatedConfig()).vars).toMatchObject({ FYRDEN_COMMIT: "0123abc-dirty" });
    expect(dirty.lines[1]).toMatch(/^WARN the working tree has uncommitted changes/);

    const unknown = deps(fake.runner, { source: { commit: undefined, dirty: false } });
    await deploy(unknown.d);
    expect((await generatedConfig()).vars).toMatchObject({ FYRDEN_COMMIT: "unknown" });
    expect(unknown.lines[1]).toMatch(/^WARN not a git checkout/);
  });

  it("treats an R2 error other than not-found as a failure, not as a missing bucket", async () => {
    const fake = fakeWrangler();
    const failing: WranglerRunner = {
      run: async (args, options) =>
        args[0] === "r2"
          ? {
              code: 1,
              stdout: "",
              stderr: "Please enable R2 through the Cloudflare Dashboard. [code: 10042]",
            }
          : fake.runner.run(args, options),
    };
    await expect(deploy(deps(failing).d)).rejects.toThrow(/10042/);
    expect(fake.calls.some((c) => c.args.includes("create") && c.args[0] === "r2")).toBe(false);
    expect(fake.state.deployed).toEqual([]);
  });

  it("says to enable Analytics Engine when the API deploy needs it", async () => {
    const fake = fakeWrangler();
    const runner: WranglerRunner = {
      run: (args, options) =>
        args[0] === "deploy"
          ? Promise.resolve({
              code: 1,
              stdout: "",
              stderr:
                "You need to enable Analytics Engine. Head to the Cloudflare Dashboard. [code: 10089]",
            })
          : fake.runner.run(args, options),
    };
    await expect(deploy(deps(runner).d)).rejects.toThrow(
      /^Workers Analytics Engine is not enabled on this account/,
    );
  });

  it("refuses to bind a KV namespace whose title another namespace shares", async () => {
    const fake = fakeWrangler();
    fake.state.kv.set("kv-unrelated", "fyrden-api-cache");
    fake.state.kv.set("kv-other", "fyrden-api-cache");
    await expect(deploy(deps(fake.runner).d)).rejects.toThrow(
      "2 KV namespaces in this account are titled fyrden-api-cache (ids kv-unrelated, kv-other)",
    );
    expect(fake.state.deployed).toEqual([]);
  });

  it("accepts a resource that someone else created in the meantime", async () => {
    const fake = fakeWrangler();
    const racing: WranglerRunner = {
      run: async (args, options) => {
        if (args[0] !== "queues" || args[1] !== "create") return fake.runner.run(args, options);
        fake.state.queues.add(args[2] as string);
        return { code: 1, stdout: "", stderr: "Queue name already taken [code: 11009]" };
      },
    };
    await deploy(deps(racing).d);
    expect(fake.state.deployed).toContain("fyrden-web");
  });
});

describe("Cloudflare account selection", () => {
  it("names the account it checks", async () => {
    const lines: string[] = [];
    await doctor(repoRoot, fakeWrangler().runner, (l) => lines.push(l), undefined);
    expect(lines[0]).toBe("ok   wrangler is logged in; checking account Test account (acct-1)");
  });

  it("pins every wrangler call after whoami to the resolved account", async () => {
    const fake = fakeWrangler();
    const { d, lines } = deps(fake.runner);
    await deploy(d);
    expect(lines[0]).toBe("deploying to account Test account (acct-1)");
    const [whoami, ...rest] = fake.calls;
    expect(whoami?.args[0]).toBe("whoami");
    expect(rest.length).toBeGreaterThan(10);
    expect(rest.every((c) => c.account === "acct-1")).toBe(true);
  });

  it("uses CLOUDFLARE_ACCOUNT_ID to choose among several accounts", async () => {
    const fake = fakeWrangler();
    fake.state.accounts.push({ id: "acct-2", name: "Second" });
    const { d, lines } = deps(fake.runner, { envAccountId: "acct-2" });
    await deploy(d);
    expect(lines[0]).toBe("deploying to account Second (acct-2)");
    expect(fake.calls.slice(1).every((c) => c.account === "acct-2")).toBe(true);
  });

  it("writes the account into the generated config and refuses a conflicting one", async () => {
    const fake = fakeWrangler();
    await deploy(deps(fake.runner).d);
    expect((await generatedConfig()).account_id).toBe("acct-1");
  });

  it.each(["apps/api/wrangler.jsonc", "apps/web/wrangler.jsonc"])(
    "refuses to start when %s names another account (wrangler would prefer it)",
    async (file) => {
      const path = join(repoRoot, file);
      await writeFile(
        path,
        (await readFile(path, "utf8")).replace("{", '{ "account_id": "acct-9",'),
      );
      const fake = fakeWrangler();
      await expect(deploy(deps(fake.runner).d)).rejects.toThrow(`${file} sets account_id acct-9`);
      expect(fake.calls.map((c) => c.args[0])).toEqual(["whoami"]);
    },
  );

  it("trusts CLOUDFLARE_ACCOUNT_ID when listing accounts is denied to a scoped token", async () => {
    const fake = fakeWrangler();
    const denied = {
      code: 1,
      stdout: "",
      stderr:
        "A request to the Cloudflare API (/accounts) failed. Authentication error [code: 10000]",
    };
    const { d, lines } = deps(
      {
        run: (args, options) =>
          args[0] === "whoami" ? Promise.resolve(denied) : fake.runner.run(args, options),
      },
      { envAccountId: "acct-1" },
    );
    await deploy(d);
    expect(lines[0]).toMatch(/\(acct-1\)$/);
    // Without an explicit account there is nothing to trust.
    await expect(
      deploy(
        deps({
          run: (args, options) =>
            args[0] === "whoami" ? Promise.resolve(denied) : fake.runner.run(args, options),
        }).d,
      ),
    ).rejects.toThrow(/not logged in/);
  });

  it("trusts CLOUDFLARE_ACCOUNT_ID when a scoped API token cannot list accounts", async () => {
    const fake = fakeWrangler();
    const { d, lines } = deps(
      {
        run: (args, options) =>
          args[0] === "whoami"
            ? Promise.resolve({ code: 0, stdout: JSON.stringify({ loggedIn: true }), stderr: "" })
            : fake.runner.run(args, options),
      },
      { envAccountId: "acct-1" },
    );
    await deploy(d);
    expect(lines[0]).toMatch(/^deploying to account .* \(acct-1\)$/);
  });

  it.each([
    [
      "not logged in",
      (f: ReturnType<typeof fakeWrangler>) => {
        f.state.loggedIn = false;
      },
      undefined,
      /not logged in/,
    ],
    ["an unknown CLOUDFLARE_ACCOUNT_ID", () => {}, "acct-x", /acct-x is not an account/],
    [
      "several accounts and no choice",
      (f: ReturnType<typeof fakeWrangler>) => {
        f.state.accounts.push({ id: "acct-2", name: "Second" });
      },
      undefined,
      /2 accounts .*set CLOUDFLARE_ACCOUNT_ID/,
    ],
  ])("refuses to deploy when %s", async (_, arrange, envAccountId, message) => {
    const fake = fakeWrangler();
    arrange(fake);
    await expect(deploy(deps(fake.runner, { envAccountId }).d)).rejects.toThrow(message);
    expect(fake.calls.map((c) => c.args[0])).toEqual(["whoami"]);
  });
});

describe("fyrden doctor", () => {
  it("reports missing resources without creating any", async () => {
    const fake = fakeWrangler();
    const lines: string[] = [];
    const report = await doctor(repoRoot, fake.runner, (l) => lines.push(l), undefined);
    expect(report.authenticated).toBe(true);
    expect(report.missing).toContain("r2:fyrden-assets");
    expect(fake.calls.some((c) => c.args.includes("create"))).toBe(false);
    expect(lines.join("\n")).toContain("free 100 MB");
    expect(report.schemaDrift).toEqual([]);
    expect(fake.calls.some((c) => c.args[1] === "execute")).toBe(false);
  });

  async function doctorLines(fake: ReturnType<typeof fakeWrangler>) {
    const lines: string[] = [];
    const report = await doctor(repoRoot, fake.runner, (l) => lines.push(l), undefined);
    return { report, lines };
  }

  it("compares each deployed D1 schema with the repository, reading only", async () => {
    const fake = fakeWrangler();
    await deploy(deps(fake.runner).d);
    fake.calls.length = 0;
    const { report, lines } = await doctorLines(fake);
    expect(report.schemaDrift).toEqual([]);
    expect(lines).toContain(
      "ok   fyrden-directory schema matches apps/api/migrations/directory.expected.sql",
    );
    expect(lines).toContain("ok   fyrden-org schema matches apps/api/migrations/org.expected.sql");
    const executed = fake.calls.filter((c) => c.args[1] === "execute");
    // Each database's applied migrations, then its schema; and fyrden-org's effects.
    expect(executed.map((c) => c.args[2])).toEqual([
      "fyrden-directory",
      "fyrden-directory",
      "fyrden-org",
      "fyrden-org",
      "fyrden-org",
    ]);
    expect(
      executed.every(
        (c) =>
          c.args.includes("--remote") &&
          /^SELECT /.test(c.args[c.args.indexOf("--command") + 1] ?? ""),
      ),
    ).toBe(true);
    expect(fake.calls.some((c) => c.args.includes("apply") || c.args.includes("create"))).toBe(
      false,
    );
  });

  it("fails on a deployed D1 schema that differs from the repository, naming each object", async () => {
    const fake = fakeWrangler();
    await deploy(deps(fake.runner).d);
    const org = fake.state.d1Schema.get("fyrden-org") ?? [];
    fake.state.d1Schema.set("fyrden-org", [
      ...org.filter((o) => o.name !== "effects" && o.name !== "effects_due_order"),
      { type: "table", name: "effects", sql: "CREATE TABLE effects (effect_id TEXT PRIMARY KEY)" },
      { type: "table", name: "scratch", sql: "CREATE TABLE scratch (x)" },
    ]);
    const { report, lines } = await doctorLines(fake);
    expect(report.schemaDrift).toEqual(["fyrden-org"]);
    expect(lines).toContain(
      "FAIL fyrden-org schema differs from apps/api/migrations/org.expected.sql: " +
        "effects (table) differs, effects_due_order (index) is missing, scratch (table) is not in the repository. " +
        "Repair it as docs/operations/d1-schema.md says.",
    );
    expect(lines).toContain(
      "ok   fyrden-directory schema matches apps/api/migrations/directory.expected.sql",
    );
  });

  it("compares a schema only once the checkout's migrations are all applied, naming those that are not", async () => {
    const fake = fakeWrangler();
    await deploy(deps(fake.runner).d);
    // A deployment from before the checkout's latest org migration: as that migration found it.
    const applied = fake.state.d1Migrations.get("fyrden-org") ?? [];
    const latest = applied.at(-1) ?? "";
    expect(latest).toMatch(/^\d{4}_\w+\.sql$/);
    fake.state.d1Migrations.set("fyrden-org", applied.slice(0, -1));
    // Without what that migration creates or alters (a schema that differs from the expected one,
    // as the one before it does).
    const created = new Set(
      [
        ...(await readFile(join(realRoot, "apps/api/migrations/org", latest), "utf8")).matchAll(
          /(?:CREATE\s+(?:TABLE|(?:UNIQUE\s+)?INDEX|VIEW|TRIGGER)|ALTER\s+TABLE)\s+(\w+)/gi,
        ),
      ].map((m) => m[1]),
    );
    expect(created.size).toBeGreaterThan(0);
    const org = fake.state.d1Schema.get("fyrden-org") ?? [];
    fake.state.d1Schema.set("fyrden-org", [...org.filter((o) => !created.has(o.name))]);
    let { report, lines } = await doctorLines(fake);
    expect(report.schemaDrift).toEqual([]);
    expect(lines).toContain(
      `WARN fyrden-org schema not compared: not yet applied: ${latest} (fyrden deploy applies them)`,
    );
    expect(lines).toContain(
      "ok   fyrden-directory schema matches apps/api/migrations/directory.expected.sql",
    );

    // A deployment from a later checkout than this one.
    fake.state.d1Migrations.set("fyrden-org", [...applied, "9999_later.sql"]);
    ({ report, lines } = await doctorLines(fake));
    expect(report.schemaDrift).toEqual([]);
    expect(lines).toContain(
      "WARN fyrden-org schema not compared: applied but not in this checkout: 9999_later.sql (check out the commit it runs)",
    );

    // A database no migration has been applied to yet.
    fake.state.d1Migrations.delete("fyrden-directory");
    ({ lines } = await doctorLines(fake));
    expect(lines.find((l) => l.startsWith("WARN fyrden-directory"))).toMatch(
      /^WARN fyrden-directory schema not compared: not yet applied: 0001_\S+\.sql, /,
    );
  });

  it("summarises the effects journal by state, oldest first created", async () => {
    const fake = fakeWrangler();
    await deploy(deps(fake.runner).d);
    fake.state.effects = [
      { state: "done", count: 3, oldest: Date.UTC(2026, 9, 17, 9) },
      { state: "pending", count: 656, oldest: Date.UTC(2026, 9, 17, 10) },
    ];
    const { lines } = await doctorLines(fake);
    expect(lines).toContain(
      "info fyrden-org effects: done 3 (oldest 2026-10-17T09:00:00.000Z), pending 656 (oldest 2026-10-17T10:00:00.000Z)",
    );
    fake.state.effects = [];
    expect((await doctorLines(fake)).lines).toContain("info fyrden-org effects: none");
  });

  it("names the commit fyrden-api runs, and warns when it was deployed with uncommitted changes", async () => {
    const fake = fakeWrangler();
    await deploy(deps(fake.runner).d);
    expect((await doctorLines(fake)).lines).toContain("ok   fyrden-api runs commit 0123abc");
    await deploy(deps(fake.runner, { source: { commit: "4567def", dirty: true } }).d);
    expect((await doctorLines(fake)).lines).toContain(
      "WARN fyrden-api runs 4567def with uncommitted changes (deployed from a dirty working tree)",
    );
    await deploy(deps(fake.runner, { source: { commit: undefined, dirty: false } }).d);
    expect((await doctorLines(fake)).lines).toContain(
      "WARN fyrden-api runs an unknown commit (deployed outside a git checkout)",
    );
  });
});

describe("parseJsonc", () => {
  it("strips comments and trailing commas but leaves strings untouched", () => {
    expect(
      parseJsonc(
        '{ // c\n "url": "https://x//y", /* b */ "a": [1, 2,], "m": "keep,}", "n": "keep,]", "q": "a\\"b,]" , }',
      ),
    ).toEqual({ url: "https://x//y", a: [1, 2], m: "keep,}", n: "keep,]", q: 'a"b,]' });
  });
});
