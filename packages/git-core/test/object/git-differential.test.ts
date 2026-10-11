import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSha1Hasher } from "../../src/hash/sha1.js";
import { encodeCommit, parseCommit } from "../../src/object/commit.js";
import { GitObjectError, type Parsed } from "../../src/object/fsck.js";
import { hashObject, type ObjectType } from "../../src/object/object.js";
import { type Oid, oidFromBytes, oidFromHex, oidToHex } from "../../src/object/oid.js";
import { encodeTag, parseTag } from "../../src/object/tag.js";
import { encodeTree, parseTree } from "../../src/object/tree.js";
import { createGitSandbox, type GitSandbox } from "../../testing/git-cli.js";
import { headerArb, identArb, messageArb } from "./arbitraries.js";

/*
 * Differential tests against the git binary: git writes objects that we
 * parse, we write objects that git reads, and `git fsck` judges a corpus of
 * well-formed and mutated objects that our checks must judge the same way.
 */

const SEED = 20261010;
type Checked = ObjectType & ("tree" | "commit" | "tag");
const parsers: Record<Checked, (body: Uint8Array) => Parsed<unknown>> = {
  tree: parseTree,
  commit: parseCommit,
  tag: parseTag,
};

let sandbox: GitSandbox;
beforeAll(async () => {
  sandbox = await createGitSandbox();
  await sandbox.git(["init", "-q", "-b", "main"]);
});
afterAll(() => sandbox.dispose());

/** Writes objects without git's own checks; returns the ids git computed. */
async function writeLiterally(type: Checked, bodies: Uint8Array[]): Promise<string[]> {
  const dir = join(sandbox.dir, `.corpus-${type}`);
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

interface GitVerdict {
  unparsable: boolean;
  errors: string[];
  warnings: string[];
}

/** Runs `git fsck` and groups its message ids by object id. */
async function fsckVerdicts(): Promise<Map<string, GitVerdict>> {
  const { stdout, stderr } = await sandbox.git(
    ["fsck", "--no-dangling", "--no-progress", "--no-reflogs"],
    { okExitCodes: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] },
  );
  const verdicts = new Map<string, GitVerdict>();
  const get = (oid: string) => {
    const known = verdicts.get(oid);
    if (known) return known;
    const created: GitVerdict = { unparsable: false, errors: [], warnings: [] };
    verdicts.set(oid, created);
    return created;
  };
  for (const line of `${stdout}\n${stderr}`.split("\n")) {
    const finding = /^(error|warning) in (?:tree|commit|tag) ([0-9a-f]{40}): ([A-Za-z0-9]+): /.exec(
      line,
    );
    if (finding) {
      const [, level, oid, id] = finding as unknown as [string, string, string, string];
      (level === "error" ? get(oid).errors : get(oid).warnings).push(id);
      continue;
    }
    const unparsable = /^error: ([0-9a-f]{40}): object could not be parsed/.exec(line);
    if (unparsable?.[1]) get(unparsable[1]).unparsable = true;
  }
  return verdicts;
}

/**
 * Ids that never name two kinds of object. fast-check repeats values, and an
 * id used as a tree in one commit and as a parent in another makes git's
 * lookup fail with "could not be parsed", which is not what is under test.
 */
const typedOid = (kind: string): fc.Arbitrary<Oid> =>
  fc.nat().map((n) => oidFromBytes(createHash("sha1").update(`${kind}:${n}`).digest()));

/** Byte edits that tend to break header syntax: separators, digits, signs, NUL. */
const INTERESTING = [
  0x00, 0x09, 0x0a, 0x20, 0x2b, 0x2d, 0x2e, 0x30, 0x31, 0x3c, 0x3e, 0x5c, 0x61, 0x67, 0x7e,
];
const editsArb = fc.array(
  fc.tuple(
    fc.constantFrom("replace", "insert", "delete"),
    fc.nat(),
    fc.constantFrom(...INTERESTING),
  ),
  { minLength: 1, maxLength: 3 },
);

function mutate(body: Uint8Array, edits: [string, number, number][]): Uint8Array {
  const bytes = [...body];
  for (const [kind, at, byte] of edits) {
    const i = bytes.length === 0 ? 0 : at % bytes.length;
    if (kind === "replace" && bytes.length > 0) bytes[i] = byte;
    else if (kind === "insert") bytes.splice(i, 0, byte);
    else bytes.splice(i, 1);
  }
  return Uint8Array.from(bytes);
}

