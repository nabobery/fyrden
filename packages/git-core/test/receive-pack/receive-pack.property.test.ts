import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OBJECT_TYPES } from "../../src/object/object.js";
import { oidFromBytes, oidToHex } from "../../src/object/oid.js";
import { asPackId } from "../../src/ports/pack-store.js";
import { decodeCursor, encodeCursor, type IndexState } from "../../src/receive-pack/cursor.js";
import { parseGitConfig } from "../../src/receive-pack/git-config.js";
import { checkGitmodules, normalizeUrl } from "../../src/receive-pack/gitmodules.js";
import { createGitSandbox, type GitSandbox } from "../../testing/git-cli.js";
import { buildRepo, packObjects } from "../pack/repo-fixture.js";
import {
  commitBody,
  type MemoryServer,
  memoryServer,
  packOf,
  request,
  treeBody,
  writeObject,
} from "./support.js";

const SEED = 20261011;
const oidArb = fc.uint8Array({ minLength: 20, maxLength: 20 }).map((b) => oidFromBytes(b));
const packIdArb = fc.integer({ min: 1, max: 2 ** 40 }).map((n) => {
  const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let text = "";
  for (let i = 0, k = n; i < 26; i++, k = Math.floor(k / 32)) text = crockford[k % 32] + text;
  return asPackId(text);
});
const typeArb = fc.constantFrom(...OBJECT_TYPES);
const packArb = fc.option(
  fc.record({ packId: packIdArb, bytes: fc.nat(), objectCount: fc.nat() }),
  { nil: null },
);

const stateArb: fc.Arbitrary<IndexState> = fc
  .record({
    phase: fc.constantFrom("parse", "completion", "connect", "graph", "done" as const),
    uploadId: fc.string(),
    packOffset: fc.nat(),
    tips: fc.array(fc.record({ index: fc.nat(), oid: oidArb, branch: fc.boolean() }), {
      maxLength: 5,
    }),
    shallow: fc.array(oidArb, { maxLength: 3 }),
    received: packArb,
    completion: packArb,
    thinBases: fc.array(oidArb, { maxLength: 4 }),
    commits: fc.array(
      fc.record({
        oid: oidArb,
        tree: oidArb,
        parents: fc.array(oidArb, { maxLength: 3 }),
        commitTime: fc.double({ noNaN: true }),
      }),
      { maxLength: 5 },
    ),
    externalLinks: fc.array(fc.tuple(oidArb, typeArb), { maxLength: 5 }),
    pendingBlobs: fc.array(
      fc.record({ oid: oidArb, gitmodules: fc.boolean(), gitattributes: fc.boolean() }),
      { maxLength: 3 },
    ),
    deps: fc.array(packIdArb, { maxLength: 3 }),
    tipErrors: fc.array(fc.tuple(fc.nat(), fc.string()), { maxLength: 3 }),
    messages: fc.array(fc.string(), { maxLength: 3 }),
    failure: fc.option(
      fc.record({ status: fc.string(), messages: fc.array(fc.string(), { maxLength: 2 }) }),
      { nil: null },
    ),
  })
  .map((s) => ({ ...s, tipTypes: s.tips.map(() => null) }) as IndexState);

const hexState = (s: IndexState) =>
  JSON.stringify(s, (_, v) => (v instanceof Uint8Array ? oidToHex(v as never) : v));

describe("index cursor", () => {
  it("round-trips every state", () => {
    fc.assert(
      fc.property(stateArb, (state) => {
        expect(JSON.parse(hexState(decodeCursor(encodeCursor(state))))).toEqual(
          JSON.parse(hexState(state)),
        );
      }),
      { seed: SEED, numRuns: 300 },
    );
  });

  it("throws only RangeError for damaged cursors", () => {
    fc.assert(
      fc.property(stateArb, fc.nat(), fc.integer({ min: 0, max: 255 }), (state, at, byte) => {
        const bytes = encodeCursor(state);
        const damaged = bytes.slice(0, Math.max(5, at % (bytes.length + 1)));
        if (damaged.length > 5) damaged[at % damaged.length] = byte;
        try {
          decodeCursor(damaged);
        } catch (error) {
          expect(error).toBeInstanceOf(RangeError);
        }
      }),
      { seed: SEED, numRuns: 500 },
    );
  });
});

