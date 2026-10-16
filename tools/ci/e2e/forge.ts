// What the pull request end-to-end tests share: fyrden-api under `wrangler
// dev` (its own state in a temporary directory, the cron run on request),
// accounts made through the admin API, a typed REST client, an MCP client,
// stock git with no user or system config, and bounded polling for what the
// server does in the background (alarms, queues).
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { mentionsToken } from "@fyrden/domain";
import {
  createDpopKey,
  type DpopKey,
  exchangeToken,
  FyrdenClient,
  FyrdenError,
  type InputOf,
  type OutputOf,
} from "@fyrden/sdk";
import { expect } from "vitest";
import { startWranglerDev } from "./wrangler-dev.js";

const root = resolve(import.meta.dirname, "../../..");
const apiDir = join(root, "apps/api");
const apiConfig = join(apiDir, "wrangler.jsonc");
const wranglerBin = join(
  dirname(createRequire(import.meta.url).resolve("wrangler/package.json")),
  "bin",
  "wrangler.js",
);

/** The cron that delivers effects (feed entries among them) the queue consumer left (wrangler.jsonc). */
export const EFFECTS_CRON = "2-59/5 * * * *";

/** Each request of a test gives up after this long (the server is local). */
const DEADLINE_MS = 30_000;
const MCP_PROTOCOL = "2026-07-28";

export interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(
  command: string,
  args: readonly string[],
  options: { cwd: string; env?: Record<string, string> },
): Promise<Run> {
  return new Promise((done, fail) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d;
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d;
    });
    child.on("error", fail);
    child.on("close", (code) => done({ code, stdout, stderr }));
    child.stdin.end();
  });
}

/** A user or an agent acting through REST. */
export interface Account {
  readonly id: string;
  readonly handle: string;
  /** Its personal access token: REST, MCP and git. Never printed. */
  readonly token: string;
  readonly api: FyrdenClient;
}

export interface Forge {
  readonly origin: string;
  readonly port: number;
  /** A directory of the test's own, removed by `stop`. */
  readonly scratch: string;
  /** The instance administrator `bootstrap` made. */
  readonly admin: Account;
  /** A new user, made by the administrator, with a token of its full rights. */
  user(handle: string): Promise<Account>;
  /** A REST client with a token (DPoP-bound when `dpop` is given). */
  client(token: string, dpop?: DpopKey): FyrdenClient;
  /** Runs the Worker's cron once, as the platform would on `schedule`. */
  cron(schedule: string): Promise<void>;
  /** Stops the server; fails if its output (the Worker's logs, the access log) shows a token. */
  stop(): Promise<void>;
}

/**
 * Starts fyrden-api under `wrangler dev` with fresh local state, its
 * secrets made for this run, and its cron run only when the test asks.
 */
