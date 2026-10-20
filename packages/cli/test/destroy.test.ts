import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { API_DEPLOY_CONFIG, deploy } from "../src/commands/deploy.ts";
import { type DestroyDeps, destroy } from "../src/commands/destroy.ts";
import { main } from "../src/index.ts";
import type { WranglerRunner } from "../src/wrangler.ts";
import { fakeWrangler } from "./fake-wrangler.ts";

const realRoot = resolve(import.meta.dirname, "../../..");
let repoRoot = "";

beforeEach(async () => {
  // A copy of the real configs, so the resource names are the real ones.
  repoRoot = await mkdtemp(join(tmpdir(), "fyrden-cli-destroy-"));
  await mkdir(join(repoRoot, "apps", "web"), { recursive: true });
  await cp(join(realRoot, "apps/api/wrangler.jsonc"), join(repoRoot, "apps/api/wrangler.jsonc"));
  await cp(join(realRoot, "apps/web/wrangler.jsonc"), join(repoRoot, "apps/web/wrangler.jsonc"));
  await cp(join(realRoot, "apps/api/migrations"), join(repoRoot, "apps/api/migrations"), {
    recursive: true,
  });
});
afterEach(() => rm(repoRoot, { recursive: true, force: true }));

const EVERY_RESOURCE = [
  "consumer:fyrden-events/fyrden-api",
  "consumer:fyrden-webhooks/fyrden-api",
  "consumer:fyrden-effects-webhooks/fyrden-api",
  "consumer:fyrden-effects-feed/fyrden-api",
  "consumer:fyrden-effects-references/fyrden-api",
  "consumer:fyrden-ci-dispatch/fyrden-api",
  "consumer:fyrden-indexing/fyrden-api",
  "worker:fyrden-web",
  "worker:fyrden-api",
  "queue:fyrden-events",
  "queue:fyrden-webhooks",
  "queue:fyrden-effects-webhooks",
  "queue:fyrden-effects-feed",
  "queue:fyrden-effects-references",
  "queue:fyrden-ci-dispatch",
  "queue:fyrden-indexing",
  "queue:fyrden-events-dlq",
  "r2:fyrden-git",
  "r2:fyrden-ci",
  "r2:fyrden-search",
  "r2:fyrden-assets",
  "d1:fyrden-directory",
  "d1:fyrden-org",
  "kv:fyrden-api-cache",
];

/** A fake account with a full Paid deployment, made by the real deploy command. */
async function deployedAccount() {
  const fake = fakeWrangler();
  await deploy({
    repoRoot,
    plan: "paid",
    runner: fake.runner,
    buildWeb: async () => {},
    source: { commit: "0123abc", dirty: false },
    randomSecret: () => "s3cret-value",
    onSecretGenerated: () => {},
    log: () => {},
  });
  fake.calls.length = 0;
  return fake;
}

/** The KV namespace ids deploy wrote into the generated config. */
async function generatedKvIds(): Promise<string[]> {
  const config = JSON.parse(
    await readFile(join(repoRoot, "apps/api", API_DEPLOY_CONFIG), "utf8"),
  ) as { kv_namespaces: { id: string }[] };
  return config.kv_namespaces.map((k) => k.id);
}

function deps(runner: WranglerRunner, overrides: Partial<DestroyDeps> = {}) {
  const lines: string[] = [];
  const d: DestroyDeps = {
    repoRoot,
    runner,
    confirmed: false,
    log: (l) => lines.push(l),
    ...overrides,
  };
  return { d, lines };
}

/** Wrangler calls that change something. */
const isChange = (args: string[]) =>
  args.includes("delete") ||
  args.includes("remove") ||
  args.includes("create") ||
  args.includes("deploy");

