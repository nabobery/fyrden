import { describe, expect, it } from "vitest";
import { buildPack, gitOid, text } from "../pack/pack-builder.js";
import { commitBody, memoryServer, request, treeBody } from "./support.js";

/*
 * A tree entry with a mode that names no object type ends the push with
 * git's "bad mode" report. The entry's pathname is attacker-sized (a few
 * bytes of a compressed pack can carry 200,000 of them): the report quotes a
 * short, escaped excerpt of it, and the push is refused like any other
 * malformed object instead of failing with a stack overflow.
 */

describe("receive-pack: bad mode with a long pathname", () => {
  it("refuses the push with a bounded report", async () => {
    const name = `${"p".repeat(200_000)}ÿ`;
    const blob = text("x\n");
    const tree = new Uint8Array(treeBody([["140000", name, gitOid("blob", blob)]]));
    const commit = text(commitBody(gitOid("tree", tree)));
    const pack = buildPack([
      { kind: "blob", data: blob },
      { kind: "tree", data: tree },
      { kind: "commit", data: commit },
    ]).bytes;
    expect(pack.length).toBeLessThan(4096);

    const server = memoryServer();
    const outcome = await server.push(
      request([{ new: gitOid("commit", commit), ref: "refs/heads/main" }], pack),
    );
    expect(outcome.lines[0]).toBe("unpack index-pack abnormal exit");
    const report = outcome.result?.messages.find((m) => m.includes("has bad mode 140000"));
    expect(report).toBeDefined();
    expect(report?.length).toBeLessThan(400);
    expect(report).toContain("pppp");
    for (const line of outcome.lines) expect(line.length).toBeLessThan(1000);
  });
});