export async function startForge(name: string): Promise<Forge> {
  const scratch = await mkdtemp(join(tmpdir(), `fyrden-e2e-${name}-`));
  await mkdir(join(scratch, "home"), { recursive: true });
  const persist = join(scratch, "state");
  const bootstrapSecret = `e2e-${crypto.randomUUID()}`;
  const envFile = join(scratch, "test.env");
  await writeFile(
    envFile,
    [
      `BOOTSTRAP_SECRET=${bootstrapSecret}`,
      `SIGNING_KEY=${randomBytes(32).toString("base64")}`,
      `WEBHOOKS_KEY=${randomBytes(32).toString("base64")}`,
      "",
    ].join("\n"),
  );
  for (const db of ["DIRECTORY", "ORG_READ"]) {
    const migrate = await run(
      process.execPath,
      [wranglerBin, "d1", "migrations", "apply", db, "--local", "--persist-to", persist],
      { cwd: apiDir, env: { NO_COLOR: "1", WRANGLER_SEND_METRICS: "false" } },
    );
    expect(migrate.code, migrate.stdout + migrate.stderr).toBe(0);
  }
  let output = "";
  let dev: ChildProcess | undefined;
  let closed: Promise<void> = Promise.resolve();
  const stop = async () => {
    try {
      if (dev && dev.exitCode === null && dev.signalCode === null) dev.kill("SIGTERM");
      const ended = await Promise.race([
        closed.then(() => true),
        new Promise<boolean>((give) => setTimeout(() => give(false), 10_000)),
      ]);
      if (!ended) {
        dev?.kill("SIGKILL");
        await closed;
      }
      // Neither the Worker nor wrangler's access log may print a token.
      expect(output.split("\n").filter(mentionsToken)).toEqual([]);
    } finally {
      // Its state and the env file (a signing seed, the bootstrap secret) go in any case.
      await rm(scratch, { recursive: true, force: true });
    }
  };
  try {
    const server = await startWranglerDev({
      args: [
        "-c",
        apiConfig,
        "--persist-to",
        persist,
        "--env-file",
        envFile,
        // The crons run when the test asks (`/__scheduled`).
        "--test-scheduled",
      ],
      cwd: apiDir,
      onOutput: (text) => {
        output += text;
      },
    });
    dev = server.child;
    closed = server.closed;
    const origin = `http://127.0.0.1:${server.port}`;
    const client = (token: string, dpop?: DpopKey) =>
      new FyrdenClient({
        baseUrl: `${origin}/api`,
        token,
        ...(dpop && { dpop }),
        fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(DEADLINE_MS) }),
      });
    const handle = `${name.replaceAll(/[^a-z0-9]/g, "")}${Date.now().toString(36)}`;
    const boot = await fetch(`${origin}/v0/admin/bootstrap`, {
      signal: AbortSignal.timeout(DEADLINE_MS),
      method: "POST",
      headers: { "X-Fyrden-Bootstrap-Secret": bootstrapSecret, "Content-Type": "application/json" },
      body: JSON.stringify({ handle }),
    });
    expect(boot.status).toBe(201);
    const adminToken = ((await boot.json()) as { token: string }).token;
    const adminApi = client(adminToken);
    const me = await adminApi.call("meta.whoami", {});
    const admin: Account = { id: me.id, handle, token: adminToken, api: adminApi };
    return {
      origin,
      port: server.port,
      scratch,
      admin,
      client,
      async user(userHandle) {
        const made = await adminApi.call("admin.users.create", { handle: userHandle });
        const pat = await adminApi.call("admin.tokens.create", {
          user_id: made.id,
          type: "pat",
          scopes: [],
          expires_in_days: 1,
        });
        return { id: made.id, handle: userHandle, token: pat.token, api: client(pat.token) };
      },
      async cron(schedule) {
        const res = await fetch(`${origin}/__scheduled?cron=${encodeURIComponent(schedule)}`, {
          signal: AbortSignal.timeout(DEADLINE_MS),
        });
        expect(res.status).toBe(200);
      },
      stop,
    };
  } catch (error) {
    await stop().catch(() => undefined);
    throw error;
  }
}

/**
 * Asks `probe` again until it returns something other than undefined, at
 * most `timeoutMs` in all: for what the server does in the background
 * (an alarm, a queue consumer). Fails naming `what` when it never does.
 */
