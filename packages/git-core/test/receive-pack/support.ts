import { oidFromHex } from "../../src/object/oid.js";
import { PackIdx } from "../../src/pack/idx-read.js";
import type { PackId, PackStore } from "../../src/ports/pack-store.js";
import type { RefStore } from "../../src/ports/ref-store.js";
import { chompLf, PktLineReader } from "../../src/protocol/pktline.js";
import { encodeReceivePackRequest } from "../../src/protocol/receive-pack-request.js";
import type { RepoView } from "../../src/reader/view.js";
import { bytesBody } from "../../src/receive-pack/body.js";
import type { FinalizeEnv } from "../../src/receive-pack/finalize.js";
import type { PushIndexEnv } from "../../src/receive-pack/indexer.js";
import { type ReceivePackOutcome, receivePack } from "../../src/receive-pack/receive-pack.js";
import { refStoreCommitter } from "../../src/receive-pack/ref-store-commit.js";
import { createMemoryBudget } from "../../testing/fakes/memory-budget.js";
import {
  createMemoryCommitGraph,
  type MemoryCommitGraph,
} from "../../testing/fakes/memory-commit-graph.js";
import { createMemoryRepoStore } from "../../testing/fakes/memory-repo-store.js";
import type { GitSandbox } from "../../testing/git-cli.js";
import { createNodeZlib } from "../../testing/node-zlib.js";

/** One line of `git push --porcelain`: flag, destination ref and summary (with any reason). */
export interface PushLine {
  readonly flag: string;
  readonly ref: string;
  readonly summary: string;
}

export interface PushRun {
  readonly ok: boolean;
  readonly lines: readonly PushLine[];
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs `git <args>` (a push with --porcelain) and parses its ref lines, accepting failure. */
export async function runPush(sandbox: GitSandbox, args: string[], cwd?: string): Promise<PushRun> {
  try {
    const { stdout, stderr } = await sandbox.git(args, cwd ? { cwd } : {});
    return { ok: true, lines: porcelain(stdout), stdout, stderr };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; code?: number };
    if (e.code !== 1 && e.code !== 128) throw error;
    return {
      ok: false,
      lines: porcelain(e.stdout ?? ""),
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
    };
  }
}

function porcelain(stdout: string): PushLine[] {
  const out: PushLine[] = [];
  for (const line of stdout.split("\n")) {
    const match = /^(.)\t[^\t]*:([^\t]*)\t(.*)$/.exec(line);
    if (match)
      out.push({ flag: match[1] as string, ref: match[2] as string, summary: match[3] as string });
  }
  return out;
}

/**
 * A bare repository that judges pushes as git does with object checking on:
 * `receive.fsckObjects` (every warning is an error), `receive.unpackLimit=1`
 * (always index-pack, as Fyrden always indexes), push options advertised,
 * pull request refs hidden. It lives in `sandbox` and goes with it.
 */
export async function oracleRepo(sandbox: GitSandbox): Promise<string> {
  const dir = await sandbox.tempDir("oracle-");
  await sandbox.git(["init", "-q", "--bare", "-b", "main", dir]);
  for (const [key, value] of [
    ["receive.fsckObjects", "true"],
    ["receive.unpackLimit", "1"],
    ["receive.advertisePushOptions", "true"],
    ["receive.hideRefs", "refs/pull/"],
  ] as const) {
    await sandbox.git(["--git-dir", dir, "config", key, value]);
  }
  return dir;
}

/* In-process pushes against the in-memory port fakes. */

export interface MemoryServer {
  readonly packStore: PackStore;
  readonly refStore: RefStore;
  readonly graph: MemoryCommitGraph;
  readonly idx: Map<PackId, Uint8Array>;
  /** Live packs newest first, as a reader view; `onLookup` sees every idx lookup. */
  view(onLookup?: (packId: PackId, oid: Uint8Array) => void): Promise<RepoView>;
  indexEnv(overrides?: Partial<PushIndexEnv>): Promise<PushIndexEnv>;
  finalizeEnv(overrides?: Partial<FinalizeEnv>): FinalizeEnv;
  /** One push: request bytes in, outcome out. */
  push(body: Uint8Array, options?: PushOptions): Promise<ReceivePackOutcome & { lines: string[] }>;
}

export interface PushOptions {
  readonly uploadId?: string;
  readonly index?: Partial<PushIndexEnv>;
  readonly finalize?: Partial<FinalizeEnv>;
  readonly onCheckpoint?: (cursor: Uint8Array) => void | Promise<void>;
}

let uploads = 0;

