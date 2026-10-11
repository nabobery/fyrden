// Ported from git.git t/t5546-receive-limits.sh (v2.53.0): a push larger
// than the server accepts. Fyrden's limit is on the request body (the
// interop server runs with BODY_LIMIT), git's on the pack (receive.maxInputSize).
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import type { CaseFile } from "./types.ts";

const from = "t5546-receive-limits.sh";

/** The push body limit the interop server is started with. */
export const BODY_LIMIT = 4 * 1024 * 1024;

export const t5546: CaseFile = {
  cases: [
    {
      from,
      test: "setting receive.maxInputSize to 512 rejects push",
      note: "refused with a message git shows; the refs are unchanged",
      async run(t) {
        const remotes = await t.remotes("too-large");
        const work = await t.work("too-large-work");
        await t.ok(["push", "-q", remotes.fyrden, "main"], work);
        const before = await t.lsRemote(remotes.fyrden);
        // Incompressible, so the pack is larger than the limit.
        await writeFile(join(t.scratch, work, "big.bin"), randomBytes(BODY_LIMIT + 512 * 1024));
        await t.commit(work, {}, "too big");
        const res = await t.git(["push", remotes.fyrden, "main"], { cwd: work });
        expect(res.code).not.toBe(0);
        expect(res.stderr).toMatch(/larger than this server accepts/);
        expect(await t.lsRemote(remotes.fyrden)).toEqual(before);
      },
    },
    {
      from,
      test: "bumping limit to 4k allows push",
      note: "a push just under the limit is accepted",
      async run(t) {
        const remotes = await t.remotes("under-limit");
        const work = await t.work("under-limit-work");
        await writeFile(join(t.scratch, work, "big.bin"), randomBytes(BODY_LIMIT - 512 * 1024));
        const tip = await t.commit(work, {}, "large but allowed");
        await t.ok(["push", "-q", remotes.fyrden, "main"], work);
        expect((await t.lsRemote(remotes.fyrden))["refs/heads/main"]).toBe(tip);
      },
    },
  ],
  notPorted: [
    {
      from,
      tests: [
        "prepare destination repository",
        "set unpacklimit to $unpack_limit",
        "prepare destination repository (again)",
        "lifting the limit allows push",
        "prepare destination repository (once more)",
        "receive trumps transfer",
        "create known-size (1024 bytes) commit",
      ],
      reason:
        "server configuration knobs (unpack limit, transfer vs receive settings) Fyrden does not have",
    },
  ],
};
