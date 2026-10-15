import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FetchClientError,
  type RemoteRef,
  SmartHttpClient,
  withoutTrailingSlashes,
} from "../../src/client/fetch-client.js";
import type { HttpTransport } from "../../src/client/transport.js";
import { latin1 } from "../../src/object/bytes.js";
import { oidFromHex, oidToHex } from "../../src/object/oid.js";
import { ProtocolError } from "../../src/protocol/errors.js";
import { createGitSandbox, type GitSandbox } from "../../testing/git-cli.js";
import {
  nodeFetchTransport,
  startUploadPackServer,
  type UploadPackServer,
} from "./upload-pack-http.js";

/*
 * The smart-HTTP v2 fetch client against git's own upload-pack (behind a
 * tiny HTTP server that does what `git http-backend` does). git is the
 * oracle: `git ls-remote` for the refs, `git index-pack` and `git fsck`
 * for the pack.
 */

let sandbox: GitSandbox;
let repo: string;
let server: UploadPackServer;
const text = async (args: string[]) => (await sandbox.git(args, { cwd: repo })).stdout.trim();

/** A ref name that is not UTF-8 (git accepts any byte above 0x7f in a name). */
const NON_UTF8 = Uint8Array.from([...Buffer.from("refs/heads/caf"), 0xe9]);

beforeAll(async () => {
  sandbox = await createGitSandbox();
  repo = join(sandbox.dir, "src");
  await sandbox.git(["init", "-q", "-b", "main", repo]);
  for (const [file, body] of [
    ["a.txt", "one\n"],
    ["b.txt", "two\n"],
    ["a.txt", "one\nthree\n"],
  ] as const) {
    await writeFile(join(repo, file), body);
    await sandbox.git(["add", file], { cwd: repo });
    await sandbox.git(["commit", "-q", "-m", `edit ${file}`], { cwd: repo });
  }
  await sandbox.git(["tag", "-a", "v1", "-m", "release", "HEAD~1"], { cwd: repo });
  await sandbox.git(["branch", "side", "HEAD~2"], { cwd: repo });
  // A packed ref whose name is not UTF-8: only packed-refs can hold it on every file system.
  const head = await text(["rev-parse", "HEAD"]);
  await sandbox.git(["pack-refs", "--all"], { cwd: repo });
  // packed-refs is sorted by name (git relies on it), peeled `^` lines after their ref.
  const file = join(repo, ".git", "packed-refs");
  const [header, ...lines] = (await readFile(file, "latin1")).trimEnd().split("\n");
  const records: string[][] = [];
  for (const line of lines) {
    if (line.startsWith("^")) records.at(-1)?.push(line);
    else records.push([line]);
  }
  records.push([`${head} ${Buffer.from(NON_UTF8).toString("latin1")}`]);
  const nameOf = (r: string[]) => (r[0] as string).slice(41);
  records.sort((a, b) => (nameOf(a) < nameOf(b) ? -1 : 1));
  await writeFile(file, `${[header, ...records.flat()].join("\n")}\n`, "latin1");
  server = await startUploadPackServer(join(repo, ".git"));
});

afterAll(async () => {
  await server?.close();
  await sandbox?.dispose();
});

const connect = (transport: HttpTransport = nodeFetchTransport, url = server.url) =>
  SmartHttpClient.connect({ transport, url, agent: "fyrden-test/1" });

const byName = (refs: readonly RemoteRef[]) =>
  new Map(refs.map((r) => [latin1(r.name), r] as const));

