// An agent's whole workflow against fyrden-api under `wrangler dev`, through
// public entry points only: an MCP client signs its user in with OAuth 2.1
// (PKCE S256, a resource indicator, a DPoP-bound token), creates a
// repository, gets a short-lived git token and pushes with stock git,
// browses it and reads a file as an MCP resource at a commit, commits a file
// change (signed by the platform, so verified), downloads an archive, forks,
// sets an expiry, and the reaper deletes the repository after it.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { mentionsToken } from "@fyrden/domain";
import {
  authorizationUrl,
  createDpopKey,
  createPkce,
  type DpopKey,
  exchangeCode,
} from "@fyrden/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const apiConfig = join(root, "apps/api/wrangler.jsonc");
const wranglerBin = join(
  dirname(createRequire(import.meta.url).resolve("wrangler/package.json")),
  "bin",
  "wrangler.js",
);
const port = 40_000 + Math.floor(Math.random() * 10_000);
const origin = `http://127.0.0.1:${port}`;
const bootstrapSecret = `e2e-${crypto.randomUUID()}`;
const signingSeed = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
const REDIRECT = "http://127.0.0.1:8765/callback";
const PROTOCOL = "2026-07-28";

let scratch = "";
let dev: ChildProcess | undefined;
let closed: Promise<void> = Promise.resolve();
let output = "";
let handle = "";
let pat = "";

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
): Promise<Run> {
  return new Promise((done, fail) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? scratch,
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

/** Stock git with no user or system config, never prompting. */
async function git(args: string[], cwd = scratch): Promise<string> {
  const result = await run("git", args, {
    cwd,
    env: {
      HOME: join(scratch, "home"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: join(scratch, "home/.gitconfig"),
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "Fyrden E2E",
      GIT_AUTHOR_EMAIL: "e2e@fyrden.invalid",
      GIT_COMMITTER_NAME: "Fyrden E2E",
      GIT_COMMITTER_EMAIL: "e2e@fyrden.invalid",
    },
  });
  // A failure's message never shows the token in a remote's URL.
  const redact = (text: string) => text.replace(/\/\/[^/@\s]*@/g, "//***@");
  expect(result.code, redact(`git ${args.join(" ")}\n${result.stderr}`)).toBe(0);
  return result.stdout;
}

/** Each request of the test gives up after this long (the server is local). */
const DEADLINE_MS = 30_000;
const timed = (init: RequestInit = {}): RequestInit => ({
  ...init,
  signal: AbortSignal.timeout(DEADLINE_MS),
});

/** An MCP client of the server: each call a stateless request with a DPoP proof. */
function mcpClient(token: string, key: DpopKey) {
  const url = `${origin}/mcp`;
  async function rpc<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(DEADLINE_MS),
      method: "POST",
      headers: {
        Authorization: `DPoP ${token}`,
        DPoP: await key.proof("POST", url, token),
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": PROTOCOL,
        "Mcp-Method": method,
        ...(typeof params.name === "string" && { "Mcp-Name": params.name }),
        ...(typeof params.uri === "string" && { "Mcp-Name": params.uri }),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params: {
          ...params,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": PROTOCOL,
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
    rpc,
    /** A tool's structured answer; `isError` answers throw. */
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

/** The user signed in to the server's own pages (a session cookie), from a token with full rights. */
async function sessionCookie(): Promise<string> {
  const res = await fetch(`${origin}/auth/token`, {
    signal: AbortSignal.timeout(DEADLINE_MS),
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ token: pat }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  const cookie = res.headers.get("Set-Cookie") ?? "";
  return cookie.split(";")[0] ?? "";
}

/** The MCP client's OAuth sign-in: registration, consent, code, DPoP-bound tokens. */
async function signIn(key: DpopKey) {
  const registered = await fetch(`${origin}/oauth/register`, {
    signal: AbortSignal.timeout(DEADLINE_MS),
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "E2E agent", redirect_uris: [REDIRECT] }),
  });
  expect(registered.status, await registered.clone().text()).toBe(201);
  const { client_id: clientId } = (await registered.json()) as { client_id: string };
  const cookie = await sessionCookie();
  const { verifier, challenge } = await createPkce();
  const consent = await fetch(
    authorizationUrl(origin, {
      clientId,
      redirectUri: REDIRECT,
      codeChallenge: challenge,
      resource: `${origin}/mcp`,
      state: "e2e",
      scope: "metadata:read contents:write repos:create administration:write",
      dpopJkt: key.jkt,
    }),
    timed({ headers: { Cookie: cookie }, redirect: "manual" }),
  );
  const page = await consent.text();
  expect(consent.status, page).toBe(200);
  const requestId = /name="request_id" value="([^"]+)"/.exec(page)?.[1] ?? "";
  const answer = await fetch(`${origin}/oauth/authorize`, {
    signal: AbortSignal.timeout(DEADLINE_MS),
    method: "POST",
    redirect: "manual",
    headers: {
      Cookie: cookie,
      Origin: origin,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ request_id: requestId, decision: "allow" }).toString(),
  });
  expect(answer.status).toBe(303);
  const back = new URL(answer.headers.get("Location") ?? "");
  return exchangeCode(
    origin,
    {
      clientId,
      code: back.searchParams.get("code") ?? "",
      codeVerifier: verifier,
      redirectUri: REDIRECT,
      resource: `${origin}/mcp`,
    },
    { dpop: key, signal: AbortSignal.timeout(DEADLINE_MS) },
  );
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "fyrden-e2e-agent-"));
  await run("mkdir", ["-p", join(scratch, "home")]);
  const persist = join(scratch, "state");
  const envFile = join(scratch, "test.env");
  await writeFile(envFile, `BOOTSTRAP_SECRET=${bootstrapSecret}\nSIGNING_KEY=${signingSeed}\n`);
  for (const db of ["DIRECTORY", "ORG_READ"]) {
    const migrate = await run(
      process.execPath,
      [
        wranglerBin,
        "d1",
        "migrations",
        "apply",
        db,
        "--local",
        "--persist-to",
        persist,
        "-c",
        apiConfig,
      ],
      { cwd: join(root, "apps/api"), env: { NO_COLOR: "1", WRANGLER_SEND_METRICS: "false" } },
    );
    expect(migrate.code, migrate.stdout + migrate.stderr).toBe(0);
  }
  dev = spawn(
    process.execPath,
    [
      wranglerBin,
      "dev",
      "-c",
      apiConfig,
      "--persist-to",
      persist,
      "--env-file",
      envFile,
      // The cron (the expiry reaper) runs when the test asks (`/__scheduled`).
      "--test-scheduled",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--inspector-port",
      String(port + 1),
    ],
    {
      cwd: join(root, "apps/api"),
      env: { ...process.env, NO_COLOR: "1", WRANGLER_SEND_METRICS: "false" },
    },
  );
  const child = dev;
  closed = new Promise((done) => child.once("close", () => done()));
  await new Promise<void>((ready, fail) => {
    const timer = setTimeout(
      () => fail(new Error(`wrangler dev did not start:\n${output}`)),
      60_000,
    );
    const onData = (d: Buffer) => {
      output += d;
      if (/Ready on/.test(output)) {
        clearTimeout(timer);
        ready();
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("exit", (code) => fail(new Error(`wrangler dev exited (${code}):\n${output}`)));
  });
  handle = `e2eagent${Date.now().toString(36)}`;
  const boot = await fetch(`${origin}/v0/admin/bootstrap`, {
    method: "POST",
    headers: { "X-Fyrden-Bootstrap-Secret": bootstrapSecret, "Content-Type": "application/json" },
    body: JSON.stringify({ handle }),
  });
  expect(boot.status, await boot.clone().text()).toBe(201);
  pat = ((await boot.json()) as { token: string }).token;
}, 120_000);

afterAll(async () => {
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
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }
});

