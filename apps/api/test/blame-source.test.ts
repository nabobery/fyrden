// The repository's blame source over a reader and a commit graph, one
// method at a time: what each answers, what it refuses without reading a
// body, and how each failure reaches the walk. A whole walk against git is
// in blame-source.git.test.ts.
import type { BoundedCommit } from "@fyrden/adapters-cloudflare/git";
import {
  BlameObjectUnreadable,
  BlameReadsSpent,
  encodeTree,
  type Oid,
  oidFromHex,
  oidToHex,
  PackError,
  ReaderWorkSpent,
} from "@fyrden/git-core";
import { describe, expect, it } from "vitest";
import {
  BLAME_MAX_PARENTS,
  MAX_COMMIT_INFO_BYTES,
  repoBlameSource,
} from "../src/do/repo/blame-source.js";
import { ReadBudgetError } from "../src/git/live-reader.js";

type Stored = { type: "blob" | "tree" | "commit" | "tag"; bytes: Uint8Array };

/** Objects by id, with every header and body read recorded. */
class FakeReader {
  readonly #objects = new Map<string, Stored>();
  readonly headers: string[] = [];
  readonly bodies: string[] = [];
  fail: (hex: string) => void = () => {};
  #next = 1;

  add(type: Stored["type"], bytes: Uint8Array): Oid {
    const oid = oidFromHex((this.#next++).toString(16).padStart(40, "0"));
    this.#objects.set(oidToHex(oid), { type, bytes });
    return oid;
  }

  async readHeader(oid: Oid) {
    const hex = oidToHex(oid);
    this.fail(hex);
    this.headers.push(hex);
    const found = this.#objects.get(hex);
    return found && { type: found.type, size: found.bytes.length };
  }

  async readObject(oid: Oid) {
    const hex = oidToHex(oid);
    this.fail(hex);
    this.bodies.push(hex);
    const found = this.#objects.get(hex);
    return found && { type: found.type, bytes: found.bytes.slice() };
  }
}

const text = (s: string) => new TextEncoder().encode(s);
const latin1 = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const name = (s: string) => text(s);
const unknown = oidFromHex("f".repeat(40));
const noGraph = { readBounded: (): BoundedCommit | undefined => undefined };

function tree(reader: FakeReader, entries: { mode: number; name: string; oid: Oid }[]): Oid {
  return reader.add(
    "tree",
    encodeTree(entries.map((e) => ({ mode: e.mode, name: name(e.name), oid: e.oid }))),
  );
}

/** A commit object whose bytes are exactly the header lines below and `message`. */
function commitBytes(
  message: Uint8Array | string,
  { headers = "", author = "Ada Lovelace", when = "1700000000 +0100" } = {},
): Uint8Array {
  const head = latin1(
    `tree ${"1".repeat(40)}\n` +
      `author ${author} <ada@example.com> ${when}\n` +
      "committer Ada Lovelace <ada@example.com> 1700000000 +0100\n" +
      headers +
      "\n",
  );
  const body = typeof message === "string" ? text(message) : message;
  const out = new Uint8Array(head.length + body.length);
  out.set(head);
  out.set(body, head.length);
  return out;
}

/** A commit of exactly `size` bytes, padded in its message's second line. */
function commitOfSize(size: number): Uint8Array {
  const bare = commitBytes("subject\n\n\n").length;
  return commitBytes(`subject\n\n${"p".repeat(size - bare)}\n`);
}

describe("repoBlameSource.commit", () => {
  it("reads the graph with blame's parent limit, and answers what it finds", async () => {
    const asked: number[] = [];
    const row: BoundedCommit = { tree: unknown, parents: "too_many", generation: 7, level: 3 };
    const source = repoBlameSource(new FakeReader(), {
      readBounded: (_oid, max) => {
        asked.push(max);
        return row;
      },
    });
    expect(await source.commit(unknown)).toEqual(row);
    expect(asked).toEqual([BLAME_MAX_PARENTS]);
    expect(BLAME_MAX_PARENTS).toBe(16);
    expect(await repoBlameSource(new FakeReader(), noGraph).commit(unknown)).toBeUndefined();
  });
});

describe("repoBlameSource.fileAt", () => {
  const setup = () => {
    const reader = new FakeReader();
    const file = reader.add("blob", text("a\n"));
    const sub = tree(reader, [{ mode: 0o100755, name: "run.sh", oid: file }]);
    const root = tree(reader, [
      { mode: 0o100644, name: "f.txt", oid: file },
      { mode: 0o120000, name: "link", oid: file },
      { mode: 0o040000, name: "dir", oid: sub },
      { mode: 0o160000, name: "module", oid: unknown },
    ]);
    return { reader, file, root, source: repoBlameSource(reader, noGraph) };
  };
  const at = (path: string) => path.split("/").map(name);

  /** A tree in raw bytes, for modes `encodeTree` won't write; entries in name order. */
  const rawTree = (reader: FakeReader, entries: [mode: string, name: string, oid: Oid][]) =>
    reader.add(
      "tree",
      Uint8Array.from(
        entries.flatMap(([mode, entryName, oid]) => [...latin1(`${mode} ${entryName}\0`), ...oid]),
      ),
    );

  it("tells kinds apart by the mode's type bits, as push validation does", async () => {
    const reader = new FakeReader();
    const file = reader.add("blob", text("a\n"));
    const sub = tree(reader, [{ mode: 0o100644, name: "in.txt", oid: file }]);
    const root = rawTree(reader, [
      ["40755", "dir", sub],
      ["100664", "group", file],
      ["120755", "legacy", file],
      ["160755", "module", unknown],
    ]);
    const source = repoBlameSource(reader, noGraph);
    expect(await source.fileAt(root, at("legacy"))).toEqual({ oid: file, kind: "symlink" });
    expect(await source.fileAt(root, at("group"))).toEqual({ oid: file, kind: "file" });
    expect(await source.fileAt(root, at("dir/in.txt"))).toEqual({ oid: file, kind: "file" });
    expect(await source.fileAt(root, at("module"))).toBeNull();
    expect(await source.fileAt(root, at("dir"))).toBeNull();
  });

  it("finds a file or a symlink, through directories", async () => {
    const { source, root, file } = setup();
    expect(await source.fileAt(root, at("f.txt"))).toEqual({ oid: file, kind: "file" });
    expect(await source.fileAt(root, at("dir/run.sh"))).toEqual({ oid: file, kind: "file" });
    expect(await source.fileAt(root, at("link"))).toEqual({ oid: file, kind: "symlink" });
  });

  it("answers null for a directory, a submodule, or nothing at the path", async () => {
    const { source, root } = setup();
    for (const path of ["dir", "module", "none", "f.txt/below", "dir/none", "module/x"])
      expect([path, await source.fileAt(root, at(path))]).toEqual([path, null]);
  });

  it("refuses a tree it can't read as unreadable, never as nothing there", async () => {
    const { reader, source, file } = setup();
    const corrupt = reader.add("tree", latin1("100644 f.txt"));
    for (const [what, oid] of [
      ["missing", unknown],
      ["a blob", file],
      ["corrupt", corrupt],
    ] as const)
      await expect(source.fileAt(oid, at("f.txt")), what).rejects.toBeInstanceOf(
        BlameObjectUnreadable,
      );
  });
});

describe("repoBlameSource.blob", () => {
  it("answers too_large from the header alone, and reads a body that fits", async () => {
    const reader = new FakeReader();
    const oid = reader.add("blob", text("four"));
    const source = repoBlameSource(reader, noGraph);
    expect(await source.blob(oid, 3)).toBe("too_large");
    expect(reader.bodies).toEqual([]);
    expect(await source.blob(oid, 4)).toEqual(text("four"));
  });

  it("refuses a missing object, or one that isn't a blob, as unreadable", async () => {
    const reader = new FakeReader();
    const notBlob = tree(reader, []);
    const source = repoBlameSource(reader, noGraph);
    await expect(source.blob(unknown, 10)).rejects.toBeInstanceOf(BlameObjectUnreadable);
    await expect(source.blob(notBlob, 10)).rejects.toBeInstanceOf(BlameObjectUnreadable);
  });
});

describe("repoBlameSource.commitInfo", () => {
  const info = async (bytes: Uint8Array) => {
    const reader = new FakeReader();
    const oid = reader.add("commit", bytes);
    return { fact: await repoBlameSource(reader, noGraph).commitInfo(oid), oid, reader };
  };

  it("reads a commit of 64 KiB, and answers too_large one byte over, with no body read", async () => {
    expect(MAX_COMMIT_INFO_BYTES).toBe(65_536);
    const fits = await info(commitOfSize(MAX_COMMIT_INFO_BYTES));
    expect(fits.fact).toMatchObject({ summary: "subject" });
    const over = await info(commitOfSize(MAX_COMMIT_INFO_BYTES + 1));
    expect(over.fact).toBe("too_large");
    expect(over.reader.bodies).toEqual([]);
  });

  it("gives the author, and the author date as git prints it: seconds and offset", async () => {
    expect((await info(commitBytes("s\n"))).fact).toEqual({
      summary: "s",
      name: "Ada Lovelace",
      email: "ada@example.com",
      date: "1700000000 +0100",
    });
  });

  it("keeps a date no JavaScript date can hold, exactly, rather than invent one", async () => {
    for (const when of ["8640000000001 -0730", "9007199254740993 +0000", "0 -1200"])
      expect([when, (await info(commitBytes("s\n", { when }))).fact]).toMatchObject([
        when,
        { date: when },
      ]);
  });

  it("keeps a leading byte order mark in a name and a summary, as git shows them", async () => {
    const fact = await info(commitBytes("\uFEFFword\n", { author: "\u00EF\u00BB\u00BFBo" }));
    expect(fact.fact).toMatchObject({ summary: "\uFEFFword", name: "\uFEFFBo" });
  });

  it("takes as summary the first line that isn't blank, as git does", async () => {
    const cases: [string, string][] = [
      ["first line\nsecond line\n\nbody\n", "first line"],
      ["  leading spaces\n", "  leading spaces"],
      ["\n \t\r\n\nafter blank lines\n", "after blank lines"],
      ["tab\there\r\nnext\n", "tab\there\r"],
      ["word   \n", "word   "],
      ["\v\nnext\n", "\v"],
      ["no line feed", "no line feed"],
      ["first\0hidden\n", "first"],
      ["\n  \nnext\0hidden\n", "next"],
    ];
    for (const [message, summary] of cases)
      expect([message, (await info(commitBytes(message))).fact]).toMatchObject([
        message,
        { summary },
      ]);
  });

  it("names the commit in parentheses when there is no summary, as git does", async () => {
    for (const message of ["", "\n", "\n\n \t\n", "   ", "\0real\n", "\n  \0x\nreal\n"]) {
      const { fact, oid } = await info(commitBytes(message));
      expect([message, fact]).toMatchObject([message, { summary: `(${oidToHex(oid)})` }]);
    }
  });

  it("decodes the text as the commit's encoding header says", async () => {
    const bytes = commitBytes(latin1("café\n"), {
      headers: "encoding ISO-8859-1\n",
      author: "Renée",
    });
    expect((await info(bytes)).fact).toMatchObject({ summary: "café", name: "Renée" });
  });

  it("refuses a missing object, one that isn't a commit, or a corrupt one, as unreadable", async () => {
    const reader = new FakeReader();
    const blob = reader.add("blob", text("x"));
    const corrupt = reader.add("commit", latin1("tree nope\n\n"));
    const source = repoBlameSource(reader, noGraph);
    for (const oid of [unknown, blob, corrupt])
      await expect(source.commitInfo(oid)).rejects.toBeInstanceOf(BlameObjectUnreadable);
  });
});

describe("repoBlameSource's failures, as the walk sees them", () => {
  const each = (source: ReturnType<typeof repoBlameSource>, oid: Oid) => [
    () => source.fileAt(oid, [name("f")]),
    () => source.blob(oid, 10),
    () => source.commitInfo(oid),
  ];

  it("turns a spent read budget into BlameReadsSpent, from every read", async () => {
    const reader = new FakeReader();
    const oid = reader.add("blob", text("x"));
    reader.fail = () => {
      throw new ReadBudgetError(5);
    };
    for (const read of each(repoBlameSource(reader, noGraph), oid))
      await expect(read()).rejects.toBeInstanceOf(BlameReadsSpent);
  });

  it("passes the reader's own refusals through, for the walk to classify", async () => {
    for (const error of [new ReaderWorkSpent(9), new PackError("delta-too-deep", "deep")]) {
      const reader = new FakeReader();
      const oid = reader.add("blob", text("x"));
      reader.fail = () => {
        throw error;
      };
      for (const read of each(repoBlameSource(reader, noGraph), oid))
        await expect(read()).rejects.toBe(error);
    }
  });
});