const latin1 = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const utf8 = (s: string) => new TextEncoder().encode(s);

/** Raw tree entries in any order, with odd modes and names that hit git's checks. */
const rawTreeArb = fc
  .array(
    fc.record({
      mode: fc.constantFrom(
        "100644",
        "100755",
        "120000",
        "40000",
        "160000",
        "040000",
        "100664",
        "100600",
        "1100644",
        "644",
      ),
      name: fc.oneof(
        fc.constantFrom(
          ...[
            ".git",
            "GIT~1",
            ".git. ",
            ".g‌it",
            "a\\.git",
            ".gitx",
            "a",
            "a.b",
            "a0",
            "b",
            ".",
            "..",
            "x/y",
            "foo",
            "foo.bar",
          ].map(utf8),
        ),
        fc
          .uint8Array({ minLength: 1, maxLength: 8 })
          .map((b) => b.map((x) => (x === 0 ? 0x61 : x))),
      ),
      oid: fc.oneof(typedOid("blob"), fc.constant(oidFromHex("0".repeat(40)))),
    }),
    { maxLength: 6 },
  )
  .map((entries) =>
    Uint8Array.from(
      entries.flatMap((e) => {
        // A tree entry's id is looked up as the type its mode implies.
        const oid = e.mode.endsWith("40000")
          ? retype(e.oid, "tree")
          : e.mode === "160000"
            ? retype(e.oid, "commit")
            : e.oid;
        return [...latin1(e.mode), 0x20, ...e.name, 0, ...oid];
      }),
    ),
  );

function retype(oid: Oid, kind: string): Oid {
  return oidFromBytes(
    createHash("sha1")
      .update(`${kind}:${oidToHex(oid)}`)
      .digest(),
  );
}

const commitBodyArb = fc
  .record({
    tree: typedOid("tree"),
    parents: fc.array(typedOid("commit"), { maxLength: 2 }),
    author: identArb,
    committer: identArb,
    headers: fc.array(headerArb, { maxLength: 2 }),
    message: messageArb,
  })
  .map(encodeCommit);

const tagBodyArb = fc
  .constantFrom("commit", "tree", "blob", "tag")
  .chain((type) =>
    fc.record({
      object: typedOid(type),
      type: fc.constant(type as ObjectType),
      name: fc.constantFrom(utf8("v1.0"), utf8("release/2026")),
      tagger: fc.option(identArb, { nil: null }),
      headers: fc.array(
        headerArb.filter((h) => h.key !== "tagger"),
        { maxLength: 2 },
      ),
      message: messageArb,
    }),
  )
  .map(encodeTag);

function corpus(arb: fc.Arbitrary<Uint8Array>, count: number): Uint8Array[] {
  const valid = fc.sample(arb, { seed: SEED, numRuns: count });
  const mutated = fc
    .sample(fc.tuple(arb, editsArb), { seed: SEED + 1, numRuns: count * 2 })
    .map(([body, edits]) => mutate(body, edits as [string, number, number][]));
  return [...valid, ...mutated];
}

function ourVerdict(type: Checked, body: Uint8Array): { thrown?: string; issues: string[] } {
  try {
    return { issues: parsers[type](body).issues.map((i) => i.id) };
  } catch (e) {
    if (!(e instanceof GitObjectError)) throw e;
    return { thrown: e.id, issues: [] };
  }
}

