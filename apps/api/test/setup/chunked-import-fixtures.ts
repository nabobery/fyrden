// Global setup (runs in Node, once per test run) for the chunked upload and
// import tests:
//
// - a commit with one incompressible file of 5.5 MiB and the pack `git push`
//   would send for it, so a chunked upload with 5 MiB parts has two parts;
// - a source repository (and a second one with a 6 MiB file and a delta
//   against it), and the protocol v2 exchange Fyrden's import client
//   has with git's own `upload-pack --stateless-rpc` for it (what
//   `git http-backend` runs), recorded so the workerd import tests replay
//   real server bytes.
//
// Uses the git on PATH (or FYRDEN_GIT_BINARY), no user or system config,
// fixed identities and dates, and seeded file contents.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ClientRequest, type HttpTransport, SmartHttpClient } from "@fyrden/git-core";
import type { TestProject } from "vitest/node";
import { IMPORT_REF_PREFIXES, selectImportRefs } from "../../src/git/import/refs.js";
import type { ChunkedFixtures, RecordedExchange } from "../helpers/chunked-fixtures.js";
import { toHex } from "../helpers/git-oracle.js";

const gitBinary = process.env.FYRDEN_GIT_BINARY ?? "git";

function gitEnv(home: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Fyrden Test",
    GIT_AUTHOR_EMAIL: "test@fyrden.invalid",
    GIT_COMMITTER_NAME: "Fyrden Test",
    GIT_COMMITTER_EMAIL: "test@fyrden.invalid",
    GIT_AUTHOR_DATE: "2026-03-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-03-01T00:00:00Z",
  };
}

function gitIn(dir: string, home: string) {
  return (args: string[], input?: string): Buffer => {
    const result = spawnSync(gitBinary, args, {
      cwd: dir,
      env: gitEnv(home) as unknown as NodeJS.ProcessEnv,
      ...(input === undefined ? {} : { input }),
      maxBuffer: 64 * 1024 * 1024,
    });
    if (result.status !== 0)
      throw new Error(`git ${args.join(" ")} failed (${result.status}): ${result.stderr}`);
    return result.stdout;
  };
}