export async function eventually<T>(
  what: string,
  probe: () => Promise<T | undefined>,
  { timeoutMs = 60_000, intervalMs = 250 } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * The refusal a REST call ended with: its status, problem code and detail,
 * and where to start over for an expired cursor. Fails if it succeeded.
 */
export async function refusal(
  call: Promise<unknown>,
): Promise<{ status: number; code: string; detail: string; resync?: string }> {
  try {
    await call;
  } catch (error) {
    if (error instanceof FyrdenError) {
      const { status, code, detail, resync } = error;
      return { status, code, detail, ...(resync !== undefined && { resync }) };
    }
    throw error;
  }
  throw new Error("the request was expected to be refused, and succeeded");
}

/** An MCP client of the server: each call a stateless request, with a DPoP proof when bound. */
export function mcpClient(origin: string, token: string, dpop?: DpopKey) {
  const url = `${origin}/mcp`;
  async function rpc<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(DEADLINE_MS),
      method: "POST",
      headers: {
        ...(dpop
          ? { Authorization: `DPoP ${token}`, DPoP: await dpop.proof("POST", url, token) }
          : { Authorization: `Bearer ${token}` }),
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": MCP_PROTOCOL,
        "Mcp-Method": method,
        ...(typeof params.name === "string" && { "Mcp-Name": params.name }),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params: {
          ...params,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL,
            "io.modelcontextprotocol/clientInfo": { name: "fyrden-e2e", version: "0.0.0" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });
    const text = await res.text();
    expect(res.status, text).toBe(200);
    // Streamable HTTP answers with JSON or a single SSE event.
    const json = text.startsWith("{")
      ? text
      : (text
          .split("\n")
          .find((l) => l.startsWith("data: "))
          ?.slice(6) ?? "");
    const message = JSON.parse(json) as { result?: T; error?: unknown };
    if (!message.result) throw new Error(`MCP error: ${json}`);
    return message.result;
  }
  return {
    /** A tool's structured answer; an `isError` answer throws with its text. */
    async tool<T = Record<string, unknown>>(name: string, args: Record<string, unknown>) {
      const result = await rpc<{
        isError?: boolean;
        structuredContent?: T;
        content: { text: string }[];
      }>("tools/call", { name, arguments: args });
      if (result.isError) throw new Error(`${name}: ${result.content[0]?.text}`);
      return result.structuredContent ?? (JSON.parse(result.content[0]?.text ?? "{}") as T);
    },
  };
}

/**
 * An agent of `owner` acting for it under a grant of `scopes`: its own
 * token exchanged (RFC 8693) for DPoP-bound ones, for REST and for MCP.
 */
export async function delegatedAgent(
  forge: Forge,
  owner: Account,
  agentHandle: string,
  scopes: InputOf<"grants.create">["scopes"],
) {
  await owner.api.call("agents.create", { handle: agentHandle });
  const own = await owner.api.call("agents.tokens.create", { agent: agentHandle });
  const grant = await owner.api.call("grants.create", { agent: agentHandle, scopes });
  const key = await createDpopKey();
  const exchange = (resource: string) =>
    exchangeToken(
      forge.origin,
      { subjectToken: own.token, grantId: grant.id, resource },
      { dpop: key, signal: AbortSignal.timeout(DEADLINE_MS) },
    );
  const forApi = await exchange(`${forge.origin}/api`);
  const forMcp = await exchange(`${forge.origin}/mcp`);
  expect(forApi.token_type).toBe("DPoP");
  return {
    handle: agentHandle,
    api: forge.client(forApi.access_token, key),
    mcp: mcpClient(forge.origin, forMcp.access_token, key),
  };
}

/** Stock git as one account, with no user or system config, never prompting; each commit a day later. */
export class Git {
  #clock = 1_767_225_600;

  constructor(
    private readonly forge: Forge,
    private readonly account: Account,
  ) {}

  /** The URL of a repository, with this account's token. */
  url(owner: string, repo: string): string {
    return `http://x-access-token:${this.account.token}@127.0.0.1:${this.forge.port}/${owner}/${repo}.git`;
  }

  /** git's result; a failure's message without the token of a remote's URL. */
  async try(args: readonly string[], cwd = this.forge.scratch): Promise<Run> {
    const date = `${this.#clock} +0000`;
    const result = await run("git", args, {
      cwd,
      env: {
        HOME: join(this.forge.scratch, "home"),
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: join(this.forge.scratch, "home/.gitconfig"),
        GIT_TERMINAL_PROMPT: "0",
        GIT_AUTHOR_NAME: this.account.handle,
        GIT_AUTHOR_EMAIL: `${this.account.handle}@fyrden.invalid`,
        GIT_COMMITTER_NAME: this.account.handle,
        GIT_COMMITTER_EMAIL: `${this.account.handle}@fyrden.invalid`,
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_DATE: date,
      },
    });
    const redact = (text: string) => text.replace(/\/\/[^/@\s]*@/g, "//***@");
    return {
      code: result.code,
      stdout: result.stdout,
      stderr: redact(`git ${args.join(" ")}\n${result.stderr}`),
    };
  }

  /** git that must succeed: its output, trimmed. */
  async ok(args: readonly string[], cwd = this.forge.scratch): Promise<string> {
    const result = await this.try(args, cwd);
    expect(result.code, result.stderr).toBe(0);
    return result.stdout.trim();
  }

  /** A clone of `owner/repo` in a new directory named `dir`, its remote `origin`. */
  async clone(owner: string, repo: string, dir: string): Promise<string> {
    const work = join(this.forge.scratch, dir);
    await this.ok(["clone", "-q", this.url(owner, repo), work]);
    return work;
  }

  /** Writes `files` and commits them: the new commit's id. */
  async commit(cwd: string, files: Record<string, string>, message: string): Promise<string> {
    this.#clock += 86_400;
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(cwd, path)), { recursive: true });
      await writeFile(join(cwd, path), content);
    }
    await this.ok(["add", "-A"], cwd);
    await this.ok(["commit", "-q", "-m", message], cwd);
    return this.ok(["rev-parse", "HEAD"], cwd);
  }

  /** `git ls-remote` of a repository, as `{ ref: oid }`. */
  async remoteRefs(owner: string, repo: string, ...patterns: string[]) {
    const out: Record<string, string> = {};
    for (const line of (await this.ok(["ls-remote", this.url(owner, repo), ...patterns])).split(
      "\n",
    )) {
      if (!line) continue;
      const [oid, ref] = line.split("\t") as [string, string];
      out[ref] = oid;
    }
    return out;
  }
}

