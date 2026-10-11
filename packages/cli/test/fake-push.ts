import type { GitRunner, PackFiles, PushDeps } from "../src/commands/push.ts";

/*
 * Fakes for `fyrden push`: a git whose answers the test scripts, an
 * in-memory pack file store, and a Fyrden server that implements the
 * chunked upload session API.
 */

export const OID = {
  a: "a".repeat(40),
  b: "b".repeat(40),
  c: "c".repeat(40),
  tag: "d".repeat(40),
};

export interface FakeGitScript {
  /** `git remote get-url <name>` answers. */
  remotes?: Record<string, string>;
  /** `git remote get-url --push --all <name>` answers; the remote's URL when absent. */
  pushUrls?: Record<string, string[]>;
  /** `git ls-remote` output lines (`oid\tname`). */
  remoteRefs?: Record<string, string>;
  /** rev-parse answers: rev -> oid. */
  revs?: Record<string, string>;
  /** symbolic full names: rev -> refs/... */
  fullNames?: Record<string, string>;
  /** Objects present locally. */
  local?: string[];
  /** Pairs "old new" that are fast-forwards. */
  ancestors?: string[];
  /** Length of the pack pack-objects writes. */
  packBytes?: number;
  /** Credential helper password. */
  password?: string;
}

export interface FakeGit extends GitRunner {
  /** Every call's arguments, `-c` options included. */
  readonly calls: string[][];
  /** The extra environment of each call in `calls`, or undefined. */
  readonly envs: (Readonly<Record<string, string>> | undefined)[];
  readonly packInputs: string[];
  readonly passthroughs: string[][];
}

export function fakeGit(script: FakeGitScript, files: FakeFiles): FakeGit {
  const calls: string[][] = [];
  const envs: FakeGit["envs"] = [];
  const packInputs: string[] = [];
  const passthroughs: string[][] = [];
  const answer = async (
    args: string[],
    input?: string,
    env?: Readonly<Record<string, string>>,
  ): Promise<{ ok: boolean; stdout: string }> => {
    calls.push(args);
    envs.push(env);
    const [cmd, ...rest] = withoutConfig(args);
    const ok = (stdout: string) => ({ ok: true, stdout });
    const no = { ok: false, stdout: "" };
    switch (cmd) {
      case "remote": {
        const name = rest.at(-1) as string;
        const url = script.remotes?.[name];
        const urls = rest.includes("--push") ? (script.pushUrls?.[name] ?? [url]) : [url];
        return url ? ok(urls.map((u) => `${u}\n`).join("")) : no;
      }
      case "ls-remote":
        return ok(
          Object.entries(script.remoteRefs ?? {})
            .map(([name, oid]) => `${oid}\t${name}\n`)
            .join(""),
        );
      case "rev-parse": {
        if (rest.includes("--symbolic-full-name")) {
          const rev = rest.at(-1) as string;
          return ok(`${script.fullNames?.[rev] ?? ""}\n`);
        }
        const rev = rest.at(-1) as string;
        const oid = script.revs?.[rev];
        return oid ? ok(`${oid}\n`) : no;
      }
      case "cat-file": {
        // --batch-check: one line per object on stdin.
        const lines = (input ?? "").split("\n").filter((l) => l !== "");
        return ok(
          lines
            .map((oid) =>
              (script.local ?? []).includes(oid) ? `${oid} commit 1\n` : `${oid} missing\n`,
            )
            .join(""),
        );
      }
      case "merge-base": {
        const [, oldOid, newOid] = rest;
        return (script.ancestors ?? []).includes(`${oldOid} ${newOid}`) ? ok("") : no;
      }
      case "credential":
        return ok(`protocol=https\nhost=x\nusername=u\npassword=${script.password ?? "tok"}\n`);
      default:
        throw new Error(`unexpected git ${args.join(" ")}`);
    }
  };
  return {
    calls,
    envs,
    packInputs,
    passthroughs,
    async run(args, input, env) {
      const result = await answer(args, input, env);
      if (!result.ok) throw new Error(`git ${args.join(" ")} failed`);
      return result.stdout;
    },
    tryRun: answer,
    async packObjects(args, revs, path) {
      calls.push(["pack-objects", ...args]);
      packInputs.push(revs);
      const bytes = new Uint8Array(script.packBytes ?? 100);
      for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
      files.data.set(path, bytes);
      return bytes.length;
    },
    async passthrough(args, env) {
      calls.push(args);
      envs.push(env);
      passthroughs.push(args);
      return 0;
    },
  };
}

/** The git command after any leading `-c name=value` options. */
export function withoutConfig(args: readonly string[]): string[] {
  let i = 0;
  while (args[i] === "-c") i += 2;
  return args.slice(i);
}

export interface FakeFiles extends PackFiles {
  readonly data: Map<string, Uint8Array>;
  readonly removed: string[];
}

