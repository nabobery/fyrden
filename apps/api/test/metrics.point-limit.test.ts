// Analytics Engine accepts at most 250 data points per invocation and throws
// on the next one. These run pushes and ref listings that make hundreds of
// counted calls through the Worker and the repository object, with datasets
// that enforce that limit as the platform does: the operations succeed, and
// the metrics are combined per invocation instead of dropped.
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createWorkersZlib } from "@fyrden/adapters-cloudflare";
import { createFakeDataset, type RecordedPoint } from "@fyrden/adapters-cloudflare/obs/testing";
import {
  createSha1Hasher,
  encodeTag,
  hashObject,
  type MemoryBudget,
  type Oid,
  oidFromHex,
  oidToHex,
  PackBuilder,
} from "@fyrden/git-core";
import { beforeEach, describe, expect, inject, it } from "vitest";
import { createApp } from "../src/app.js";
import { basic, ORIGIN } from "./helpers/git-http.js";
import { type PushTarget, postPush, pushTarget } from "./helpers/push.js";
import { GIT_PUSH_CAPS, pushBody, ZERO } from "./helpers/push-fixtures.js";
import { inRepo } from "./helpers/repo-git.js";

const fx = inject("pushFixtures");
const MAIN = "refs/heads/main";
const UPLOAD = "git-upload-pack";
const encoder = new TextEncoder();
const unbounded: MemoryBudget = {
  reserve: async (bytes) => ({ bytes, release() {} }),
  tryReserve: (bytes) => ({ bytes, release() {} }),
};

let target: PushTarget;
let worker: ReturnType<typeof createFakeDataset>;
let repoObject: ReturnType<typeof createFakeDataset>;

beforeEach(async () => {
  target = await pushTarget();
  worker = createFakeDataset();
  repoObject = createFakeDataset();
  const dataset = repoObject.dataset;
  await inRepo(target.repo.stub, (repo) => {
    repo.metricsDataset = dataset;
  });
});

const named = (points: RecordedPoint[], name: string) => points.filter((p) => p.name === name);

async function push(body: Uint8Array) {
  const reply = await postPush(target, body, { bindings: { METRICS: worker.dataset } });
  expect(reply.status).toBe(200);
  return reply.report;
}

async function pushMain(): Promise<void> {
  const report = await push(pushBody([{ old: ZERO, new: fx.c2, ref: MAIN }], { pack: fx.packC2 }));
  expect(report).toEqual(["unpack ok\n", `ok ${MAIN}\n`, "0000"]);
}

/** `count` annotated tags of `target` (with a tagger, as git writes them) and the pack holding them. */
async function annotatedTags(
  of: string,
  count: number,
): Promise<{ tags: { name: string; oid: string }[]; pack: string }> {
  const sha1 = () => createSha1Hasher({ detectCollisions: false });
  const objects: { oid: Oid; bytes: Uint8Array }[] = [];
  const tags: { name: string; oid: string }[] = [];
  for (let i = 0; i < count; i++) {
    const name = `v${i}`;
    const bytes = encodeTag({
      object: oidFromHex(of),
      type: "commit",
      name: encoder.encode(name),
      tagger: {
        name: encoder.encode("Fyrden Test"),
        email: encoder.encode("test@fyrden.invalid"),
        timestamp: 1_770_000_000 + i,
        timezone: "+0000",
      },
      headers: [],
      message: encoder.encode(`release ${i}\n`),
    });
    const oid = await hashObject(sha1, "tag", bytes);
    objects.push({ oid, bytes });
    tags.push({ name: `refs/tags/${name}`, oid: oidToHex(oid) });
  }
  const chunks: Uint8Array[] = [];
  const builder = await PackBuilder.start(objects.length, {
    sink: { write: async (chunk) => void chunks.push(chunk.slice()) },
    zlib: createWorkersZlib(),
    memory: unbounded,
  });
  for (const object of objects) await builder.addObject("tag", object.bytes, object.oid);
  (await builder.finish()).release();
  const pack = chunks.map((c) => [...c].map((b) => b.toString(16).padStart(2, "0")).join(""));
  return { tags, pack: pack.join("") };
}

function pkt(line: string): string {
  return (encoder.encode(line).length + 4).toString(16).padStart(4, "0") + line;
}

/** Every point either dataset got stays within the budget: nothing was dropped. */
function expectNothingDropped(): void {
  expect(named(worker.points, "metrics.dropped")).toEqual([]);
  expect(named(repoObject.points, "metrics.dropped")).toEqual([]);
}

describe("the Analytics Engine point limit on real operations", () => {
  it("a non-atomic push of 30 refs commits every ref and reports success", async () => {
    await pushMain();
    repoObject.points.length = 0;
    const tags = Array.from({ length: 30 }, (_, i) => `refs/tags/t${i + 1}`);
    const report = await push(
      pushBody(
        tags.map((ref) => ({ old: ZERO, new: fx.c2, ref })),
        { pack: fx.packEmpty, caps: GIT_PUSH_CAPS },
      ),
    );
    expect(report).toEqual(["unpack ok\n", ...tags.map((ref) => `ok ${ref}\n`), "0000"]);
    const stored = await inRepo(target.repo.stub, ({ git }) =>
      [...git.refStore.readRefsSync().refs.keys()].filter((name) => name.startsWith("refs/tags/")),
    );
    expect(stored).toHaveLength(30);
    expectNothingDropped();
    // One commit per ref, but the storage gauges are written once per
    // invocation: at most one point per group for the push's commits.
    const gauges = named(repoObject.points, "git.repo.packs");
    const groups = new Set(gauges.map((p) => p.blobs[1]));
    expect(gauges.length).toBeLessThanOrEqual(groups.size * 2);
  });

  it("lists and peels 400 annotated tags", async () => {
    await pushMain();
    const { tags, pack } = await annotatedTags(fx.c2, 400);
    const report = await push(
      pushBody(
        tags.map((t) => ({ old: ZERO, new: t.oid, ref: t.name })),
        { pack, caps: [...GIT_PUSH_CAPS, "atomic"] },
      ),
    );
    expect(report.filter((line) => line.startsWith("ok "))).toHaveLength(400);
    worker.points.length = 0;
    repoObject.points.length = 0;

    const ctx = createExecutionContext();
    const response = await createApp().fetch(
      new Request(`${ORIGIN}${target.path}/${UPLOAD}`, {
        method: "POST",
        headers: {
          "Content-Type": `application/x-${UPLOAD}-request`,
          "Git-Protocol": "version=2",
          Authorization: basic(target.owner.token),
        },
        body: [
          pkt("command=ls-refs\n"),
          pkt("object-format=sha1\n"),
          "0001",
          pkt("peel\n"),
          pkt("ref-prefix refs/tags/\n"),
          "0000",
        ].join(""),
      }),
      { ...env, METRICS: worker.dataset },
      ctx,
    );
    const text = new TextDecoder().decode(await response.arrayBuffer());
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    expect(text.match(/ peeled:/g)).toHaveLength(400);
    expect(text).toContain(`${tags[399]?.oid} refs/tags/v399 peeled:${fx.c2}`);
    expectNothingDropped();
    // The object's block reads are one combined point per kind, not one per read.
    const reads = named(repoObject.points, "r2.class_b");
    expect(new Set(reads.map((p) => p.blobs.join("/"))).size).toBe(reads.length);
  });
});