/** Seeded bytes that do not compress (xorshift32). */
function noise(length: number, seed: number): Buffer {
  const out = Buffer.alloc(length);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

/** git's upload-pack as the server, without HTTP: what http-backend runs per request. */
function uploadPackTransport(
  repoDir: string,
  home: string,
  log: RecordedExchange[],
): HttpTransport {
  const run = (args: string[], input: Uint8Array) =>
    new Promise<Buffer>((resolve, reject) => {
      const child = spawn(gitBinary, ["upload-pack", ...args, repoDir], {
        env: { ...gitEnv(home), GIT_PROTOCOL: "version=2" } as unknown as NodeJS.ProcessEnv,
      });
      const out: Buffer[] = [];
      child.stdout.on("data", (d: Buffer) => out.push(d));
      child.on("error", reject);
      child.on("close", () => resolve(Buffer.concat(out)));
      // git may exit without reading its input (an advertisement does).
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    });
  return async (request: ClientRequest) => {
    const get = request.method === "GET";
    const body = await run(
      get ? ["--stateless-rpc", "--advertise-refs"] : ["--stateless-rpc"],
      request.body ?? new Uint8Array(0),
    );
    log.push({
      method: request.method,
      request: toHex(request.body ?? new Uint8Array(0)),
      response: toHex(body),
    });
    return {
      status: 200,
      contentType: get
        ? "application/x-git-upload-pack-advertisement"
        : "application/x-git-upload-pack-result",
      body: (async function* () {
        yield new Uint8Array(body);
      })(),
      cancel: async () => {},
    };
  };
}

/** The import client's exchange with git's upload-pack for `repoDir`, recorded. */
async function recordImport(repoDir: string, home: string): Promise<RecordedExchange[]> {
  const exchanges: RecordedExchange[] = [];
  const client = await SmartHttpClient.connect({
    transport: uploadPackTransport(repoDir, home, exchanges),
    url: "https://source.invalid/source.git",
    agent: "fyrden",
  });
  const selection = selectImportRefs(
    await client.lsRefs({ prefixes: IMPORT_REF_PREFIXES, symrefs: true }),
  );
  await client.fetchPack(selection.wants, { write: () => {} });
  return exchanges;
}

export default async function setup(project: TestProject): Promise<() => void> {
  const root = mkdtempSync(join(tmpdir(), "fyrden-chunked-fixtures-"));
  const work = join(root, "big");
  spawnSync(gitBinary, ["init", "-q", "-b", "main", work]);
  const big = gitIn(work, root);
  writeFileSync(join(work, "noise.bin"), noise(5.5 * 1024 * 1024, 20261011));
  big(["add", "noise.bin"]);
  big(["commit", "-q", "-m", "a large file"]);
  const bigCommit = big(["rev-parse", "HEAD"]).toString("utf8").trim();
  const bigPack = toHex(big(["pack-objects", "--stdout", "--revs", "-q"], `${bigCommit}\n`));

  // The import source: two branches, an annotated tag, a ref outside
  // heads/tags, and a branch whose name is not UTF-8 (in packed-refs, the
  // only place every file system can hold it).
  const src = join(root, "source");
  spawnSync(gitBinary, ["init", "-q", "-b", "trunk", src]);
  const git = gitIn(src, root);
  const text = (args: string[]) => git(args).toString("utf8").trim();
  for (const [file, body] of [
    ["a.txt", "alpha\n"],
    ["b.txt", "beta\n"],
    ["a.txt", "alpha\ngamma\n"],
  ] as const) {
    writeFileSync(join(src, file), body);
    git(["add", file]);
    git(["commit", "-q", "-m", `edit ${file}`]);
  }
  git(["tag", "-a", "v1.0", "-m", "release", "HEAD~1"]);
  git(["branch", "feature", "HEAD~2"]);
  git(["update-ref", "refs/pull/1/head", "HEAD~1"]);
  git(["pack-refs", "--all"]);
  const trunk = text(["rev-parse", "trunk"]);
  const packedFile = join(src, ".git", "packed-refs");
  const [header, ...lines] = readFileSync(packedFile, "latin1").trimEnd().split("\n");
  const records: string[][] = [];
  for (const line of lines) {
    if (line.startsWith("^")) records.at(-1)?.push(line);
    else records.push([line]);
  }
  records.push([`${trunk} refs/heads/caf\xe9`]);
  const nameOf = (r: string[]) => (r[0] as string).slice(41);
  records.sort((a, b) => (nameOf(a) < nameOf(b) ? -1 : 1));
  writeFileSync(packedFile, `${[header, ...records.flat()].join("\n")}\n`, "latin1");

  const exchanges = await recordImport(join(src, ".git"), root);

  // A source whose pack needs several MiB of the indexing memory pool: a
  // 6 MiB incompressible file, and a second commit that appends to it (a
  // delta against the first version).
  const large = join(root, "large-source");
  spawnSync(gitBinary, ["init", "-q", "-b", "main", large]);
  const lg = gitIn(large, root);
  const largeFile = noise(6 * 1024 * 1024, 20261012);
  writeFileSync(join(large, "large.bin"), largeFile);
  lg(["add", "large.bin"]);
  lg(["commit", "-q", "-m", "a large file"]);
  writeFileSync(join(large, "large.bin"), Buffer.concat([largeFile, Buffer.from("more\n")]));
  lg(["add", "large.bin"]);
  lg(["commit", "-q", "-m", "append"]);
  const largeExchanges = await recordImport(join(large, ".git"), root);

  const fixtures: ChunkedFixtures = {
    bigCommit,
    bigPack,
    source: {
      exchanges,
      refs: Object.fromEntries(
        text(["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/", "refs/tags/"])
          .split("\n")
          .map((line) => line.split(" ") as [string, string])
          .filter(([name]) => /^[\x20-\x7e]+$/.test(name)),
      ),
      head: "refs/heads/trunk",
    },
    largeSource: {
      exchanges: largeExchanges,
      main: lg(["rev-parse", "main"]).toString("utf8").trim(),
    },
  };
  project.provide("chunkedFixtures", fixtures);
  return () => rmSync(root, { recursive: true, force: true });
}
