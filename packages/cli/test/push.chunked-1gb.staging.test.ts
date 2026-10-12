// A 1 GiB push through `fyrden push --chunked`.
//
// Locally (always): the same command against a synthetic 1 GiB pack and a
// server fake that counts, so the request plan is checked without a real
// 1 GiB file: every part is one request under the body limit, the parts
// cover the pack exactly, and the request count is what staging budgets.
//
// On staging (only when FYRDEN_STAGING_REPO_URL, FYRDEN_TOKEN and
// FYRDEN_STAGING_SOURCE are set): the real command pushes a local
// repository of about 1 GiB (FYRDEN_STAGING_SOURCE, its current branch) to
// an empty staging repository and records the time taken.
import { describe, expect, it } from "vitest";
import { DEFAULT_BODY_LIMIT, push } from "../src/commands/push.ts";
import { nodePushDeps } from "../src/commands/push-node.ts";
import { deps, fakeFiles, fakeGit, fakeServer, OID } from "./fake-push.ts";

const GiB = 1024 * 1024 * 1024;
const PART = 16 * 1024 * 1024;

describe("push.chunked-1gb (local scale)", () => {
  it("plans a 1 GiB pack as 64 parts of 16 MiB, each one request under the body limit", async () => {
    const reads: [number, number][] = [];
    const files = fakeFiles();
    files.read = async (_path, offset, length) => {
      reads.push([offset, length]);
      return new Uint8Array(length);
    };
    const git = fakeGit(
      {
        remotes: { origin: "https://staging.example/alice/proj.git" },
        remoteRefs: {},
        revs: { main: OID.a },
        fullNames: { main: "refs/heads/main" },
      },
      files,
    );
    // A pack of exactly 1 GiB, never materialised.
    git.packObjects = async (_args, revs) => {
      git.packInputs.push(revs);
      return GiB;
    };
    const server = fakeServer({ partSize: PART, countOnly: true });
    const d = deps(git, files, server);
    expect(
      await push(
        {
          remote: "origin",
          refspecs: ["main"],
          chunked: true,
          force: false,
          bodyLimit: DEFAULT_BODY_LIMIT,
        },
        d,
      ),
    ).toBe(0);

    const puts = server.requests.filter((r) => r.method === "PUT");
    expect(puts).toHaveLength(64);
    expect(puts.every((p) => (p.bytes ?? 0) === PART && PART < DEFAULT_BODY_LIMIT)).toBe(true);
    // The parts tile the pack: offsets 0, 16 MiB, ... with no gap or overlap.
    expect(reads).toEqual(Array.from({ length: 64 }, (_, i) => [i * PART, PART]));
    // One create, 64 parts, one complete: 66 requests for 1 GiB.
    expect(server.requests).toHaveLength(66);
  }, 60_000);
});

const staging = {
  url: process.env.FYRDEN_STAGING_REPO_URL,
  token: process.env.FYRDEN_TOKEN,
  source: process.env.FYRDEN_STAGING_SOURCE,
};

describe.skipIf(!staging.url || !staging.token || !staging.source)(
  "push.chunked-1gb (staging)",
  () => {
    it("pushes about 1 GiB to an empty staging repository with --chunked", async () => {
      const started = Date.now();
      const cwd = process.cwd();
      process.chdir(staging.source as string);
      try {
        const code = await push(
          {
            remote: staging.url as string,
            refspecs: ["HEAD:refs/heads/main"],
            chunked: true,
            force: false,
            bodyLimit: DEFAULT_BODY_LIMIT,
          },
          nodePushDeps(),
        );
        expect(code).toBe(0);
      } finally {
        process.chdir(cwd);
      }
      console.log(`push.chunked-1gb.staging: ${Date.now() - started} ms`);
    }, 3_600_000);
  },
);
