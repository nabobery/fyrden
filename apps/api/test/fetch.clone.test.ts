// Fetch and clone through the Worker and the repository object, with packs
// git wrote: verbatim plans (one pack as it is, several stitched),
// regenerated packs, negotiation, shallow, refusals, read leases and the
// R2 calls each request makes, on both plan modes.

import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, inject, it } from "vitest";
import type { FetchFixtureRepo } from "./helpers/fetch-fixtures.js";
import {
  countingBucket,
  fetchBody,
  loadFixture,
  type Plan,
  packObjects,
  parseFetchResponse,
  recordingMetrics,
  throughWorker,
} from "./helpers/fetch-repo.js";
import { basic, createRepo, ORIGIN, type TestRepo } from "./helpers/git-http.js";
import { fromHex } from "./helpers/git-oracle.js";
import { principalWithToken } from "./helpers/principals.js";
import { inRepo } from "./helpers/repo-git.js";

const fixtures = inject("fetchFixtures");
const UPLOAD = "git-upload-pack";

/** What `git clone` asks for: every ref tip, ofs-delta, no progress, done. */
const cloneArgs = (fixture: FetchFixtureRepo, extra: string[] = []) => [
  ...[...new Set(fixture.refs.map((r) => r.oid))].map((oid) => `want ${oid}`),
  "ofs-delta",
  "no-progress",
  ...extra,
  "done",
];

const tip = (fixture: FetchFixtureRepo, name: string) =>
  fixture.refs.find((r) => r.name === name)?.oid as string;

let owner: { principalId: string; token: string };
let handle: string;

beforeAll(async () => {
  owner = await principalWithToken("user", "git");
  handle = owner.principalId.toLowerCase().replace("_", "-");
});

async function repoWith(fixture: FetchFixtureRepo, options?: { allReachable?: boolean }) {
  const repo = await createRepo(owner.principalId);
  const packIds = await loadFixture(repo.stub, fixture, options);
  return { repo, packIds };
}

function uploadPackRequest(repo: TestRepo, args: readonly string[]): Request {
  return new Request(`${ORIGIN}/${handle}/${repo.name}.git/${UPLOAD}`, {
    method: "POST",
    headers: {
      "Content-Type": `application/x-${UPLOAD}-request`,
      "Git-Protocol": "version=2",
      Authorization: basic(owner.token),
    },
    body: fetchBody(args),
  });
}

interface Exchange {
  readonly bytes: Uint8Array;
  readonly r2: string[];
  readonly points: { name: string; blobs: string[]; value: number }[];
  /** Unexpired leases held while the response was being read. */
  readonly leasesDuring: number;
  readonly leasesAfter: number;
}

const liveLeases = (repo: TestRepo) =>
  inRepo(
    repo.stub,
    ({ git }) =>
      git.context.storage.sql
        .exec("SELECT count(*) AS n FROM leases WHERE expires_at > ?", Date.now())
        .one().n as number,
  );

async function exchange(repo: TestRepo, plan: Plan, args: readonly string[]): Promise<Exchange> {
  const counted = countingBucket(env.GIT);
  const metrics = recordingMetrics();
  let bytes = new Uint8Array(0);
  let leasesDuring = 0;
  await throughWorker(
    uploadPackRequest(repo, args),
    { plan, bucket: counted.bucket, metrics: metrics.dataset },
    async (response) => {
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe(`application/x-${UPLOAD}-result`);
      leasesDuring = await liveLeases(repo);
      bytes = new Uint8Array(await response.arrayBuffer());
    },
  );
  return {
    bytes,
    r2: counted.calls,
    points: metrics.points,
    leasesDuring,
    leasesAfter: await liveLeases(repo),
  };
}

const fetchMetric = (points: Exchange["points"]) =>
  points.filter((p) => p.name === "git.fetch").map((p) => p.blobs.join(" "));
const callsMetric = (points: Exchange["points"], where: string, kind: string) =>
  points
    .filter((p) => p.name === "git.fetch.calls" && p.blobs[0] === where && p.blobs[1] === kind)
    .reduce((n, p) => n + p.value, 0);

const MODES: [Plan, "stored" | "transport"][] = [
  ["free", "stored"],
  ["paid", "transport"],
  [undefined, "stored"],
];

