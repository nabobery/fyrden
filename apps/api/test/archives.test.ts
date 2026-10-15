// Archives (tarball and zipball) of the repository test/setup/browse-fixtures.ts
// built: read back here and compared with what `git ls-tree` says the commit
// holds; built in many small slices, each one run twice as after an
// eviction; refused past their limits; reachable only with read access.

import { exports } from "cloudflare:workers";
import { createClockBlockCache } from "@fyrden/adapters-cloudflare";
import { beforeAll, describe, expect, inject, it } from "vitest";
import {
  ARCHIVE_POLICY,
  type ArchiveFormat,
  archiveJobId,
  RepoArchives,
} from "../src/do/repo/archive.js";
import { type ArchivedEntry, untarGz, unzip } from "./helpers/archive-read.js";
import type { TreeLine } from "./helpers/browse-fixtures.js";
import { ORIGIN } from "./helpers/git-http.js";
import { scopedToken } from "./helpers/principals.js";
import { type PushTarget, postPush, pushTarget } from "./helpers/push.js";
import { pushBody, ZERO } from "./helpers/push-fixtures.js";
import { inRepo } from "./helpers/repo-git.js";

const fx = inject("browseFixtures");

let target: PushTarget;
let pat: string;
let handle: string;
let base: string;

beforeAll(async () => {
  target = await pushTarget();
  pat = await scopedToken(target.owner.principalId, [], "pat");
  const reply = await postPush(
    target,
    pushBody(
      fx.refs.map((r) => ({ old: ZERO, new: r.oid, ref: r.name })),
      { pack: fx.packHex },
    ),
  );
  expect(reply.report.filter((line) => line.startsWith("ng"))).toEqual([]);
  handle = target.owner.principalId.toLowerCase().replace("_", "-");
  base = `/repos/${handle}/${target.repo.name}`;
});

