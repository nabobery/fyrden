// Blame runs over several slices and under concurrent requests: one slice at
// a time per object, a second request for the same run waiting for it, a
// lost compare-and-set leaving nothing behind, and a run whose checkpoint
// can't be read replaced rather than failing forever.
import { createClockBlockCache } from "@fyrden/adapters-cloudflare";
import { DO_MEMORY, type RepoGitStorage } from "@fyrden/adapters-cloudflare/git";
import { describe, expect, inject, it } from "vitest";
import type { RepoDO } from "../src/do/RepoDO.js";
import {
  BLAME_SHARE_BYTES,
  type BlameAnswer,
  type BlameRequest,
  type BlameResult,
  RepoBlame,
} from "../src/do/repo/blame.js";
import { postPush, pushTarget } from "./helpers/push.js";
import { pushBody, ZERO } from "./helpers/push-fixtures.js";
import { inRepo } from "./helpers/repo-git.js";

const fx = inject("blameFixtures");

async function pushed(): Promise<{ stub: DurableObjectStub<RepoDO>; repoId: string }> {
  const target = await pushTarget();
  const reply = await postPush(
    target,
    pushBody([{ old: ZERO, new: fx.tip, ref: "refs/heads/main" }], { pack: fx.pack }),
  );
  expect(reply.report).toContain("ok refs/heads/main\n");
  return { stub: target.repo.stub, repoId: target.repo.id };
}

/** A promise and the function that settles it. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** The storage with checkpoint writes held until `release` opens; `entered` opens at the first. */
function holdingPuts(
  git: RepoGitStorage,
  release: Promise<void>,
  entered: () => void,
): RepoGitStorage {
  const bucket = new Proxy(git.bucket, {
    get(inner, property) {
      const value = Reflect.get(inner, property);
      if (property !== "put" || typeof value !== "function")
        return typeof value === "function" ? value.bind(inner) : value;
      return async (...args: unknown[]) => {
        entered();
        await release;
        return value.apply(inner, args);
      };
    },
  });
  return new Proxy(git, {
    get: (inner, property) => (property === "bucket" ? bucket : Reflect.get(inner, property)),
  });
}

type Blamer = (request: BlameRequest) => Promise<BlameResult>;

const ok = (result: BlameResult): BlameAnswer => {
  if (!result.ok) throw new Error(`${result.failure.status} ${result.failure.code}`);
  return result.value;
};

/** Every line's commit or reason, following continuations to the end. */
async function wholeFile(
  blame: Blamer,
  path: string,
): Promise<{ lines: string[]; pages: BlameAnswer[] }> {
  const pages: BlameAnswer[] = [];
  let continuation: string | undefined;
  for (let guard = 0; guard < 100; guard++) {
    const page = ok(await blame({ path, ...(continuation && { continuation }) }));
    pages.push(page);
    if (page.next_continuation === null) break;
    continuation = page.next_continuation;
  }
  const out = new Array<string>(pages.at(-1)?.lines ?? 0).fill("?");
  for (const page of pages)
    for (const r of page.ranges)
      out.fill(
        "unresolved" in r ? r.unresolved : `${r.commit}@${r.source_start_line}`,
        r.start_line - 1,
        r.start_line - 1 + r.line_count,
      );
  return { lines: out, pages };
}

const fromGit = (path: string) => (fx.blames[path] ?? []).map((g) => `${g.commit}@${g.line}`);

