import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { concatBytes } from "../../src/object/bytes.js";
import { type Oid, oidFromHex } from "../../src/object/oid.js";
import { rangeStreamFromStore } from "../../src/pack-write/verbatim.js";
import { PktLineReader } from "../../src/protocol/pktline.js";
import { decodeSidebandPacket } from "../../src/protocol/sideband.js";
import type { FetchArgs } from "../../src/protocol/v2-command.js";
import type { FetchPlan, FetchPlanOptions } from "../../src/upload-pack/fetch.js";
import { planFetch } from "../../src/upload-pack/fetch.js";
import { renderFetchResponse } from "../../src/upload-pack/response.js";
import {
  type ExportOptions,
  exportUploadPackRepo,
} from "../../testing/ext-transport/upload-pack-export.js";
import { uploadPackRemote } from "../../testing/ext-transport/upload-pack-remote.js";
import {
  type LoadedUploadPackRepo,
  openUploadPackRepo,
} from "../../testing/ext-transport/upload-pack-repo.js";
import { createGitSandbox, type GitResult, type GitSandbox } from "../../testing/git-cli.js";

/** Sandboxes and directories made by a test, removed by `cleanup`. */
export class Scratch {
  readonly #disposers: (() => Promise<void>)[] = [];

  async sandbox(): Promise<GitSandbox> {
    const sandbox = await createGitSandbox();
    this.#disposers.push(() => sandbox.dispose());
    return sandbox;
  }

  async dir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "fyrden-upload-pack-"));
    this.#disposers.push(() => rm(dir, { recursive: true, force: true }));
    return dir;
  }

  async cleanup(): Promise<void> {
    for (const dispose of this.#disposers.splice(0)) await dispose();
  }
}

let clock = 0;

/** A source repository on branch `main`. */
export async function sourceRepo(scratch: Scratch): Promise<GitSandbox> {
  const repo = await scratch.sandbox();
  await repo.git(["init", "-q", "-b", "main"]);
  return repo;
}

/**
 * Writes files (null deletes one) and commits them. Each commit gets its own
 * date, one day after the previous one unless `date` (seconds) is given.
 */
export async function commit(
  repo: GitSandbox,
  files: Readonly<Record<string, string | null>>,
  message: string,
  options: { date?: number; allowEmpty?: boolean } = {},
): Promise<string> {
  for (const [path, content] of Object.entries(files)) {
    const full = join(repo.dir, path);
    if (content === null) await rm(full, { force: true });
    else {
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, content);
    }
  }
  await repo.git(["add", "-A"]);
  const date = `${options.date ?? 1_767_225_600 + ++clock * 86_400} +0000`;
  await repo.git(
    ["commit", "-q", ...(options.allowEmpty ? ["--allow-empty"] : []), "-m", message],
    {
      env: { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    },
  );
  return (await repo.git(["rev-parse", "HEAD"])).stdout.trim();
}

/** Exports `repo` into a fresh repository directory for the test server. */
export async function serve(
  scratch: Scratch,
  repo: GitSandbox,
  options?: ExportOptions,
): Promise<string> {
  const dir = await scratch.dir();
  await exportUploadPackRepo(repo, dir, options);
  return dir;
}

/** Runs git in `cwd` (default: the sandbox) against the test server for `dir`. */
export async function gitRemote(
  client: GitSandbox,
  dir: string,
  build: (url: string) => string[],
  options: {
    cwd?: string;
    framing?: "transport" | "stored";
    protocol?: 0 | 2;
    trace?: boolean;
  } = {},
): Promise<GitResult> {
  const remote = uploadPackRemote(dir, options);
  return client.git([...remote.config, ...build(remote.url)], {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    env: { ...remote.env, ...(options.trace ? { GIT_TRACE_PACKET: "1" } : {}) },
  });
}

/** Points the clone's `origin` at the test server for `dir`. */
export async function setOrigin(client: GitSandbox, cwd: string, dir: string): Promise<void> {
  const remote = uploadPackRemote(dir);
  await client.git(["remote", "set-url", "origin", remote.url], { cwd });
}

/** `git rev-list --objects --all`: the oids, sorted. */
export async function objectSet(repo: GitSandbox, cwd = repo.dir): Promise<string[]> {
  const { stdout } = await repo.git(["rev-list", "--objects", "--all"], { cwd });
  return stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => line.slice(0, 40))
    .sort();
}

/** The clone's `.git/shallow`, sorted (empty when not shallow). */
export async function shallowFile(cwd: string): Promise<string[]> {
  try {
    return (await readFile(join(cwd, ".git/shallow"), "utf8"))
      .split("\n")
      .filter((line) => line.length > 0)
      .sort();
  } catch {
    return [];
  }
}

