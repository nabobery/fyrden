/*
 * `fyrden push [--chunked] [--force] [--body-limit <bytes>] <remote> <refspec...>`
 *
 * Makes the pack `git push` would send (`git pack-objects --revs --thin`
 * against the remote's refs from `git ls-remote`) and checks its size
 * first. Cloudflare refuses a request body above the plan's limit with its
 * own 413 before Fyrden runs (104,857,600 bytes on Free and Pro, measured
 * 2026-10-10), so a push above it cannot work: without --chunked the
 * command stops and says so; under it, it runs `git push` itself. With
 * --chunked the pack goes up through the upload session API in parts, each
 * part a request under the limit, retried on failure; completing the
 * session indexes, checks and commits it as a push.
 */

/** The request body limit on Cloudflare Free and Pro (measured on Workers Free, 2026-10-10). */
export const DEFAULT_BODY_LIMIT = 104_857_600;

const OID = /^[0-9a-f]{40}$/;
/** Attempts per part before giving up. */
const PART_ATTEMPTS = 5;
/** First retry delay; doubles per attempt. */
const RETRY_MS = 1_000;
/** Part refusals another try can fix. */
const RETRY_CODES = new Set(["part_not_stored", "part_in_progress", "part_superseded"]);
/** Longest the command keeps calling complete while the server indexes. */
const COMPLETE_TIMEOUT_MS = 60 * 60 * 1000;
const COMPLETE_POLL_MS = 2_000;

/** Variables added to one git call's environment. */
export type GitEnv = Readonly<Record<string, string>>;

export interface GitRunner {
  /** Runs git and resolves its stdout; rejects when git fails. */
  run(args: string[], input?: string, env?: GitEnv): Promise<string>;
  /** Runs git; resolves whether it succeeded and its stdout. */
  tryRun(args: string[], input?: string, env?: GitEnv): Promise<{ ok: boolean; stdout: string }>;
  /** Runs `git pack-objects <args>` with `revs` on stdin, its stdout written to `path`; resolves the length. */
  packObjects(args: string[], revs: string, path: string): Promise<number>;
  /** Runs git attached to the terminal; resolves its exit code. */
  passthrough(args: string[], env?: GitEnv): Promise<number>;
}

export interface PackFiles {
  tempPath(): Promise<string>;
  read(path: string, offset: number, length: number): Promise<Uint8Array>;
  remove(path: string): Promise<void>;
}

export interface PushDeps {
  readonly git: GitRunner;
  readonly files: PackFiles;
  readonly fetch: typeof fetch;
  readonly env: Record<string, string | undefined>;
  log(line: string): void;
  error(line: string): void;
  sleep(ms: number): Promise<void>;
  randomId(): string;
}

export interface PushArgs {
  readonly remote: string;
  readonly refspecs: readonly string[];
  readonly chunked: boolean;
  readonly force: boolean;
  readonly bodyLimit: number;
}

export const PUSH_USAGE =
  "fyrden push [--chunked] [--force] [--body-limit <bytes>] <remote> <refspec...>";

export function parsePushArgs(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): PushArgs | { error: string } {
  let chunked = false;
  let force = false;
  let bodyLimit = positive(env.FYRDEN_PUSH_BODY_LIMIT) ?? DEFAULT_BODY_LIMIT;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--chunked") chunked = true;
    else if (arg === "--force" || arg === "-f") force = true;
    else if (arg === "--body-limit") {
      const value = positive(argv[++i]);
      if (value === undefined) return { error: "--body-limit needs a number of bytes" };
      bodyLimit = value;
    } else if (arg.startsWith("-")) return { error: `unknown option ${arg}` };
    else rest.push(arg);
  }
  const [remote, ...refspecs] = rest;
  if (!remote || refspecs.length === 0) return { error: `usage: ${PUSH_USAGE}` };
  return { remote, refspecs, chunked, force, bodyLimit };
}

function positive(text: string | undefined): number | undefined {
  if (text === undefined || !/^\d{1,16}$/.test(text)) return undefined;
  const value = Number(text);
  return value > 0 ? value : undefined;
}

