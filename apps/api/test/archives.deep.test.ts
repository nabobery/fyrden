// An archive of deeply nested directories, built one entry a slice: its
// cursor (the stack of directories) is kept in one row, so it must grow
// with the path's length, not its square; past its bound the build fails.

import { createClockBlockCache } from "@fyrden/adapters-cloudflare";
import { encodeTree, type Oid, oidToHex } from "@fyrden/git-core";
import { beforeAll, describe, expect, it } from "vitest";
import { archiveJobId, RepoArchives } from "../src/do/repo/archive.js";
import { untarGz } from "./helpers/archive-read.js";
import { type BuiltObject, commit, concat, object, packOf } from "./helpers/pack-build.js";
import { type PushTarget, postPush, pushTarget } from "./helpers/push.js";
import { pushBody, ZERO } from "./helpers/push-fixtures.js";
import { inRepo } from "./helpers/repo-git.js";

const encoder = new TextEncoder();
const DEPTH = 140;
/** The directory at `level`: 200 bytes. */
const dir = (level: number) => `${level}`.padEnd(200, "d");

let target: PushTarget;
let head: string;

beforeAll(async () => {
  target = await pushTarget();
  const objects: BuiltObject[] = [];
  const file = await object("blob", encoder.encode("deep\n"));
  objects.push(file);
  // From the deepest directory up: two files in it, then one directory a level.
  let tree = await object(
    "tree",
    encodeTree(["f", "g"].map((n) => ({ mode: 0o100644, name: encoder.encode(n), oid: file.oid }))),
  );
  objects.push(tree);
  for (let level = DEPTH - 1; level >= 0; level--) {
    tree = await object(
      "tree",
      encodeTree([{ mode: 0o040000, name: encoder.encode(dir(level)), oid: tree.oid as Oid }]),
    );
    objects.push(tree);
  }
  const made = await commit(tree.oid, [], 1_700_000_000, "deep");
  head = oidToHex(made.oid);
  const reply = await postPush(
    target,
    concat([
      pushBody([{ old: ZERO, new: head, ref: "refs/heads/main" }]),
      await packOf([made, ...objects]),
    ]),
  );
  expect(reply.report.filter((line) => line.startsWith("ng"))).toEqual([]);
});

/** Builds the archive one entry a slice; the largest cursor kept, and how it ended. */
function build(prefix: string, maxCursorBytes?: number) {
  return inRepo(target.repo.stub, async ({ git }) => {
    const archives = new RepoArchives({
      git,
      memoryBlocks: createClockBlockCache(),
      policy: { sliceEntries: 1, ...(maxCursorBytes && { maxCursorBytes }) },
    });
    const input = { commit: head, mtime: 0, format: "tar.gz" as const, prefix, budgetMs: 0 };
    let status = await archives.request(input);
    const runId = git.context.storage.sql
      .exec<{ run_id: string }>("SELECT run_id FROM archives WHERE prefix = ?", prefix)
      .one().run_id;
    const jobId = archiveJobId(runId);
    let largest = 0;
    for (let rounds = 0; status.ok && status.value.state === "building"; rounds++) {
      if (rounds > 1_000) throw new Error("the archive does not finish");
      // A deadline already passed: one slice a call, so the cursor is seen after each.
      await git.jobs.runJob(jobId, archives.handler(), git.memory, git.context.now());
      largest = Math.max(largest, git.jobs.get(jobId)?.cursor?.byteLength ?? 0);
      status = await archives.request(input);
    }
    if (!status.ok) return { largest, status };
    const parts: Uint8Array[] = [];
    for (const key of status.value.state === "ready" ? status.value.keys : []) {
      const stored = await git.bucket.get(key);
      parts.push(new Uint8Array(await (stored as R2ObjectBody).arrayBuffer()));
    }
    return { largest, status, paths: untarGz(concat(parts)).entries.map((e) => e.path) };
  });
}

describe("an archive of deep directories", () => {
  it("keeps a cursor that grows with the path's length, and comes out whole", async () => {
    const built = await build("deep");
    expect(built.status).toMatchObject({ ok: true, value: { state: "ready" } });
    // Each of 140 directories' names once: tens of KiB (by whole paths, 2.6 MB).
    expect(built.largest).toBeGreaterThan(DEPTH * 200);
    expect(built.largest).toBeLessThan(80_000);
    const deepest = ["deep", ...Array.from({ length: DEPTH }, (_, i) => dir(i))].join("/");
    expect(built.paths).toContain(`${deepest}/f`);
    expect(built.paths).toContain(`${deepest}/g`);
  });

  it("fails a build whose cursor would outgrow its bound, and says so", async () => {
    const built = await build("bounded", 10_000);
    expect(built.status).toMatchObject({ ok: false, status: 422, code: "archive_failed" });
    expect(built.largest).toBeLessThanOrEqual(10_000);
  });
});
