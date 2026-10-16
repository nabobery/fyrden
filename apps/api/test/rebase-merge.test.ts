// Rebase merges: the pull request's commits replayed onto the base tip by a
// saga a request starts and the alarm finishes, authors and messages kept,
// committed and signed by the server, published as one push; empty commits
// as git rebase treats them; merge commits and conflicts refused; the saga
// resumed after errors, restarted on a new signing key, failed when its
// token is revoked or the pull request changes.
import { env, exports } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { beforeEach, describe, expect, inject, it } from "vitest";
import type { RepoDO } from "../src/do/RepoDO.js";
import { REBASE_POLICY, type RebasePolicy, rebaseJobId } from "../src/do/repo/rebase-saga.js";
import { api, json, user, type Who } from "./helpers/api.js";
import { ORIGIN } from "./helpers/git-http.js";
import { scopedToken } from "./helpers/principals.js";
import { type PushTarget, postPush } from "./helpers/push.js";
import { pushBody, ZERO } from "./helpers/push-fixtures.js";
import { inRepo } from "./helpers/repo-git.js";

const fx = inject("pushFixtures");

type Merged = { sha: string; merged: boolean; code?: string; detail?: string };
type Commit = {
  sha: string;
  commit: {
    message: string;
    author: { name: string; email: string; date: string };
    committer: { name: string; email: string };
    tree: { sha: string };
    verification: { verified: boolean; reason: string };
  };
  parents: { sha: string }[];
};

let owner: Who;
let repo: { id: string; name: string };
let path: string;

const stub = () => env.REPO.getByName(repo.id);
const commitOn = async (branch: string, changes: Record<string, unknown>[], message: string) => {
  const made = await json<{ commit: { sha: string } }>(
    api("POST", `${path}/file-commits`, owner.token, { branch, message, changes }),
  );
  expect(made.status).toBe(201);
  return made.body.commit.sha;
};
/** Pushes branch `name` from `old` to `sha` (a force push when it must be). */
async function branchFrom(name: string, sha: string, old = ZERO) {
  const target: PushTarget = {
    repo: { id: repo.id, name: repo.name, stub: stub() },
    owner: {
      principalId: owner.principalId,
      token: await scopedToken(owner.principalId, [], "git"),
    },
    path: `/${owner.handle}/${repo.name}.git`,
  };
  const pushed = await postPush(
    target,
    pushBody([{ old, new: sha, ref: `refs/heads/${name}` }], { pack: fx.packEmpty }),
  );
  expect(pushed.report).toContain(`ok refs/heads/${name}\n`);
}
const commitAt = async (ref: string) =>
  (await json<Commit>(api("GET", `${path}/commits/${ref}`, owner.token))).body;
const file = async (name: string, ref = "main") => {
  const got = await json<{ content?: string }>(
    api("GET", `${path}/contents/${name}?ref=${ref}`, owner.token),
  );
  return got.body.content === undefined ? undefined : atob(got.body.content.replace(/\n/g, ""));
};
const open = async (head = "feature", base = "main") => {
  const opened = await json<{ number: number }>(
    api("POST", `${path}/pulls`, owner.token, { title: "Feature", head, base }),
  );
  expect(opened.status).toBe(201);
  return opened.body.number;
};
const rebase = (number = 1, who: Who = owner, body: Record<string, unknown> = {}) =>
  json<Merged>(
    api("PUT", `${path}/pulls/${number}/merge`, who.token, { merge_method: "rebase", ...body }),
  );
const setPolicy = (policy: Partial<RebasePolicy>) =>
  inRepo(stub(), (r: RepoDO) => {
    r.rebasePolicy = { ...REBASE_POLICY, ...policy };
  });
const saga = (number = 1) =>
  inRepo(stub(), (r: RepoDO) => {
    const row = r.git.context.storage.sql
      .exec<{ state: string; generation: number; next: number; saga_id: string }>(
        "SELECT state, generation, next, saga_id FROM merge_sagas WHERE pr_number = ?",
        number,
      )
      .toArray()[0];
    const kept = r.git.context.storage.sql
      .exec<{ n: number }>("SELECT count(*) AS n FROM merge_saga_objects")
      .one().n;
    return { ...row, kept };
  });
