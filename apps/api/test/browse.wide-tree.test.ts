// A path's history through a commit whose tree is wide: the lookup scans the
// tree in place for the path's name, as git log does, finding the entry at
// either end of the tree, a missing name, and a file named as a directory.

import { exports } from "cloudflare:workers";
import { encodeTree, type Oid, oidToHex } from "@fyrden/git-core";
import { beforeAll, describe, expect, it } from "vitest";
import { ORIGIN } from "./helpers/git-http.js";
import { commit, concat, object, packOf } from "./helpers/pack-build.js";
import { scopedToken } from "./helpers/principals.js";
import { postPush, pushTarget } from "./helpers/push.js";
import { pushBody, ZERO } from "./helpers/push-fixtures.js";

const encoder = new TextEncoder();
const ENTRIES = 50_000;
const name = (i: number) => `f${String(i).padStart(5, "0")}`;

let pat: string;
let base: string;
let first: string;
let second: string;

/** Two commits: the first with a wide tree, the second changing its last file. */
async function widePack(): Promise<{ first: Oid; second: Oid; pack: Uint8Array }> {
  const one = await object("blob", encoder.encode("one\n"));
  const two = await object("blob", encoder.encode("two\n"));
  const tree = (last: Oid) =>
    object(
      "tree",
      encodeTree(
        Array.from({ length: ENTRIES }, (_, i) => ({
          mode: 0o100644,
          name: encoder.encode(name(i)),
          oid: i === ENTRIES - 1 ? last : one.oid,
        })),
      ),
    );
  const t1 = await tree(one.oid);
  const t2 = await tree(two.oid);
  const c1 = await commit(t1.oid, [], 1_700_000_000, "wide");
  const c2 = await commit(t2.oid, [c1.oid], 1_700_000_100, "change the last file");
  return { first: c1.oid, second: c2.oid, pack: await packOf([c2, c1, t2, t1, one, two]) };
}

async function history(path: string): Promise<string[]> {
  const res = await exports.default.fetch(
    `${ORIGIN}/api${base}/commits?${new URLSearchParams({ path })}`,
    { headers: { Authorization: `Bearer ${pat}` } },
  );
  expect(res.status, path).toBe(200);
  return (await res.json<{ commits: { sha: string }[] }>()).commits.map((c) => c.sha);
}

beforeAll(async () => {
  const target = await pushTarget();
  pat = await scopedToken(target.owner.principalId, [], "pat");
  const built = await widePack();
  first = oidToHex(built.first);
  second = oidToHex(built.second);
  const reply = await postPush(
    target,
    concat([pushBody([{ old: ZERO, new: second, ref: "refs/heads/main" }]), built.pack]),
  );
  expect(reply.report.filter((line) => line.startsWith("ng"))).toEqual([]);
  base = `/repos/${target.owner.principalId.toLowerCase().replace("_", "-")}/${target.repo.name}`;
});

describe("a path's history through a wide tree", () => {
  it("finds a file at either end of the tree, and nothing for a name it lacks", async () => {
    expect(await history(name(ENTRIES - 1))).toEqual([second, first]);
    expect(await history(name(0))).toEqual([first]);
    expect(await history("missing")).toEqual([]);
    // A file is not a directory.
    expect(await history(`${name(0)}/inside`)).toEqual([]);
  });
});
