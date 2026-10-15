import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PktLineReader } from "../../src/protocol/pktline.js";
import { decodeSidebandPacket } from "../../src/protocol/sideband.js";
import { bytesBody, readPushBody } from "../../src/receive-pack/body.js";
import { planPush } from "../../src/receive-pack/commands.js";
import { finalizePush } from "../../src/receive-pack/finalize.js";
import { encodeFatalError, encodePushResponse } from "../../src/receive-pack/report.js";
import { createGitSandbox, type GitSandbox } from "../../testing/git-cli.js";
import {
  commitBody,
  gitReceivePack,
  type MemoryServer,
  memoryServer,
  oracleRepo,
  packOf,
  reportLines,
  request,
  treeBody,
  writeObject,
} from "./support.js";

/*
 * The command checks and the response encoding, against `git receive-pack`
 * fed the same request bytes (both repositories hold the same refs).
 */

let sandbox: GitSandbox;
let oracle: string;
let server: MemoryServer;
let tree: string;
let c1: string;
let c2: string;
let objects: string[];

/** Sends `body` to both; returns both reports. */
async function both(body: Uint8Array) {
  const ours = await server.push(body);
  return { ours: ours.lines, git: await gitReceivePack(sandbox, oracle, body), outcome: ours };
}

beforeAll(async () => {
  sandbox = await createGitSandbox();
  await sandbox.git(["init", "-q", "-b", "main"]);
  oracle = await oracleRepo(sandbox);
  server = memoryServer();
  const blob = await writeObject(sandbox, "blob", "x\n");
  tree = await writeObject(sandbox, "tree", treeBody([["100644", "x", blob]]));
  c1 = await writeObject(sandbox, "commit", commitBody(tree, [], "one"));
  c2 = await writeObject(sandbox, "commit", commitBody(tree, [c1], "two"));
  objects = [blob, tree, c1, c2];
  const setup = await both(
    request(
      [
        { new: c1, ref: "refs/heads/main" },
        { new: c1, ref: "refs/heads/keep" },
        { new: c1, ref: "refs/heads/gone" },
      ],
      await packOf(sandbox, objects),
    ),
  );
  expect(setup.ours).toEqual(setup.git);
});
afterAll(() => sandbox.dispose());