/** Runs the repository's alarm, its jobs made due, until the saga stops running. */
async function drive(number = 1) {
  for (let i = 0; i < 40; i++) {
    if ((await saga(number)).state !== "running") return;
    await inRepo(stub(), async (r: RepoDO) => {
      r.git.context.storage.sql.exec(
        "UPDATE jobs SET next_run_at = ? WHERE state = 'queued'",
        r.git.context.now(),
      );
      await r.alarm();
    });
  }
  throw new Error("the saga did not finish");
}
/** The first-parent chain from `sha` down to (not including) `until`. */
async function chain(sha: string, until: string): Promise<Commit[]> {
  const out: Commit[] = [];
  for (let at = sha; at !== until; ) {
    const commit = await commitAt(at);
    out.push(commit);
    expect(commit.parents).toHaveLength(1);
    at = commit.parents[0]?.sha as string;
  }
  return out.reverse();
}

let base: string;
beforeEach(async () => {
  owner = await user();
  repo = (
    await json<{ id: string; name: string }>(
      api("POST", "/user/repos", owner.token, { name: uniqueId("r") }),
    )
  ).body;
  path = `/repos/${owner.handle}/${repo.name}`;
  base = await commitOn(
    "main",
    [
      { path: "a.txt", content: "one\ntwo\nthree\nfour\nfive\n" },
      { path: "b.txt", content: "bee\n" },
    ],
    "base",
  );
  await branchFrom("feature", base);
});