/** A repository of `owner` with one commit on main, pushed with stock git; its working copy. */
export async function seededRepo(
  forge: Forge,
  owner: Account,
  git: Git,
  name: string,
  files: Record<string, string>,
): Promise<string> {
  await owner.api.call("repos.create", { name });
  const work = join(forge.scratch, `${owner.handle}-${name}`);
  await git.ok(["init", "-q", "-b", "main", work]);
  await git.ok(["remote", "add", "origin", git.url(owner.handle, name)], work);
  await git.commit(work, files, "first");
  await git.ok(["push", "-q", "origin", "main"], work);
  return work;
}

export type FeedItem = OutputOf<"feed.list">["items"][number];

/**
 * Every change of a feed after `since`, page after page until the server
 * says to wait (each page checked to name an item at most once), and the
 * cursor to read on from.
 */
export async function readFeed(
  api: FyrdenClient,
  since: string,
): Promise<{ items: FeedItem[]; cursor: string }> {
  const items: FeedItem[] = [];
  let cursor = since;
  for (;;) {
    const page = await api.call("feed.list", { since: cursor, limit: 100 });
    const keys = page.items.map((i) => i.item_key);
    expect(new Set(keys).size, "an item twice in one page").toBe(keys.length);
    items.push(...page.items);
    cursor = page.next_cursor;
    if (page.poll_after_ms > 0) return { items, cursor };
  }
}

/**
 * Follows a feed as a client should: from a cursor, page after page until
 * the server says to wait, keeping the latest copy of each item by its key.
 */
export class FeedFollower {
  readonly items = new Map<string, FeedItem>();

  constructor(
    private readonly api: FyrdenClient,
    private cursor: string,
  ) {}

  /** Reads what changed since the last read; no page names an item twice. */
  async poll(): Promise<void> {
    const read = await readFeed(this.api, this.cursor);
    for (const item of read.items) this.items.set(item.item_key, item);
    this.cursor = read.cursor;
  }

  /** The item of pull request `number` of `kind`, as last read. */
  find(number: number, kind: FeedItem["kind"]): FeedItem | undefined {
    return [...this.items.values()].find(
      (i) => i.thread_key === `pull/${number}` && i.kind === kind,
    );
  }

  /**
   * Polls until the item of pull request `number` of `kind` is in `state`
   * (and matches `extra`), running the effects cron between reads as the
   * platform's schedule would for entries the queue consumer left.
   */
  async until(
    forge: Forge,
    number: number,
    kind: FeedItem["kind"],
    state: FeedItem["state"],
    extra: (item: FeedItem) => boolean = () => true,
  ): Promise<FeedItem> {
    return eventually(`a ${state} ${kind} item for #${number} in the feed`, async () => {
      await this.poll();
      const item = this.find(number, kind);
      if (item?.state === state && extra(item)) return item;
      await forge.cron(EFFECTS_CRON);
      return undefined;
    });
  }
}