describe("SmartHttpClient", () => {
  it("reads the protocol v2 capability advertisement", async () => {
    const client = await connect();
    const names = client.capabilities.map((c) => c.name);
    expect(names).toContain("ls-refs");
    expect(names).toContain("fetch");
    expect(server.requests.at(-1)?.path).toBe("/repo.git/info/refs?service=git-upload-pack");
  });

  it("lists the same refs as git for-each-ref, with HEAD's target and peeled tags", async () => {
    const client = await connect();
    const refs = await client.lsRefs({
      prefixes: ["HEAD", "refs/heads/", "refs/tags/"],
      symrefs: true,
      peel: true,
    });
    const listed = byName(refs);
    for (const line of (await text(["for-each-ref", "--format=%(objectname) %(refname)"])).split(
      "\n",
    )) {
      const [oid, name] = line.split(" ") as [string, string];
      // git prints the name that is not UTF-8 lossily; it is checked by bytes below.
      if (!/^[\x20-\x7e]+$/.test(name)) continue;
      expect(oidToHex((listed.get(name) as RemoteRef).oid)).toBe(oid);
    }
    expect(latin1((listed.get("HEAD") as RemoteRef).symrefTarget as Uint8Array)).toBe(
      "refs/heads/main",
    );
    const peeled = (listed.get("refs/tags/v1") as RemoteRef).peeled;
    expect(peeled && oidToHex(peeled)).toBe(await text(["rev-parse", "v1^{}"]));
    // The name that is not UTF-8 comes back as the same bytes.
    expect(refs.some((r) => Buffer.from(r.name).equals(Buffer.from(NON_UTF8)))).toBe(true);
  });

  it("fetches a pack git can index that holds every wanted object", async () => {
    const client = await connect();
    const refs = await client.lsRefs({ prefixes: ["refs/heads/", "refs/tags/"] });
    const wants = [...new Map(refs.map((r) => [oidToHex(r.oid), r.oid])).values()];
    const chunks: Uint8Array[] = [];
    const result = await client.fetchPack(wants, { write: (c) => void chunks.push(c.slice()) });
    const pack = Buffer.concat(chunks);
    expect(result.bytes).toBe(pack.length);
    expect(pack.subarray(0, 4).toString("latin1")).toBe("PACK");

    const target = join(sandbox.dir, "fetched.git");
    await sandbox.git(["init", "-q", "--bare", target]);
    await sandbox.git(["--git-dir", target, "index-pack", "--stdin", "--strict"], {
      input: pack,
    });
    for (const want of wants) {
      await sandbox.git(["--git-dir", target, "cat-file", "-e", oidToHex(want)]);
    }
    await sandbox.git([
      "--git-dir",
      target,
      "update-ref",
      "refs/heads/main",
      oidToHex(wants[0] as (typeof wants)[number]),
    ]);
    await sandbox.git(["--git-dir", target, "fsck", "--strict"]);
  });

  it("reports progress only when asked and sends no-progress otherwise", async () => {
    const client = await connect();
    const [main] = await client.lsRefs({ prefixes: ["refs/heads/main"] });
    await client.fetchPack([(main as RemoteRef).oid], { write: () => {} });
    expect(latin1(server.requests.at(-1)?.body ?? new Uint8Array())).toContain("no-progress");
  });

  it("stops a pack larger than the limit", async () => {
    const client = await SmartHttpClient.connect({
      transport: nodeFetchTransport,
      url: server.url,
      limits: { maxPackBytes: 100 },
    });
    const [main] = await client.lsRefs({ prefixes: ["refs/heads/main"] });
    const error = await client
      .fetchPack([(main as RemoteRef).oid], { write: () => {} })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FetchClientError);
    expect((error as FetchClientError).code).toBe("too-large");
  });

  it("turns the server's ERR for an object it does not have into a remote error", async () => {
    const client = await connect();
    const error = await client
      .fetchPack([oidFromHex("1".repeat(40))], { write: () => {} })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FetchClientError);
    expect((error as FetchClientError).code).toBe("remote-error");
    expect((error as Error).message).toMatch(/not our ref/);
  });

  it("refuses a server that does not speak protocol v2", async () => {
    const old = await startUploadPackServer(join(repo, ".git"), { v0Only: true });
    try {
      const error = await connect(nodeFetchTransport, old.url).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(FetchClientError);
      expect((error as FetchClientError).code).toBe("no-v2");
    } finally {
      await old.close();
    }
  });

  it("reports an HTTP error status without reading further", async () => {
    const gone = await startUploadPackServer(join(repo, ".git"), { status: 404 });
    try {
      const error = await connect(nodeFetchTransport, gone.url).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(FetchClientError);
      expect((error as FetchClientError).code).toBe("http-status");
      expect((error as FetchClientError).status).toBe(404);
    } finally {
      await gone.close();
    }
  });

  it("refuses a dumb-HTTP answer (wrong content type)", async () => {
    const transport: HttpTransport = async () => ({
      status: 200,
      contentType: "text/plain",
      body: (async function* () {
        yield new TextEncoder().encode("abc\trefs/heads/main\n");
      })(),
      cancel: async () => {},
    });
    const error = await connect(transport).catch((e: unknown) => e);
    expect((error as FetchClientError).code).toBe("not-smart");
  });

  it("refuses an advertisement without fetch", async () => {
    const transport: HttpTransport = async () => ({
      status: 200,
      contentType: "application/x-git-upload-pack-advertisement",
      body: (async function* () {
        yield new TextEncoder().encode("000eversion 2\n000cls-refs\n0000");
      })(),
      cancel: async () => {},
    });
    const error = await connect(transport).catch((e: unknown) => e);
    expect((error as FetchClientError).code).toBe("unsupported");
  });

  it("fails a truncated pack stream with a typed error", async () => {
    let call = 0;
    const transport: HttpTransport = async (request) => {
      call++;
      if (call === 1) return nodeFetchTransport(request);
      return {
        status: 200,
        contentType: "application/x-git-upload-pack-result",
        body: (async function* () {
          yield new TextEncoder().encode("000dpackfile\n0009\u0001PACK");
        })(),
        cancel: async () => {},
      };
    };
    const client = await connect(transport);
    const error = await client
      .fetchPack([oidFromHex("1".repeat(40))], { write: () => {} })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProtocolError);
  });
});

describe("withoutTrailingSlashes", () => {
  it("drops every trailing slash and nothing else", () => {
    expect(withoutTrailingSlashes("https://h/a/b///")).toBe("https://h/a/b");
    expect(withoutTrailingSlashes("https://h/a")).toBe("https://h/a");
    expect(withoutTrailingSlashes("///")).toBe("");
    expect(withoutTrailingSlashes("")).toBe("");
  });

  // Well under the old regex's time on this input (over 20 s), with room for slow runners.
  it("takes linear time on many slashes that do not end the URL", { timeout: 5_000 }, () => {
    // A regex trim (/\/+$/) backtracks quadratically on this shape.
    const url = `https://h/${"/".repeat(200_000)}a`;
    expect(withoutTrailingSlashes(url)).toBe(url);
  });
});