export function fakeFiles(): FakeFiles {
  const data = new Map<string, Uint8Array>();
  const removed: string[] = [];
  let n = 0;
  return {
    data,
    removed,
    tempPath: async () => `/tmp/pack-${n++}`,
    read: async (path, offset, length) =>
      (data.get(path) as Uint8Array).slice(offset, offset + length),
    remove: async (path) => {
      removed.push(path);
      data.delete(path);
    },
  };
}

export interface ServerOptions {
  partSize: number;
  /** Fail these PUTs once (by part number) with this status, or a network error. */
  failOnce?: Record<number, number | "network" | "part_in_progress" | "part_superseded">;
  /** How many completes answer "indexing" before the outcome. */
  indexingRounds?: number;
  /** The outcome per ref; default ok. */
  rejected?: Record<string, string>;
  /** Keep only part lengths, not bytes (large synthetic uploads). */
  countOnly?: boolean;
}

export interface FakeServer {
  readonly fetch: typeof fetch;
  readonly requests: {
    method: string;
    path: string;
    auth: string | null;
    body?: unknown;
    bytes?: number;
  }[];
  readonly stored: Map<number, Uint8Array>;
}

export function fakeServer(options: ServerOptions): FakeServer {
  const requests: FakeServer["requests"] = [];
  const stored = new Map<number, Uint8Array>();
  const failed = new Set<number>();
  let session: { size: number; ref_updates: { ref: string }[] } | undefined;
  let rounds = options.indexingRounds ?? 0;
  const id = "01JABCDEFGHJKMNPQRSTVWXYZ0";
  const partsUrl = `/alice/proj.git/uploads/${id}/parts`;
  const view = (state: string, refs?: unknown) => ({
    id,
    state,
    size: session?.size,
    part_size: options.partSize,
    part_count: Math.ceil((session?.size ?? 0) / options.partSize),
    parts_received: [...stored.keys()].sort((a, b) => a - b),
    parts_url: partsUrl,
    expires_at: 0,
    ...(refs ? { refs } : {}),
  });
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const fetchImpl = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const auth = request.headers.get("Authorization");
    if (url.pathname === "/api/repos/alice/proj/uploads" && request.method === "POST") {
      const body = (await request.json()) as typeof session;
      requests.push({ method: "POST", path: url.pathname, auth, body });
      session = body;
      return json(201, view("receiving"));
    }
    const part = url.pathname.startsWith(`${partsUrl}/`)
      ? Number(url.pathname.slice(partsUrl.length + 1))
      : undefined;
    if (part !== undefined && request.method === "PUT") {
      const bytes = new Uint8Array(await request.arrayBuffer());
      requests.push({ method: "PUT", path: url.pathname, auth, bytes: bytes.length });
      const failure = options.failOnce?.[part];
      if (failure !== undefined && !failed.has(part)) {
        failed.add(part);
        if (failure === "network") throw new TypeError("fetch failed");
        if (typeof failure === "string") return json(409, { code: failure, detail: "try again" });
        return json(failure, {
          code: failure === 422 ? "wrong_part_size" : "part_not_stored",
          detail: "try again",
        });
      }
      stored.set(part, options.countOnly ? new Uint8Array(0) : bytes);
      return json(200, { part, parts_received: [...stored.keys()], part_count: 0 });
    }
    if (url.pathname === `/api/repos/alice/proj/uploads/${id}` && request.method === "GET") {
      requests.push({ method: "GET", path: url.pathname, auth });
      return json(200, view("receiving"));
    }
    if (url.pathname === `/api/repos/alice/proj/uploads/${id}/complete`) {
      requests.push({ method: "POST", path: url.pathname, auth });
      if (rounds > 0) {
        rounds--;
        return json(200, view("indexing"));
      }
      const refs = (session?.ref_updates ?? []).map((u) =>
        options.rejected?.[u.ref]
          ? { ref: u.ref, status: "rejected", reason: options.rejected[u.ref] }
          : { ref: u.ref, status: "ok" },
      );
      const allOk = refs.every((r) => r.status === "ok");
      return json(200, view(allOk ? "committed" : "rejected", refs));
    }
    if (url.pathname === `/api/repos/alice/proj/uploads/${id}` && request.method === "DELETE") {
      requests.push({ method: "DELETE", path: url.pathname, auth });
      return json(200, view("rejected"));
    }
    return json(404, { code: "not_found" });
  };
  return { fetch: fetchImpl as typeof fetch, requests, stored };
}

export function deps(
  git: FakeGit,
  files: FakeFiles,
  server: FakeServer | undefined,
  env: Record<string, string | undefined> = {},
): PushDeps & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    git,
    files,
    fetch:
      server?.fetch ??
      (async () => {
        throw new Error("no server in this test");
      }),
    env,
    log: (line) => out.push(line),
    error: (line) => err.push(line),
    sleep: async () => {},
    randomId: () => "idem-key",
    out,
    err,
  };
}
