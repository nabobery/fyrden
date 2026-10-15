// The engine metrics a push and a clone write: per-invocation subrequests in
// the Worker and in the repository object, the object's active time, and the
// repository's pack count and storage after each commit.
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { repoStorage } from "@fyrden/adapters-cloudflare/git";
import { beforeEach, describe, expect, inject, it } from "vitest";
import { createApp } from "../src/app.js";
import { fetchBody, parseFetchResponse, recordingMetrics } from "./helpers/fetch-repo.js";
import { basic, ORIGIN } from "./helpers/git-http.js";
import { type PushTarget, pushTarget, RECEIVE } from "./helpers/push.js";
import { pushBody, reportLines, ZERO } from "./helpers/push-fixtures.js";
import { inRepo } from "./helpers/repo-git.js";

const fx = inject("pushFixtures");
const MAIN = "refs/heads/main";
const UPLOAD = "git-upload-pack";

type Points = ReturnType<typeof recordingMetrics>["points"];

let target: PushTarget;
let worker: ReturnType<typeof recordingMetrics>;
let repoObject: ReturnType<typeof recordingMetrics>;

beforeEach(async () => {
  target = await pushTarget();
  worker = recordingMetrics();
  repoObject = recordingMetrics();
  const dataset = repoObject.dataset;
  await inRepo(target.repo.stub, (repo) => {
    repo.metricsDataset = dataset;
  });
});

/** One request through the Worker, its body read and its background work finished. */
async function send(request: Request): Promise<Uint8Array> {
  const ctx = createExecutionContext();
  const response = await createApp().fetch(request, { ...env, METRICS: worker.dataset }, ctx);
  expect(response.status).toBe(200);
  const bytes = new Uint8Array(await response.arrayBuffer());
  await waitOnExecutionContext(ctx);
  return bytes;
}

async function pushC2(): Promise<void> {
  const body = pushBody([{ old: ZERO, new: fx.c2, ref: MAIN }], { pack: fx.packC2 });
  const bytes = await send(
    new Request(`${ORIGIN}${target.path}/${RECEIVE}`, {
      method: "POST",
      headers: {
        "Content-Type": `application/x-${RECEIVE}-request`,
        Authorization: basic(target.owner.token),
        "Content-Length": String(body.length),
      },
      body,
    }),
  );
  expect(reportLines(bytes).report).toEqual(["unpack ok\n", `ok ${MAIN}\n`, "0000"]);
}

const points = (all: Points, name: string) => all.filter((p) => p.name === name);
const sum = (all: Points, name: string, blobs: readonly string[]) =>
  points(all, name)
    .filter((p) => blobs.every((b, i) => b === "*" || p.blobs[i] === b))
    .reduce((n, p) => n + p.value, 0);

