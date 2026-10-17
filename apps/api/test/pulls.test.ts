// Pull requests between a repository's branches: opening, the permission
// matrix, and `refs/pull/<n>/head` following the head branch in the same
// ref transaction as the branch.
import { env } from "cloudflare:workers";
import { oidFromHex, oidToHex } from "@fyrden/git-core";
import { uniqueId } from "@fyrden/testing";
import { beforeEach, describe, expect, inject, it } from "vitest";
import { api, json, user, type Who } from "./helpers/api.js";
import { basic, gitFetch } from "./helpers/git-http.js";
import { scopedToken } from "./helpers/principals.js";
import { type PushTarget, postPush } from "./helpers/push.js";
import { pushBody, ZERO } from "./helpers/push-fixtures.js";
import { inRepo } from "./helpers/repo-git.js";

const fx = inject("pushFixtures");

type Pull = {
  number: number;
  state: string;
  draft: boolean;
  title: string;
  body: string | null;
  user: { id: string };
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  head_ref_deleted: boolean;
  code?: string;
};

let owner: Who;
let repo: { id: string; name: string };
let path: string;

async function push(
  commands: { old: string; new: string; ref: string }[],
  pack: string,
  caps?: string[],
) {
  const target: PushTarget = {
    repo: { id: repo.id, name: repo.name, stub: env.REPO.getByName(repo.id) },
    owner: {
      principalId: owner.principalId,
      token: await scopedToken(owner.principalId, [], "git"),
    },
    path: `/${owner.handle}/${repo.name}.git`,
  };
  return postPush(target, pushBody(commands, { pack, ...(caps && { caps }) }));
}

const open = (who: Who, body: Record<string, unknown>) =>
  json<Pull>(api("POST", `${path}/pulls`, who.token, { title: "Change", ...body }));
const patch = (who: Who, number: number, body: Record<string, unknown>) =>
  json<Pull>(api("PATCH", `${path}/pulls/${number}`, who.token, body));
const get = (number: number) => json<Pull>(api("GET", `${path}/pulls/${number}`, owner.token));

/** The repository's refs, as the object holds them. */
const refs = () =>
  inRepo(env.REPO.getByName(repo.id), (r) => {
    const snapshot = r.git.refStore.readRefsSync();
    return {
      version: snapshot.version,
      refs: Object.fromEntries([...snapshot.refs].map(([name, oid]) => [name, oidToHex(oid)])),
    };
  });

async function collaborator(permission: "pull" | "triage" | "push"): Promise<Who> {
  const who = await user();
  const set = await api(
    "PUT",
    `/repos/${owner.handle}/${repo.name}/collaborators/${who.handle}`,
    owner.token,
    { permission },
  );
  expect(set.status).toBe(200);
  return who;
}

beforeEach(async () => {
  owner = await user();
  repo = (
    await json<{ id: string; name: string }>(
      api("POST", "/user/repos", owner.token, { name: uniqueId("r") }),
    )
  ).body;
  path = `/repos/${owner.handle}/${repo.name}`;
  // main at c1, feature at c2 (a child of c1).
  const first = await push(
    [
      { old: ZERO, new: fx.c1, ref: "refs/heads/main" },
      { old: ZERO, new: fx.c2, ref: "refs/heads/feature" },
    ],
    fx.packC2,
  );
  expect(first.report).toContain("ok refs/heads/feature\n");
});