class PushError extends Error {}

interface Update {
  readonly spec: string;
  readonly src: string;
  readonly ref: string;
  readonly old: string | null;
  readonly new: string | null;
  readonly force: boolean;
}

interface Status {
  readonly flag: string;
  readonly summary: string;
  readonly detail?: string;
}

/** `fyrden push`; resolves the exit code. */
export async function push(args: PushArgs, deps: PushDeps): Promise<number> {
  try {
    return await run(args, deps);
  } catch (error) {
    if (!(error instanceof PushError)) throw error;
    deps.error(`fyrden: ${error.message}`);
    return 1;
  }
}

async function run(args: PushArgs, deps: PushDeps): Promise<number> {
  const { git } = deps;
  const url = await pushUrl(git, args.remote);
  // A token we hold goes to git through a helper, so the URL git is given
  // carries no credentials; without one, git's own helpers answer.
  const token = knownToken(deps, url);
  const auth = token === undefined ? undefined : gitAuth(url, token);
  const target = auth ? redacted(url) : url.href;
  const remoteRefs = await lsRemote(git, target, auth);
  const updates: Update[] = [];
  for (const spec of args.refspecs)
    updates.push(await resolveSpec(git, spec, remoteRefs, args.force));

  const pending = updates.filter((u) => u.old !== u.new);
  if (pending.length === 0) {
    deps.error("Everything up-to-date");
    return 0;
  }
  // Refused locally as git refuses them: the server's compare-and-set would too.
  const refusals = new Map<Update, Status>();
  for (const update of pending) {
    const refusal = await localRefusal(git, update);
    if (refusal) refusals.set(update, refusal);
  }
  if (refusals.size > 0) {
    printStatuses(
      deps,
      url,
      pending.map((u) => [
        u,
        refusals.get(u) ?? { flag: "!", summary: "[rejected]", detail: "atomic push failed" },
      ]),
    );
    return 1;
  }

  // A remote name keeps every remote.<name>.* setting git push applies; a URL
  // is passed without the credentials it may carry.
  const destination = args.remote.includes("://") ? target : args.remote;
  const passthrough = () =>
    git.passthrough(
      [
        ...(auth?.config ?? []),
        "push",
        ...(args.force ? ["--force"] : []),
        destination,
        ...args.refspecs,
      ],
      auth?.env,
    );
  // Deletions need no pack: git push sends them in a few bytes.
  if (pending.every((u) => u.new === null)) return passthrough();

  const path = await deps.files.tempPath();
  try {
    const size = await makePack(git, pending, remoteRefs, path);
    const body = size + commandSectionBytes(pending);
    if (!args.chunked) {
      if (body > args.bodyLimit) {
        throw new PushError(
          `this push needs a request of about ${body} bytes, larger than the server's request body limit of ${args.bodyLimit} bytes (Cloudflare refuses larger requests before Fyrden sees them). Push it with \`fyrden push --chunked ${args.remote} ${args.refspecs.join(" ")}\`, or push fewer commits at a time.`,
        );
      }
      await deps.files.remove(path);
      return passthrough();
    }
    const outcome = await uploadChunked(deps, url, token, path, size, pending);
    printStatuses(
      deps,
      url,
      pending.map((u) => [u, statusOf(u, outcome)]),
    );
    return outcome.every((r) => r.status === "ok") && outcome.length === pending.length ? 0 : 1;
  } finally {
    await deps.files.remove(path).catch(() => {});
  }
}

/**
 * Where `git push <remote>` sends: `remote.<name>.pushurl`, else its url,
 * each rewritten by pushInsteadOf/insteadOf as git push rewrites them.
 * Discovery, the size check and the upload all use this one URL.
 */