describe("fyrden destroy", () => {
  it("is a dry run by default: lists what it would delete and deletes nothing", async () => {
    const fake = await deployedAccount();
    const before = structuredClone({ ...fake.state, consumers: [...fake.state.consumers] });
    const { d, lines } = deps(fake.runner);
    const result = await destroy(d);
    expect(result.dryRun).toBe(true);
    expect(result.deleted).toEqual([]);
    expect(result.wouldDelete).toEqual(EVERY_RESOURCE);
    expect(result.left).toEqual(["analytics-engine:fyrden_metrics"]);
    expect(fake.calls.filter((c) => isChange(c.args))).toEqual([]);
    expect({ ...fake.state, consumers: [...fake.state.consumers] }).toEqual(before);
    const output = lines.join("\n");
    expect(output).toContain("would delete worker:fyrden-api");
    expect(output).toMatch(/dry run: nothing was deleted; rerun with --yes/);
  });

  it("with --yes deletes every resource deploy created, in an order Cloudflare accepts", async () => {
    const fake = await deployedAccount();
    const result = await destroy(deps(fake.runner, { confirmed: true }).d);
    expect(result.dryRun).toBe(false);
    expect(result.deleted).toEqual(EVERY_RESOURCE);
    expect(result.skipped).toEqual([]);
    expect(result.left).toEqual(["analytics-engine:fyrden_metrics"]);
    expect(fake.state.deployed).toEqual([]);
    expect(fake.state.queues.size + fake.state.r2.size + fake.state.d1.size).toBe(0);
    expect(fake.state.kv.size).toBe(0);

    const changes = fake.calls.filter((c) => isChange(c.args)).map((c) => c.args.join(" "));
    const firstIndex = (prefix: string) => changes.findIndex((c) => c.startsWith(prefix));
    const lastIndex = (prefix: string) => changes.findLastIndex((c) => c.startsWith(prefix));
    const order = [
      "queues consumer remove",
      "delete --name fyrden-web",
      "delete --name fyrden-api",
      "queues delete",
      "r2 bucket delete",
      "d1 delete",
      "kv namespace delete",
    ];
    for (const [i, step] of order.entries()) {
      expect(firstIndex(step), step).toBeGreaterThanOrEqual(0);
      const next = order[i + 1];
      if (next) expect(lastIndex(step), `${step} before ${next}`).toBeLessThan(firstIndex(next));
    }
  });

  it("removes every queue consumer before deleting the consumer Worker (Cloudflare refuses otherwise)", async () => {
    const fake = await deployedAccount();
    await destroy(deps(fake.runner, { confirmed: true }).d);
    const args = fake.calls.map((c) => c.args.join(" "));
    const workerDelete = args.indexOf("delete --name fyrden-api --force");
    for (const queue of [
      "fyrden-events",
      "fyrden-webhooks",
      "fyrden-effects-webhooks",
      "fyrden-effects-feed",
      "fyrden-effects-references",
      "fyrden-ci-dispatch",
    ]) {
      const remove = args.indexOf(`queues consumer remove ${queue} fyrden-api`);
      expect(remove).toBeGreaterThanOrEqual(0);
      expect(remove).toBeLessThan(workerDelete);
    }
  });

  it("prints the data-loss warning before deleting anything, and a summary after", async () => {
    const fake = await deployedAccount();
    const { d, lines } = deps(fake.runner, { confirmed: true });
    await destroy(d);
    const warning = lines.findIndex((l) => l.startsWith("WARNING"));
    const firstDelete = lines.findIndex((l) => l.startsWith("deleted "));
    expect(warning).toBeGreaterThanOrEqual(0);
    expect(warning).toBeLessThan(firstDelete);
    expect(lines[warning]).toMatch(/cannot be undone/);
    const output = lines.join("\n");
    expect(output).toContain(`deleted ${EVERY_RESOURCE.length}`);
    expect(output).toMatch(/left in place: analytics-engine:fyrden_metrics/);
  });

  it("skips resources that do not exist", async () => {
    const fake = await deployedAccount();
    fake.state.r2.delete("fyrden-ci");
    fake.state.queues.delete("fyrden-indexing");
    fake.state.consumers.delete("fyrden-indexing");
    fake.state.d1.delete("fyrden-org");
    const result = await destroy(deps(fake.runner, { confirmed: true }).d);
    expect(result.skipped).toEqual(["queue:fyrden-indexing", "r2:fyrden-ci", "d1:fyrden-org"]);
    expect(result.deleted).toEqual(
      EVERY_RESOURCE.filter((r) => !/indexing|r2:fyrden-ci$|fyrden-org/.test(r)),
    );
  });

  it("deletes nothing and succeeds on an account with no deployment", async () => {
    const fake = fakeWrangler();
    const result = await destroy(deps(fake.runner, { confirmed: true }).d);
    expect(result.deleted).toEqual([]);
    expect(result.skipped).toEqual(EVERY_RESOURCE.filter((r) => !r.startsWith("consumer:")));
    expect(fake.calls.filter((c) => isChange(c.args))).toEqual([]);
  });

  it("is idempotent: a second run deletes nothing and succeeds", async () => {
    const fake = await deployedAccount();
    await destroy(deps(fake.runner, { confirmed: true }).d);
    const before = fake.calls.length;
    const second = await destroy(deps(fake.runner, { confirmed: true }).d);
    expect(second.deleted).toEqual([]);
    expect(second.complete).toBe(true);
    expect(fake.calls.slice(before).filter((c) => isChange(c.args))).toEqual([]);
  });

  it("leaves a non-empty bucket in place with instructions, and still deletes the rest", async () => {
    const fake = await deployedAccount();
    fake.state.r2Objects.set("fyrden-git", 1234);

    const dry = deps(fake.runner);
    await destroy(dry.d);
    expect(dry.lines.join("\n")).toContain("would delete r2:fyrden-git (about 1,234 objects");

    const { d, lines } = deps(fake.runner, { confirmed: true });
    const result = await destroy(d);
    expect(fake.state.r2.has("fyrden-git")).toBe(true);
    expect(result.complete).toBe(false);
    expect(result.left).toEqual(["r2:fyrden-git", "analytics-engine:fyrden_metrics"]);
    expect(result.deleted).toContain("d1:fyrden-directory");
    expect(result.deleted).toContain("kv:fyrden-api-cache");
    const output = lines.join("\n");
    expect(output).toContain("Empty Bucket");
    expect(output).toContain("wrangler r2 bucket lifecycle add fyrden-git");
    // No per-object deletes: they would take hours on a large bucket.
    expect(fake.calls.some((c) => c.args[0] === "r2" && c.args[1] === "object")).toBe(false);

    // Once the bucket is empty, a rerun finishes the job.
    fake.state.r2Objects.delete("fyrden-git");
    const rerun = await destroy(deps(fake.runner, { confirmed: true }).d);
    expect(rerun.deleted).toEqual(["r2:fyrden-git"]);
    expect(rerun.complete).toBe(true);
  });

  it("asks R2 to abort incomplete multipart uploads when they keep a bucket from being deleted", async () => {
    const fake = await deployedAccount();
    // An interrupted push left uploads R2 lists nowhere; the bucket has no objects.
    fake.state.r2Uploads.set("fyrden-git", 7);

    const { d, lines } = deps(fake.runner, { confirmed: true });
    const result = await destroy(d);
    expect(result.complete).toBe(false);
    expect(result.left).toContain("r2:fyrden-git");
    expect(fake.state.r2Lifecycle.get("fyrden-git")).toEqual(
      new Map([["fyrden-destroy-abort", ["--abort-multipart-days", "1", "--force"]]]),
    );
    const output = lines.join("\n");
    expect(output).toContain("incomplete multipart uploads");
    expect(output).toContain("added lifecycle rule fyrden-destroy-abort");
    expect(output).toContain("rerun `fyrden destroy --yes`");
    // The object advice stays, for a bucket that also holds objects.
    expect(output).toContain("--expire-days 1");

    // A rerun before R2 has aborted them: the rule is there already, which is fine.
    const early = deps(fake.runner, { confirmed: true });
    const again = await destroy(early.d);
    expect(again.left).toContain("r2:fyrden-git");
    expect(early.lines.join("\n")).toContain("could not add lifecycle rule fyrden-destroy-abort");

    // R2 aborts them (within about a day); the next run deletes the bucket.
    fake.state.r2Uploads.delete("fyrden-git");
    const rerun = await destroy(deps(fake.runner, { confirmed: true }).d);
    expect(rerun.deleted).toEqual(["r2:fyrden-git"]);
    expect(rerun.complete).toBe(true);
  });

  it("stops at an unexpected failure instead of deleting data behind it", async () => {
    const fake = await deployedAccount();
    const failing: WranglerRunner = {
      run: async (args, options) =>
        args[0] === "delete" && args.includes("fyrden-api")
          ? { code: 1, stdout: "", stderr: "fetch failed: network timeout" }
          : fake.runner.run(args, options),
    };
    await expect(destroy(deps(failing, { confirmed: true }).d)).rejects.toThrow(/network timeout/);
    expect(fake.state.r2.size).toBe(4);
    expect(fake.state.d1.size).toBe(2);
  });

  it("refuses, before deleting anything, when another KV namespace shares Fyrden's title", async () => {
    const fake = await deployedAccount();
    // [unrelated, Fyrden's]: a first-match lookup would pick the unrelated one.
    const [[fyrdenId, title]] = [...fake.state.kv] as [[string, string]];
    fake.state.kv = new Map([
      ["kv-unrelated", title],
      [fyrdenId, title],
    ]);
    for (const confirmed of [false, true]) {
      await expect(destroy(deps(fake.runner, { confirmed }).d)).rejects.toThrow(
        `2 KV namespaces in this account are titled ${title} (ids kv-unrelated, ${fyrdenId})`,
      );
    }
    expect(fake.calls.filter((c) => isChange(c.args))).toEqual([]);
    expect(fake.state.kv.size).toBe(2);
    expect(fake.state.deployed).toContain("fyrden-api");
  });

  it("deletes the KV namespace deploy bound, by id, among unrelated namespaces", async () => {
    const fake = await deployedAccount();
    const bound = (await generatedKvIds())[0];
    fake.state.kv = new Map([["kv-unrelated", "someone-else-cache"], ...fake.state.kv]);
    await destroy(deps(fake.runner, { confirmed: true }).d);
    expect(fake.calls.map((c) => c.args.join(" "))).toContain(
      `kv namespace delete --namespace-id ${bound} -y`,
    );
    expect([...fake.state.kv]).toEqual([["kv-unrelated", "someone-else-cache"]]);
  });

  it("never prints the bootstrap secret", async () => {
    const fake = await deployedAccount();
    const dry = deps(fake.runner);
    await destroy(dry.d);
    const yes = deps(fake.runner, { confirmed: true });
    await destroy(yes.d);
    expect([...dry.lines, ...yes.lines].join("\n")).not.toContain("s3cret-value");
  });
});

