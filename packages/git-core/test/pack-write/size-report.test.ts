import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { packSizeReport } from "../../src/pack-write/size-report.js";
import { createGitSandbox, type GitSandbox } from "../../testing/git-cli.js";
import { gitPackRows } from "../pack/git-oracle.js";
import { parseBytes } from "../pack/parse-helpers.js";
import { buildRepo, packObjects } from "../pack/repo-fixture.js";

/* The size report agrees with what `git verify-pack -v` says about each entry. */

let repo: GitSandbox;
beforeAll(async () => {
  repo = await createGitSandbox();
  await buildRepo(repo, { seed: 2, commits: 20, files: 4, binaryBytes: 1000 });
});
afterAll(() => repo.dispose());

describe("packSizeReport", () => {
  it("tallies whole and delta entries per type as git sees them", async () => {
    const bytes = await packObjects(repo, { ofsDelta: true });
    const { pack } = await parseBytes(bytes);
    const report = packSizeReport(pack.entries);
    pack.release();
    const rows = (await gitPackRows(repo, bytes))?.rows ?? [];
    expect(report.objects).toBe(rows.length);
    expect(report.packBytes).toBe(bytes.length);
    for (const type of ["commit", "tree", "blob", "tag"] as const) {
      for (const isDelta of [false, true]) {
        const mine = rows.filter((r) => r.type === type && (r.baseOid !== undefined) === isDelta);
        expect(report.byType[type][isDelta ? "delta" : "whole"]).toEqual({
          count: mine.length,
          bytes: mine.reduce((n, r) => n + r.sizeInPack, 0),
        });
      }
    }
    expect(report.delta.count).toBeGreaterThan(0);
    expect(report.whole.count + report.delta.count).toBe(report.objects);
  });
});