describe("opening a pull request", () => {
  it("records both sides and creates a fetchable refs/pull/<n>/head in the same commit", async () => {
    const before = await refs();
    const opened = await open(owner, { head: "feature", base: "main", body: "Why" });
    expect(opened.status).toBe(201);
    expect(opened.body).toMatchObject({
      number: 1,
      state: "open",
      draft: false,
      title: "Change",
      body: "Why",
      user: { id: owner.principalId },
      head: { ref: "feature", sha: fx.c2 },
      base: { ref: "main", sha: fx.c1 },
      head_ref_deleted: false,
    });
    const after = await refs();
    expect(after.version).toBe(before.version + 1);
    expect(after.refs["refs/pull/1/head"]).toBe(fx.c2);
    expect((await get(1)).body).toEqual(opened.body);
    const listed = await json<{ pull_requests: Pull[] }>(api("GET", `${path}/pulls`, owner.token));
    expect(listed.body.pull_requests.map((p) => p.number)).toEqual([1]);

    // Fetchable, as git's ls-refs lists the repository's refs; never pushable.
    const pkt = (line: string) =>
      (new TextEncoder().encode(line).length + 4).toString(16).padStart(4, "0") + line;
    const listedRefs = await gitFetch(`/${owner.handle}/${repo.name}.git/git-upload-pack`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-git-upload-pack-request",
        "Git-Protocol": "version=2",
        Authorization: basic(await scopedToken(owner.principalId, [], "git")),
      },
      body: [
        pkt("command=ls-refs\n"),
        pkt("object-format=sha1\n"),
        "0001",
        pkt("ref-prefix refs/pull/\n"),
        "0000",
      ].join(""),
    });
    expect(await listedRefs.text()).toContain(`${fx.c2} refs/pull/1/head`);
    const pushed = await push([{ old: fx.c2, new: fx.c1, ref: "refs/pull/1/head" }], fx.packEmpty);
    expect(pushed.report.join("")).toMatch(/ng refs\/pull\/1\/head/);
  });

  it("numbers pull requests in order and refuses a second one between the same branches", async () => {
    await push([{ old: ZERO, new: fx.c2, ref: "refs/heads/other" }], fx.packEmpty);
    expect((await open(owner, { head: "feature", base: "main" })).body.number).toBe(1);
    const again = await open(owner, { head: "feature", base: "main" });
    expect(again).toMatchObject({ status: 422, body: { code: "pull_exists" } });
    expect((await open(owner, { head: "other", base: "main" })).body.number).toBe(2);
  });

  it("refuses a head with nothing new, the same branch twice, and missing branches", async () => {
    expect((await open(owner, { head: "main", base: "feature" })).body.code).toBe("no_commits");
    expect((await open(owner, { head: "main", base: "main" })).body.code).toBe("same_branches");
    expect((await open(owner, { head: "nope", base: "main" })).body.code).toBe("head_not_found");
    expect((await open(owner, { head: "feature", base: "nope" })).body.code).toBe("base_not_found");
    expect((await refs()).refs["refs/pull/1/head"]).toBeUndefined();
  });

  it("lets a reader open one, and records the event and audit row with it", async () => {
    const reader = await collaborator("pull");
    const opened = await open(reader, { head: "feature", base: "main", draft: true });
    expect(opened.status).toBe(201);
    expect(opened.body).toMatchObject({ draft: true, user: { id: reader.principalId } });
    const rows = await inRepo(env.REPO.getByName(repo.id), (r) => {
      const sql = r.git.context.storage.sql;
      return {
        events: sql
          .exec<{ event: string }>("SELECT event FROM outbox ORDER BY source_seq")
          .toArray()
          .map(
            (row) =>
              JSON.parse(row.event) as {
                type: string;
                entity: { type: string; row: { number: number } } | null;
              },
          ),
        audit: sql
          .exec<{ action: string; actor_id: string }>(
            "SELECT action, actor_id FROM audit_log ORDER BY at",
          )
          .toArray(),
      };
    });
    const opening = rows.events.find((e) => e.type === "pull_request.opened");
    expect(opening?.entity).toMatchObject({ type: "pull_request", row: { number: 1 } });
    // The pull request ref is not a pushed ref.
    expect(JSON.stringify(rows.events.filter((e) => e.type === "refs.updated"))).not.toContain(
      "refs/pull/",
    );
    expect(rows.audit).toContainEqual({
      action: "pull_request.open",
      actor_id: reader.principalId,
    });
  });
});