describe("rebase merges", () => {
  it("replays each commit onto the base tip, keeping authors and messages, signed by the server", async () => {
    const one = await commitOn(
      "feature",
      [{ path: "a.txt", content: "one\ntwo\nthree\nfour\nFIVE\n" }],
      "Shout five\n\nWith a body.",
    );
    const two = await commitOn("feature", [{ path: "c.txt", content: "new\n" }], "Add c");
    const three = await commitOn("feature", [{ path: "b.txt", delete: true }], "Drop b");
    await open();
    const mainTip = await commitOn(
      "main",
      [{ path: "a.txt", content: "ONE\ntwo\nthree\nfour\nfive\n" }],
      "Shout one",
    );

    const merged = await rebase();
    expect(merged).toMatchObject({ status: 200, body: { merged: true } });
    const made = await chain(merged.body.sha, mainTip);
    const originals = await Promise.all([one, two, three].map(commitAt));
    expect(made.map((c) => c.commit.message)).toEqual(originals.map((c) => c.commit.message));
    expect(made.map((c) => c.commit.author)).toEqual(originals.map((c) => c.commit.author));
    for (const c of made) {
      expect(c.commit.committer.name).toBe("Fyrden");
      expect(c.commit.verification).toMatchObject({ verified: true });
    }
    expect(made.map((c) => c.sha)).not.toContain(one);
    expect((await commitAt("main")).sha).toBe(merged.body.sha);
    expect(await file("a.txt")).toBe("ONE\ntwo\nthree\nfour\nFIVE\n");
    expect(await file("c.txt")).toBe("new\n");
    expect(await file("b.txt")).toBeUndefined();
    const pull = (await json<Record<string, unknown>>(api("GET", `${path}/pulls/1`, owner.token)))
      .body;
    expect(pull).toMatchObject({ merged: true, merge_commit_sha: merged.body.sha });
    // The saga is done and keeps nothing; the same request again answers the same merge.
    expect(await saga()).toMatchObject({ state: "done", kept: 0 });
    expect(await rebase()).toMatchObject({ status: 200, body: { sha: merged.body.sha } });
  });

  it("rewrites the commits of a head already on the base tip, with the same trees", async () => {
    const one = await commitOn("feature", [{ path: "c.txt", content: "c\n" }], "Add c");
    const two = await commitOn("feature", [{ path: "d.txt", content: "d\n" }], "Add d");
    await open();
    const merged = await rebase();
    expect(merged.status).toBe(200);
    const made = await chain(merged.body.sha, base);
    const originals = await Promise.all([one, two].map(commitAt));
    expect(made.map((c) => c.commit.tree.sha)).toEqual(originals.map((c) => c.commit.tree.sha));
    expect(made.every((c) => c.commit.committer.name === "Fyrden")).toBe(true);
  });

  it("drops a commit whose changes the base already has, and refuses when nothing is left", async () => {
    await commitOn("feature", [{ path: "b.txt", content: "BEE\n" }], "Shout bee");
    await commitOn("feature", [{ path: "c.txt", content: "c\n" }], "Add c");
    await open();
    const mainTip = await commitOn("main", [{ path: "b.txt", content: "BEE\n" }], "Same change");
    const merged = await rebase();
    expect(merged.status).toBe(200);
    expect((await chain(merged.body.sha, mainTip)).map((c) => c.commit.message)).toEqual(["Add c"]);

    // A second pull request with only the change the base has: nothing to rebase.
    await branchFrom("again", base);
    await commitOn("again", [{ path: "b.txt", content: "BEE\n" }], "Shout bee again");
    const second = await open("again");
    expect((await rebase(second)).body).toMatchObject({ code: "not_mergeable" });
  });

  it("refuses a conflicting commit, naming it, and a pull request with a merge commit", async () => {
    const conflicting = await commitOn(
      "feature",
      [{ path: "a.txt", content: "one\ntwo\nTHREE\nfour\nfive\n" }],
      "Shout three",
    );
    await open();
    await commitOn("main", [{ path: "a.txt", content: "one\ntwo\n3\nfour\nfive\n" }], "Number");
    const refused = await rebase();
    expect(refused.body).toMatchObject({ code: "merge_conflict" });
    expect(refused.body.detail).toContain(conflicting);
    expect(await saga()).toMatchObject({ state: "failed", kept: 0 });

    // Merge the base into another branch through a pull request: a merge commit.
    await branchFrom("merged", base);
    await commitOn("merged", [{ path: "e.txt", content: "e\n" }], "Add e");
    const into = await json<{ number: number }>(
      api("POST", `${path}/pulls`, owner.token, { title: "Sync", head: "main", base: "merged" }),
    );
    expect(
      (await api("PUT", `${path}/pulls/${into.body.number}/merge`, owner.token, {})).status,
    ).toBe(200);
    const withMerge = await open("merged");
    expect((await rebase(withMerge)).body).toMatchObject({ code: "not_mergeable" });
  });

  it("answers a failure found in the background once, then starts again", async () => {
    await commitOn(
      "feature",
      [{ path: "a.txt", content: "one\ntwo\nTHREE\nfour\nfive\n" }],
      "Shout three",
    );
    await open();
    await commitOn("main", [{ path: "a.txt", content: "one\ntwo\n3\nfour\nfive\n" }], "Number");
    await setPolicy({ requestCalls: 0 });
    expect((await rebase()).body).toMatchObject({ code: "merge_in_progress" });
    await drive();
    const first = await saga();
    expect(first).toMatchObject({ state: "failed" });
    expect((await rebase()).body).toMatchObject({ code: "merge_conflict" });
    expect((await saga()).saga_id).toBe(first.saga_id);
    // Answered: the next request is a new attempt.
    expect((await rebase()).body).toMatchObject({ code: "merge_in_progress" });
    expect((await saga()).saga_id).not.toBe(first.saga_id);
  });

  it("refuses more commits than the limit", async () => {
    await commitOn("feature", [{ path: "c.txt", content: "c\n" }], "Add c");
    await commitOn("feature", [{ path: "d.txt", content: "d\n" }], "Add d");
    await open();
    await setPolicy({ maxCommits: 1 });
    expect((await rebase()).body).toMatchObject({ code: "too_expensive" });
  });

  it("answers merge_in_progress and finishes in the background, a slice at a time", async () => {
    for (const name of ["c", "d", "e"])
      await commitOn("feature", [{ path: `${name}.txt`, content: `${name}\n` }], `Add ${name}`);
    await open();
    await commitOn("main", [{ path: "b.txt", content: "BEE\n" }], "Shout bee");
    await setPolicy({ requestCalls: 0, commitsPerSlice: 1 });
    const first = await rebase();
    expect(first.body).toMatchObject({ code: "merge_in_progress" });
    // A merge of another method waits for it.
    expect(
      (await json(api("PUT", `${path}/pulls/1/merge`, owner.token, { merge_method: "squash" })))
        .body,
    ).toMatchObject({ code: "merge_in_progress" });
    await drive();
    const done = await saga();
    expect(done).toMatchObject({ state: "done", next: 3, kept: 0 });
    const again = await rebase();
    expect(again.status).toBe(200);
    expect((await commitAt("main")).sha).toBe(again.body.sha);
    expect(await file("e.txt")).toBe("e\n");
    expect(await file("b.txt")).toBe("BEE\n");
  });

  it("keeps the comparison it was rebased onto when it finishes in the background", async () => {
    const commits: string[] = [];
    for (const name of ["c", "d"])
      commits.push(
        await commitOn("feature", [{ path: `${name}.txt`, content: `${name}\n` }], `Add ${name}`),
      );
    await open();
    const tip = await commitOn("main", [{ path: "b.txt", content: "BEE\n" }], "Shout bee");
    const listed = async () => ({
      files: (
        await json<{ files: { filename: string }[] }>(
          api("GET", `${path}/pulls/1/files`, owner.token),
        )
      ).body.files.map((f) => f.filename),
      commits: (
        await json<{ commits: { sha: string }[] }>(
          api("GET", `${path}/pulls/1/commits`, owner.token),
        )
      ).body.commits.map((c) => c.sha),
    });
    expect(await listed()).toEqual({ files: ["c.txt", "d.txt"], commits });
    await setPolicy({ requestCalls: 0, commitsPerSlice: 1 });
    expect((await rebase()).body).toMatchObject({ code: "merge_in_progress" });
    await drive();
    const pull = await json<{ merged: boolean; base: { sha: string } }>(
      api("GET", `${path}/pulls/1`, owner.token),
    );
    expect(pull.body).toMatchObject({ merged: true, base: { sha: tip } });
    // The base branch then takes the head itself: the merged pull request's listings stay.
    const merged = (await commitAt("main")).sha;
    await branchFrom("main", commits[1] as string, merged);
    expect(await listed()).toEqual({ files: ["c.txt", "d.txt"], commits });
  });

  it("releases the request's idempotency key while the rebase goes on", async () => {
    await commitOn("feature", [{ path: "c.txt", content: "c\n" }], "Add c");
    await open();
    await commitOn("main", [{ path: "b.txt", content: "BEE\n" }], "Shout bee");
    await setPolicy({ requestCalls: 0 });
    const key = crypto.randomUUID();
    const send = () =>
      json<Merged>(
        exports.default.fetch(`${ORIGIN}/api${path}/pulls/1/merge`, {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${owner.token}`,
            "Content-Type": "application/json",
            "Idempotency-Key": key,
          },
          body: JSON.stringify({ merge_method: "rebase" }),
        }),
      );
    expect((await send()).body).toMatchObject({ code: "merge_in_progress" });
    await drive();
    const done = await send();
    expect(done.status).toBe(200);
    expect(done.body.sha).toBe((await commitAt("main")).sha);
  });

  it("goes on after an error before its commit, and stays merged after an error past it", async () => {
    await commitOn("feature", [{ path: "c.txt", content: "c\n" }], "Add c");
    await open();
    await commitOn("main", [{ path: "b.txt", content: "BEE\n" }], "Shout bee");
    await inRepo(stub(), (r: RepoDO) => {
      r.rebaseHooks = {
        beforeFinalize: async () => {
          r.rebaseHooks = {
            afterFinalize: async () => {
              r.rebaseHooks = {};
              throw new Error("after the commit");
            },
          };
          throw new Error("before the commit");
        },
      };
    });
    const first = await rebase();
    expect(first.body).toMatchObject({ code: "merge_in_progress" });
    await drive();
    expect(await saga()).toMatchObject({ state: "done", kept: 0 });
    const merged = await rebase();
    expect(merged.status).toBe(200);
    expect((await commitAt("main")).sha).toBe(merged.body.sha);
  });

  for (const throws of [true, false])
    it(`makes its push again when one that lost the job discarded it (${throws ? "seen at the next step" : "seen by its commit"})`, async () => {
      await commitOn("feature", [{ path: "c.txt", content: "c\n" }], "Add c");
      await open();
      await commitOn("main", [{ path: "b.txt", content: "BEE\n" }], "Shout bee");
      await inRepo(stub(), (r: RepoDO) => {
        r.rebaseHooks = {
          beforeFinalize: async () => {
            r.rebaseHooks = {};
            // As a runner that lost the job does inside its commit: the push refused, discarded.
            const [row] = r.git.context.storage.sql
              .exec<{ upload_json: string }>("SELECT upload_json FROM merge_sagas")
              .toArray();
            const upload = JSON.parse(row?.upload_json ?? "{}") as { uploadId: string };
            r.git.uploads.abort(upload.uploadId);
            if (throws) throw new Error("taken over");
          },
        };
      });
      // Seen by its commit, the push is made again in the same request; else at the next step.
      const first = await rebase();
      if (throws) expect(first.body).toMatchObject({ code: "merge_in_progress" });
      else expect(first.status).toBe(200);
      await drive();
      expect(await saga()).toMatchObject({ state: "done", kept: 0 });
      const merged = await rebase();
      expect(merged.status).toBe(200);
      expect((await commitAt("main")).sha).toBe(merged.body.sha);
    });

  it("leaves its push to the runner that took the job over during its commit", async () => {
    await commitOn("feature", [{ path: "c.txt", content: "c\n" }], "Add c");
    await open();
    await commitOn("main", [{ path: "b.txt", content: "BEE\n" }], "Shout bee");
    let uploadId = "";
    await inRepo(stub(), (r: RepoDO) => {
      r.rebaseHooks = {
        beforeFinalize: async () => {
          r.rebaseHooks = {};
          const sql = r.git.context.storage.sql;
          uploadId = (
            JSON.parse(
              sql.exec<{ upload_json: string }>("SELECT upload_json FROM merge_sagas").one()
                .upload_json,
            ) as { uploadId: string }
          ).uploadId;
          // Taken over: another run claims the job while this one is about to commit.
          sql.exec(
            `UPDATE jobs SET claim = claim + 1, state = 'queued', next_run_at = ?
             WHERE job_id = 'merge-saga:1'`,
            r.git.context.now(),
          );
        },
      };
    });
    expect((await rebase()).body).toMatchObject({ code: "merge_in_progress" });
    // The push is still there, for the run that took over.
    const kept = await inRepo(stub(), (r: RepoDO) => r.git.uploads.get(uploadId)?.state);
    expect(kept).toBe("indexed");
    expect(await saga()).toMatchObject({ state: "running" });
    await drive();
    expect(await saga()).toMatchObject({ state: "done", kept: 0 });
    expect((await rebase()).status).toBe(200);
  });

  it("takes its job from a slice of the saga it replaces, whose end then records nothing", async () => {
    const state = await inRepo(stub(), async (r: RepoDO) => {
      const id = rebaseJobId(99);
      r.git.jobs.ensure("merge_saga", id);
      await r.git.jobs.runJob(
        id,
        {
          runSlice: async () => {
            // A request starts the next saga while this slice of the last one ends.
            r.git.jobs.restart("merge_saga", id);
            return { done: true };
          },
        },
        r.git.memory,
        r.git.context.now(),
      );
      return r.git.jobs.get(id)?.state;
    });
    expect(state).toBe("queued");
  });

  it("is replaced at once by a request for a newer head", async () => {
    await commitOn("feature", [{ path: "c.txt", content: "c\n" }], "Add c");
    await open();
    await commitOn("main", [{ path: "b.txt", content: "BEE\n" }], "Shout bee");
    await setPolicy({ requestCalls: 0 });
    expect((await rebase()).body).toMatchObject({ code: "merge_in_progress" });
    const first = await saga();
    await commitOn("feature", [{ path: "d.txt", content: "d\n" }], "Add d");
    await setPolicy({});
    const merged = await rebase();
    expect(merged.status).toBe(200);
    expect((await saga()).saga_id).not.toBe(first.saga_id);
    expect(await file("d.txt")).toBe("d\n");
  });

  it("starts again under a new signing key, its earlier objects gone", async () => {
    await commitOn("feature", [{ path: "c.txt", content: "c\n" }], "Add c");
    await commitOn("feature", [{ path: "d.txt", content: "d\n" }], "Add d");
    await open();
    const mainTip = await commitOn("main", [{ path: "b.txt", content: "BEE\n" }], "Shout bee");
    await setPolicy({ requestCalls: 0, commitsPerSlice: 1 });
    expect((await rebase()).body).toMatchObject({ code: "merge_in_progress" });
    // One commit replayed under the first key (one slice).
    await inRepo(stub(), async (r: RepoDO) => {
      await r.git.jobs.runJob(
        rebaseJobId(1),
        r.rebases.handler("alarm"),
        r.git.memory,
        r.git.context.now(),
      );
    });
    expect((await saga()).next).toBe(1);
    const original = (env as { SIGNING_KEY?: string }).SIGNING_KEY;
    const rotated = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
    try {
      await inRepo(stub(), (r: RepoDO) => {
        (r as unknown as { env: { SIGNING_KEY: string } }).env.SIGNING_KEY = rotated;
      });
      await drive();
      expect(await saga()).toMatchObject({ state: "done", generation: 2, kept: 0 });
    } finally {
      await inRepo(stub(), (r: RepoDO) => {
        const vars = (r as unknown as { env: { SIGNING_KEY?: string } }).env;
        if (original === undefined) delete vars.SIGNING_KEY;
        else vars.SIGNING_KEY = original;
      });
    }
    const merged = await rebase();
    expect(merged.status).toBe(200);
    // Both commits signed with the new key, which the API (still on the first one) does not know:
    // the commit replayed under the first key was not kept.
    const made = await chain(merged.body.sha, mainTip);
    expect(made.map((c) => c.commit.verification.reason)).toEqual(["unknown_key", "unknown_key"]);
  });

  it("fails when the merger's token is revoked, or the pull request changes, before its commit", async () => {
    await commitOn("feature", [{ path: "c.txt", content: "c\n" }], "Add c");
    await open();
    await commitOn("main", [{ path: "b.txt", content: "BEE\n" }], "Shout bee");
    await setPolicy({ requestCalls: 0 });
    expect((await rebase()).body).toMatchObject({ code: "merge_in_progress" });
    await commitOn("feature", [{ path: "d.txt", content: "d\n" }], "Add d");
    await drive();
    expect(await saga()).toMatchObject({ state: "failed", kept: 0 });
    const mainBefore = (await commitAt("main")).sha;

    // A new rebase of the new head; its token revoked before the commit.
    expect((await rebase()).body).toMatchObject({ code: "merge_in_progress" });
    await env.DIRECTORY.prepare("UPDATE tokens SET revoked_at = ? WHERE principal_id = ?")
      .bind(Date.now(), owner.principalId)
      .run();
    await drive();
    const failed = await inRepo(stub(), (r: RepoDO) => r.rebases.view(1));
    expect(failed).toMatchObject({ state: "failed", failure: { code: "token_revoked" } });
    expect(await saga()).toMatchObject({ kept: 0 });
    const uploads = await inRepo(stub(), (r: RepoDO) =>
      r.git.context.storage.sql
        .exec<{ n: number }>("SELECT count(*) AS n FROM uploads WHERE state = 'indexed'")
        .one(),
    );
    expect(uploads.n).toBe(0);
    expect((await commitAt("main")).sha).toBe(mainBefore);
  });

  it("admits only as many running rebases as allowed, and bounds what one keeps", async () => {
    await commitOn("feature", [{ path: "c.txt", content: "c\n" }], "Add c");
    await branchFrom("other", base);
    await commitOn("other", [{ path: "d.txt", content: "d\n" }], "Add d");
    await open();
    const second = await open("other");
    await commitOn("main", [{ path: "b.txt", content: "BEE\n" }], "Shout bee");
    await setPolicy({ requestCalls: 0, maxRunning: 1 });
    expect((await rebase()).body).toMatchObject({ code: "merge_in_progress" });
    expect((await rebase(second)).body).toMatchObject({ code: "busy" });
    await drive();
    // A commit's objects (a tree and the commit) past the limit of what a saga keeps.
    await setPolicy({ maxStagedObjects: 1 });
    expect((await rebase(second)).body).toMatchObject({ code: "too_expensive" });
    expect(await saga(second)).toMatchObject({ state: "failed", kept: 0 });
  });

  for (const [what, change, code] of [
    [
      "a review",
      async (reviewer: Who, head: string) =>
        api("POST", `${path}/pulls/1/reviews`, reviewer.token, {
          event: "APPROVE",
          commit_id: head,
        }),
      "pull_changed",
    ],
    [
      "a retarget",
      async () => {
        await branchFrom("elsewhere", base);
        return api("PATCH", `${path}/pulls/1`, owner.token, { base: "elsewhere" });
      },
      "pull_changed",
    ],
    [
      "a push to the base",
      async () => {
        await commitOn("main", [{ path: "e.txt", content: "e\n" }], "Add e");
        return new Response(null, { status: 204 });
      },
      "base_moved",
    ],
  ] as const) {
    it(`fails on ${what} before its commit`, async () => {
      const head = await commitOn("feature", [{ path: "c.txt", content: "c\n" }], "Add c");
      await open();
      await commitOn("main", [{ path: "b.txt", content: "BEE\n" }], "Shout bee");
      const reviewer = await user();
      await api("PUT", `${path}/collaborators/${reviewer.handle}`, owner.token, {
        permission: "push",
      });
      await setPolicy({ requestCalls: 0 });
      expect((await rebase()).body).toMatchObject({ code: "merge_in_progress" });
      const mainBefore = (await commitAt("main")).sha;
      expect((await change(reviewer, head)).status).toBeLessThan(300);
      await drive();
      const failed = await inRepo(stub(), (r: RepoDO) => r.rebases.view(1));
      expect(failed).toMatchObject({ state: "failed", failure: { code } });
      expect(await saga()).toMatchObject({ kept: 0 });
      if (code === "pull_changed") expect((await commitAt("main")).sha).toBe(mainBefore);
    });
  }

  it("is allowed or refused by the rulesets' merge methods", async () => {
    await commitOn("feature", [{ path: "c.txt", content: "c\n" }], "Add c");
    await open();
    const ruleset = (methods: string[]) =>
      api("POST", `${path}/rulesets`, owner.token, {
        name: uniqueId("methods"),
        enforcement: "active",
        conditions: { ref_name: { include: ["~DEFAULT_BRANCH"] } },
        rules: [
          { type: "pull_request", parameters: { allowed_merge_methods: methods } },
          { type: "required_signatures" },
        ],
      });
    const merge = await ruleset(["merge"]);
    expect(merge.status).toBe(201);
    expect((await rebase()).body).toMatchObject({ code: "merge_refused" });
    const id = (await json<{ id: number }>(Promise.resolve(merge))).body.id;
    expect((await api("DELETE", `${path}/rulesets/${id}`, owner.token)).ok).toBe(true);
    expect((await ruleset(["rebase"])).status).toBe(201);
    expect((await rebase()).status).toBe(200);
  });
});