describe("receive-pack commands, judged by git", () => {
  it("reports compare-and-set failures with git's reasons", async () => {
    const r = await both(
      request(
        [
          { new: c2, ref: "refs/heads/main" }, // create, but it exists
          { old: c2, new: c1, ref: "refs/heads/keep" }, // stale old value
          { old: c2, new: c1, ref: "refs/heads/absent" }, // update of a ref that does not exist
          { old: c1, new: c2, ref: "refs/heads/gone" }, // fine
        ],
        await packOf(sandbox, []),
      ),
    );
    expect(r.ours).toEqual(r.git);
    expect(r.ours).toEqual([
      "unpack ok",
      "ng refs/heads/main reference already exists",
      "ng refs/heads/keep incorrect old value provided",
      "ng refs/heads/absent reference does not exist",
      "ok refs/heads/gone",
    ]);
  });

  it("refuses funny ref names as git does", async () => {
    const r = await both(
      request(
        [
          { new: c1, ref: "HEAD" },
          { new: c1, ref: "refs/one" },
          { new: c1, ref: "refs/heads/a..b" },
          { new: c1, ref: "refs/heads/x.lock" },
          { new: c1, ref: "refs/heads/ok-name" },
        ],
        await packOf(sandbox, []),
      ),
    );
    expect(r.ours).toEqual(r.git);
    expect(r.ours.filter((l) => l.endsWith("funny refname"))).toHaveLength(4);
  });

  it("refuses ref namespace conflicts as git does; a deletion in the push frees the name", async () => {
    const empty = await packOf(sandbox, []);
    const setup = await both(request([{ new: c1, ref: "refs/heads/ns" }], empty));
    expect(setup.ours).toEqual(setup.git);
    const batched = await both(
      request(
        [
          { new: c1, ref: "refs/heads/ns/sub" }, // below an existing ref
          { new: c1, ref: "refs/heads/q" }, // above another creation: refused
          { new: c1, ref: "refs/heads/q/y" }, // goes ahead
          { new: c1, ref: "refs/heads/ns-other" }, // shares a prefix only
        ],
        empty,
      ),
    );
    expect(batched.ours).toEqual(batched.git);
    expect(batched.ours).toEqual([
      "unpack ok",
      "ng refs/heads/ns/sub refname conflict",
      "ng refs/heads/q refname conflict",
      "ok refs/heads/q/y",
      "ok refs/heads/ns-other",
    ]);
    const atomic = await both(
      request(
        [
          { new: c1, ref: "refs/heads/at" },
          { new: c1, ref: "refs/heads/at/x" },
        ],
        empty,
        { capabilities: ["report-status", "atomic"] },
      ),
    );
    expect(atomic.ours).toEqual(atomic.git);
    expect(atomic.ours).toEqual([
      "unpack ok",
      "ng refs/heads/at atomic transaction failed",
      "ng refs/heads/at/x atomic transaction failed",
    ]);
    const freed = await both(
      request(
        [
          { old: c1, ref: "refs/heads/ns" },
          { new: c1, ref: "refs/heads/ns/sub" },
        ],
        empty,
      ),
    );
    expect(freed.ours).toEqual(freed.git);
    expect(freed.ours).toEqual(["unpack ok", "ok refs/heads/ns", "ok refs/heads/ns/sub"]);
  });

  it("explains a namespace conflict in git's words", async () => {
    const local = memoryServer();
    await local.push(
      request([{ new: c1, ref: "refs/heads/topic" }], await packOf(sandbox, objects)),
    );
    const body = request([{ new: c1, ref: "refs/heads/topic/sub" }], await packOf(sandbox, []), {
      capabilities: ["report-status", "atomic"],
    });
    const { request: req } = await readPushBody(bytesBody(body), { pushOptionsAdvertised: true });
    const plan = planPush(req, await local.refStore.readRefs());
    expect(plan.messages).toEqual([
      "error: cannot lock ref 'refs/heads/topic/sub': 'refs/heads/topic' exists; cannot create 'refs/heads/topic/sub'",
    ]);
    const same = request(
      [
        { new: c1, ref: "refs/heads/x/y" },
        { new: c1, ref: "refs/heads/x" },
      ],
      await packOf(sandbox, []),
    );
    const { request: sameReq } = await readPushBody(bytesBody(same), {
      pushOptionsAdvertised: true,
    });
    expect(planPush(sameReq, await local.refStore.readRefs()).messages).toEqual([
      "error: cannot process 'refs/heads/x' and 'refs/heads/x/y' at the same time",
    ]);
  });

  it("deletes in a delete-only push without a pack; a ref already gone is refused", async () => {
    const r = await both(
      request([
        { old: c2, ref: "refs/heads/gone" },
        { old: c1, ref: "refs/heads/never-existed" },
      ]),
    );
    expect(r.ours).toEqual(r.git);
    expect(r.ours).toEqual([
      "unpack ok",
      "ok refs/heads/gone",
      "ng refs/heads/never-existed reference does not exist",
    ]);
  });

  it("frames the report on side-band 1 with report-status-v2, byte for byte as git", async () => {
    const body = request(
      [{ old: c1, new: c2, ref: "refs/heads/keep" }],
      await packOf(sandbox, []),
      {
        capabilities: ["report-status-v2", "side-band-64k", "quiet", "agent=git/2.53.0"],
        pushOptions: ["ci.skip"],
      },
    );
    const ours = await server.push(body);
    const gitOut = await sandbox.gitBytes(["receive-pack", oracle], { input: body });
    const reader = new PktLineReader(gitOut);
    for (let pkt = reader.read(); pkt && pkt.kind !== "flush"; pkt = reader.read()) {}
    expect(band1(ours.response)).toEqual(band1(reader.rest()));
    expect(ours.result?.pushOptions.map((o) => Buffer.from(o).toString())).toEqual(["ci.skip"]);
    // The response ends with the flush that closes side-band.
    expect(Buffer.from(ours.response.subarray(-4)).toString()).toBe("0000");
  });

  it("refuses refs with names that are not UTF-8, or too long, per ref (git accepts both)", async () => {
    const bad = Buffer.concat([Buffer.from("refs/heads/caf"), Buffer.from([0xe9])]);
    const long = `refs/heads/${"x".repeat(1100)}`;
    const ours = await server.push(
      request(
        [
          { new: c1, ref: bad },
          { new: c1, ref: long },
          { new: c1, ref: "refs/heads/fine" },
        ],
        await packOf(sandbox, []),
      ),
    );
    expect(ours.lines).toEqual([
      "unpack ok",
      `ng ${bad.toString("latin1")} ref name must be valid UTF-8`,
      `ng ${long} ref name is longer than 1024 bytes`,
      "ok refs/heads/fine",
    ]);
  });

  it("fails every update of a ref named twice", async () => {
    const ours = await server.push(
      request(
        [
          { old: c1, new: c2, ref: "refs/heads/fine" },
          { old: c1, new: c1, ref: "refs/heads/fine" },
        ],
        await packOf(sandbox, []),
      ),
    );
    expect(ours.lines).toEqual([
      "unpack ok",
      "ng refs/heads/fine failed to update refs",
      "ng refs/heads/fine failed to update refs",
    ]);
  });

  it("answers a malformed request with an error the client prints, never a thrown error", async () => {
    const garbage = new TextEncoder().encode("0010not a command0000");
    const ours = await server.push(garbage);
    expect(reportLines(ours.response)[0]).toMatch(/^ERR protocol error: expected old\/new\/ref/);
    expect(encodeFatalError("boom", true)).toEqual(
      new Uint8Array([...Buffer.from("000a\u0003boom\n"), ...Buffer.from("0000")]),
    );
  });
});