describe("refs/pull/<n>/head follows the head branch", () => {
  it("moves with a push to the branch, in the same version", async () => {
    await open(owner, { head: "feature", base: "main" });
    const pushed = await push(
      [{ old: fx.c2, new: fx.c3, ref: "refs/heads/feature" }],
      fx.packC3ThinOnC2,
    );
    expect(pushed.report).toContain("ok refs/heads/feature\n");
    const after = await refs();
    expect(after.refs["refs/pull/1/head"]).toBe(fx.c3);
    expect((await get(1)).body.head.sha).toBe(fx.c3);
    const reflog = await inRepo(env.REPO.getByName(repo.id), (r) =>
      r.git.context.storage.sql
        .exec<{ ref: string; version: number }>(
          "SELECT ref, version FROM reflog WHERE ref IN ('refs/heads/feature', 'refs/pull/1/head') ORDER BY seq DESC LIMIT 2",
        )
        .toArray(),
    );
    expect(new Set(reflog.map((r) => r.version)).size).toBe(1);
  });

  it("moves with a file write to the branch", async () => {
    await open(owner, { head: "feature", base: "main" });
    const written = await json<{ commit: { sha: string } }>(
      api("PUT", `${path}/contents/new.txt`, owner.token, {
        message: "add",
        content: btoa("new"),
        branch: "feature",
      }),
    );
    expect(written.status).toBe(200);
    expect((await refs()).refs["refs/pull/1/head"]).toBe(written.body.commit.sha);
    expect((await get(1)).body.head.sha).toBe(written.body.commit.sha);
  });

  it("moves only the accepted head's pull request when a non-atomic push rejects another command", async () => {
    await push([{ old: ZERO, new: fx.c2, ref: "refs/heads/second" }], fx.packEmpty);
    await open(owner, { head: "feature", base: "main" });
    await open(owner, { head: "second", base: "main" });
    // `second` names a stale old value: refused, `feature` goes through.
    const pushed = await push(
      [
        { old: fx.c2, new: fx.c3, ref: "refs/heads/feature" },
        { old: fx.c1, new: fx.c3, ref: "refs/heads/second" },
      ],
      fx.packC3ThinOnC2,
    );
    expect(pushed.report).toContain("ok refs/heads/feature\n");
    const after = (await refs()).refs;
    expect(after["refs/pull/1/head"]).toBe(fx.c3);
    expect(after["refs/pull/2/head"]).toBe(fx.c2);
  });

  it("moves both pull requests of an atomic push, or neither", async () => {
    await push([{ old: ZERO, new: fx.c2, ref: "refs/heads/second" }], fx.packEmpty);
    await open(owner, { head: "feature", base: "main" });
    await open(owner, { head: "second", base: "main" });
    const atomic = ["report-status-v2", "side-band-64k", "quiet", "atomic", "object-format=sha1"];
    const refused = await push(
      [
        { old: fx.c2, new: fx.c3, ref: "refs/heads/feature" },
        { old: fx.c1, new: fx.c3, ref: "refs/heads/second" },
      ],
      fx.packC3ThinOnC2,
      atomic,
    );
    expect(refused.report.join("")).not.toContain("ok refs/heads/feature");
    expect((await refs()).refs["refs/pull/1/head"]).toBe(fx.c2);
    const both = await push(
      [
        { old: fx.c2, new: fx.c3, ref: "refs/heads/feature" },
        { old: fx.c2, new: fx.c3, ref: "refs/heads/second" },
      ],
      fx.packC3ThinOnC2,
      atomic,
    );
    expect(both.report).toContain("ok refs/heads/second\n");
    const after = await refs();
    expect([after.refs["refs/pull/1/head"], after.refs["refs/pull/2/head"]]).toEqual([
      fx.c3,
      fx.c3,
    ]);
  });

  it("stays on its last head when the branch is deleted, and follows it again once restored", async () => {
    await open(owner, { head: "feature", base: "main" });
    await push([{ old: fx.c2, new: ZERO, ref: "refs/heads/feature" }], fx.packEmpty);
    expect((await refs()).refs["refs/pull/1/head"]).toBe(fx.c2);
    expect((await get(1)).body).toMatchObject({ state: "open", head_ref_deleted: true });

    expect((await patch(owner, 1, { state: "closed" })).body.state).toBe("closed");
    expect((await patch(owner, 1, { state: "open" })).body.code).toBe("head_ref_deleted");

    await push([{ old: ZERO, new: fx.c3, ref: "refs/heads/feature" }], fx.packC3ThinOnC2);
    expect((await get(1)).body).toMatchObject({ state: "closed", head_ref_deleted: false });
    // Closed: the ref stays where it was until the pull request is reopened.
    expect((await refs()).refs["refs/pull/1/head"]).toBe(fx.c2);
    const reopened = await patch(owner, 1, { state: "open" });
    expect(reopened.body).toMatchObject({ state: "open", head: { sha: fx.c3 } });
    expect((await refs()).refs["refs/pull/1/head"]).toBe(fx.c3);
  });

  it("records the head a push made while the pull request was being opened", async () => {
    const stub = env.REPO.getByName(repo.id);
    const opened = await inRepo(stub, async (r) => {
      // A push lands between reading the tips and the commit (during the ancestry walk).
      const graph = r.git.commitGraph;
      const read = graph.read.bind(graph);
      let moved = false;
      graph.read = async (...args) => {
        if (!moved) {
          moved = true;
          const tip = r.git.refStore.readRefsSync();
          r.git.refStore.commitSync({
            addPacks: [],
            removePacks: [],
            refUpdates: [
              { name: "refs/heads/feature", oldOid: oidFromHex(fx.c2), newOid: oidFromHex(fx.c1) },
            ],
            expectedVersion: tip.version,
          });
        }
        return read(...args);
      };
      try {
        return await r.createPull(
          { title: "Race", body: null, draft: false, baseRef: "main", headRef: "feature" },
          { principal: owner.principalId, via: "api" },
        );
      } finally {
        graph.read = read;
      }
    });
    // The retry saw feature at c1: nothing new against main.
    expect(opened).toMatchObject({ ok: false, code: "no_commits" });
    expect((await refs()).refs["refs/pull/1/head"]).toBeUndefined();
  });
});

