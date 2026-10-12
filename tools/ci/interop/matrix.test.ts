// The git interoperability matrix: cases ported from git's own test suite,
// run with one git binary (FYRDEN_GIT_BINARY, default `git` on PATH) against
// fyrden-api under `wrangler dev`, each compared with git's own server.
//
//   FYRDEN_INTEROP_FULL=1   every case (default: the pull request subset)
//   FYRDEN_INTEROP_PLAN     free (default) or paid
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitVersion } from "@fyrden/testing/git-cli";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BODY_LIMIT, CATALOGUE } from "./cases/index.ts";
import { compareVersions, createInterop } from "./harness.ts";
import { type Server, startServer } from "./server.ts";

const full = process.env.FYRDEN_INTEROP_FULL === "1";
const plan = process.env.FYRDEN_INTEROP_PLAN === "paid" ? "paid" : "free";
const version = await gitVersion();

let scratch = "";
let server: Server;
let next = 0;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "fyrden-interop-"));
  server = await startServer({
    persistTo: join(scratch, "state"),
    plan,
    vars: { GIT_PUSH_MAX_BODY_BYTES: String(BODY_LIMIT) },
  });
}, 120_000);

afterAll(async () => {
  await server?.stop();
  // Neither the Worker nor wrangler's access log may print a token.
  expect(server?.tokenLines() ?? []).toEqual([]);
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

describe.each(CATALOGUE.map((file) => [file.cases[0]?.from ?? "", file] as const))(
  `git ${version} against Fyrden (${plan}): %s`,
  (_, file) => {
    for (const c of file.cases) {
      const title = c.note ? `${c.test} (${c.note})` : c.test;
      const tooOld = c.minGit !== undefined && compareVersions(version, c.minGit) < 0;
      const run = tooOld || !(full || c.fast) ? it.skip : it.concurrent;
      run(title, async () => {
        const id = `c${next++}`;
        const t = await createInterop(server, join(scratch, id), version, id);
        await c.run(t);
      });
    }
  },
);
