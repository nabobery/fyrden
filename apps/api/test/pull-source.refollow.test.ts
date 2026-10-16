// After a restore, a head's repository asks every other member of its fork
// network to follow again the pull requests whose head it is: members a
// page at a time, each member's pull requests a page at a time, within a
// bounded number of calls a slice, going on from its cursor.
import type { Job } from "@fyrden/adapters-cloudflare/git";
import { describe, expect, it } from "vitest";
import { PullSource } from "../src/network/pull-source.js";

/** A network of `count` other members; `pages` of pull requests each member is asked for. */
function network(count: number, pages: (member: string) => number) {
  const ids = Array.from({ length: count }, (_, i) => `m${String(i).padStart(4, "0")}`);
  const asked: string[] = [];
  let calls = 0;
  const source = new PullSource({
    git: undefined as never,
    repoId: () => "head",
    tell: async () => "applied",
    log: () => undefined as never,
    epoch: () => 1,
    members: async (after, limit) => {
      calls++;
      return ids.filter((id) => id > after).slice(0, limit);
    },
    followAgain: async (member, after) => {
      calls++;
      asked.push(`${member}@${after}`);
      return after + 1 < pages(member) ? after + 1 : null;
    },
  });
  return { source, asked, calls: () => calls };
}

/** Runs the job's slices to the end; answers the calls each made. */
async function runToEnd(source: PullSource, calls: () => number): Promise<number[]> {
  const handler = source.refollowHandler();
  let cursor: Uint8Array | null = null;
  const perSlice: number[] = [];
  for (;;) {
    const before = calls();
    const job: Job = {
      jobId: "pull-refollow",
      kind: "pull_refollow",
      cursor,
      attempts: 0,
      claim: 1,
    };
    const result = await handler.runSlice(job);
    perSlice.push(calls() - before);
    if (result.done) return perSlice;
    cursor = result.cursor;
  }
}

describe("asking a network's members to follow again", () => {
  it("asks every member, past several pages of members, each from its first pull request", async () => {
    const { source, asked, calls } = network(120, () => 1);
    const perSlice = await runToEnd(source, calls);
    expect(asked).toHaveLength(120);
    expect(new Set(asked).size).toBe(120);
    expect(asked.every((a) => a.endsWith("@0"))).toBe(true);
    expect(Math.max(...perSlice)).toBeLessThanOrEqual(20);
  });

  it("goes through a member's pull requests page by page, across slices", async () => {
    const { source, asked, calls } = network(3, (member) => (member === "m0001" ? 45 : 1));
    await runToEnd(source, calls);
    expect(asked.filter((a) => a.startsWith("m0001@"))).toEqual(
      Array.from({ length: 45 }, (_, i) => `m0001@${i}`),
    );
    expect(asked.filter((a) => !a.startsWith("m0001@"))).toEqual(["m0000@0", "m0002@0"]);
  });

  it("ends at once in a network of one", async () => {
    const { source, asked, calls } = network(0, () => 1);
    expect(await runToEnd(source, calls)).toEqual([1]);
    expect(asked).toEqual([]);
  });
});