async function pushUrl(git: GitRunner, remote: string): Promise<URL> {
  let text = remote;
  if (!remote.includes("://")) {
    const configured = await git.tryRun(["remote", "get-url", "--push", "--all", remote]);
    if (!configured.ok) throw new PushError(`no remote named ${remote}`);
    const urls = configured.stdout.split("\n").filter((line) => line.trim() !== "");
    if (urls.length !== 1)
      throw new PushError(
        `remote ${remote} has ${urls.length} push URLs, and fyrden push sends to one; name the URL to push to instead of the remote`,
      );
    text = (urls[0] as string).trim();
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new PushError("the remote must be an https:// URL to a Fyrden repository");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new PushError("the remote must be an https:// URL to a Fyrden repository");
  return url;
}

async function lsRemote(
  git: GitRunner,
  url: string,
  auth: GitAuth | undefined,
): Promise<Map<string, string>> {
  const refs = new Map<string, string>();
  const out = await git.run([...(auth?.config ?? []), "ls-remote", url], undefined, auth?.env);
  for (const line of out.split("\n")) {
    const [oid, name] = line.split("\t");
    if (oid && name && OID.test(oid)) refs.set(name, oid);
  }
  return refs;
}

async function resolveSpec(
  git: GitRunner,
  spec: string,
  remoteRefs: Map<string, string>,
  forceAll: boolean,
): Promise<Update> {
  const force = forceAll || spec.startsWith("+");
  const body = spec.startsWith("+") ? spec.slice(1) : spec;
  const colon = body.indexOf(":");
  const src = colon < 0 ? body : body.slice(0, colon);
  let dst = colon < 0 ? "" : body.slice(colon + 1);
  let newOid: string | null = null;
  let srcFull = "";
  if (src !== "") {
    const rev = await git.tryRun(["rev-parse", "--verify", "--quiet", src]);
    newOid = rev.stdout.trim();
    if (!rev.ok || !OID.test(newOid)) throw new PushError(`src refspec ${src} does not match any`);
    srcFull = (await git.tryRun(["rev-parse", "--symbolic-full-name", src])).stdout.trim();
  }
  if (dst === "") {
    if (!srcFull.startsWith("refs/"))
      throw new PushError(`the destination of ${spec} must be named (${src}:refs/heads/<name>)`);
    dst = srcFull;
  } else if (!dst.startsWith("refs/")) {
    dst = srcFull.startsWith("refs/tags/") ? `refs/tags/${dst}` : `refs/heads/${dst}`;
  }
  return { spec, src, ref: dst, old: remoteRefs.get(dst) ?? null, new: newOid, force };
}

async function localRefusal(git: GitRunner, u: Update): Promise<Status | undefined> {
  if (u.old === null || u.new === null || u.force) return undefined;
  const reject = (detail: string): Status => ({ flag: "!", summary: "[rejected]", detail });
  if (u.ref.startsWith("refs/tags/")) return reject("already exists");
  if (!(await present(git, [u.old])).has(u.old)) return reject("fetch first");
  const ff = await git.tryRun(["merge-base", "--is-ancestor", u.old, u.new]);
  return ff.ok ? undefined : reject("non-fast-forward");
}

async function present(git: GitRunner, oids: readonly string[]): Promise<Set<string>> {
  if (oids.length === 0) return new Set();
  const out = await git.run(["cat-file", "--batch-check"], `${oids.join("\n")}\n`);
  const found = new Set<string>();
  for (const line of out.split("\n")) {
    const [oid, type] = line.split(" ");
    if (oid && type && type !== "missing") found.add(oid);
  }
  return found;
}

/** The pack `git push` sends: new tips, less what the remote's refs reach (thin, as send-pack makes it). */
async function makePack(
  git: GitRunner,
  updates: readonly Update[],
  remoteRefs: Map<string, string>,
  path: string,
): Promise<number> {
  const haves = await present(git, [...new Set(remoteRefs.values())]);
  const revs = [
    ...new Set(updates.flatMap((u) => (u.new === null ? [] : [u.new]))),
    ...[...haves].map((oid) => `^${oid}`),
  ];
  return git.packObjects(
    ["--stdout", "--revs", "--thin", "--delta-base-offset", "-q"],
    `${revs.join("\n")}\n`,
    path,
  );
}

/** Bytes of the receive-pack command section for `updates`, with git's usual capability list. */
function commandSectionBytes(updates: readonly Update[]): number {
  const caps = 120;
  return updates.reduce((n, u) => n + 4 + 82 + new TextEncoder().encode(u.ref).length, 4 + caps);
}

interface RefOutcome {
  readonly ref: string;
  readonly status: "ok" | "rejected";
  readonly reason?: string;
}

interface Session {
  readonly id: string;
  readonly state: string;
  readonly part_size: number;
  readonly part_count: number;
  readonly parts_received: number[];
  readonly parts_url: string;
  readonly refs?: RefOutcome[];
  readonly error?: string;
}

async function uploadChunked(
  deps: PushDeps,
  url: URL,
  known: string | undefined,
  path: string,
  size: number,
  updates: readonly Update[],
): Promise<RefOutcome[]> {
  const token = known ?? (await helperToken(deps, url));
  const segments = url.pathname.split("/").filter((s) => s !== "");
  if (segments.length !== 2)
    throw new PushError(
      `${redacted(url)} is not a Fyrden repository URL (https://<host>/<owner>/<repo>.git)`,
    );
  const [owner, repoGit] = segments as [string, string];
  const repo = repoGit.replace(/\.git$/, "");
  const api = `${url.origin}/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/uploads`;
  const call = async (method: string, target: string, body?: unknown): Promise<Session> => {
    const response = await deps.fetch(target, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(method === "GET" ? {} : { "Idempotency-Key": deps.randomId() }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = (await response.json().catch(() => ({}))) as Session & { detail?: string };
    if (!response.ok)
      throw new PushError(
        `the server refused the upload (HTTP ${response.status}): ${json.detail ?? "no detail"}`,
      );
    return json;
  };

  let session = await call("POST", api, {
    size,
    ref_updates: updates.map((u) => ({ ref: u.ref, old: u.old, new: u.new })),
  });
  deps.error(`Uploading ${size} bytes in ${session.part_count} parts (upload ${session.id})`);
  const basic = `Basic ${btoa(`fyrden:${token}`)}`;
  const received = new Set(session.parts_received);
  for (let n = 1; n <= session.part_count; n++) {
    if (received.has(n)) continue;
    const offset = (n - 1) * session.part_size;
    const bytes = await deps.files.read(path, offset, Math.min(session.part_size, size - offset));
    for (let attempt = 1; ; attempt++) {
      const failure = await putPart(deps, `${url.origin}${session.parts_url}/${n}`, basic, bytes);
      if (failure === undefined) break;
      if (!failure.retry || attempt >= PART_ATTEMPTS)
        throw new PushError(`part ${n} could not be uploaded: ${failure.message}`);
      await deps.sleep(failure.retryAfterMs ?? RETRY_MS * 2 ** (attempt - 1));
      // Resume from what the server holds (the part may have arrived after all).
      session = await call("GET", `${api}/${session.id}`);
      if (session.parts_received.includes(n)) break;
    }
  }
  const started = Date.now();
  for (;;) {
    session = await call("POST", `${api}/${session.id}/complete`);
    if (session.state !== "indexing") break;
    if (Date.now() - started > COMPLETE_TIMEOUT_MS)
      throw new PushError(`the server is still indexing upload ${session.id}; check it later`);
    await deps.sleep(COMPLETE_POLL_MS);
  }
  if (session.state !== "committed" && !session.refs?.length)
    throw new PushError(`the upload was ${session.state}: ${session.error ?? "no detail"}`);
  return session.refs ?? [];
}

async function putPart(
  deps: PushDeps,
  target: string,
  auth: string,
  bytes: Uint8Array,
): Promise<{ retry: boolean; message: string; retryAfterMs?: number } | undefined> {
  let response: Response;
  try {
    response = await deps.fetch(target, {
      method: "PUT",
      headers: { Authorization: auth, "Content-Length": String(bytes.length) },
      body: bytes,
    });
  } catch (error) {
    return { retry: true, message: error instanceof Error ? error.message : String(error) };
  }
  if (response.ok) {
    await response.body?.cancel();
    return undefined;
  }
  const json = (await response.json().catch(() => ({}))) as { code?: string; detail?: string };
  const retryAfter = Number(response.headers.get("Retry-After"));
  return {
    // Server errors, rate limits, a part the store did not take and a part
    // another request was uploading meanwhile are worth another try.
    retry:
      response.status >= 500 ||
      response.status === 429 ||
      (json.code !== undefined && RETRY_CODES.has(json.code)),
    message: `HTTP ${response.status} ${json.detail ?? ""}`.trim(),
    ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterMs: retryAfter * 1000 } : {}),
  };
}

/** The token the command holds itself: `FYRDEN_TOKEN`, else the push URL's password. */
function knownToken(deps: PushDeps, url: URL): string | undefined {
  if (deps.env.FYRDEN_TOKEN) return deps.env.FYRDEN_TOKEN;
  if (url.password) return decodeURIComponent(url.password);
  return undefined;
}

/** The environment variable the per-call credential helper reads the token from. */
const CREDENTIAL_VAR = "FYRDEN_GIT_CREDENTIAL";

export interface GitAuth {
  /** `-c` options to put before the git command. */
  readonly config: readonly string[];
  readonly env: GitEnv;
}

/**
 * Git options that answer credential requests for `url`'s origin with
 * `token`, for one call. The helper reads the token from that call's
 * environment, so it is never in a URL or argv. The empty `credential.helper`
 * first clears every configured helper for the call, so none is asked and
 * none stores the token; the helper is scoped to the origin, so a redirect
 * to another host gets nothing.
 */
export function gitAuth(url: URL, token: string): GitAuth {
  const helper = `!f() { test "$1" = get && printf 'username=fyrden\\npassword=%s\\n' "$${CREDENTIAL_VAR}"; }; f`;
  return {
    config: ["-c", "credential.helper=", "-c", `credential.${url.origin}.helper=${helper}`],
    env: { [CREDENTIAL_VAR]: token },
  };
}

/** The token git's credential helpers have for `url`. */
async function helperToken(deps: PushDeps, url: URL): Promise<string> {
  const out = await deps.git.tryRun(
    ["credential", "fill"],
    `protocol=${url.protocol.replace(":", "")}\nhost=${url.host}\npath=${url.pathname.replace(/^\//, "")}\n\n`,
  );
  const password = out.stdout.split("\n").find((l) => l.startsWith("password="));
  if (!out.ok || !password) throw new PushError(`no credentials for ${url.host}; set FYRDEN_TOKEN`);
  return password.slice("password=".length);
}

function statusOf(u: Update, outcome: readonly RefOutcome[]): Status {
  const result = outcome.find((r) => r.ref === u.ref);
  if (result?.status !== "ok")
    return { flag: "!", summary: "[rejected]", detail: result?.reason ?? "atomic push failed" };
  if (u.new === null) return { flag: "-", summary: "[deleted]" };
  if (u.old === null)
    return { flag: "*", summary: u.ref.startsWith("refs/tags/") ? "[new tag]" : "[new branch]" };
  const range = `${u.old.slice(0, 7)}${u.force ? "..." : ".."}${u.new.slice(0, 7)}`;
  return u.force
    ? { flag: "+", summary: range, detail: "forced update" }
    : { flag: " ", summary: range };
}

function shortName(ref: string): string {
  for (const prefix of ["refs/heads/", "refs/tags/"])
    if (ref.startsWith(prefix)) return ref.slice(prefix.length);
  return ref;
}

/** Lines as git prints them (transport.c `print_ref_status`, summary width 17). */
function printStatuses(deps: PushDeps, url: URL, statuses: readonly [Update, Status][]): void {
  deps.log(`To ${redacted(url)}`);
  for (const [u, s] of statuses) {
    const names = `${u.src === "" ? "(delete)" : u.src} -> ${shortName(u.ref)}`;
    deps.log(` ${s.flag} ${s.summary.padEnd(17)} ${names}${s.detail ? ` (${s.detail})` : ""}`);
  }
}

/** The URL without user name or password: a token in the remote URL is never printed. */
function redacted(url: URL): string {
  const shown = new URL(url.href);
  shown.username = "";
  shown.password = "";
  return shown.href;
}