describe("atomic and non-atomic commits", () => {
  it("fails the whole atomic push when one ref loses its compare-and-set at the commit point", async () => {
    const local = memoryServer();
    const setup = await local.push(
      request(
        [
          { new: c1, ref: "refs/heads/a" },
          { new: c1, ref: "refs/heads/b" },
        ],
        await packOf(sandbox, objects),
      ),
    );
    expect(setup.lines).toEqual(["unpack ok", "ok refs/heads/a", "ok refs/heads/b"]);
    const body = bytesBody(
      request(
        [
          { old: c1, new: c2, ref: "refs/heads/a" },
          { old: c1, new: c2, ref: "refs/heads/b" },
        ],
        await packOf(sandbox, []),
        { capabilities: ["report-status", "atomic"] },
      ),
    );
    const { request: req } = await readPushBody(body, { pushOptionsAdvertised: true });
    const plan = planPush(req, await local.refStore.readRefs());
    const commit = local.finalizeEnv().commit;
    const calls: string[][] = [];
    const result = await finalizePush(plan, undefined, "atomic-race", {
      ...local.finalizeEnv(),
      commit: async (r) => {
        calls.push(r.updates.map((u) => u.name));
        // Another push moved b after the plan.
        return { ok: false, reason: "ref-conflict", ref: "refs/heads/b" };
      },
    });
    void commit;
    expect(calls).toEqual([["refs/heads/a", "refs/heads/b"]]);
    expect(reportLines(encodePushResponse(result.report, plan.capabilities))).toEqual([
      "unpack ok",
      "ng refs/heads/a atomic transaction failed",
      "ng refs/heads/b incorrect old value provided",
    ]);
    expect(result.uploadCommitted).toBe(false);
  });

  it("commits non-atomic updates one by one, deletions first; the first success carries the upload", async () => {
    const local = memoryServer();
    await local.push(
      request(
        [
          { new: c1, ref: "refs/heads/a" },
          { new: c1, ref: "refs/heads/d" },
        ],
        await packOf(sandbox, objects),
      ),
    );
    const body = bytesBody(
      request(
        [
          { old: c1, new: c2, ref: "refs/heads/a" },
          { old: c1, ref: "refs/heads/d" },
          { new: c2, ref: "refs/heads/n" },
        ],
        await packOf(sandbox, []),
      ),
    );
    const { request: req } = await readPushBody(body, { pushOptionsAdvertised: true });
    const plan = planPush(req, await local.refStore.readRefs());
    const real = local.finalizeEnv().commit;
    const calls: [string, boolean, boolean][] = [];
    const result = await finalizePush(plan, undefined, "non-atomic", {
      ...local.finalizeEnv(),
      commit: async (r) => {
        const name = r.updates[0]?.name as string;
        calls.push([name, r.withUpload, r.fastForward.has(name)]);
        if (name === "refs/heads/d")
          return { ok: false, reason: "refused", message: "ruleset says no" };
        return real(r);
      },
    });
    expect(calls).toEqual([
      ["refs/heads/d", true, false],
      ["refs/heads/a", true, true],
      ["refs/heads/n", false, false],
    ]);
    expect(reportLines(encodePushResponse(result.report, plan.capabilities))).toEqual([
      "unpack ok",
      "ok refs/heads/a",
      "ng refs/heads/d ruleset says no",
      "ok refs/heads/n",
    ]);
    expect(result.applied.map((u) => u.name)).toEqual(["refs/heads/a", "refs/heads/n"]);
  });

  it("refuses the commands the repository's rules refuse, with their facts; atomic pushes as a whole", async () => {
    for (const atomic of [false, true]) {
      const local = memoryServer();
      await local.push(request([{ new: c1, ref: "refs/heads/a" }], await packOf(sandbox, objects)));
      const body = bytesBody(
        request(
          [
            { old: c1, new: c2, ref: "refs/heads/a" },
            { new: c2, ref: "refs/heads/n" },
          ],
          await packOf(sandbox, []),
          { capabilities: atomic ? ["report-status", "atomic"] : ["report-status"] },
        ),
      );
      const { request: req } = await readPushBody(body, { pushOptionsAdvertised: true });
      const plan = planPush(req, await local.refStore.readRefs());
      const seen: unknown[] = [];
      const result = await finalizePush(plan, undefined, `rules-${atomic}`, {
        ...local.finalizeEnv(),
        checkCommands: async (commands) => {
          seen.push(...commands.map((c) => [c.name, c.kind, c.fastForward]));
          return new Map([[1, "cannot create this ref"]]);
        },
      });
      expect(seen).toEqual([
        ["refs/heads/a", "update", true],
        ["refs/heads/n", "create", false],
      ]);
      expect(reportLines(encodePushResponse(result.report, plan.capabilities))).toEqual(
        atomic
          ? [
              "unpack ok",
              "ng refs/heads/a atomic push failure",
              "ng refs/heads/n cannot create this ref",
            ]
          : ["unpack ok", "ok refs/heads/a", "ng refs/heads/n cannot create this ref"],
      );
      expect(result.uploadCommitted).toBe(!atomic);
    }
  });

  it("refuses at the commit point a namespace conflict created after the plan", async () => {
    for (const atomic of [false, true]) {
      const local = memoryServer();
      await local.push(request([{ new: c1, ref: "refs/heads/a" }], await packOf(sandbox, objects)));
      const body = request(
        [
          { new: c1, ref: "refs/heads/r/x" },
          { old: c1, new: c2, ref: "refs/heads/a" },
        ],
        await packOf(sandbox, []),
        { capabilities: atomic ? ["report-status", "atomic"] : ["report-status"] },
      );
      const { request: req } = await readPushBody(bytesBody(body), { pushOptionsAdvertised: true });
      const plan = planPush(req, await local.refStore.readRefs());
      expect(plan.commands.map((c) => c.error)).toEqual([undefined, undefined]);
      // Another push creates refs/heads/r between the plan and the commit.
      const other = await local.push(
        request([{ new: c1, ref: "refs/heads/r" }], await packOf(sandbox, [])),
      );
      expect(other.lines).toEqual(["unpack ok", "ok refs/heads/r"]);
      const result = await finalizePush(plan, undefined, `late-${atomic}`, local.finalizeEnv());
      expect(reportLines(encodePushResponse(result.report, plan.capabilities))).toEqual(
        atomic
          ? [
              "unpack ok",
              "ng refs/heads/r/x atomic transaction failed",
              "ng refs/heads/a atomic transaction failed",
            ]
          : ["unpack ok", "ng refs/heads/r/x refname conflict", "ok refs/heads/a"],
      );
      expect(result.messages).toContain(
        "error: cannot lock ref 'refs/heads/r/x': 'refs/heads/r' exists; cannot create 'refs/heads/r/x'",
      );
      expect((await local.refStore.readRefs()).refs.has("refs/heads/r/x")).toBe(false);
    }
  });

  it("refuses non-fast-forward branch updates only when configured", async () => {
    const local = memoryServer();
    await local.push(request([{ new: c2, ref: "refs/heads/a" }], await packOf(sandbox, objects)));
    const rewind = request([{ old: c2, new: c1, ref: "refs/heads/a" }], await packOf(sandbox, []));
    const denied = await local.push(rewind, { finalize: { denyNonFastForwards: true } });
    expect(denied.lines).toEqual(["unpack ok", "ng refs/heads/a non-fast-forward"]);
    const allowed = await local.push(rewind);
    expect(allowed.lines).toEqual(["unpack ok", "ok refs/heads/a"]);
  });
});

/** The payload of side-band 1 packets, joined. */
function band1(response: Uint8Array): Buffer {
  const reader = new PktLineReader(response);
  const parts: Uint8Array[] = [];
  for (let pkt = reader.read(); pkt; pkt = reader.read()) {
    if (pkt.kind !== "data") continue;
    const frame = decodeSidebandPacket(pkt.data);
    if (frame.band === 1) parts.push(frame.payload);
  }
  return Buffer.concat(parts);
}