/** `git fsck --full --strict` must pass with nothing dangling or missing to report. */
export async function fsck(repo: GitSandbox, cwd: string): Promise<string> {
  const { stdout, stderr } = await repo.git(["fsck", "--full", "--strict", "--no-dangling"], {
    cwd,
  });
  return stdout + stderr;
}

/** The same operation run by stock git against the source over `file://`, protocol v2. */
export async function oracle(
  client: GitSandbox,
  source: GitSandbox,
  args: (url: string) => string[],
  cwd?: string,
): Promise<GitResult> {
  return client.git(["-c", "protocol.version=2", ...args(`file://${source.dir}`)], {
    ...(cwd ? { cwd } : {}),
  });
}

export const hexOid = (hex: string): Oid => oidFromHex(hex);

/** A fetch request with defaults: nothing but the given fields. */
export function fetchArgs(overrides: Partial<FetchArgs>): FetchArgs {
  return {
    wants: [],
    haves: [],
    done: true,
    thinPack: false,
    noProgress: true,
    includeTag: false,
    ofsDelta: true,
    shallow: [],
    deepen: undefined,
    deepenRelative: false,
    deepenSince: undefined,
    deepenNot: [],
    ...overrides,
  };
}

/** Plans a fetch against a loaded directory and renders the exact response bytes. */
export async function planAndRender(
  loaded: LoadedUploadPackRepo,
  args: FetchArgs,
  options: FetchPlanOptions = { framing: "transport" },
): Promise<{ plan: FetchPlan; bytes: Uint8Array }> {
  const plan = await planFetch(loaded.repository, args, options);
  const parts: Uint8Array[] = [];
  for await (const chunk of renderFetchResponse(
    plan.parts,
    rangeStreamFromStore(loaded.packStore),
  )) {
    parts.push(new Uint8Array(chunk));
  }
  return { plan, bytes: concatBytes(parts) };
}

export { openUploadPackRepo };

export interface ParsedFetchResponse {
  readonly acknowledgments?: readonly string[];
  readonly ready: boolean;
  readonly shallowInfo?: readonly string[];
  /** The pack bytes from side-band 1, when there was a packfile section. */
  readonly pack?: Uint8Array;
  readonly progress: string;
}

/** Reads a protocol v2 fetch response section by section (gitprotocol-v2, "fetch"). */
export function parseFetchResponse(bytes: Uint8Array): ParsedFetchResponse {
  const reader = new PktLineReader(bytes, { maxLines: 10_000_000, maxBytes: 2 ** 40 });
  const text = (data: Uint8Array) => Buffer.from(data).toString("latin1").replace(/\n$/, "");
  let acknowledgments: string[] | undefined;
  let shallowInfo: string[] | undefined;
  let ready = false;
  let progress = "";
  const pack: Uint8Array[] = [];
  let sawPack = false;
  for (;;) {
    const header = reader.read();
    if (header === undefined) throw new Error("response ended without a flush");
    if (header.kind === "flush") break;
    if (header.kind !== "data") throw new Error(`unexpected ${header.kind} packet`);
    const name = text(header.data);
    const lines: string[] = [];
    let end: string;
    for (;;) {
      const pkt = reader.read();
      if (pkt === undefined) throw new Error(`section ${name} not terminated`);
      if (pkt.kind !== "data") {
        end = pkt.kind;
        break;
      }
      if (name === "packfile") {
        const frame = decodeSidebandPacket(pkt.data);
        if (frame.band === 1) pack.push(frame.payload);
        else if (frame.band === 2) progress += text(frame.payload);
        else throw new Error(`band 3: ${text(frame.payload)}`);
      } else lines.push(text(pkt.data));
    }
    if (name === "acknowledgments") {
      ready = lines.includes("ready");
      acknowledgments = lines.filter((line) => line !== "ready");
    } else if (name === "shallow-info") shallowInfo = lines;
    else if (name === "packfile") sawPack = true;
    else throw new Error(`unknown section ${name}`);
    if (end === "flush") break;
    if (end !== "delim") throw new Error(`section ${name} ended by ${end}`);
  }
  if (reader.read() !== undefined) throw new Error("bytes after the final flush");
  return {
    ...(acknowledgments ? { acknowledgments } : {}),
    ready,
    ...(shallowInfo ? { shallowInfo } : {}),
    ...(sawPack ? { pack: concatBytes(pack) } : {}),
    progress,
  };
}