describe.each(MODES)("fetch through the Worker (plan %s: %s framing)", (plan, mode) => {
  it("clones a one-pack repository verbatim, byte for byte, with one R2 read in the Worker", async () => {
    const { repo } = await repoWith(fixtures.single);
    const result = await exchange(repo, plan, cloneArgs(fixtures.single));
    const parsed = parseFetchResponse(result.bytes);
    expect(parsed.acknowledgments).toBeUndefined();
    expect(parsed.shallowInfo).toBeUndefined();
    expect(parsed.pack).toEqual(fromHex(fixtures.single.packs[0] as string));
    expect((await packObjects(parsed.pack as Uint8Array)).oids).toEqual(fixtures.single.objects);
    // Full side-band-64k packets, except the last.
    expect(parsed.packetSizes.slice(0, -1).every((n) => n === 65_515)).toBe(true);
    expect(result.r2).toEqual(["get"]);
    expect(fetchMetric(result.points)).toEqual([`clone as-is ${mode} false`]);
    expect(callsMetric(result.points, "worker", "r2")).toBe(1);
    // The object reads the idx whole (one GET per pack); on the stored mode
    // it also reads the pack once and writes the framed copy (one PUT).
    expect(callsMetric(result.points, "do", "r2")).toBe(mode === "stored" ? 3 : 1);
    expect(result.leasesDuring).toBeGreaterThan(0);
    expect(result.leasesAfter).toBe(0);
  });

  it("frames a pack of several packets exactly as git expects", async () => {
    const { repo } = await repoWith(fixtures.large);
    const result = await exchange(repo, plan, cloneArgs(fixtures.large));
    const parsed = parseFetchResponse(result.bytes);
    const stored = fromHex(fixtures.large.packs[0] as string);
    expect(parsed.pack?.length).toBe(stored.length);
    expect(parsed.pack).toEqual(stored);
    expect(parsed.packetSizes.length).toBe(Math.ceil(stored.length / 65_515));
    expect(parsed.packetSizes.slice(0, -1).every((n) => n === 65_515)).toBe(true);
    expect(result.r2).toEqual(["get"]);
  });

  it("serves a second clone from the same stored bytes", async () => {
    const { repo } = await repoWith(fixtures.single);
    await exchange(repo, plan, cloneArgs(fixtures.single));
    const again = await exchange(repo, plan, cloneArgs(fixtures.single));
    expect(parseFetchResponse(again.bytes).pack).toEqual(
      fromHex(fixtures.single.packs[0] as string),
    );
    expect(fetchMetric(again.points)).toEqual([`clone as-is ${mode} ${mode === "stored"}`]);
    expect(again.r2).toEqual(["get"]);
    // Only the idx: the framed copy exists already.
    expect(callsMetric(again.points, "do", "r2")).toBe(1);
  });

  it("stitches two stored packs into one pack", async () => {
    const { repo } = await repoWith(fixtures.split);
    const result = await exchange(repo, plan, cloneArgs(fixtures.split));
    const parsed = parseFetchResponse(result.bytes);
    expect((await packObjects(parsed.pack as Uint8Array)).oids).toEqual(fixtures.split.objects);
    expect(fetchMetric(result.points)).toEqual([`clone stitched ${mode} false`]);
    // One GET per stored pack, or one for the framed copy.
    expect(result.r2).toEqual(mode === "stored" ? ["get"] : ["get", "get"]);
    expect(result.leasesAfter).toBe(0);
  });

  it("regenerates the pack when the stored pack may hold unreachable objects", async () => {
    const { repo } = await repoWith(fixtures.single, { allReachable: false });
    const result = await exchange(repo, plan, cloneArgs(fixtures.single));
    const parsed = parseFetchResponse(result.bytes);
    expect((await packObjects(parsed.pack as Uint8Array)).oids).toEqual(fixtures.single.objects);
    expect(fetchMetric(result.points)).toEqual([`clone regenerated ${mode} false`]);
    expect(result.r2).toEqual(["get"]);
    expect(result.leasesAfter).toBe(0);
  });

  it("sends only what the client lacks when it has a commit", async () => {
    const { repo } = await repoWith(fixtures.single);
    const main = tip(fixtures.single, "refs/heads/main");
    const result = await exchange(repo, plan, [
      `want ${main}`,
      `have ${fixtures.have}`,
      "ofs-delta",
      "no-progress",
      "done",
    ]);
    const parsed = parseFetchResponse(result.bytes);
    expect(parsed.acknowledgments).toBeUndefined();
    expect((await packObjects(parsed.pack as Uint8Array)).oids).toEqual(fixtures.sinceHave);
    expect(fetchMetric(result.points)).toEqual([`fetch regenerated ${mode} false`]);
  });

  it("acknowledges common commits during negotiation without sending a pack until ready", async () => {
    const { repo } = await repoWith(fixtures.single);
    const main = tip(fixtures.single, "refs/heads/main");
    const unknown = "1".repeat(40);
    const result = await exchange(repo, plan, [
      `want ${main}`,
      `have ${unknown}`,
      "ofs-delta",
      "no-progress",
    ]);
    const parsed = parseFetchResponse(result.bytes);
    expect(parsed.acknowledgments).toEqual(["NAK"]);
    expect(parsed.ready).toBe(false);
    expect(parsed.pack).toBeUndefined();
    expect(result.r2).toEqual([]);
    expect(fetchMetric(result.points)).toEqual([`negotiate none ${mode} false`]);
    expect(result.leasesAfter).toBe(0);
  });

  it("answers a depth-1 clone with shallow-info and one commit's tree", async () => {
    const { repo } = await repoWith(fixtures.single);
    const main = tip(fixtures.single, "refs/heads/main");
    const result = await exchange(repo, plan, [
      `want ${main}`,
      "ofs-delta",
      "no-progress",
      "deepen 1",
      "done",
    ]);
    const parsed = parseFetchResponse(result.bytes);
    expect(parsed.shallowInfo).toEqual([`shallow ${main}`]);
    expect((await packObjects(parsed.pack as Uint8Array)).oids).toEqual(fixtures.depthOne);
  });

  it("refuses a want no ref reaches with git's error and leaves no lease", async () => {
    const { repo } = await repoWith(fixtures.single);
    const stray = "2".repeat(40);
    const result = await exchange(repo, plan, [`want ${stray}`, "ofs-delta", "done"]);
    expect(parseFetchResponse(result.bytes).error).toBe(`upload-pack: not our ref ${stray}`);
    expect(result.r2).toEqual([]);
    expect(fetchMetric(result.points)).toEqual([`refused none ${mode} false`]);
    expect(result.leasesAfter).toBe(0);
  });

  it("releases its leases when the client goes away mid-response", async () => {
    const { repo } = await repoWith(fixtures.single);
    await throughWorker(
      uploadPackRequest(repo, cloneArgs(fixtures.single)),
      { plan },
      async (response) => {
        const reader = (response.body as ReadableStream<Uint8Array>).getReader();
        await reader.read();
        await reader.cancel();
      },
    );
    expect(await liveLeases(repo)).toBe(0);
  });
});