function get(path: string, token = pat) {
  return exports.default.fetch(`${ORIGIN}/api${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

const bytesOf = (base64: string) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));

/** What the archive of `main` must hold: its top directory, then `git ls-tree -r -t`. */
function expectedEntries(prefix: string) {
  const top = { path: prefix, type: "dir", executable: false };
  return [
    top,
    ...fx.trees.recursive.map((line: TreeLine) => ({
      path: `${prefix}/${line.path}`,
      type:
        line.mode === "040000" || line.mode === "160000"
          ? "dir"
          : line.mode === "120000"
            ? "symlink"
            : "file",
      executable: line.mode === "100755",
    })),
  ];
}

function shape(entries: readonly ArchivedEntry[]) {
  return entries.map((e) => ({ path: e.path, type: e.type, executable: e.executable }));
}

function checkContents(entries: readonly ArchivedEntry[], prefix: string) {
  const byPath = new Map(entries.map((e) => [e.path, e]));
  for (const [path, file] of Object.entries(fx.files))
    expect(byPath.get(`${prefix}/${path}`)?.data, path).toEqual(bytesOf(file.base64));
  expect(byPath.get(`${prefix}/link`)?.link).toBe("README.md");
}

describe("archives", () => {
  it("serve a .tar.gz of the default branch under owner-repo-sha/, with git's entries", async () => {
    const res = await get(`${base}/tarball`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/gzip");
    const prefix = `${handle}-${target.repo.name}-${(fx.revs.main as string).slice(0, 7)}`;
    expect(res.headers.get("Content-Disposition")).toBe(`attachment; filename="${prefix}.tar.gz"`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(String(bytes.length)).toBe(res.headers.get("Content-Length"));
    const { entries, commit } = untarGz(bytes);
    expect(commit).toBe(fx.revs.main);
    expect(shape(entries)).toEqual(expectedEntries(prefix));
    checkContents(entries, prefix);
  });

  it("answer 304 to a matching If-None-Match, without reading a segment", async () => {
    const first = await get(`${base}/tarball`);
    expect(first.status).toBe(200);
    await first.arrayBuffer();
    const etag = first.headers.get("ETag") as string;
    const again = await exports.default.fetch(`${ORIGIN}/api${base}/tarball`, {
      headers: { Authorization: `Bearer ${pat}`, "If-None-Match": etag },
    });
    expect(again.status).toBe(304);
    expect(again.headers.get("ETag")).toBe(etag);
    expect(await again.text()).toBe("");
  });

  it("serve a .zip of a tag, and the same archive again from its segments", async () => {
    const first = await get(`${base}/zipball/v1`);
    expect(first.status).toBe(200);
    const again = await get(`${base}/zipball/${fx.revs.v1}`);
    const a = new Uint8Array(await first.arrayBuffer());
    expect(new Uint8Array(await again.arrayBuffer())).toEqual(a);
    const prefix = `${handle}-${target.repo.name}-${(fx.revs.v1 as string).slice(0, 7)}`;
    const paths = unzip(a).map((e) => e.path);
    expect(paths).toContain(`${prefix}/README.md`);
    expect(paths).toContain(`${prefix}/src/lib/util.ts`);
    expect(paths).not.toContain(`${prefix}/run.sh`);
  });

  it("are built in many slices, replayed as after an eviction, and come out whole", async () => {
    for (const format of ["tar.gz", "zip"] as ArchiveFormat[]) {
      const outcome = await inRepo(target.repo.stub, async ({ git }) => {
        const archives = new RepoArchives({
          git,
          memoryBlocks: createClockBlockCache(),
          policy: { sliceBytes: 1 },
        });
        const input = {
          commit: fx.revs.main as string,
          mtime: 1_772_323_200,
          format,
          prefix: `sliced-${format}`,
          budgetMs: 0,
        };
        let status = await archives.request(input);
        const runId = git.context.storage.sql
          .exec<{ run_id: string }>("SELECT run_id FROM archives WHERE prefix = ?", input.prefix)
          .one().run_id;
        const jobId = archiveJobId(runId);
        let rounds = 0;
        while (status.ok && status.value.state === "building") {
          // A few slices, then back to where they started: the eviction of
          // a run whose segments were stored and recorded but whose cursor was not.
          const before = git.jobs.get(jobId)?.cursor ?? null;
          await git.jobs.runJob(jobId, archives.handler(), git.memory, Date.now() + 30);
          if (rounds % 2 === 0 && git.jobs.get(jobId)?.state !== "done")
            git.context.storage.sql.exec(
              "UPDATE jobs SET cursor = ?, state = 'queued', next_run_at = 0 WHERE job_id = ?",
              before,
              jobId,
            );
          rounds++;
          status = await archives.request(input);
          if (rounds > 500) throw new Error("the archive does not finish");
        }
        if (!status.ok || status.value.state !== "ready") throw new Error(JSON.stringify(status));
        const parts: Uint8Array[] = [];
        for (const key of status.value.keys) {
          const object = await git.bucket.get(key);
          parts.push(new Uint8Array(await (object as R2ObjectBody).arrayBuffer()));
        }
        return { parts, rounds, bytes: status.value.bytes };
      });
      expect(outcome.parts.length).toBeGreaterThan(5);
      const bytes = new Uint8Array(outcome.parts.reduce((n, p) => n + p.length, 0));
      // What the archive says it holds is what its segments hold, replays or not.
      expect(outcome.bytes, format).toBe(bytes.length);
      let at = 0;
      for (const part of outcome.parts) {
        bytes.set(part, at);
        at += part.length;
      }
      const prefix = `sliced-${format}`;
      const entries = format === "zip" ? unzip(bytes) : untarGz(bytes).entries;
      expect(shape(entries), format).toEqual(expectedEntries(prefix));
      checkContents(entries, prefix);
    }
  });

  it("start a new slice before a file that would take one past its bytes", async () => {
    const sizes = [...new Set(Object.values(fx.files).map((f) => bytesOf(f.base64).length))];
    for (const sliceBytes of sizes) {
      const segments = await inRepo(target.repo.stub, async ({ git }) => {
        const archives = new RepoArchives({
          git,
          memoryBlocks: createClockBlockCache(),
          policy: { sliceBytes },
        });
        const status = await archives.request({
          commit: fx.revs.main as string,
          mtime: 0,
          format: "tar.gz",
          prefix: `bounded-${sliceBytes}`,
          budgetMs: 60_000,
        });
        if (!status.ok || status.value.state !== "ready") throw new Error(JSON.stringify(status));
        const parts: Uint8Array[] = [];
        for (const key of status.value.keys) {
          const object = await git.bucket.get(key);
          parts.push(new Uint8Array(await (object as R2ObjectBody).arrayBuffer()));
        }
        return parts;
      });
      // A segment holds one file, or files within the slice's bytes together.
      for (const segment of segments) {
        const files = untarGz(segment).entries.filter((e) => e.type === "file");
        const bytes = files.reduce((n, e) => n + (e.data?.length ?? 0), 0);
        if (files.length > 1)
          expect(bytes, `slice of ${sliceBytes}`).toBeLessThanOrEqual(sliceBytes);
      }
    }
  });

  it("refuse a symbolic link whose target is too long to archive, and say so", async () => {
    const outcome = await inRepo(target.repo.stub, async ({ git }) => {
      const archives = new RepoArchives({
        git,
        memoryBlocks: createClockBlockCache(),
        policy: { maxLinkBytes: 4 },
      });
      return archives.request({
        commit: fx.revs.main as string,
        mtime: 0,
        format: "tar.gz",
        prefix: "long-link",
        budgetMs: 60_000,
      });
    });
    expect(outcome).toMatchObject({ ok: false, status: 422 });
    expect(JSON.stringify(outcome)).toContain("symbolic link");
  });

  it("hold a large file's bytes reserved, and wait for them rather than overrun the pool or fail", async () => {
    const large = Math.max(...Object.values(fx.files).map((f) => bytesOf(f.base64).length));
    expect(large).toBeGreaterThanOrEqual(1024 * 1024);
    const outcome = await inRepo(target.repo.stub, async ({ git }) => {
      // One segment allowed: a slice that gave up for memory must not count as one.
      const archives = new RepoArchives({
        git,
        memoryBlocks: createClockBlockCache(),
        policy: { maxSegments: 1, sliceBytes: 1024 * 1024 * 1024, sliceEntries: 100_000 },
      });
      const input = {
        commit: fx.revs.main as string,
        mtime: 0,
        format: "tar.gz" as const,
        prefix: "reserved",
        budgetMs: 2_000,
      };
      // All is taken but the slice's own memory, the reader's cache, and less than the
      // large file's bytes.
      const free = git.memory.stats().totalBytes - git.memory.stats().reservedBytes;
      const readerCache = 4 * 1024 * 1024;
      const taken = git.memory.tryReserve(
        free - ARCHIVE_POLICY.sliceMemoryBytes - readerCache - large + 1,
      );
      if (!taken) throw new Error("the pool is in use");
      let status: Awaited<ReturnType<typeof archives.request>>;
      try {
        status = await archives.request(input);
      } finally {
        taken.release();
      }
      const whileTaken = status.ok ? status.value.state : "failed";
      for (let i = 0; i < 50 && status.ok && status.value.state === "building"; i++) {
        const runId = git.context.storage.sql
          .exec<{ run_id: string }>("SELECT run_id FROM archives WHERE prefix = ?", input.prefix)
          .one().run_id;
        await git.jobs.runJob(
          archiveJobId(runId),
          archives.handler(),
          git.memory,
          Date.now() + 2_000,
        );
        status = await archives.request(input);
      }
      return { whileTaken, after: status.ok ? status.value.state : "failed" };
    });
    expect(outcome).toEqual({ whileTaken: "building", after: "ready" });
  });

  it("bound every slice by its entries, not only by the bytes of files", async () => {
    const outcome = await inRepo(target.repo.stub, async ({ git }) => {
      const archives = new RepoArchives({
        git,
        memoryBlocks: createClockBlockCache(),
        policy: { sliceEntries: 3 },
      });
      const input = {
        commit: fx.revs.main as string,
        mtime: 0,
        format: "tar.gz" as const,
        prefix: "few",
        budgetMs: 60_000,
      };
      const status = await archives.request(input);
      return status.ok && status.value.state === "ready" ? status.value.keys.length : -1;
    });
    // One segment per three entries.
    expect(outcome).toBe(Math.ceil((fx.trees.recursive.length + 1) / 3));
  });

  it("record no segment from a runner that lost its claim, and serve only recorded ones", async () => {
    const outcome = await inRepo(target.repo.stub, async ({ git }) => {
      const archives = new RepoArchives({
        git,
        memoryBlocks: createClockBlockCache(),
        policy: { sliceEntries: 4 },
      });
      const input = {
        commit: fx.revs.main as string,
        mtime: 0,
        format: "zip" as const,
        prefix: "fenced",
        budgetMs: 0,
      };
      await archives.request(input);
      const runId = git.context.storage.sql
        .exec<{ run_id: string }>("SELECT run_id FROM archives WHERE prefix = 'fenced'")
        .one().run_id;
      const jobId = archiveJobId(runId);
      const before = git.context.storage.sql
        .exec<{ n: number }>("SELECT count(*) AS n FROM archive_segments WHERE run_id = ?", runId)
        .one().n;
      const cursor = git.jobs.get(jobId)?.cursor ?? null;
      // A runner whose claim is gone: nothing it writes is recorded.
      const stale = await archives
        .handler()
        .runSlice({ jobId, kind: "archive", cursor, attempts: 0, claim: -1 });
      const recorded = git.context.storage.sql
        .exec<{ n: number }>("SELECT count(*) AS n FROM archive_segments WHERE run_id = ?", runId)
        .one().n;
      git.context.storage.sql.exec(
        "UPDATE jobs SET state = 'queued', next_run_at = 0, cursor = ? WHERE job_id = ?",
        cursor,
        jobId,
      );
      const ready = await archives.request({ ...input, budgetMs: 60_000 });
      const objects = (
        await git.bucket.list({ prefix: `net/${git.networkId()}/scratch/${runId}/` })
      ).objects.length;
      if (!ready.ok || ready.value.state !== "ready") throw new Error("not ready");
      let stored = 0;
      for (const key of ready.value.keys)
        stored += new Uint8Array(await ((await git.bucket.get(key)) as R2ObjectBody).arrayBuffer())
          .length;
      return {
        stale,
        recorded: recorded - before,
        keys: ready.value.keys.length,
        objects,
        bytes: ready.value.bytes,
        stored,
      };
    });
    expect(outcome.stale).toEqual({ done: true });
    expect(outcome.recorded).toBe(0);
    // The stale runner deleted the object it could not record: only recorded segments are left.
    expect(outcome.objects).toBe(outcome.keys);
    expect(outcome.bytes).toBe(outcome.stored);
  });

  it("run one slice at a time in a repository", async () => {
    const outcome = await inRepo(target.repo.stub, async ({ git }) => {
      const archives = new RepoArchives({ git, memoryBlocks: createClockBlockCache() });
      const input = {
        commit: fx.revs.main as string,
        mtime: 0,
        format: "tar.gz" as const,
        prefix: "locked",
        budgetMs: 2_000,
      };
      const lock = git.locks.tryAcquire("archive-slice", "another", 60_000);
      const blocked = await archives.request(input);
      if (lock) git.locks.release(lock);
      const done = await archives.request(input);
      return { blocked, done };
    });
    expect(outcome.blocked).toMatchObject({ ok: true, value: { state: "building", bytes: 0 } });
    expect(outcome.done).toMatchObject({ ok: true, value: { state: "ready" } });
  });

  it("turn a build whose job ran out of attempts into a failure, then start it again", async () => {
    const outcomes = await inRepo(target.repo.stub, async ({ git }) => {
      const archives = new RepoArchives({ git, memoryBlocks: createClockBlockCache() });
      const input = {
        commit: fx.revs.main as string,
        mtime: 0,
        format: "zip" as const,
        prefix: "retried",
        budgetMs: 0,
      };
      await archives.request(input);
      // However far it got, its job is now out of attempts with the archive unfinished.
      const runId = git.context.storage.sql
        .exec<{ run_id: string }>("SELECT run_id FROM archives WHERE prefix = 'retried'")
        .one().run_id;
      git.context.storage.sql.exec(
        "UPDATE archives SET state = 'building' WHERE run_id = ?",
        runId,
      );
      git.context.storage.sql.exec(
        "UPDATE jobs SET state = 'failed' WHERE job_id = ?",
        archiveJobId(runId),
      );
      const failed = await archives.request(input);
      const again = await archives.request({ ...input, budgetMs: 60_000 });
      return { failed, again };
    });
    expect(outcomes.failed).toMatchObject({ ok: false, code: "archive_failed" });
    expect(outcomes.again).toMatchObject({ ok: true, value: { state: "ready" } });
  });

  it("keep an expired archive while a download holds it, and clear it after", async () => {
    const left = await inRepo(target.repo.stub, async ({ git }) => {
      const archives = new RepoArchives({ git, memoryBlocks: createClockBlockCache() });
      const input = {
        commit: fx.revs.main as string,
        mtime: 0,
        format: "zip" as const,
        budgetMs: 60_000,
      };
      const ready = await archives.request({ ...input, prefix: "leased" });
      if (!ready.ok || ready.value.state !== "ready") throw new Error("not ready");
      // Older than the retention, but leased by the download that just started.
      git.context.storage.sql.exec("UPDATE archives SET created_at = 0 WHERE prefix = 'leased'");
      await archives.request({ ...input, prefix: "other" });
      const kept = await git.bucket.get(ready.value.keys[0] as string);
      git.context.storage.sql.exec("UPDATE archives SET leased_until = 0 WHERE prefix = 'leased'");
      await archives.request({ ...input, prefix: "another" });
      const gone = await git.bucket.get(ready.value.keys[0] as string);
      const rows = git.context.storage.sql
        .exec<{ n: number }>("SELECT count(*) AS n FROM archives WHERE prefix = 'leased'")
        .one().n;
      return { kept: kept !== null, gone: gone === null, rows };
    });
    expect(left).toEqual({ kept: true, gone: true, rows: 0 });
  });

  it("refuse a commit with a file over the limit, and say so", async () => {
    const outcome = await inRepo(target.repo.stub, async ({ git }) =>
      new RepoArchives({
        git,
        memoryBlocks: createClockBlockCache(),
        policy: { maxFileBytes: 1024 },
      }).request({
        commit: fx.revs.main as string,
        mtime: 0,
        format: "tar.gz",
        prefix: "too-big",
        budgetMs: 5_000,
      }),
    );
    expect(outcome).toMatchObject({ ok: false, status: 422, code: "archive_failed" });
  });

  it("are linked from the registry operation, and need read access", async () => {
    const link = await get(`${base}/archives/zip?ref=main`);
    expect(link.status).toBe(200);
    const body = await link.json<{ state: string; download_url: string; commit: string }>();
    expect(body).toMatchObject({ state: "ready", commit: fx.revs.main });
    expect(body.download_url).toBe(`${ORIGIN}/api${base}/zipball/${fx.revs.main}`);
    const stranger = await scopedToken((await pushTarget()).owner.principalId, [], "pat");
    expect((await get(`${base}/tarball`, stranger)).status).toBe(404);
    expect((await get(`${base}/archives/zip`, stranger)).status).toBe(404);
    const metadata = await scopedToken(target.owner.principalId, ["metadata:read"], "pat");
    expect((await get(`${base}/tarball`, metadata)).status).toBe(403);
    expect((await get(`${base}/tarball/nope`)).status).toBe(404);
  });
});