describe("a patch of several changes", () => {
  it("emits each step's snapshot with its own base: reopened on the old one, then retargeted", async () => {
    await push([{ old: ZERO, new: fx.c2, ref: "refs/heads/release" }], fx.packEmpty);
    await push([{ old: ZERO, new: fx.c3, ref: "refs/heads/feature2" }], fx.packC3ThinOnC2);
    await open(owner, { head: "feature2", base: "main" });
    await patch(owner, 1, { state: "closed" });
    const done = await patch(owner, 1, { state: "open", base: "release", title: "Both" });
    expect(done.body).toMatchObject({
      state: "open",
      title: "Both",
      base: { ref: "release", sha: fx.c2 },
    });
    const snapshots = await inRepo(env.REPO.getByName(repo.id), (r) =>
      r.git.context.storage.sql
        .exec<{ event: string }>("SELECT event FROM outbox ORDER BY source_seq")
        .toArray()
        .map(
          (row) =>
            JSON.parse(row.event) as {
              type: string;
              entity: { version: number; row: { baseRef: string; baseSha: string } } | null;
            },
        )
        .filter((e) => e.type.startsWith("pull_request.")),
    );
    expect(snapshots.map((e) => [e.type, e.entity?.row.baseRef, e.entity?.row.baseSha])).toEqual([
      ["pull_request.opened", "main", fx.c1],
      ["pull_request.closed", "main", fx.c1],
      ["pull_request.reopened", "main", fx.c1],
      ["pull_request.edited", "main", fx.c1],
      ["pull_request.edited", "release", fx.c2],
    ]);
    // Each snapshot is newer than the one before it.
    const versions = snapshots.map((e) => e.entity?.version ?? 0);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    expect(new Set(versions).size).toBe(versions.length);
  });

  it("reopens only onto an existing base, and names the open pull request it would duplicate", async () => {
    await push([{ old: ZERO, new: fx.c1, ref: "refs/heads/release" }], fx.packEmpty);
    await open(owner, { head: "feature", base: "release" });
    await patch(owner, 1, { state: "closed" });
    await push([{ old: fx.c1, new: ZERO, ref: "refs/heads/release" }], fx.packEmpty);
    expect((await patch(owner, 1, { state: "open" })).body.code).toBe("base_not_found");
    // Retargeting in the same patch reopens it onto the new base.
    await open(owner, { head: "feature", base: "main" });
    const duplicate = await json<{ code: string; detail: string }>(
      api("PATCH", `${path}/pulls/1`, owner.token, { state: "open", base: "main" }),
    );
    expect(duplicate.body.code).toBe("pull_exists");
    expect(duplicate.body.detail).toContain("#2");
    await patch(owner, 2, { state: "closed" });
    expect((await patch(owner, 1, { state: "open", base: "main" })).body).toMatchObject({
      state: "open",
      base: { ref: "main", sha: fx.c1 },
    });
  });

  it("finds a branch's pull requests through an index, whatever their state", async () => {
    const plans = await inRepo(env.REPO.getByName(repo.id), (r) =>
      [
        "SELECT number FROM pull_requests WHERE head_ref = 'x' AND state = 'open'",
        "UPDATE pull_requests SET version = version + 1 WHERE head_ref = 'x' AND state != 'merged' AND head_ref_deleted = 0",
      ].map((query) =>
        r.git.context.storage.sql
          .exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`)
          .toArray()
          .map((row) => row.detail)
          .join("; "),
      ),
    );
    for (const plan of plans) expect(plan).toMatch(/USING (COVERING )?INDEX pull_requests_head/);
  });
});

describe("the pull request matrix", () => {
  it("lets the author edit, draft, retarget, close and reopen with only a reader's role", async () => {
    const author = await collaborator("pull");
    await push([{ old: ZERO, new: fx.c1, ref: "refs/heads/release" }], fx.packEmpty);
    await open(author, { head: "feature", base: "main" });
    expect((await patch(author, 1, { title: "Better", body: "" })).body).toMatchObject({
      title: "Better",
      body: null,
    });
    expect((await patch(author, 1, { draft: true })).body.draft).toBe(true);
    expect((await patch(author, 1, { base: "release" })).body.base).toEqual({
      ref: "release",
      sha: fx.c1,
    });
    expect((await patch(author, 1, { state: "closed" })).body.state).toBe("closed");
    expect((await patch(author, 1, { state: "open" })).body.state).toBe("open");
  });

  it("gives others what their role allows: triage closes and reopens, write edits", async () => {
    await open(owner, { head: "feature", base: "main" });
    const reader = await collaborator("pull");
    const triager = await collaborator("triage");
    const writer = await collaborator("push");
    expect(await patch(reader, 1, { state: "closed" })).toMatchObject({
      status: 403,
      body: { code: "forbidden" },
    });
    expect((await patch(triager, 1, { title: "Mine now" })).status).toBe(403);
    expect((await patch(triager, 1, { state: "closed" })).body.state).toBe("closed");
    expect((await patch(triager, 1, { state: "open" })).body.state).toBe("open");
    expect((await patch(writer, 1, { title: "Edited" })).body.title).toBe("Edited");
    // All or nothing: a reader's close fails the whole patch, title included.
    expect((await patch(reader, 1, { title: "Sneaky", state: "closed" })).status).toBe(403);
    expect((await get(1)).body).toMatchObject({ title: "Edited", state: "open" });
  });

  it("retargets onto a protected branch: rules apply when merging, not to the pull request", async () => {
    await push([{ old: ZERO, new: fx.c1, ref: "refs/heads/stable" }], fx.packEmpty);
    const ruleset = await api("POST", `${path}/rulesets`, owner.token, {
      name: "protect stable",
      enforcement: "active",
      conditions: { ref_name: { include: ["refs/heads/stable"] } },
      rules: [{ type: "pull_request" }],
    });
    expect(ruleset.status).toBe(201);
    await open(owner, { head: "feature", base: "main" });
    const retargeted = await patch(owner, 1, { base: "stable" });
    expect(retargeted.body.base.ref).toBe("stable");
  });

  it("refuses a token scoped without pull_requests:write, and a stranger as if there were no repository", async () => {
    const readOnly = {
      ...owner,
      token: await scopedToken(owner.principalId, ["pull_requests:read"]),
    };
    expect((await open(readOnly, { head: "feature", base: "main" })).status).toBe(403);
    const stranger = await user();
    expect((await open(stranger, { head: "feature", base: "main" })).status).toBe(404);
  });
});
