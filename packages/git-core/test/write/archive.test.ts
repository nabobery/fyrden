import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ArchiveEntry,
  gzipMember,
  tarCommitHeader,
  tarEnd,
  tarEntry,
  type ZipRecord,
  zipEnd,
  zipEntry,
} from "../../src/write/archive.js";
import { createGitSandbox, type GitSandbox } from "../../testing/git-cli.js";
import { createNodeZlib } from "../../testing/node-zlib.js";

/*
 * Differential tests against `git archive`: a repository with nested and
 * long paths, an executable, short and long symlinks, a non-ASCII name, an
 * empty file and a submodule, archived by git and by these encoders (from
 * the same tree, in git's order), both extracted with the system's tar and
 * unzip, and the extracted trees compared.
 */

const zlib = createNodeZlib();
const encoder = new TextEncoder();
const MTIME = 1_772_323_200;
const PREFIX = "repo-abc1234";

let sandbox: GitSandbox;
let repo: string;
let commit: string;
let entries: ArchiveEntry[];

beforeAll(async () => {
  sandbox = await createGitSandbox();
  repo = join(sandbox.dir, "repo");
  await sandbox.git(["init", "-q", "-b", "main", repo]);
  const add = async (mode: string, content: string | Uint8Array, path: string) => {
    const { stdout } = await sandbox.git(["hash-object", "-w", "--stdin"], {
      cwd: repo,
      input: content,
    });
    await sandbox.git(
      ["update-index", "--add", "--cacheinfo", `${mode},${stdout.trim()},${path}`],
      { cwd: repo },
    );
  };
  await add("100644", "# readme\n", "README.md");
  await add("100644", "", "empty.txt");
  await add("100755", "#!/bin/sh\necho hi\n", "bin/run.sh");
  await add("120000", "README.md", "link");
  await add("120000", `${"t".repeat(120)}/target`, "longlink");
  await add("100644", "deep\n", `${"d".repeat(60)}/${"e".repeat(60)}/file.txt`);
  await add("100644", "very\n", `${"x".repeat(200)}/${"y".repeat(200)}.txt`);
  await add("100644", "ünï\n", "docs/ünïcödé.md");
  await add(
    "100644",
    new Uint8Array(70_000).map((_, i) => (i * 7) % 256),
    "data/blob.bin",
  );
  // A submodule: git archives it as an empty directory.
  await sandbox.git(["update-index", "--add", "--cacheinfo", `160000,${"1".repeat(40)},sub`], {
    cwd: repo,
  });
  const full = (await sandbox.git(["write-tree"], { cwd: repo })).stdout.trim();
  commit = (
    await sandbox.git(["commit-tree", full, "-m", "fixture"], {
      cwd: repo,
      env: { GIT_COMMITTER_DATE: `@${MTIME} +0000`, GIT_AUTHOR_DATE: `@${MTIME} +0000` },
    })
  ).stdout.trim();

  // The tree in git's order (a directory before what is in it).
  const listing = (await sandbox.git(["ls-tree", "-r", "-t", "-z", commit], { cwd: repo })).stdout;
  entries = [];
  for (const line of listing.split("\0").filter(Boolean)) {
    const [meta, path] = line.split("\t") as [string, string];
    const [mode, , sha] = meta.split(" ") as [string, string, string];
    const kind =
      mode === "040000"
        ? "dir"
        : mode === "160000"
          ? "submodule"
          : mode === "120000"
            ? "symlink"
            : mode === "100755"
              ? "executable"
              : "file";
    const data =
      kind === "dir" || kind === "submodule"
        ? new Uint8Array(0)
        : await sandbox.gitBytes(["cat-file", "blob", sha], { cwd: repo });
    entries.push({ path: encoder.encode(`${PREFIX}/${path}`), kind, data });
  }
});
afterAll(() => sandbox.dispose());