describe("fyrden destroy account selection", () => {
  it("pins every wrangler call after whoami to the resolved account", async () => {
    const fake = await deployedAccount();
    const { d, lines } = deps(fake.runner, { confirmed: true });
    await destroy(d);
    expect(lines[0]).toBe("destroying Fyrden in account Test account (acct-1)");
    const [whoami, ...rest] = fake.calls;
    expect(whoami?.args[0]).toBe("whoami");
    expect(rest.length).toBeGreaterThan(20);
    expect(rest.every((c) => c.account === "acct-1")).toBe(true);
  });

  it("uses CLOUDFLARE_ACCOUNT_ID to choose among several accounts", async () => {
    const fake = fakeWrangler();
    fake.state.accounts.push({ id: "acct-2", name: "Second" });
    const { d, lines } = deps(fake.runner, { envAccountId: "acct-2" });
    await destroy(d);
    expect(lines[0]).toBe("destroying Fyrden in account Second (acct-2) (dry run)");
    expect(fake.calls.slice(1).every((c) => c.account === "acct-2")).toBe(true);
  });

  it("refuses with several accounts and no CLOUDFLARE_ACCOUNT_ID", async () => {
    const fake = await deployedAccount();
    fake.state.accounts.push({ id: "acct-2", name: "Second" });
    await expect(destroy(deps(fake.runner, { confirmed: true }).d)).rejects.toThrow(
      /2 accounts .*set CLOUDFLARE_ACCOUNT_ID/,
    );
    expect(fake.calls.map((c) => c.args[0])).toEqual(["whoami"]);
  });

  it.each(["apps/api/wrangler.jsonc", "apps/web/wrangler.jsonc"])(
    "refuses to start when %s names another account",
    async (file) => {
      const path = join(repoRoot, file);
      await writeFile(
        path,
        (await readFile(path, "utf8")).replace("{", '{ "account_id": "acct-9",'),
      );
      const fake = fakeWrangler();
      await expect(destroy(deps(fake.runner, { confirmed: true }).d)).rejects.toThrow(
        `${file} sets account_id acct-9`,
      );
      expect(fake.calls.map((c) => c.args[0])).toEqual(["whoami"]);
    },
  );
});

describe("fyrden destroy arguments", () => {
  it.each([["--force"], ["--yes", "--plan", "free"], ["-y"]])(
    "rejects anything but --yes (%s) before touching Cloudflare",
    async (...args) => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        expect(await main(["destroy", ...args])).toBe(2);
        expect(error.mock.calls[0]?.[0]).toContain("fyrden destroy [--yes]");
      } finally {
        error.mockRestore();
      }
    },
  );
});
