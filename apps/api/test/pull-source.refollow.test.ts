// After a restore, a head's repository asks every other member of its fork
// network to follow again the pull requests whose head it is: members a
// page at a time, each member's pull requests a page at a time, within a
// bounded number of calls a slice. A member that cannot be asked is asked
// again later, the others going on meanwhile.
import type { Job, SliceResult } from "@fyrden/adapters-cloudflare/git";
import { createLogger } from "@fyrden/adapters-cloudflare/obs";
import { describe, expect, it } from "vitest";
import type { RepoDO } from "../src/do/RepoDO.js";
import { PullSource } from "../src/network/pull-source.js";
import { createRepo } from "./helpers/git-http.js";
import { setOffset } from "./helpers/maintenance.js";
import { principalWithToken } from "./helpers/principals.js";
import { inRepo } from "./helpers/repo-git.js";

interface Network {
  /** Members of the network, by id. */
  readonly count: number;
  /** Pages of pull requests a member is asked for. */
  readonly pages?: (member: string) => number;
  /** Whether asking `member` (its `attempt`th time, from 1) fails. */
  readonly fails?: (member: string, attempt: number) => boolean;
  /** Whether reading the directory's `n`th page (from 1) fails. */
  readonly directoryFails?: (n: number) => boolean;
}

/**
 * Runs `test` in a repository object with a `PullSource` asking the
 * members of `network`: `slice` runs one slice of its job (the cursor kept
 * between them), `asked` lists `member@after` for each answered ask.
 */
async function withNetwork<T>(
  network: Network,
  test: (it: {
    slice: () => Promise<SliceResult>;
    asked: string[];
    calls: () => number;
    later: (ms: number) => void;
  }) => Promise<T>,
): Promise<T> {
  const owner = await principalWithToken("user", "pat");
  const repo = await createRepo(owner.principalId);
  return inRepo(repo.stub, async (r: RepoDO) => {
    const ids = Array.from({ length: network.count }, (_, i) => `m${String(i).padStart(4, "0")}`);
    const asked: string[] = [];
    const attempts = new Map<string, number>();
    let calls = 0;
    let pagesRead = 0;
    let offset = 0;
    setOffset(r.git, offset);
    const source = new PullSource({
      git: r.git,
      repoId: () => repo.id,
      tell: async () => "applied",
      log: () => createLogger({ test: "refollow" }),
      epoch: () => 1,
      members: async (after, limit) => {
        calls++;
        if (network.directoryFails?.(++pagesRead)) throw new Error("the directory is down");
        return ids.filter((id) => id > after).slice(0, limit);
      },
      followAgain: async (member, after) => {
        calls++;
        const attempt = (attempts.get(member) ?? 0) + 1;
        attempts.set(member, attempt);
        if (network.fails?.(member, attempt)) throw new Error(`${member} is unavailable`);
        asked.push(`${member}@${after}`);
        return after + 1 < (network.pages?.(member) ?? 1) ? after + 1 : null;
      },
    });
    source.restored();
    const handler = source.refollowHandler();
    let cursor: Uint8Array | null = null;
    const slice = async () => {
      const job: Job = {
        jobId: "pull-refollow",
        kind: "pull_refollow",
        cursor,
        attempts: 0,
        claim: 1,
      };
      const result = await handler.runSlice(job);
      if (!result.done) cursor = result.cursor;
      return result;
    };
    const later = (ms: number) => {
      offset += ms;
      setOffset(r.git, offset);
    };
    return test({ slice, asked, calls: () => calls, later });
  });
}

/** Runs slices while the job has work due now; answers the last result and the calls per slice. */
async function runDue(slice: () => Promise<SliceResult>, calls: () => number) {
  const perSlice: number[] = [];
  for (;;) {
    const before = calls();
    const result = await slice();
    perSlice.push(calls() - before);
    if (result.done || (result.runAfterMs ?? 0) > 0) return { result, perSlice };
  }
}

describe("asking a network's members to follow again", () => {
  it("asks every member, past several pages of members, each from its first pull request", async () => {
    const { asked, perSlice, done } = await withNetwork({ count: 120 }, async (n) => {
      const { result, perSlice } = await runDue(n.slice, n.calls);
      return { asked: n.asked, perSlice, done: result.done };
    });
    expect(done).toBe(true);
    expect(asked).toHaveLength(120);
    expect(new Set(asked).size).toBe(120);
    expect(asked.every((a) => a.endsWith("@0"))).toBe(true);
    expect(Math.max(...perSlice)).toBeLessThanOrEqual(20);
  });

  it("goes through a member's pull requests page by page, across slices", async () => {
    const asked = await withNetwork(
      { count: 3, pages: (m) => (m === "m0001" ? 45 : 1) },
      async (n) => {
        await runDue(n.slice, n.calls);
        return n.asked;
      },
    );
    expect(asked.filter((a) => a.startsWith("m0001@"))).toEqual(
      Array.from({ length: 45 }, (_, i) => `m0001@${i}`),
    );
    expect(asked.filter((a) => !a.startsWith("m0001@"))).toEqual(["m0000@0", "m0002@0"]);
  });

  it("ends at once in a network of one", async () => {
    const { perSlice, done } = await withNetwork({ count: 0 }, async (n) => {
      const { result, perSlice } = await runDue(n.slice, n.calls);
      return { perSlice, done: result.done };
    });
    expect(done).toBe(true);
    expect(perSlice).toEqual([1]);
  });

  it("asks the others while a member is unavailable, and that one again later until it answers", async () => {
    await withNetwork(
      // The 31st member fails its first two asks, on its second page.
      {
        count: 60,
        pages: (m) => (m === "m0030" ? 2 : 1),
        fails: (m, a) => m === "m0030" && a <= 3 && a > 1,
      },
      async (n) => {
        const first = await runDue(n.slice, n.calls);
        // Everyone else is done; the failing one waits, its first page kept.
        expect(first.result.done).toBe(false);
        expect(n.asked).toHaveLength(60);
        expect(n.asked).toContain("m0030@0");
        expect(n.asked).not.toContain("m0030@1");
        // Not due yet: nothing is asked.
        const before = n.asked.length;
        expect(await n.slice()).toMatchObject({ done: false });
        expect(n.asked).toHaveLength(before);
        // Once due, asked again from where it was (and again after the second failure).
        for (let i = 0; i < 2; i++) {
          n.later(60 * 60_000);
          await runDue(n.slice, n.calls);
        }
        expect(n.asked.filter((a) => a.startsWith("m0030@"))).toEqual(["m0030@0", "m0030@1"]);
        const last = await runDue(n.slice, n.calls);
        expect(last.result.done).toBe(true);
      },
    );
  });

  it("reads the directory again later when it cannot, failing no slice", async () => {
    await withNetwork({ count: 5, directoryFails: (page) => page === 1 }, async (n) => {
      const first = await n.slice();
      expect(first.done).toBe(false);
      expect(first.done === false && (first.runAfterMs ?? 0) > 0).toBe(true);
      n.later(60 * 60_000);
      const { result } = await runDue(n.slice, n.calls);
      expect(result.done).toBe(true);
      expect(n.asked).toHaveLength(5);
    });
  });
});