/** Every path below `dir`: its type, whether it is executable, its content or target. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string, rel: string) => {
    for (const name of readdirSync(at).sort()) {
      const path = join(at, name);
      const key = rel ? `${rel}/${name}` : name;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) out[key] = `link ${readlinkSync(path)}`;
      else if (stat.isDirectory()) {
        out[key] = "dir";
        walk(path, key);
      } else {
        const exec = (stat.mode & 0o100) !== 0 ? "exec" : "file";
        out[key] = `${exec} ${readFileSync(path).toString("base64")}`;
      }
    }
  };
  walk(dir, "");
  return out;
}

function extract(archive: string, into: string, tool: "tar" | "unzip"): Record<string, string> {
  mkdirSync(into, { recursive: true });
  if (tool === "tar") execFileSync("tar", ["-xf", archive, "-C", into]);
  else execFileSync("unzip", ["-q", archive, "-d", into]);
  return snapshot(into);
}

let expected: Record<string, string>;

describe("archives", () => {
  beforeAll(async () => {
    const gitTar = join(sandbox.dir, "git.tar");
    writeFileSync(
      gitTar,
      await sandbox.gitBytes(["archive", "--format=tar", `--prefix=${PREFIX}/`, commit], {
        cwd: repo,
      }),
    );
    expected = extract(gitTar, join(sandbox.dir, "from-git"), "tar");
  });

  it("are compared on the hard cases: long paths and links, a submodule, an executable", () => {
    const keys = Object.keys(expected);
    expect(keys).toContain(`${PREFIX}/${"x".repeat(200)}/${"y".repeat(200)}.txt`);
    expect(expected[`${PREFIX}/longlink`]).toBe(`link ${"t".repeat(120)}/target`);
    expect(expected[`${PREFIX}/sub`]).toBe("dir");
    expect(expected[`${PREFIX}/bin/run.sh`]?.startsWith("exec ")).toBe(true);
    expect(keys).toContain(`${PREFIX}/docs/ünïcödé.md`);
  });

  it("make a .tar.gz of several gzip members that extracts as git's tar does", async () => {
    const half = Math.floor(entries.length / 2);
    const first = new Uint8Array([
      ...tarCommitHeader(commit, MTIME),
      ...entries.slice(0, half).flatMap((e) => [...tarEntry(e, MTIME)]),
    ]);
    const rest = new Uint8Array([
      ...entries.slice(half).flatMap((e) => [...tarEntry(e, MTIME)]),
      ...tarEnd(),
    ]);
    const gz = new Uint8Array([
      ...gzipMember(zlib, first, MTIME),
      ...gzipMember(zlib, rest, MTIME),
    ]);
    const path = join(sandbox.dir, "ours.tar.gz");
    writeFileSync(path, gz);
    expect(extract(path, join(sandbox.dir, "from-tgz"), "tar")).toEqual(expected);
    // git reads the commit id back from the global header.
    const tar = gunzipSync(gz);
    const { stdout } = await sandbox.git(["get-tar-commit-id"], { cwd: repo, input: tar });
    expect(stdout.trim()).toBe(commit);
  });

  it("make a .zip that extracts as git's tar does", () => {
    const parts: Uint8Array[] = [];
    const records: ZipRecord[] = [];
    let offset = 0;
    for (const entry of entries) {
      const { bytes, record } = zipEntry(zlib, entry, MTIME, offset);
      parts.push(bytes);
      records.push(record);
      offset += bytes.length;
    }
    parts.push(zipEnd(records, offset, MTIME));
    const path = join(sandbox.dir, "ours.zip");
    writeFileSync(path, Buffer.concat(parts));
    expect(extract(path, join(sandbox.dir, "from-zip"), "unzip")).toEqual(expected);
  });
});

describe("zip fields", () => {
  const file = (path: Uint8Array): ArchiveEntry => ({
    path,
    kind: "file",
    data: new Uint8Array([1]),
  });

  it("flags UTF-8 names only, as git does", () => {
    expect(zipEntry(zlib, file(encoder.encode("ünï.txt")), MTIME, 0).record.flags).toBe(0x0800);
    expect(zipEntry(zlib, file(Uint8Array.of(0x61, 0xff)), MTIME, 0).record.flags).toBe(0);
  });

  it("refuses what a zip without ZIP64 cannot hold, instead of wrapping it", () => {
    expect(() => zipEntry(zlib, file(new Uint8Array(65_536).fill(0x61)), MTIME, 0)).toThrow(
      RangeError,
    );
    expect(() => zipEntry(zlib, file(encoder.encode("a")), MTIME, 2 ** 32 - 10)).toThrow(
      RangeError,
    );
    const record = zipEntry(zlib, file(encoder.encode("a")), MTIME, 0).record;
    expect(() => zipEnd(new Array(65_536).fill(record), 0, MTIME)).toThrow(RangeError);
  });

  it("clamps dates to what each format holds", () => {
    // Year 2108 in a zip is written as its last date, 2107-12-31, not wrapped to 1980.
    const late = zipEntry(zlib, file(encoder.encode("a")), 4_356_000_000, 0).bytes;
    const date = new DataView(late.buffer, late.byteOffset).getUint16(12, true);
    expect(1980 + (date >> 9)).toBe(2107);
    // A tar mtime past eleven octal digits is written as the largest they hold.
    const tar = tarEntry(file(encoder.encode("a")), 8 ** 12);
    expect(new TextDecoder().decode(tar.subarray(136, 147))).toBe("77777777777");
  });
});
