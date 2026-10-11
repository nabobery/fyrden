import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileRepo } from "../../testing/ext-transport/file-repo.js";
import {
  compareIdxWithGit,
  createServerRepo,
  extRemote,
  reconstructRepo,
  writeExtConfig,
} from "../../testing/ext-transport/harness.js";
import { createGitSandbox, type GitSandbox } from "../../testing/git-cli.js";
import { buildRepo } from "../pack/repo-fixture.js";
import { oracleRepo, type PushRun, runPush } from "./support.js";

/*
 * Real `git push` against git-core's push path, through git's ext:: remote
 * helper and the file-backed test server. Where git itself is a fair judge,
 * the same push goes to a bare repository with `receive.fsckObjects` on and
 * the per-ref results must match. After pushes, the stored packs and refs
 * are rebuilt into a bare repository that `git fsck` checks (clone is not
 * available yet).
 */

const TIMEOUT = 60_000;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

interface Setup {
  sandbox: GitSandbox;
  server: string;
  oracle: string;
  /** Pushes to both servers with the same arguments. */
  both(...args: string[]): Promise<{ ours: PushRun; git: PushRun }>;
  ours(...args: string[]): Promise<PushRun>;
}

async function setup(shape?: {
  commits: number;
  files: number;
  binaryBytes?: number;
}): Promise<Setup> {
  const sandbox = await createGitSandbox();
  cleanups.push(() => sandbox.dispose());
  if (shape) await buildRepo(sandbox, { seed: 7, ...shape });
  else await sandbox.git(["init", "-q", "-b", "main"]);
  const { dir: server, dispose } = await createServerRepo();
  cleanups.push(dispose);
  const oracle = await oracleRepo(sandbox);
  await sandbox.git(["config", "remote.srv.url", extRemote(server)]);
  await sandbox.git(["config", "remote.oracle.url", oracle]);
  const ours = (...args: string[]) =>
    runPush(sandbox, ["-c", "protocol.ext.allow=always", "push", "--porcelain", "srv", ...args]);
  const git = (...args: string[]) => runPush(sandbox, ["push", "--porcelain", "oracle", ...args]);
  return {
    sandbox,
    server,
    oracle,
    ours,
    both: async (...args) => ({ ours: await ours(...args), git: await git(...args) }),
  };
}

async function commitFile(sandbox: GitSandbox, name: string, content: string, message = name) {
  await writeFile(join(sandbox.dir, name), content);
  await sandbox.git(["add", name]);
  await sandbox.git(["commit", "-q", "-m", message]);
}

/** The stored refs and packs pass `git fsck --strict` and hold `refs`. */
async function expectSound(s: Setup): Promise<Map<string, string>> {
  const rebuilt = await reconstructRepo(s.sandbox, s.server);
  await s.sandbox.git(["--git-dir", rebuilt, "fsck", "--strict", "--no-dangling"]);
  const { stdout } = await s.sandbox.git([
    "--git-dir",
    rebuilt,
    "for-each-ref",
    "--format=%(refname) %(objectname)",
  ]);
  return new Map(
    stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => l.split(" ") as [string, string]),
  );
}

const sameResults = (r: { ours: PushRun; git: PushRun }) => {
  expect(r.ours.lines).toEqual(r.git.lines);
  expect(r.ours.ok).toBe(r.git.ok);
};