describe("objects written by git", () => {
  it("hash, parse without findings, and re-encode to the same bytes", async () => {
    await sandbox.git(["commit", "-q", "--allow-empty", "-m", "root"]);
    const blob = (
      await sandbox.git(["hash-object", "-w", "--stdin"], { input: "x\n" })
    ).stdout.trim();
    const sub = (await sandbox.git(["rev-parse", "HEAD"])).stdout.trim();
    const inner = (
      await sandbox.git(["mktree"], { input: `100644 blob ${blob}\tf\n` })
    ).stdout.trim();
    const tree = (
      await sandbox.git(["mktree"], {
        input: [
          `100644 blob ${blob}\tfile`,
          `100755 blob ${blob}\texec`,
          `120000 blob ${blob}\tlink`,
          `160000 commit ${sub}\tsub`,
          `040000 tree ${inner}\tdir`,
          `100644 blob ${blob}\tdir.txt`,
          `100644 blob ${blob}\tnon-ascii-é`,
        ].join("\n"),
      })
    ).stdout.trim();
    const merge = (
      await sandbox.git(["commit-tree", tree, "-p", sub, "-p", sub, "-m", "merge\n\nbody"], {
        env: { GIT_AUTHOR_NAME: "Ünïcode Name", GIT_AUTHOR_DATE: "1700000000 -0730" },
      })
    ).stdout.trim();
    await sandbox.git(["tag", "-a", "v1", merge, "-m", "annotated"]);
    await sandbox.git(["tag", "-a", "v1-of-tag", "v1", "-m", "tag of a tag"]);

    const raw = await sandbox.gitBytes(["cat-file", "--batch-all-objects", "--batch"]);
    let offset = 0;
    const seen = new Set<string>();
    while (offset < raw.length) {
      const nl = raw.indexOf(0x0a, offset);
      const [oid, type, size] = new TextDecoder().decode(raw.subarray(offset, nl)).split(" ");
      const body = raw.subarray(nl + 1, nl + 1 + Number(size));
      offset = nl + 1 + Number(size) + 1;
      seen.add(type as string);
      expect(oidToHex(await hashObject(createSha1Hasher, type as ObjectType, body))).toBe(oid);
      if (type === "blob") continue;
      const parsed = parsers[type as Checked](body);
      expect(parsed.issues).toEqual([]);
      const encoded =
        type === "tree"
          ? encodeTree(parsed.value as Parameters<typeof encodeTree>[0])
          : type === "commit"
            ? encodeCommit(parsed.value as Parameters<typeof encodeCommit>[0])
            : encodeTag(parsed.value as Parameters<typeof encodeTag>[0]);
      expect(encoded).toEqual(new Uint8Array(body));
    }
    expect([...seen].sort()).toEqual(["blob", "commit", "tag", "tree"]);
  });
});

describe("objects we write", () => {
  it.each(["tree", "commit", "tag"] as const)("%s ids match git hash-object", async (type) => {
    const arb = type === "tree" ? rawTreeArb : type === "commit" ? commitBodyArb : tagBodyArb;
    const bodies = fc.sample(arb, { seed: SEED + 2, numRuns: 40 });
    const ids = await writeLiterally(type, bodies);
    for (const [i, body] of bodies.entries()) {
      expect(oidToHex(await hashObject(createSha1Hasher, type, body))).toBe(ids[i]);
    }
  });
});

describe("git fsck as the oracle", () => {
  it("agrees with our checks on well-formed and mutated trees, commits and tags", async () => {
    const corpora = {
      tree: corpus(rawTreeArb, 150),
      commit: corpus(commitBodyArb, 120),
      tag: corpus(tagBodyArb, 80),
    };
    const written: { type: Checked; body: Uint8Array; oid: string }[] = [];
    for (const type of ["tree", "commit", "tag"] as const) {
      const ids = await writeLiterally(type, corpora[type]);
      for (const [i, body] of corpora[type].entries()) {
        written.push({ type, body, oid: ids[i] as string });
      }
    }
    const verdicts = await fsckVerdicts();
    const disagreements: string[] = [];
    let rejected = 0;
    for (const { type, body, oid } of written) {
      const git = verdicts.get(oid) ?? { unparsable: false, errors: [], warnings: [] };
      const ours = ourVerdict(type, body);
      if (ours.thrown) rejected++;
      let agrees: boolean;
      if (git.unparsable) {
        agrees = ours.thrown !== undefined;
      } else if (type === "tree") {
        // A tree we cannot read is badTree; git also reports what it saw before that point.
        agrees = ours.thrown
          ? git.errors.includes(ours.thrown)
          : sameSet([...git.errors, ...git.warnings], ours.issues);
      } else {
        // git's fsck stops at the first error in a commit or tag, as we do.
        agrees = ours.thrown
          ? git.errors.length === 1 && git.errors[0] === ours.thrown
          : git.errors.length === 0 && sameSet(git.warnings, ours.issues);
      }
      if (!agrees) {
        disagreements.push(
          `${type} ${oid}: git ${JSON.stringify(git)} ours ${JSON.stringify(ours)} body ${JSON.stringify(new TextDecoder("latin1").decode(body))}`,
        );
      }
    }
    expect(disagreements).toEqual([]);
    // The corpus exercises both sides: plenty rejected, plenty accepted.
    expect(rejected).toBeGreaterThan(written.length / 10);
    expect(rejected).toBeLessThan(written.length);
  }, 60_000);
});

function sameSet(a: string[], b: string[]): boolean {
  const x = new Set(a);
  const y = new Set(b);
  return x.size === y.size && [...x].every((v) => y.has(v));
}