export function memoryServer(): MemoryServer {
  const { packStore, refStore } = createMemoryRepoStore();
  const graph = createMemoryCommitGraph();
  const idx = new Map<PackId, Uint8Array>();
  const server: MemoryServer = {
    packStore,
    refStore,
    graph,
    idx,
    async view(onLookup) {
      const live = [...(await packStore.listPacks())].reverse();
      return {
        scope: "test",
        packs: live.map((p) => {
          const parsed = PackIdx.parse(idx.get(p.packId) as Uint8Array);
          return {
            packId: p.packId,
            bytes: p.bytes,
            idx: {
              lookup: (oid: Uint8Array, at?: number) => {
                onLookup?.(p.packId, oid.subarray(at ?? 0, (at ?? 0) + 20));
                return parsed.lookup(oid, at);
              },
              crc32At: (position: number) => parsed.crc32At(position),
            },
          };
        }),
      };
    },
    async indexEnv(overrides = {}) {
      return {
        zlib: createNodeZlib(),
        memory: createMemoryBudget(512 * 1024 * 1024),
        commitGraph: graph,
        packStore,
        beginPack: () => packStore.beginPack(),
        storeIdx: async (packId, bytes) => {
          idx.set(packId, bytes.slice());
        },
        loadIdx: async (packId) => idx.get(packId) as Uint8Array,
        view: await server.view(),
        refStore,
        ...overrides,
      };
    },
    finalizeEnv(overrides = {}) {
      return {
        commitGraph: graph,
        reauthorize: async () => undefined,
        commit: refStoreCommitter(refStore, { onUploadCommitted: (id) => graph.promote(id) }),
        ...overrides,
      };
    },
    async push(body, options = {}) {
      const outcome = await receivePack({
        body: bytesBody(body),
        refs: await refStore.readRefs(),
        uploadId: options.uploadId ?? `upload-${++uploads}`,
        index: await server.indexEnv(options.index),
        finalize: server.finalizeEnv(options.finalize),
        ...(options.onCheckpoint ? { onCheckpoint: options.onCheckpoint } : {}),
      });
      return { ...outcome, lines: reportLines(outcome.response) };
    },
  };
  return server;
}

/** The text lines of a response without side-band (report packets; ERR lines too). */
export function reportLines(response: Uint8Array): string[] {
  const reader = new PktLineReader(response);
  const out: string[] = [];
  for (let pkt = reader.read(); pkt; pkt = reader.read()) {
    if (pkt.kind === "data") out.push(Buffer.from(chompLf(pkt.data)).toString("latin1"));
  }
  return out;
}

export interface Command {
  readonly old?: string;
  readonly new?: string;
  readonly ref: string | Uint8Array;
}

const ZERO = "0".repeat(40);

/** A receive-pack request: commands with report-status, then the pack (if any). */
export function request(
  commands: readonly Command[],
  pack?: Uint8Array,
  options: { capabilities?: string[]; pushOptions?: string[]; shallow?: string[] } = {},
): Uint8Array {
  const caps = [...(options.capabilities ?? ["report-status"])];
  if (options.pushOptions) caps.push("push-options");
  const head = encodeReceivePackRequest({
    shallow: (options.shallow ?? []).map(oidFromHex),
    commands: commands.map((c) => ({
      oldOid: oidFromHex(c.old ?? ZERO),
      newOid: oidFromHex(c.new ?? ZERO),
      refName: typeof c.ref === "string" ? new TextEncoder().encode(c.ref) : c.ref,
    })),
    capabilities: caps.map((token) => {
      const eq = token.indexOf("=");
      return eq < 0 ? { name: token } : { name: token.slice(0, eq), value: token.slice(eq + 1) };
    }),
    pushOptions: options.pushOptions?.map((o) => new TextEncoder().encode(o)),
  });
  return pack ? Buffer.concat([head, pack]) : head;
}

/** Runs `git receive-pack` on `bareDir` with `body` as the request; returns its report lines. */
export async function gitReceivePack(
  sandbox: GitSandbox,
  bareDir: string,
  body: Uint8Array,
): Promise<string[]> {
  const out = await sandbox.gitBytes(["receive-pack", bareDir], { input: body });
  const reader = new PktLineReader(out);
  // Skip the advertisement.
  for (let pkt = reader.read(); pkt && pkt.kind !== "flush"; pkt = reader.read()) {}
  return reportLines(reader.rest());
}

/** Writes objects with `git hash-object -w --literally`; returns their ids. */
export async function writeObject(
  sandbox: GitSandbox,
  type: "commit" | "tree" | "blob" | "tag",
  body: Uint8Array | string,
  gitDir?: string,
): Promise<string> {
  const args = gitDir ? ["--git-dir", gitDir] : [];
  const { stdout } = await sandbox.git(
    [...args, "hash-object", "-w", "--literally", "-t", type, "--stdin"],
    { input: body },
  );
  return stdout.trim();
}

/** A pack holding exactly `oids` (no traversal), as `git pack-objects` writes it. */
export function packOf(sandbox: GitSandbox, oids: readonly string[]): Promise<Uint8Array> {
  const input = oids.length > 0 ? `${oids.join("\n")}\n` : "";
  return sandbox.gitBytes(["pack-objects", "--stdout", "-q"], { input });
}

/** A tree body from (mode, name, oid) entries, in the order given. */
export function treeBody(entries: readonly (readonly [string, string, string])[]): Uint8Array {
  return Buffer.concat(
    entries.map(([mode, name, oid]) =>
      Buffer.concat([Buffer.from(`${mode} ${name}\0`, "latin1"), Buffer.from(oid, "hex")]),
    ),
  );
}

export function commitBody(tree: string, parents: readonly string[] = [], message = "m"): string {
  const lines = [`tree ${tree}`, ...parents.map((p) => `parent ${p}`)];
  return `${lines.join("\n")}\nauthor A <a@b.c> 1700000000 +0000\ncommitter A <a@b.c> 1700000000 +0000\n\n${message}\n`;
}

export function tagBody(object: string, type: string, name = "t"): string {
  return `object ${object}\ntype ${type}\ntag ${name}\ntagger A <a@b.c> 1700000000 +0000\n\nmsg\n`;
}
