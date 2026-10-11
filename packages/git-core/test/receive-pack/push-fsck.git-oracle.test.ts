import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { concatBytes } from "../../src/object/bytes.js";
import { oidFromHex } from "../../src/object/oid.js";
import { PUSH_FSCK_SEVERITY, PushFsck, type PushFsckId } from "../../src/receive-pack/fsck.js";
import { checkGitmodules } from "../../src/receive-pack/gitmodules.js";
import { createGitSandbox, type GitSandbox } from "../../testing/git-cli.js";

/*
 * The push checks that git's object model did not have yet (`.gitmodules`
 * contents, special names as symbolic links), judged by `git fsck`, which
 * runs the same fsck.c code as `receive-pack` with `receive.fsckObjects`.
 */

const SEED = 20261011;
const latin1 = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0));

let sandbox: GitSandbox;
beforeAll(async () => {
  sandbox = await createGitSandbox();
  await sandbox.git(["init", "-q", "-b", "main"]);
});
afterAll(() => sandbox.dispose());

let corpusCount = 0;
async function writeLiterally(type: "blob" | "tree", bodies: Uint8Array[]): Promise<string[]> {
  const dir = join(sandbox.dir, `.corpus-${corpusCount++}`);
  await mkdir(dir, { recursive: true });
  const paths = await Promise.all(
    bodies.map(async (body, i) => {
      const path = join(dir, String(i));
      await writeFile(path, body);
      return path;
    }),
  );
  const { stdout } = await sandbox.git(
    ["hash-object", "-w", "--literally", "-t", type, "--stdin-paths"],
    { input: `${paths.join("\n")}\n` },
  );
  return stdout.trim().split("\n");
}

function treeOf(entries: readonly [string, Uint8Array, string][]): Uint8Array {
  return concatBytes(
    entries.map(([mode, name, oid]) =>
      concatBytes([latin1(`${mode} `), name, Uint8Array.of(0), oidFromHex(oid)]),
    ),
  );
}

/** `git fsck` findings as "<id>: <message>" lines, grouped by object id. */
async function fsckFindings(): Promise<Map<string, string[]>> {
  const { stdout, stderr } = await sandbox.git(
    ["fsck", "--no-dangling", "--no-progress", "--no-reflogs"],
    { okExitCodes: Array.from({ length: 32 }, (_, i) => i) },
  );
  const out = new Map<string, string[]>();
  for (const line of `${stdout}\n${stderr}`.split("\n")) {
    const match = /^(?:error|warning) in (?:blob|tree) ([0-9a-f]{40}): (.*)$/.exec(line);
    if (!match) continue;
    const [, oid, finding] = match as unknown as [string, string, string];
    out.set(oid, [...(out.get(oid) ?? []), finding]);
  }
  return out;
}

const names = [
  "submodule",
  "x",
  "..",
  "../a",
  "a/..",
  "a/../b",
  "a\\..",
  "..\\a",
  "..x",
  "x..",
  "a/..b",
  "",
  ".",
];
const urls = [
  "https://example.com/r.git",
  "-u",
  "--upload-pack=touch",
  "./x",
  "../x",
  "../../:x",
  "../../../evil:x",
  "..\\..\\:x",
  "./../x",
  "./..//x",
  "../.././/host",
  "git://h/%0a",
  "git://h/x%0Ay",
  "../x%0a",
  "https://h/%0Ax",
  "https://h/x%0a",
  "http::https://h/r",
  "https::example.com",
  "https:///x",
  "https://h:0/x",
  "https://h:99999/",
  "https://h:080/",
  "https://h:00/",
  "https://h:65535",
  "https://h:/x",
  "https://a b/",
  "https://h/../..",
  "https://h/a/../..",
  "https://h/a/./../b",
  "https://h/%2e%2e/x",
  "ftp://h/%zz",
  "ftps://h/%4",
  "http://[::1]:80/",
  "https://user:%0a@h/",
  "https://us%zzer@h/",
  "https://@h/",
  "1https://h/",
  "https:/h",
  "file:///x",
  "ssh://h/x",
  "h:x",
  "",
];
const others = [
  "path = a",
  "path = -x",
  "path",
  "update = !rm -rf /",
  "update = merge",
  "update",
  "url",
];