describe("git config parser and .gitmodules checks", () => {
  it("never throw on arbitrary bytes", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 300 }), (bytes) => {
        parseGitConfig(bytes, () => {});
        checkGitmodules(bytes);
      }),
      { seed: SEED, numRuns: 2000 },
    );
  });

  it("normalizes arbitrary URL-like text without throwing", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z]{1,5}:\/\/[a-zA-Z0-9.:@%/?#\-[\]]{0,40}$/), (url) => {
        const normalized = normalizeUrl(url);
        if (normalized !== undefined)
          expect(normalized.startsWith(url.split(":")[0] as string)).toBe(true);
      }),
      { seed: SEED, numRuns: 1000 },
    );
  });
});

let sandbox: GitSandbox;
let valid: Uint8Array;
let thinPush: Uint8Array;
let thinCreate: Uint8Array;
let seedPush: Uint8Array;

beforeAll(async () => {
  sandbox = await createGitSandbox();
  await buildRepo(sandbox, { seed: 11, commits: 6, files: 3, binaryBytes: 1500 });
  const rev = async (r: string) => (await sandbox.git(["rev-parse", r])).stdout.trim();
  const blob = await writeObject(sandbox, "blob", "fuzz\n");
  const tree = await writeObject(sandbox, "tree", treeBody([["100644", "f", blob]]));
  const commit = await writeObject(sandbox, "commit", commitBody(tree));
  valid = request(
    [{ new: commit, ref: "refs/heads/main" }],
    await packOf(sandbox, [blob, tree, commit]),
    { capabilities: ["report-status", "side-band-64k"] },
  );
  seedPush = request(
    [{ new: await rev("main~2"), ref: "refs/heads/main" }],
    await packObjects(sandbox, { revs: ["main~2"] }),
  );
  thinCreate = request(
    [{ new: await rev("main"), ref: "refs/heads/main" }],
    await packObjects(sandbox, { thin: true, revs: ["main", "^main~2"] }),
  );
  thinPush = request(
    [{ old: await rev("main~2"), new: await rev("main"), ref: "refs/heads/main" }],
    await packObjects(sandbox, { thin: true, revs: ["main", "^main~2"] }),
  );
});
afterAll(() => sandbox.dispose());

describe("receive-pack.thin-pack-fix (engine half)", () => {
  it("refuses a thin pack whose external base the repository lacks", async () => {
    const server: MemoryServer = memoryServer();
    const result = await server.push(thinCreate);
    expect(result.lines).toEqual([
      "unpack index-pack abnormal exit",
      "ng refs/heads/main unpacker error",
    ]);
    expect(result.result?.messages.join("\n")).toMatch(/fatal: missing-base: /);
  });

  it("completes a thin pack from the repository", async () => {
    const server = memoryServer();
    expect((await server.push(seedPush)).lines).toEqual(["unpack ok", "ok refs/heads/main"]);
    const result = await server.push(thinPush);
    expect(result.lines).toEqual(["unpack ok", "ok refs/heads/main"]);
    expect(result.indexed?.ok && result.indexed.packs).toHaveLength(2);
  });
});

describe("receive-pack mutation fuzz", () => {
  it("answers every mutated request with a response, never an untyped error", async () => {
    const mutations = fc.sample(
      fc.tuple(fc.nat(), fc.integer({ min: 0, max: 255 }), fc.boolean()),
      { seed: SEED, numRuns: 150 },
    );
    for (const [at, byte, truncate] of mutations) {
      const body = truncate ? valid.slice(0, at % valid.length) : valid.slice();
      if (!truncate) body[at % body.length] = byte;
      const result = await memoryServer().push(body);
      expect(result.response.length).toBeGreaterThanOrEqual(0);
    }
  }, 60_000);
});