describe("an agent's workflow through MCP, OAuth and stock git (wrangler dev)", () => {
  it("creates, pushes, browses, writes, archives, forks and expires a repository", {
    timeout: 300_000,
  }, async () => {
    const key = await createDpopKey();
    const tokens = await signIn(key);
    expect(tokens.token_type).toBe("DPoP");
    const mcp = mcpClient(tokens.access_token, key);
    const name = `agent-${Date.now().toString(36)}`;
    const at = { owner: handle, repo: name };

    // A repository, and a git token for stock git.
    await mcp.tool("create_repo", { name });
    const gitToken = await mcp.tool<{ token: string; expires_at: number }>("create_git_token", {});
    expect(gitToken.expires_at - Date.now()).toBeLessThanOrEqual(60 * 60 * 1000);
    const work = join(scratch, name);
    await git(["init", "-q", "-b", "main", work]);
    await writeFile(join(work, "README.md"), "# Agent\n");
    await git(["add", "-A"], work);
    await git(["commit", "-q", "-m", "first"], work);
    const first = (await git(["rev-parse", "HEAD"], work)).trim();
    const remote = `http://x-access-token:${gitToken.token}@127.0.0.1:${port}/${handle}/${name}.git`;
    await git(["push", "-q", remote, "main"], work);

    // Browse it: its history, its tree and a file's bytes.
    const commits = await mcp.tool<{ commits: { sha: string }[] }>("list_commits", at);
    expect(commits.commits.map((c) => c.sha)).toEqual([first]);
    const tree = await mcp.tool<{ tree: { path: string; type: string }[] }>("list_files", {
      ...at,
      tree_sha: "main",
      recursive: "1",
    });
    expect(tree.tree.map((e) => `${e.type} ${e.path}`)).toEqual(["blob README.md"]);
    const readme = await mcp.tool<{ sha: string; content: string; encoding: string }>(
      "get_file_contents",
      { ...at, path: "README.md" },
    );
    expect(Buffer.from(readme.content, "base64").toString()).toBe("# Agent\n");

    // A change of that file, committed by the server and signed with the platform's key.
    await mcp.tool("create_or_update_file", {
      ...at,
      path: "README.md",
      message: "edit",
      content: Buffer.from("# Agent, edited\n").toString("base64"),
      sha: readme.sha,
    });
    const after = await mcp.tool<{
      commits: { sha: string; commit: { verification: { verified: boolean } } }[];
    }>("list_commits", at);
    expect(after.commits.map((c) => c.sha).slice(1)).toEqual([first]);
    expect(after.commits[0]?.commit.verification.verified).toBe(true);
    // As a resource: at the first commit, the file as it was there; on main, as it is.
    const resource = async (ref: string) =>
      (
        await mcp.rpc<{ contents: { text?: string }[] }>("resources/read", {
          uri: `fyrden://repos/${handle}/${name}/refs/${ref}/files/README.md`,
        })
      ).contents[0]?.text;
    expect(await resource(first)).toBe("# Agent\n");
    expect(await resource("main")).toBe("# Agent, edited\n");

    // An archive of it, downloaded with the git token (the MCP token is for /mcp only).
    const archive = await mcp.tool<{ download_url: string }>("get_archive", {
      ...at,
      format: "zip",
    });
    let zip: Response | undefined;
    for (let i = 0; i < 20; i++) {
      zip = await fetch(
        archive.download_url,
        timed({ headers: { Authorization: `Bearer ${gitToken.token}` } }),
      );
      if (zip.status !== 202) break;
      await new Promise((r) => setTimeout(r, 1_000));
    }
    expect(zip?.status).toBe(200);
    const bytes = Buffer.from(await (zip as Response).arrayBuffer());
    expect(bytes.subarray(0, 2).toString()).toBe("PK");
    // Its central directory names the file under the archive's top directory.
    expect(bytes.toString("latin1")).toMatch(/\/README\.md/);

    // A fork, with the history it was forked with.
    const forkName = `${name}-fork`;
    const fork = await mcp.tool<{ name: string; parent_id: string }>("fork_repo", {
      ...at,
      name: forkName,
    });
    expect(fork.name).toBe(forkName);
    const forked = await mcp.tool<{ commits: { sha: string }[] }>("list_commits", {
      owner: handle,
      repo: forkName,
    });
    expect(forked.commits.map((c) => c.sha)).toEqual(after.commits.map((c) => c.sha));

    // An expiry: the reaper leaves it until then, and deletes it after.
    const expiresAt = Date.now() + 20_000;
    const set = await mcp.tool<{ expires_at: number }>("update_repo", {
      ...at,
      expires_at: expiresAt,
    });
    expect(set.expires_at).toBe(expiresAt);
    const cron = async () => {
      const res = await fetch(
        `${origin}/__scheduled?cron=${encodeURIComponent("*/5 * * * *")}`,
        timed(),
      );
      expect(res.status).toBe(200);
    };
    const exists = async () =>
      (
        await fetch(
          `${origin}/api/repos/${handle}/${name}`,
          timed({ headers: { Authorization: `Bearer ${pat}` } }),
        )
      ).status === 200;
    await cron();
    expect(await exists()).toBe(true);
    await new Promise((r) => setTimeout(r, Math.max(0, expiresAt - Date.now()) + 500));
    // Deleted once its name can be taken again (a deletion holds it until it finishes).
    let recreated = false;
    for (let i = 0; i < 30 && !recreated; i++) {
      await cron();
      const again = await fetch(
        `${origin}/api/user/repos`,
        timed({
          method: "POST",
          headers: {
            Authorization: `Bearer ${pat}`,
            "Content-Type": "application/json",
            "Idempotency-Key": crypto.randomUUID(),
          },
          body: JSON.stringify({ name }),
        }),
      );
      recreated = again.status === 201;
      if (!recreated) {
        expect(again.status).toBe(409);
        await new Promise((r) => setTimeout(r, 1_000));
      }
    }
    expect(recreated).toBe(true);
  });
});