function gitmodules(name: string, lines: readonly string[]): string {
  return `[submodule "${name}"]\n${lines.map((l) => `\t${l}\n`).join("")}`;
}

const handwritten: string[] = [
  "",
  "[submodule]\n\turl = -x\n",
  '[submodule "a"]\n\tURL = -x\n',
  "[Submodule.Foo]\n\turl = https://h/r\n",
  "[submodule.Foo]\n\turl = -x\n",
  "[submodule.a.b]\n\tpath = -x\n",
  '[submodule "a\\"b"]\n\turl = ./x\n',
  '[submodule "a\\\\..\\\\b"]\n\turl = x\n',
  '[submodule "x"]\n\turl = "-x"\n',
  '[submodule "x"]\n\turl = -x ; comment\n',
  '[submodule "x"]\n\turl = " -x"\n',
  '[submodule "x"]\n\turl = \\-x\n',
  '[submodule "x"]\n\turl = ../x\\nboom\n',
  '[submodule "x"]\r\n\turl = -x\r\n',
  '\u00EF\u00BB\u00BF[submodule "x"]\n\turl = -x\n',
  '\u00FF[submodule "x"]\n\turl = -x\n',
  '[submodule "x"]\n\turl = -x\u00FF\n\tpath = -y\n',
  '[submodule "x"]\n\turl = \u00E9-x\n',
  '[submodule "x"]\n\turl = a\u000Bb\n\tpath\u000C= -y\n',
  '\u00EF\u00BB[submodule "x"]\n\turl = -x\n',
  '[submodule "x"]\n\turl = -x\n[broken\n\tpath = -y\n',
  '[submodule "x"\n\turl = -x\n',
  '[submodule "x"]\n\turl = "unterminated\n',
  '[submodule "x"]\n\turl = bad\\escape\n',
  '[submodule "x"]\n\turl = a\\\n-x\n',
  '[submodule "x"]\n\t1url = -x\n',
  '[submodule "x"]\n\turl -x\n',
  '# comment\n[submodule "../y"] # trailing\n\tpath=-p\n',
  '[submodule "x"]\n\turl = https://h/x\0%0a\n',
  '[submodule "x\0"]\n\turl = x\n',
  '[submodule "x"]\n\tupdate = !\n\tpath = -\n',
  '[submodule  "x" ]\n\turl = -x\n',
  '[ submodule "x"]\n\turl = -x\n',
];

describe("push fsck: .gitmodules contents (git fsck as oracle)", () => {
  it("reports exactly git's findings for a seeded corpus", async () => {
    const generated = fc.sample(
      fc
        .tuple(
          fc.constantFrom(...names),
          fc.subarray([...urls.map((u) => `url = ${u}`), ...others], {
            minLength: 0,
            maxLength: 4,
          }),
        )
        .map(([name, lines]) => gitmodules(name, lines)),
      { seed: SEED, numRuns: 300 },
    );
    const singles = [
      ...urls.map((u) => gitmodules("x", [`url = ${u}`])),
      ...names.map((n) => gitmodules(n, ["path = a"])),
      ...others.map((o) => gitmodules("x", [o])),
    ];
    const corpus = [...new Set([...handwritten, ...singles, ...generated])].map(latin1);
    const blobs = await writeLiterally("blob", corpus);
    // Each blob is named .gitmodules by a tree of its own.
    await writeLiterally(
      "tree",
      blobs.map((oid) => treeOf([["100644", latin1(".gitmodules"), oid]])),
    );
    const git = await fsckFindings();
    const differences: string[] = [];
    corpus.forEach((bytes, i) => {
      const oid = blobs[i] as string;
      // git fsck prints a message with a newline over two lines; compare first lines.
      // Whole values, as git prints them (messages for clients show excerpts).
      const ours = checkGitmodules(bytes).map(
        (f) => `${f.id}: ${f.what}${f.value === undefined ? "" : `: ${f.value}`}`.split("\n")[0],
      );
      const theirs = git.get(oid) ?? [];
      if (JSON.stringify(ours.sort()) !== JSON.stringify([...theirs].sort())) {
        differences.push(
          `${JSON.stringify(String.fromCharCode(...bytes))}: ours ${JSON.stringify(ours)} git ${JSON.stringify(theirs)}`,
        );
      }
    });
    expect(differences).toEqual([]);
  }, 60_000);
});

