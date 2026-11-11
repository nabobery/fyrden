import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { unusedEntries, usedHashes } from "../src/prune-turbo-cache.ts";

const run = promisify(execFile);
const script = resolve(import.meta.dirname, "../src/prune-turbo-cache.ts");

const USED = "afec79a59d28900c";
const STALE = "001738869a941fb9";
const entries = (hash: string) => [`${hash}.tar.zst`, `${hash}-meta.json`, `${hash}-manifest.json`];

describe("usedHashes", () => {
  it("collects every task hash across summaries", () => {
    const hashes = usedHashes([
      { tasks: [{ hash: USED }] },
      { tasks: [{ hash: STALE }, { hash: USED }] },
    ]);
    expect([...hashes].sort()).toEqual([STALE, USED]);
  });

  it("refuses a summary without a tasks list or a task without a hash", () => {
    expect(() => usedHashes([{}])).toThrow(/tasks list/);
    expect(() => usedHashes([null])).toThrow(/tasks list/);
    expect(() => usedHashes([{ tasks: [{ taskId: "x" }] }])).toThrow(/task hash/);
    expect(() => usedHashes([{ tasks: [{ hash: "../../etc" }] }])).toThrow(/task hash/);
  });
});

describe("unusedEntries", () => {
  it("names every file of an unused hash and nothing of a used one", () => {
    const files = [...entries(USED), ...entries(STALE)];
    expect(unusedEntries(files, new Set([USED])).sort()).toEqual(entries(STALE).sort());
  });

  it("leaves files of another shape alone", () => {
    expect(unusedEntries(["README", `${STALE}.tar.gz`, ".DS_Store"], new Set())).toEqual([]);
  });
});

describe("prune-turbo-cache (the script CI runs)", () => {
  let root: string | undefined;
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function dirs() {
    root = await mkdtemp(join(tmpdir(), "fyrden-turbo-prune-"));
    const cache = join(root, "cache");
    const runs = join(root, "runs");
    await Promise.all([mkdir(cache), mkdir(runs)]);
    await Promise.all(
      [...entries(USED), ...entries(STALE)].map((name) => writeFile(join(cache, name), "x")),
    );
    return { cache, runs };
  }

  it("removes the entries no run used", async () => {
    const { cache, runs } = await dirs();
    await writeFile(join(runs, "a.json"), JSON.stringify({ tasks: [{ hash: USED }] }));
    const { stdout } = await run(process.execPath, [script, cache, runs]);
    expect(stdout).toContain("kept 3 files, removed 3 unused");
    expect((await readdir(cache)).sort()).toEqual(entries(USED).sort());
  });

  it("fails, removing nothing, when no run summary exists", async () => {
    const { cache, runs } = await dirs();
    await expect(run(process.execPath, [script, cache, runs])).rejects.toThrow(
      /no Turbo run summaries/,
    );
    expect(await readdir(cache)).toHaveLength(6);
  });

  it("fails, removing nothing, on a malformed summary", async () => {
    const { cache, runs } = await dirs();
    await writeFile(join(runs, "a.json"), JSON.stringify({ tasks: [{}] }));
    await expect(run(process.execPath, [script, cache, runs])).rejects.toThrow(/task hash/);
    expect(await readdir(cache)).toHaveLength(6);
  });
});