describe("how the Worker touches pack bytes", () => {
  /**
   * Runs a clone while counting BYOB readers and JavaScript `TransformStream`s
   * made (the Worker and the object share this isolate in tests).
   */
  async function instrumentedClone(plan: Plan) {
    const { repo } = await repoWith(fixtures.large);
    const scope = globalThis as unknown as { TransformStream: typeof TransformStream };
    const original = scope.TransformStream;
    const getReader = ReadableStream.prototype.getReader;
    let byob = 0;
    let transforms = 0;
    scope.TransformStream = class extends original {
      constructor(...args: ConstructorParameters<typeof TransformStream>) {
        transforms++;
        super(...args);
      }
    };
    ReadableStream.prototype.getReader = function (this: ReadableStream, options?: unknown) {
      if ((options as { mode?: string } | undefined)?.mode === "byob") byob++;
      return getReader.call(this, options as never);
    } as typeof getReader;
    try {
      const result = await exchange(repo, plan, cloneArgs(fixtures.large));
      expect(parseFetchResponse(result.bytes).pack).toEqual(
        fromHex(fixtures.large.packs[0] as string),
      );
    } finally {
      scope.TransformStream = original;
      ReadableStream.prototype.getReader = getReader;
    }
    return { byob, transforms };
  }

  it("on Free, pipes the stored framed copy natively: no BYOB reads, no JavaScript transform", async () => {
    // The first clone writes the framed copy (in the object); the second is the steady state.
    await instrumentedClone("free");
    const { byob, transforms } = await instrumentedClone("free");
    expect(byob).toBe(0);
    expect(transforms).toBe(0);
  });

  it("on Paid, frames with BYOB reads and no JavaScript transform", async () => {
    const { byob, transforms } = await instrumentedClone("paid");
    expect(byob).toBe(1);
    expect(transforms).toBe(0);
  });
});

describe("fetch request handling", () => {
  it("answers a request without wants with nothing, as git does", async () => {
    const { repo } = await repoWith(fixtures.single);
    const result = await exchange(repo, "paid", ["done"]);
    expect(result.bytes).toEqual(new Uint8Array(0));
    expect(result.r2).toEqual([]);
  });
});