describe("receive-pack with real git push", () => {
  it(
    "pushes a new repository, then more commits as a thin pack",
    async () => {
      const s = await setup({ commits: 12, files: 4, binaryBytes: 3000 });
      sameResults(await s.both("main~4:refs/heads/main"));
      // A thin pack: deltas against objects the server already has.
      const second = await s.both("main", "--tags");
      sameResults(second);
      expect(second.ours.lines.map((l) => l.ref).sort()).toEqual([
        "refs/heads/main",
        "refs/tags/v1",
      ]);
      const repo = await FileRepo.open(s.server);
      // Two received packs and the second push's completion pack.
      expect(repo.livePacks).toHaveLength(3);
      // The first pack and the completion pack are self-contained: their .idx is git's.
      expect(await compareIdxWithGit(s.sandbox, s.server)).toBe(2);
      const refs = await expectSound(s);
      const { stdout: head } = await s.sandbox.git(["rev-parse", "main"]);
      expect(refs.get("refs/heads/main")).toBe(head.trim());
      // Every pushed commit is a verified commit-graph row.
      const { stdout: all } = await s.sandbox.git(["rev-list", "main"]);
      const rows = await repo.commitGraph.read(
        all
          .trim()
          .split("\n")
          .map((h) => Uint8Array.from(Buffer.from(h, "hex")) as never),
        "verified",
      );
      expect(rows.every((r) => r?.state === "verified")).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "force-pushes, and honours --force-with-lease",
    async () => {
      const s = await setup();
      await commitFile(s.sandbox, "a", "1");
      await commitFile(s.sandbox, "a", "2");
      sameResults(await s.both("main"));
      await s.sandbox.git(["reset", "-q", "--hard", "HEAD~1"]);
      await commitFile(s.sandbox, "b", "rewritten");
      sameResults(await s.both("main")); // non-fast-forward, refused by the client
      const forced = await s.both("--force", "main");
      sameResults(forced);
      expect(forced.ours.lines[0]?.flag).toBe("+");
      // A lease on the value the server has: accepted.
      await commitFile(s.sandbox, "c", "again");
      await s.sandbox.git(["reset", "-q", "--hard", "HEAD~1"]);
      await commitFile(s.sandbox, "c", "other");
      // The lease names what the server has (the forced commit, now HEAD~1).
      const { stdout: leased } = await s.sandbox.git(["rev-parse", "HEAD~1"]);
      const leaseOk = await s.ours(`--force-with-lease=main:${leased.trim()}`, "main");
      expect(leaseOk.ok).toBe(true);
      // A stale lease: the client refuses before sending.
      await commitFile(s.sandbox, "d", "x");
      const stale = await s.ours(`--force-with-lease=main:${"1".repeat(40)}`, "main");
      expect(stale.ok).toBe(false);
      expect(stale.lines[0]?.summary).toContain("stale info");
      await expectSound(s);
    },
    TIMEOUT,
  );

  it(
    "deletes branches, but not the current one, as git does",
    async () => {
      const s = await setup();
      await commitFile(s.sandbox, "a", "1");
      sameResults(await s.both("main", "main:refs/heads/topic"));
      sameResults(await s.both(":refs/heads/topic"));
      const current = await s.both(":refs/heads/main");
      sameResults(current);
      expect(current.ours.lines[0]?.summary).toContain("deletion of the current branch prohibited");
      const refs = await expectSound(s);
      expect([...refs.keys()]).toEqual(["refs/heads/main"]);
    },
    TIMEOUT,
  );

  it(
    "pushes lightweight and annotated tags",
    async () => {
      const s = await setup();
      await commitFile(s.sandbox, "a", "1");
      await s.sandbox.git(["tag", "light"]);
      await s.sandbox.git(["tag", "-a", "-m", "annotated", "v1"]);
      await s.sandbox.git(["tag", "-a", "-m", "tag of a tag", "v1-again", "v1"]);
      const { stdout: blob } = await s.sandbox.git(["rev-parse", "HEAD:a"]);
      await s.sandbox.git(["tag", "-a", "-m", "a blob", "blob-tag", blob.trim()]);
      const r = await s.both("main", "--tags");
      sameResults(r);
      expect(r.ours.lines).toHaveLength(5);
      const refs = await expectSound(s);
      expect(refs.has("refs/tags/v1-again")).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "keeps push options for the push event",
    async () => {
      const s = await setup();
      await commitFile(s.sandbox, "a", "1");
      sameResults(await s.both("-o", "ci.skip", "-o", "reviewer=ada lovelace", "main"));
      const repo = await FileRepo.open(s.server);
      expect(repo.pushes.at(-1)?.pushOptions).toEqual(["ci.skip", "reviewer=ada lovelace"]);
      expect(repo.pushes.at(-1)?.applied.map((u) => u.name)).toEqual(["refs/heads/main"]);
    },
    TIMEOUT,
  );

  it(
    "refuses updates to a hidden ref (pull request refs) as git does",
    async () => {
      const s = await setup();
      await commitFile(s.sandbox, "a", "1");
      const r = await s.both("main", "main:refs/pull/1/head");
      sameResults(r);
      expect(r.ours.lines.find((l) => l.ref === "refs/pull/1/head")?.summary).toContain(
        "deny updating a hidden ref",
      );
    },
    TIMEOUT,
  );

  it(
    "refuses a corrupt commit with git's fsck message",
    async () => {
      const s = await setup();
      await commitFile(s.sandbox, "a", "1");
      const { stdout: tree } = await s.sandbox.git(["rev-parse", "HEAD^{tree}"]);
      const body = `tree ${tree.trim()}\nauthor A <a@b> notadate +0000\ncommitter A <a@b> 1 +0000\n\nbad\n`;
      const { stdout: bad } = await s.sandbox.git(
        ["hash-object", "-w", "--literally", "-t", "commit", "--stdin"],
        { input: body },
      );
      await s.sandbox.git(["update-ref", "refs/heads/bad", bad.trim()]);
      const r = await s.both("bad");
      sameResults(r);
      expect(r.ours.lines[0]?.summary).toContain("unpacker error");
      for (const run of [r.ours, r.git]) {
        expect(run.stderr).toContain(`error: object ${bad.trim()}: badDate`);
        expect(run.stderr).toContain("remote unpack failed: index-pack abnormal exit");
      }
      expect((await FileRepo.open(s.server)).livePacks).toHaveLength(0);
    },
    TIMEOUT,
  );

  it(
    "refuses a tree with a .git entry and a malicious .gitmodules",
    async () => {
      const s = await setup();
      await commitFile(s.sandbox, "a", "1");
      const { stdout: blob } = await s.sandbox.git(["rev-parse", "HEAD:a"]);
      for (const [branch, entries] of [
        ["dotgit", `100644 blob ${blob.trim()}\t.GIT\n`],
        ["gitmodules", null],
      ] as const) {
        let treeInput: string | null = entries;
        if (!treeInput) {
          const { stdout: modules } = await s.sandbox.git(["hash-object", "-w", "--stdin"], {
            input: '[submodule "../../hooks"]\n\tpath = x\n\turl = https://example.com/x\n',
          });
          treeInput = `100644 blob ${modules.trim()}\t.gitmodules\n`;
        }
        const { stdout: tree } = await s.sandbox.git(["mktree"], { input: treeInput });
        const { stdout: commit } = await s.sandbox.git(["commit-tree", "-m", branch, tree.trim()]);
        await s.sandbox.git(["update-ref", `refs/heads/${branch}`, commit.trim()]);
        const r = await s.both(branch);
        sameResults(r);
        expect(r.ours.stderr).toMatch(branch === "dotgit" ? /hasDotgit/ : /gitmodulesName/);
      }
    },
    TIMEOUT,
  );

  it(
    "applies non-atomic pushes ref by ref, atomic pushes all or nothing",
    async () => {
      const s = await setup();
      await commitFile(s.sandbox, "a", "1");
      // A ref name that is not UTF-8 (git allows any byte from 0x80): written
      // into the config, since command-line arguments are always UTF-8.
      const config = join(s.sandbox.dir, ".git", "config");
      await appendFile(
        config,
        Buffer.concat([
          Buffer.from('[remote "srvbad"]\n\turl = '),
          Buffer.from(extRemote(s.server)),
          Buffer.from(
            "\n\tpush = refs/heads/main:refs/heads/ok\n\tpush = refs/heads/main:refs/heads/bad",
          ),
          Buffer.from([0xc3, 0x28]),
          Buffer.from("\n"),
        ]),
      );
      const pushBad = (...args: string[]) =>
        runPush(s.sandbox, [
          "-c",
          "protocol.ext.allow=always",
          "push",
          "--porcelain",
          ...args,
          "srvbad",
        ]);
      const atomic = await pushBad("--atomic");
      expect(atomic.ok).toBe(false);
      const atomicByRef = new Map(
        atomic.lines.map((l) => [l.ref.endsWith("/ok") ? "ok" : "bad", l.summary]),
      );
      expect(atomicByRef).toEqual(
        new Map([
          ["ok", "[remote rejected] (atomic push failure)"],
          ["bad", "[remote rejected] (ref name must be valid UTF-8)"],
        ]),
      );
      expect((await FileRepo.open(s.server)).livePacks).toHaveLength(0);
      const plain = await pushBad();
      expect(plain.ok).toBe(false);
      const byRef = new Map(
        plain.lines.map((l) => [l.ref.endsWith("/ok") ? "ok" : "bad", l.summary]),
      );
      expect(byRef.get("ok")).toBe("[new branch]");
      expect(byRef.get("bad")).toBe("[remote rejected] (ref name must be valid UTF-8)");
      expect([...(await expectSound(s)).keys()]).toEqual(["refs/heads/ok"]);
    },
    TIMEOUT,
  );

  it(
    "refuses at the commit point when re-authorization fails, refs unchanged",
    async () => {
      const s = await setup();
      await commitFile(s.sandbox, "a", "1");
      await writeExtConfig(s.server, { revoked: "token revoked" });
      const r = await s.ours("main");
      expect(r.ok).toBe(false);
      expect(r.lines[0]?.summary).toBe("[remote rejected] (token revoked)");
      const repo = await FileRepo.open(s.server);
      expect(repo.livePacks).toHaveLength(0);
      expect((await repo.refStore.readRefs()).refs.size).toBe(0);
    },
    TIMEOUT,
  );
});
