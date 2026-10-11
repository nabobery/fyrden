// The object checks of a push, through the Worker and the repository
// object: histories with legacy encodings that real repositories carry are
// accepted (zero-padded tree modes, tags without a tagger), while trees and
// .gitmodules files that would harm people who clone the repository are
// refused.
import { createWorkersZlib } from "@fyrden/adapters-cloudflare";
import {
  createSha1Hasher,
  hashObject,
  type MemoryBudget,
  type ObjectType,
  type Oid,
  oidToHex,
  PackBuilder,
} from "@fyrden/git-core";
import { describe, expect, it } from "vitest";
import { postPush, pushTarget } from "./helpers/push.js";
import { GIT_PUSH_CAPS, pushBody, ZERO } from "./helpers/push-fixtures.js";
import { inRepo } from "./helpers/repo-git.js";

const MAIN = "refs/heads/main";
const encoder = new TextEncoder();
const sha1 = () => createSha1Hasher({ detectCollisions: false });
const unbounded: MemoryBudget = {
  reserve: async (bytes) => ({ bytes, release() {} }),
  tryReserve: (bytes) => ({ bytes, release() {} }),
};

type Built = { oid: Oid; type: ObjectType; data: Uint8Array };

async function object(type: ObjectType, data: Uint8Array): Promise<Built> {
  return { oid: await hashObject(sha1, type, data), type, data };
}

const concat = (parts: readonly Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

/** A tree from raw entries: the mode text exactly as given (a zero-padded one included). */
const tree = (entries: readonly [string, string, Oid][]) =>
  object(
    "tree",
    concat(entries.map(([mode, name, oid]) => concat([encoder.encode(`${mode} ${name}\0`), oid]))),
  );

const commit = (treeOid: Oid) =>
  object(
    "commit",
    encoder.encode(
      `tree ${oidToHex(treeOid)}\nauthor A <a@fyrden.invalid> 1700000000 +0000\ncommitter A <a@fyrden.invalid> 1700000000 +0000\n\nlegacy\n`,
    ),
  );

async function packOf(objects: readonly Built[]): Promise<string> {
  const chunks: Uint8Array[] = [];
  const builder = await PackBuilder.start(objects.length, {
    sink: { write: async (chunk) => void chunks.push(chunk.slice()) },
    zlib: createWorkersZlib(),
    memory: unbounded,
  });
  for (const o of objects) await builder.addObject(o.type, o.data, o.oid);
  (await builder.finish()).release();
  return [...concat(chunks)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function push(refs: readonly [string, Oid][], objects: readonly Built[]) {
  const target = await pushTarget();
  const reply = await postPush(
    target,
    pushBody(
      refs.map(([ref, oid]) => ({ old: ZERO, new: oidToHex(oid), ref })),
      { pack: await packOf(objects), caps: GIT_PUSH_CAPS },
    ),
  );
  expect(reply.status).toBe(200);
  const refsAfter = await inRepo(target.repo.stub, ({ git }) => [
    ...git.refStore.readRefsSync().refs.keys(),
  ]);
  return { report: reply.report, progress: reply.progress.join(""), refsAfter };
}

describe("push object checks", () => {
  it("accepts a history with a zero-padded tree mode and a tag without a tagger", async () => {
    const blob = await object("blob", encoder.encode("hello\n"));
    const padded = await tree([["0100644", "a.txt", blob.oid]]);
    const c = await commit(padded.oid);
    const tag = await object(
      "tag",
      encoder.encode(`object ${oidToHex(c.oid)}\ntype commit\ntag old\n\nan early tag\n`),
    );
    const { report, progress, refsAfter } = await push(
      [
        [MAIN, c.oid],
        ["refs/tags/old", tag.oid],
      ],
      [blob, padded, c, tag],
    );
    expect(report).toEqual(["unpack ok\n", `ok ${MAIN}\n`, "ok refs/tags/old\n", "0000"]);
    expect(refsAfter.sort()).toEqual([MAIN, "refs/tags/old"]);
    // The findings reach the client as warnings.
    expect(progress).toContain("zeroPaddedFilemode");
    expect(progress).toContain("missingTaggerEntry");
  });

  it("refuses a tree with a .GIT entry", async () => {
    const blob = await object("blob", encoder.encode("[core]\n\thooksPath = x\n"));
    const inner = await tree([["100644", "config", blob.oid]]);
    const top = await tree([["40000", ".GIT", inner.oid]]);
    const c = await commit(top.oid);
    const { report, progress, refsAfter } = await push([[MAIN, c.oid]], [blob, inner, top, c]);
    // As git reports it: the unpack status, and the finding on the progress channel.
    expect(report[0]).toBe("unpack index-pack abnormal exit\n");
    expect(progress).toContain("hasDotgit: contains '.git'");
    expect(report).toContain(`ng ${MAIN} unpacker error\n`);
    expect(refsAfter).toEqual([]);
  });

  it("refuses a .gitmodules whose submodule name climbs out of the repository", async () => {
    const modules = await object(
      "blob",
      encoder.encode('[submodule "../../hooks"]\n\tpath = a\n\turl = https://example.invalid/x\n'),
    );
    const top = await tree([["100644", ".gitmodules", modules.oid]]);
    const c = await commit(top.oid);
    const { report, progress, refsAfter } = await push([[MAIN, c.oid]], [modules, top, c]);
    expect(report[0]).toBe("unpack index-pack abnormal exit\n");
    expect(progress).toContain("gitmodulesName");
    expect(refsAfter).toEqual([]);
  });
});