const special = [
  ".gitmodules",
  ".GITMODULES",
  ".GitModules",
  ".gitmodules ",
  ".gitmodules. . .",
  ".gitmodules:stream",
  ".gitmodules::$DATA",
  ".gitmodulesx",
  ".gitmodules/",
  "gitmod~1",
  "GITMOD~4",
  "gitmod~5",
  "gitmod~1 .",
  "gitmod~1x",
  "gi7eba~1",
  "GI7EBA~9",
  "gi7eba~10",
  "gi7eb~1",
  "gi7e~123",
  "gi7eba~0",
  "gi7ebax1",
  "a\\.gitmodules",
  "a\\b\\gitmod~1",
  "a\\.gitmodulesx",
  ".git\u00e2\u0080\u008cmodules",
  ".gitmodule\u00ef\u00bb\u00bfs",
  ".gitmodules\u00e2\u0080\u008c",
  ".gitattributes",
  ".GITATTRIBUTES  ",
  "gitatt~1",
  "gi7d29~1",
  ".gitignore",
  "gitign~2",
  "gi250a~3",
  ".mailmap",
  "mailma~1",
  "maba30~4",
  ".mailmap:x",
  "\u00ff\u00ffgi~1",
  "~1gitmo",
  ".git",
  "readme",
];

describe("push fsck: special names in trees (git fsck as oracle)", () => {
  it("flags the same symbolic links and .gitmodules names as git", async () => {
    const [target] = await writeLiterally("blob", [latin1("target")]);
    const symlinkTrees = special.map((name) =>
      treeOf([["120000", latin1(name), target as string]]),
    );
    const trees = await writeLiterally("tree", symlinkTrees);
    const git = await fsckFindings();
    // Every id is reported, never thrown, so all findings are visible.
    const levels = Object.fromEntries(
      Object.keys(PUSH_FSCK_SEVERITY).map((id) => [id, "warn"]),
    ) as Record<PushFsckId, "warn">;
    const differences: string[] = [];
    special.forEach((name, i) => {
      const fsck = new PushFsck({ levels });
      const oid = oidFromHex(trees[i] as string);
      fsck.check(oid, "tree", symlinkTrees[i] as Uint8Array);
      const ours = fsck.warnings.map((f) => f.message);
      const theirs = git.get(trees[i] as string) ?? [];
      if (JSON.stringify(ours.sort()) !== JSON.stringify([...theirs].sort())) {
        differences.push(
          `${JSON.stringify(name)}: ours ${JSON.stringify(ours)} git ${JSON.stringify(theirs)}`,
        );
      }
    });
    expect(differences).toEqual([]);
  });

  it("checks a .gitmodules blob named by a regular file, whichever comes first", () => {
    const evil = latin1('[submodule "../../x"]\n\tpath = a\n');
    const blob = oidFromHex("1".repeat(40));
    const tree = treeOf([["100644", latin1(".gitmodules"), "1".repeat(40)]]);
    // Tree first: the blob is checked when it arrives.
    const first = new PushFsck();
    first.check(oidFromHex("2".repeat(40)), "tree", tree);
    expect(() => first.check(blob, "blob", evil)).toThrow(/gitmodulesName/);
    // Blob first: it is pending until finish.
    const second = new PushFsck();
    second.check(blob, "blob", evil);
    second.check(oidFromHex("2".repeat(40)), "tree", tree);
    expect(second.pending()).toHaveLength(1);
    expect(() => second.finishBlob(blob, { type: "blob", data: evil })).toThrow(/gitmodulesName/);
    // Missing or not a blob.
    const third = new PushFsck();
    third.check(oidFromHex("2".repeat(40)), "tree", tree);
    expect(() => third.finishBlob(blob, undefined)).toThrow(/gitmodulesMissing/);
    expect(() => third.finishBlob(blob, { type: "tree", data: new Uint8Array(0) })).toThrow(
      /gitmodulesBlob: non-blob found at .gitmodules/,
    );
  });
});