describe("engine metrics", () => {
  it("a push writes the Worker's and the object's subrequests, active time and the repository's storage", async () => {
    await pushC2();
    const route = "POST /:owner/:repo/git-receive-pack";

    // The Worker: one invocation, written once, counting its calls to the
    // object, R2 (the body PUT) and D1 (the token and repository lookups).
    const workerCalls = points(worker.points, "subrequests");
    expect(workerCalls.map((p) => p.blobs)).toEqual([["worker", "internal", route]]);
    expect(sum(worker.points, "do.request", ["RepoDO", "*"])).toBeGreaterThanOrEqual(3); // beginPush, runPush, finalizePush
    expect(sum(worker.points, "do.request", ["OrgDO", "reserveStorage"])).toBe(1);
    const objectCalls = sum(worker.points, "do.request", ["*", "*"]);
    expect(workerCalls[0]?.value).toBe(
      objectCalls +
        sum(worker.points, "r2.class_a", ["*", "*"]) +
        sum(worker.points, "r2.class_b", ["*", "*"]) +
        sum(worker.points, "d1.query", ["*", "*"]),
    );
    expect(sum(worker.points, "r2.class_a", ["fyrden-git", "put_body"])).toBe(1);

    // The object: each RPC is an invocation with its wall time and its R2 calls.
    const methods = points(repoObject.points, "do.active_ms").map((p) => p.blobs[1]);
    expect(methods).toEqual(expect.arrayContaining(["runPush", "finalizePush"]));
    for (const p of points(repoObject.points, "do.active_ms")) {
      expect(p.blobs[0]).toBe("RepoDO");
      expect(p.value).toBeGreaterThanOrEqual(0);
    }
    expect(sum(repoObject.points, "subrequests", ["do", "internal", "runPush"])).toBeGreaterThan(0);

    // The repository after the commit: one own live pack, with its bytes,
    // and every other group written as zero.
    const repoId = target.repo.id;
    const gauge = (name: string) =>
      Object.fromEntries(
        points(repoObject.points, name)
          .filter((p) => p.blobs[0] === repoId)
          .map((p) => [p.blobs[1], p.value]),
      );
    expect(gauge("git.repo.packs")).toEqual({
      live_own: 1,
      live_borrowed: 0,
      pending: 0,
      superseded: 0,
      garbage: 0,
      condemned: 0,
      discarded: 0,
      fetch: 0,
    });
    expect(gauge("git.repo.bytes").live_own).toBe(fx.packC2.length / 2);
    expect(sum(repoObject.points, "git.push", ["committed", "pushes"])).toBe(1);
  });

  it("a clone writes its subrequests once the body has been sent", async () => {
    await pushC2();
    worker.points.length = 0;
    repoObject.points.length = 0;
    const bytes = await send(
      new Request(`${ORIGIN}${target.path}/${UPLOAD}`, {
        method: "POST",
        headers: {
          "Content-Type": `application/x-${UPLOAD}-request`,
          "Git-Protocol": "version=2",
          Authorization: basic(target.owner.token),
        },
        body: fetchBody([`want ${fx.c2}`, "ofs-delta", "no-progress", "done"]),
      }),
    );
    expect(parseFetchResponse(bytes).pack).toBeDefined();

    // The Worker's count includes the R2 reads made while the body streamed
    // and the lease release after it.
    const workerCalls = points(worker.points, "subrequests");
    expect(workerCalls.map((p) => p.blobs)).toEqual([
      ["worker", "internal", "POST /:owner/:repo/git-upload-pack"],
    ]);
    const streamed = sum(worker.points, "git.fetch.calls", ["worker", "r2"]);
    expect(streamed).toBeGreaterThan(0);
    expect(sum(worker.points, "do.request", ["RepoDO", "planFetch"])).toBe(1);
    expect(sum(worker.points, "do.request", ["RepoDO", "releaseFetchLease"])).toBe(1);
    expect(workerCalls[0]?.value).toBe(
      sum(worker.points, "do.request", ["*", "*"]) +
        sum(worker.points, "r2.class_b", ["*", "*"]) +
        sum(worker.points, "d1.query", ["*", "*"]),
    );

    // The object's plan: its R2 reads match what it reported to the Worker.
    expect(points(repoObject.points, "do.active_ms").map((p) => p.blobs)).toContainEqual([
      "RepoDO",
      "planFetch",
    ]);
    expect(sum(repoObject.points, "subrequests", ["do", "internal", "planFetch"])).toBe(
      sum(worker.points, "git.fetch.calls", ["do", "r2"]),
    );
  });

  it("groups the repository's packs by state, origin and kind, leaving deleted packs out", async () => {
    const groups = await inRepo(target.repo.stub, ({ git }) => {
      const networkId = git.networkId();
      const add = (
        state: string,
        bytes: number | null,
        extra: { origin?: string; kind?: string } = {},
      ) =>
        git.context.storage.sql.exec(
          `INSERT INTO packs (pack_id, network_id, r2_key, origin, kind, state, bytes, created_at, last_touched_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)`,
          crypto.randomUUID(),
          networkId,
          "net/x/p/y.pack",
          extra.origin ?? "own",
          extra.kind ?? "receive",
          state,
          bytes,
        );
      add("live", 10);
      add("live", 20, { kind: "compact" });
      add("live", 5, { origin: "borrowed" });
      add("indexing", null);
      add("indexed", 7);
      add("superseded", 100);
      add("garbage", 3, { kind: "garbage" });
      add("condemned", 4);
      add("discarded", 1);
      add("deleted", 1_000);
      add("indexing", 50, { kind: "fetch" });
      return repoStorage(git);
    });
    expect(Object.fromEntries(groups.map((g) => [g.group, [g.packs, g.bytes]]))).toEqual({
      live_own: [2, 30],
      live_borrowed: [1, 5],
      pending: [2, 7],
      superseded: [1, 100],
      garbage: [1, 3],
      condemned: [1, 4],
      discarded: [1, 1],
      fetch: [1, 50],
    });
  });
});