describe("blame runs over slices", () => {
  it("walks a run over several slices, each request a step, and ends where git does", async () => {
    const { stub, repoId } = await pushed();
    const result = await inRepo(stub, async (repo) => {
      const blame = new RepoBlame({
        git: repo.git,
        memoryBlocks: createClockBlockCache(),
        storage: repo.git.context.storage as unknown as DurableObjectStorage,
        repoId: () => repoId,
        epochGen: () => repo.events.epochGen(),
        slice: { maxSteps: 1 },
      });
      return wholeFile((r) => blame.answer(r), "f.txt");
    });
    expect(result.lines).toEqual(fromGit("f.txt"));
    expect(result.pages.length).toBeGreaterThan(2);
    expect(result.pages[0]).toMatchObject({ state: "partial" });
    expect((result.pages[0] as BlameAnswer).pending_lines).toBeGreaterThan(0);
    expect(result.pages.at(-1)).toMatchObject({ state: "complete", pending_lines: 0 });
  });

  it("runs one blame request per object: its share is over half the pool", () => {
    expect(2 * BLAME_SHARE_BYTES).toBeGreaterThan(DO_MEMORY.operationPoolBytes);
    expect(BLAME_SHARE_BYTES).toBeLessThanOrEqual(DO_MEMORY.operationPoolBytes);
  });

  it("answers busy to a second request while a slice runs, touching nothing, and a retry resumes", async () => {
    const { stub, repoId } = await pushed();
    const seen = await inRepo(stub, async (repo) => {
      const release = gate();
      const entered = gate();
      const deps = {
        memoryBlocks: createClockBlockCache(),
        storage: repo.git.context.storage as unknown as DurableObjectStorage,
        repoId: () => repoId,
        epochGen: () => repo.events.epochGen(),
        slice: { maxSteps: 1 },
      };
      const sql = repo.git.context.storage.sql;
      const snapshot = async () => ({
        rows: sql
          .exec(
            "SELECT run_id, generation, checkpoint_key, attempts, touched_at FROM blame_runs ORDER BY run_id",
          )
          .toArray(),
        objects: (await repo.git.bucket.list({ prefix: `repo/${repoId}/blame/` })).objects.map(
          (o) => o.key,
        ),
      });
      const plain = new RepoBlame({ ...deps, git: repo.git });
      const first = ok(await plain.answer({ path: "f.txt" }));
      // The held slice takes the default limits, so it finishes the run: the retry then
      // has nothing to walk, and must deliver from the checkpoint the held slice published.
      const { slice: _small, ...defaults } = deps;
      const held = new RepoBlame({
        ...defaults,
        git: holdingPuts(repo.git, release.promise, entered.open),
      });
      const running = held.answer({
        path: "f.txt",
        continuation: first.next_continuation as string,
      });
      await entered.promise;
      const during = await snapshot();
      const sameRun = await plain.answer({
        path: "f.txt",
        continuation: first.next_continuation as string,
      });
      const otherFile = await plain.answer({ path: "link" });
      const after = await snapshot();
      release.open();
      const finished = ok(await running);
      const published = sql
        .exec<{ generation: number }>("SELECT generation FROM blame_runs WHERE path = 'f.txt'")
        .one().generation;
      const retry = ok(
        await plain.answer({ path: "f.txt", continuation: first.next_continuation as string }),
      );
      const generationAfterRetry = sql
        .exec<{ generation: number }>("SELECT generation FROM blame_runs WHERE path = 'f.txt'")
        .one().generation;
      const busy = (r: BlameResult) =>
        r.ok ? "answered" : { code: r.failure.code, retryAfter: r.failure.retryAfter };
      return {
        sameRun: busy(sameRun),
        otherFile: busy(otherFile),
        untouched: JSON.stringify(after) === JSON.stringify(during),
        finishedRanges: finished.ranges,
        retryRanges: retry.ranges,
        published,
        generationAfterRetry,
      };
    });
    expect(seen.sameRun).toEqual({ code: "blame_busy", retryAfter: 1 });
    expect(seen.otherFile).toEqual({ code: "blame_busy", retryAfter: 1 });
    expect(seen.untouched).toBe(true);
    // The retry reads the checkpoint the held slice published: the same ranges, no step redone.
    expect(seen.retryRanges).toEqual(seen.finishedRanges);
    expect(seen.generationAfterRetry).toBe(seen.published);
  });

  it("leaves no object behind when the row moved under a slice, and still answers", async () => {
    const { stub, repoId } = await pushed();
    const seen = await inRepo(stub, async (repo) => {
      const release = gate();
      const entered = gate();
      const blame = new RepoBlame({
        git: holdingPuts(repo.git, release.promise, entered.open),
        memoryBlocks: createClockBlockCache(),
        storage: repo.git.context.storage as unknown as DurableObjectStorage,
        repoId: () => repoId,
        epochGen: () => repo.events.epochGen(),
      });
      const answering = blame.answer({ path: "f.txt" });
      await entered.promise;
      // As cleanup or the cap would: the row goes while the slice writes.
      repo.git.context.storage.sql.exec("DELETE FROM blame_runs");
      release.open();
      const answer = await answering;
      const listed = await repo.git.bucket.list({ prefix: `repo/${repoId}/blame/` });
      return {
        answer: answer.ok ? answer.value.state : answer.failure.code,
        objects: listed.objects.length,
      };
    });
    expect(seen.objects).toBe(0);
    expect(seen.answer).toBe("complete");
  });

  it("replaces a run whose checkpoint is damaged; its old continuation starts over", async () => {
    const { stub, repoId } = await pushed();
    const seen = await inRepo(stub, async (repo) => {
      const blame = new RepoBlame({
        git: repo.git,
        memoryBlocks: createClockBlockCache(),
        storage: repo.git.context.storage as unknown as DurableObjectStorage,
        repoId: () => repoId,
        epochGen: () => repo.events.epochGen(),
        slice: { maxSteps: 1 },
      });
      const first = ok(await blame.answer({ path: "f.txt" }));
      const runBefore = repo.git.context.storage.sql
        .exec<{ run_id: string; checkpoint_key: string; checkpoint_bytes: number }>(
          "SELECT run_id, checkpoint_key, checkpoint_bytes FROM blame_runs",
        )
        .one();
      await repo.git.bucket.put(
        runBefore.checkpoint_key,
        new Uint8Array(runBefore.checkpoint_bytes),
      );
      const old = await blame.answer({
        path: "f.txt",
        continuation: first.next_continuation as string,
      });
      const fresh = await wholeFile((r) => blame.answer(r), "f.txt");
      const runAfter = repo.git.context.storage.sql
        .exec<{ run_id: string }>("SELECT run_id FROM blame_runs")
        .toArray();
      return {
        old: old.ok ? "answered" : old.failure.code,
        lines: fresh.lines,
        replaced: runAfter.length === 1 && runAfter[0]?.run_id !== runBefore.run_id,
      };
    });
    expect(seen.old).toBe("blame_restarted");
    expect(seen.replaced).toBe(true);
    expect(seen.lines).toEqual(fromGit("f.txt"));
  });
});
