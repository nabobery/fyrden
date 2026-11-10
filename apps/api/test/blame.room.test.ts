// A repository object whose pack view leaves blame no room: every live pack
// takes 1 KiB of the 8 MiB room, so 8,192 of them leave none. Blame answers
// busy, whether it starts a run or loads one, as it does for a state too large
// for the room there is.
import { createClockBlockCache } from "@fyrden/adapters-cloudflare";
import { describe, expect, inject, it } from "vitest";
import type { RepoDO } from "../src/do/RepoDO.js";
import { type BlameAnswer, type BlameResult, RepoBlame } from "../src/do/repo/blame.js";
import { postPush, pushTarget } from "./helpers/push.js";
import { pushBody, ZERO } from "./helpers/push-fixtures.js";
import { inRepo } from "./helpers/repo-git.js";

const fx = inject("blameFixtures");
const NO_ROOM_PACKS = 8192;

async function pushed(): Promise<{ stub: DurableObjectStub<RepoDO>; repoId: string }> {
  const target = await pushTarget();
  const reply = await postPush(
    target,
    pushBody([{ old: ZERO, new: fx.tip, ref: "refs/heads/main" }], { pack: fx.pack }),
  );
  expect(reply.report).toContain("ok refs/heads/main\n");
  return { stub: target.repo.stub, repoId: target.repo.id };
}

const ok = (result: BlameResult): BlameAnswer => {
  if (!result.ok) throw new Error(`${result.failure.status} ${result.failure.code}`);
  return result.value;
};

const failure = (result: BlameResult) =>
  result.ok
    ? result
    : { status: result.failure.status, code: result.failure.code, message: result.failure.message };

describe("blame with no room left", () => {
  it("answers busy to a new run and to a run it would load, rather than failing", async () => {
    const { stub, repoId } = await pushed();
    const seen = await inRepo(stub, async (repo) => {
      const deps = {
        git: repo.git,
        memoryBlocks: createClockBlockCache(),
        storage: repo.git.context.storage as unknown as DurableObjectStorage,
        repoId: () => repoId,
        epochGen: () => repo.events.epochGen(),
        slice: { maxSteps: 1 },
      };
      const roomy = new RepoBlame(deps);
      const full = new RepoBlame({ ...deps, livePacks: () => NO_ROOM_PACKS });
      // A run this request would start.
      const start = failure(await full.answer({ path: "f.txt" }));
      // A run with a checkpoint, then loaded where there's no room.
      const first = ok(await roomy.answer({ path: "f.txt" }));
      const load = failure(
        await full.answer({ path: "f.txt", continuation: first.next_continuation as string }),
      );
      return { start, pending: first.pending_lines, load };
    });
    const noRoom = {
      status: 503,
      code: "blame_busy",
      message: "Blame has no room for this file right now.",
    };
    expect(seen.start).toEqual(noRoom);
    expect(seen.pending).toBeGreaterThan(0);
    expect(seen.load).toEqual(noRoom);
  });
});
